import json
import zipfile
from dataclasses import asdict, replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import jsonschema
import pytest

from nova_generator.application.ports.editorial_assistant import (
    EditorialSuggestion,
    EditorialWordTranslation,
)
from nova_generator.application.use_cases.editorial_assistance import (
    EditorialAssistanceError,
    build_editorial_prompt,
    persist_editorial_preparation,
    scene_is_editorially_prepared,
    validate_editorial_result,
)
from nova_generator.application.use_cases.external_editorial_exchange import (
    ExternalEditorialExchange,
    ResegmentationConfirmationRequired,
)
from nova_generator.application.use_cases.import_legacy_editorial_project import (
    ImportLegacyEditorialProject,
)
from nova_generator.infrastructure.database.base import Base
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.session import (
    create_database_engine,
    create_session_factory,
)


def _resegmented_fixture_zip(repository, scene_id) -> bytes:
    """A two-cue package for a one-cue scene, retaining all source word IDs."""
    from nova_generator.application.use_cases.editorial_assistance import build_editorial_prompt

    _old_hash, cues = build_editorial_prompt(repository, scene_id)
    original = asdict(cues[0])
    head = original["words"][:1]
    tail = original["words"][1:]
    assert head and tail
    second_id = str(uuid4())
    first = {
        **original, "words": head, "order": 1,
        "speech_end_ms": head[-1]["end_ms"],
        "subtitle_end_ms": head[-1]["end_ms"],
        "original_en": head[0]["surface"], "current_en": "", "current_pt": "",
        "trailing": "", "word_by_word_en": head[0]["surface"],
        "requires_reconciliation": False,
    }
    second = {
        **original, "id": second_id, "words": [
            {**word, "order": index} for index, word in enumerate(tail, 1)
        ], "order": 2,
        "speech_start_ms": tail[0]["start_ms"],
        "subtitle_start_ms": tail[0]["start_ms"],
        "original_en": " ".join(word["surface"] for word in tail),
        "current_en": "", "current_pt": "", "trailing": "",
        "word_by_word_en": "".join(f'{word["leading"]}{word["surface"]}' for word in tail),
        "requires_reconciliation": False,
    }
    source_cues = [first, second]
    source_hash = sha256(json.dumps(
        source_cues, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode()).hexdigest()
    suggestions = []
    for cue in source_cues:
        words = cue["words"]
        suggestions.append({
            "cue_id": cue["id"], "order": cue["order"],
            "approved_en": "".join(
                f'{word["leading"]}{word["surface"]}' for word in words
            ),
            "approved_pt": "Tradução editorial.",
            "word_translations": [{
                "word_id": word["id"], "order": word["order"],
                "leading": word["leading"], "surface": word["surface"],
                "start_ms": word["start_ms"], "end_ms": word["end_ms"],
                "pt": "tradução",
            } for word in words],
            "context_practices": [], "semantic_units": [], "speaker_turns": [],
            "trailing": "", "notes": "",
        })
    manifest = {
        "schema_version": "nova-generator-editorial-exchange/1.5",
        "scene_id": str(scene_id), "input_sha256": source_hash,
        "chunks": [{
            "id": "chunk-001", "index": 1,
            "cue_ids": [cue["id"] for cue in source_cues],
            "cue_orders": [1, 2],
        }],
    }
    mapping = {
        "schema_version": "nova-generator-cue-resegmentation/1.0",
        "scene_id": str(scene_id), "resegmented_input_sha256": source_hash,
        "cues": [{
            "cue_id": cue["id"], "order": cue["order"],
            "speaker": "A", "start_ms": cue["speech_start_ms"],
            "end_ms": cue["speech_end_ms"],
            "source_spans": [{"word_ids": [word["id"] for word in cue["words"]]}],
        } for cue in source_cues],
    }
    first_en = suggestions[0]["approved_en"]
    card = {
        "card_id": str(uuid4()), "cue_id": first["id"],
        "source_context_en": first_en, "source_context_pt": "Tradução editorial.",
        "front_en": "I study English.", "back_pt": "Eu estudo inglês.",
        "uses_literal_scene_line": False, "card_type": "VOCABULARY",
        "focus_text": head[0]["surface"], "meaning": "eu", "marked_en": "I",
        "marked_pt": "Eu", "explanation_pt": "Pronome pessoal.",
        "example_en": "I learn every day.", "example_pt": "Eu aprendo todo dia.",
        "tags": ["study"],
    }
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, item in {
            "manifest.json": manifest,
            "editorial_input.json": {"scene_id": str(scene_id),
                                     "input_sha256": source_hash, "cues": source_cues},
            "cue-resegmentation-map.json": mapping,
            "chunks/001-chunk-001-result.json": {
                "schema_version": "nova-generator-editorial-suggestions/1.5",
                "scene_id": str(scene_id), "input_sha256": source_hash,
                "chunk_id": "chunk-001", "suggestions": suggestions,
            },
            "anki/anki-ai-result.json": {
                "contract": "nova-generator-anki-proposal/2.0", "scene_id": str(scene_id),
                "input_sha256": source_hash, "anki_cards": [card],
            },
        }.items():
            archive.writestr(name, json.dumps(item, ensure_ascii=False))
    return buffer.getvalue()


def test_resegmented_zip_requires_owner_confirmation_and_imports_atomically(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'resegmentation.db'}")
    Base.metadata.create_all(engine)
    repo = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repo).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="resegmentation-test", imported_by="test",
    )
    scene_id = repo.get_project_scenes(project_id)[0].id
    exchange = ExternalEditorialExchange(repo, tmp_path)
    payload = _resegmented_fixture_zip(repo, scene_id)
    original_words = [word.id for cue in repo.get_scene_cues(scene_id)
                      for word in repo.get_cue_words(cue.id)]
    original_revisions = len(repo.list_revisions(scene_id))
    with pytest.raises(ResegmentationConfirmationRequired, match="reorganiza 1 cues em 2"):
        exchange.import_batch(scene_id, [("proposta.zip", payload)])
    assert len(repo.get_scene_cues(scene_id)) == 1
    assert len(repo.list_revisions(scene_id)) == original_revisions

    result = exchange.import_batch(
        scene_id, [("proposta.zip", payload)], allow_resegmentation=True
    )
    assert len(result.suggestions) == 2
    assert len(repo.get_scene_cues(scene_id)) == 2
    assert [word.id for cue in repo.get_scene_cues(scene_id)
            for word in repo.get_cue_words(cue.id)] == original_words
    assert (tmp_path / str(project_id) / "materials" /
            f"anki-prepared-{scene_id}.json").exists()
    assert len(repo.list_revisions(scene_id)) == original_revisions + 1
    exchange.import_batch(scene_id, [("proposta.zip", payload)])
    assert len(repo.list_revisions(scene_id)) == original_revisions + 1


def test_resegmented_zip_rejects_changed_words_without_mutation(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'stale_resegmentation.db'}")
    Base.metadata.create_all(engine)
    repo = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repo).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="stale-resegmentation", imported_by="test",
    )
    scene_id = repo.get_project_scenes(project_id)[0].id
    revision_count = len(repo.list_revisions(scene_id))
    payload = _resegmented_fixture_zip(repo, scene_id)
    with zipfile.ZipFile(BytesIO(payload)) as old:
        files = {name: old.read(name) for name in old.namelist()}
    changed = json.loads(files["cue-resegmentation-map.json"])
    changed["cues"][1]["source_spans"][0]["word_ids"] = [str(uuid4())]
    files["cue-resegmentation-map.json"] = json.dumps(changed).encode()
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    exchange = ExternalEditorialExchange(repo, tmp_path)
    with pytest.raises(EditorialAssistanceError, match="map and source word spans"):
        exchange.import_batch(scene_id, [("tampered.zip", buffer.getvalue())],
                              allow_resegmentation=True)
    assert len(repo.get_scene_cues(scene_id)) == 1
    assert len(repo.list_revisions(scene_id)) == revision_count


def test_external_package_round_trip_is_versioned_and_stale_safe(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session_factory = create_session_factory(engine)
    repository = SqlAlchemyEditorialProjectRepository(session_factory)
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-round-trip",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    package = exchange.build_package(scene.id)
    with zipfile.ZipFile(package) as archive:
        assert {"editorial_input.json", "editorial_result_template.json", "INSTRUCOES.md"} <= set(
            archive.namelist()
        )
        template = json.loads(archive.read("editorial_result_template.json"))
        source = json.loads(archive.read("editorial_input.json"))
    assert source["schema_version"] == "nova-generator-editorial-input/1.3"
    assert source["cues"][0]["words"][0]["surface"] == "I"
    assert source["cues"][0]["words"][0]["start_ms"] == 100
    assert source["cues"][0]["words"][0]["original_start_ms"] == 100
    assert "confidence" in source["cues"][0]["words"][0]
    contract_root = Path(__file__).parents[2] / "contracts" / "editorial-ai" / "v1.3"
    jsonschema.validate(
        source,
        json.loads((contract_root / "input.schema.json").read_text(encoding="utf-8")),
    )
    template["suggestions"][0]["approved_pt"] = "“Não posso… ir?”"
    for suggestion, _cue in zip(template["suggestions"], source["cues"], strict=True):
        for index, word in enumerate(suggestion["word_translations"], 1):
            word["pt"] = f"tradução {index}"
    word_ids = [word["id"] for word in source["cues"][0]["words"][:2]]
    template["suggestions"][0]["semantic_units"] = [{"word_ids": word_ids, "pt": "Não posso"}]
    result = exchange.import_result(
        scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8")
    )
    assert result.provider == "external"
    assert result.suggestions[0].approved_pt == "“Não posso… ir?”"
    assert result.suggestions[0].semantic_units[0].pt == "Não posso"
    legacy_result = json.loads(json.dumps(template))
    legacy_result["schema_version"] = "nova-generator-editorial-suggestions/1.0"
    legacy_result["suggestions"][0].pop("semantic_units")
    legacy_result["suggestions"][0].pop("word_translations")
    compatible = exchange.import_result(
        scene.id, json.dumps(legacy_result, ensure_ascii=False).encode("utf-8")
    )
    assert compatible.suggestions[0].semantic_units == ()
    with pytest.raises(EditorialAssistanceError, match="contract 1.3"):
        persist_editorial_preparation(repository, compatible, author="test")
    template["input_sha256"] = "0" * 64
    with pytest.raises(EditorialAssistanceError, match="stale"):
        exchange.import_result(scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8"))
    persist_editorial_preparation(repository, result, author="test")
    revision_count = len(repository.list_revisions(scene.id))
    assert persist_editorial_preparation(repository, result, author="test") is False
    assert len(repository.list_revisions(scene.id)) == revision_count
    assert scene_is_editorially_prepared(repository, scene.id)
    prepared_cue = repository.get_scene_cues(scene.id)[0]
    assert prepared_cue.approved_pt == "“Não posso… ir?”"
    prepared_words = repository.get_cue_words(prepared_cue.id)
    assert prepared_words[0].provenance["pt"] == "Não posso"
    assert prepared_words[1].provenance["semantic_group_role"] == "member"

    input_sha256, prompts = build_editorial_prompt(repository, scene.id)
    whitespace = replace(
        result,
        input_sha256=input_sha256,
        suggestions=tuple(
            replace(item, approved_pt="   ") if index == 0 else item
            for index, item in enumerate(result.suggestions)
        ),
    )
    with pytest.raises(EditorialAssistanceError, match="empty English or Portuguese"):
        validate_editorial_result(
            whitespace,
            scene_id=scene.id,
            input_sha256=input_sha256,
            cues=prompts,
            require_word_translations=True,
        )

    regrouped = replace(
        result,
        input_sha256=input_sha256,
        suggestions=tuple(
            EditorialSuggestion(
                cue_id=cue.id,
                order=cue.order,
                approved_en=cue.current_en or cue.original_en,
                approved_pt=cue.current_pt,
                word_translations=tuple(
                    EditorialWordTranslation(
                        word.id,
                        f"nova {word.order}",
                        word.order,
                        word.leading,
                        word.surface,
                        word.start_ms,
                        word.end_ms,
                    )
                    for word in cue.words
                ),
                trailing=cue.trailing,
            )
            for cue in prompts
        ),
    )
    assert persist_editorial_preparation(repository, regrouped, author="test")
    ungrouped_words = repository.get_cue_words(prepared_cue.id)
    assert all("semantic_group_id" not in word.provenance for word in ungrouped_words)
    assert all("semantic_group_role" not in word.provenance for word in ungrouped_words)


def test_external_result_rejects_overlapping_semantic_units(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'overlap.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-overlap",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        template = json.loads(archive.read("editorial_result_template.json"))
        source = json.loads(archive.read("editorial_input.json"))
    ids = [word["id"] for word in source["cues"][0]["words"]]
    template["suggestions"][0]["approved_pt"] = "Natural"
    for index, word in enumerate(template["suggestions"][0]["word_translations"], 1):
        word["pt"] = f"tradução {index}"
    template["suggestions"][0]["semantic_units"] = [
        {"word_ids": ids[:2], "pt": "Primeira"},
        {"word_ids": ids[1:], "pt": "Sobreposta"},
    ]
    with pytest.raises(EditorialAssistanceError, match="overlap"):
        exchange.import_result(scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8"))


def test_external_13_rejects_unknown_fields_and_coerced_order(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'strict.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-strict",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        template = json.loads(archive.read("editorial_result_template.json"))
    for suggestion in template["suggestions"]:
        suggestion["approved_pt"] = "Tradução natural."
        for word in suggestion["word_translations"]:
            word["pt"] = "tradução"

    with_extra = json.loads(json.dumps(template))
    with_extra["unexpected"] = True
    with pytest.raises(EditorialAssistanceError, match="contract"):
        exchange.import_result(scene.id, json.dumps(with_extra, ensure_ascii=False).encode("utf-8"))
    coerced = json.loads(json.dumps(template))
    coerced["suggestions"][0]["order"] = "1"
    with pytest.raises(EditorialAssistanceError, match="contract"):
        exchange.import_result(scene.id, json.dumps(coerced, ensure_ascii=False).encode("utf-8"))


def test_package_marks_preexisting_text_word_divergence(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'divergent.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-divergence",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    cue = repository.get_scene_cues(scene.id)[0]
    repository.save_cue(
        replace(cue, approved_en="“I cannot… go?”"), repository.get_cue_words(cue.id)
    )
    with zipfile.ZipFile(
        ExternalEditorialExchange(repository, tmp_path).build_package(scene.id)
    ) as archive:
        source = json.loads(archive.read("editorial_input.json"))
        template = json.loads(archive.read("editorial_result_template.json"))

    assert source["cues"][0]["requires_reconciliation"] is True
    assert source["cues"][0]["current_en"] == "“I cannot… go?”"
    assert template["suggestions"][0]["approved_en"] == source["cues"][0]["word_by_word_en"]


def test_external_13_reconciles_literal_word_surface_and_rejects_divergence(
    tmp_path: Path,
) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'reconcile.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-reconcile",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        template = json.loads(archive.read("editorial_result_template.json"))
    suggestion = template["suggestions"][0]
    suggestion["approved_pt"] = "“Eu não posso… ir?”"
    suggestion["notes"] = "Correção conferida no áudio."
    for index, word in enumerate(suggestion["word_translations"], 1):
        word["pt"] = f"palavra {index}"
    suggestion["word_translations"][1]["surface"] = "cannot"
    suggestion["approved_en"] = "“I cannot go?”"
    suggestion["word_translations"][1]["leading"] = " "
    suggestion["word_translations"][2]["surface"] = "go?"
    suggestion["word_translations"][2]["leading"] = " "
    suggestion["trailing"] = "”"

    result = exchange.import_result(
        scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8")
    )
    assert persist_editorial_preparation(repository, result, author="test")
    prepared = repository.get_scene_cues(scene.id)[0]
    words = repository.get_cue_words(prepared.id)
    assert prepared.approved_en == "“I cannot go?”"
    assert "".join(word.surface for word in words) + suggestion["trailing"] == prepared.approved_en
    assert prepared.provenance["editorial_preparation_notes"] == "Correção conferida no áudio."

    stale_hash, _ = build_editorial_prompt(repository, scene.id)
    invalid = replace(result, input_sha256=stale_hash)
    invalid = replace(
        invalid,
        suggestions=(replace(invalid.suggestions[0], approved_en="Texto divergente"),),
    )
    with pytest.raises(EditorialAssistanceError, match="exactly match"):
        persist_editorial_preparation(repository, invalid, author="test")


def test_external_text_chunks_are_small_and_apply_progressively(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'chunks.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-chunks",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    exchange._CUES_PER_CHUNK = 1
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        names = archive.namelist()
        assert "scene.mp4" not in names
        assert "manifest.json" in names
        result_names = [name for name in names if name.endswith("-result.json")]
        assert len(result_names) == len(repository.get_scene_cues(scene.id))
        first = json.loads(archive.read(result_names[0]))
    for suggestion in first["suggestions"]:
        suggestion["approved_pt"] = "Tradução natural."
        for word in suggestion["word_translations"]:
            word["pt"] = "tradução"
    imported = exchange.import_result(scene.id, json.dumps(first).encode("utf-8"))
    assert imported.contract_version.endswith("/1.5")
    changed = repository.get_scene_cues(scene.id)[0]
    assert changed.provenance["editorial_preparation_contract"].endswith("/1.5")


def test_external_speaker_turns_preserve_word_times(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'speaker-turns.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-speaker-turns",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    exchange._CUES_PER_CHUNK = 1
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        result_name = next(name for name in archive.namelist() if name.endswith("-result.json"))
        payload = json.loads(archive.read(result_name))
    cue_before = repository.get_scene_cues(scene.id)[0]
    words_before = repository.get_cue_words(cue_before.id)
    assert len(words_before) >= 2
    suggestion = payload["suggestions"][0]
    suggestion["approved_pt"] = "Tradução completa."
    for word in suggestion["word_translations"]:
        word["pt"] = "tradução"
    ids = [item["word_id"] for item in suggestion["word_translations"]]
    suggestion["speaker_turns"] = [
        {
            "word_ids": ids[:1],
            "speaker": "speaker_1",
            "approved_pt": "Eu.",
            "confidence": "uncertain",
        },
        {
            "word_ids": ids[1:],
            "speaker": "speaker_2",
            "approved_pt": "Não posso ir.",
            "confidence": "medium",
        },
    ]
    original_count = len(repository.get_scene_cues(scene.id))
    result = exchange.import_result(scene.id, json.dumps(payload).encode("utf-8"))
    assert result.contract_version.endswith("/1.5")
    cues = repository.get_scene_cues(scene.id)
    assert len(cues) == original_count + 1
    left, right = cues[:2]
    assert [left.speaker, right.speaker] == ["speaker_1", "speaker_2"]
    assert left.speech_end_ms <= right.speech_start_ms
    assert [word.id for cue in (left, right) for word in repository.get_cue_words(cue.id)] == [
        word.id for word in words_before
    ]
    new_starts = [
        word.start_ms for cue in (left, right) for word in repository.get_cue_words(cue.id)
    ]
    assert new_starts == [word.start_ms for word in words_before]


def test_external_batch_applies_atomic_speaker_revision(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'batch.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-batch",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    original = repository.get_scene_cues(scene.id)[0]
    original_words = repository.get_cue_words(original.id)
    new_id = uuid4()
    other = replace(
        original, id=new_id, order=2,
        speech_start_ms=2200, speech_end_ms=4100,
        subtitle_start_ms=2200, subtitle_end_ms=4100,
    )
    shifted_words = [
        replace(
            word, id=uuid4(), cue_id=new_id,
            start_ms=word.start_ms + 2100, end_ms=word.end_ms + 2100,
            original_start_ms=word.original_start_ms + 2100,
            original_end_ms=word.original_end_ms + 2100,
        )
        for word in original_words
    ]
    repository.replace_scene_cues(
        scene.id, [(original, original_words), (other, shifted_words)]
    )
    exchange = ExternalEditorialExchange(repository, tmp_path)
    exchange._CUES_PER_CHUNK = 1
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        names = sorted(name for name in archive.namelist() if name.endswith("-result.json"))
        results = [json.loads(archive.read(name)) for name in names]
    initial_cues = repository.get_scene_cues(scene.id)
    initial_revisions = len(repository.list_revisions(scene.id))
    for payload in results:
        for suggestion in payload["suggestions"]:
            suggestion["approved_pt"] = "Tradução do turno."
            for word in suggestion["word_translations"]:
                word["pt"] = "tradução"
    first = results[0]["suggestions"][0]
    ids = [word["word_id"] for word in first["word_translations"]]
    assert len(ids) >= 2
    first["speaker_turns"] = [
        {
            "word_ids": ids[:1],
            "speaker": "speaker_1",
            "approved_pt": "Primeiro.",
            "confidence": "medium",
        },
        {
            "word_ids": ids[1:],
            "speaker": "speaker_2",
            "approved_pt": "Segundo.",
            "confidence": "medium",
        },
    ]
    uploads = [
        (name, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        for name, payload in zip(names, results, strict=True)
    ]
    with pytest.raises(EditorialAssistanceError, match="all chunks"):
        exchange.import_batch(scene.id, uploads[:-1])
    assert repository.get_scene_cues(scene.id) == initial_cues
    assert len(repository.list_revisions(scene.id)) == initial_revisions

    bad = json.loads(json.dumps(results[-1]))
    bad["suggestions"][0]["order"] = "invalid"
    with pytest.raises(EditorialAssistanceError, match="invalid contract"):
        exchange.import_batch(
            scene.id,
            uploads[:-1] + [(names[-1], json.dumps(bad).encode("utf-8"))],
        )
    assert repository.get_scene_cues(scene.id) == initial_cues

    output = BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, payload in uploads:
            archive.writestr(f"chunks/{name}", payload)
        archive.writestr("INSTRUCOES.md", "Text instructions are ignored.")
    result = exchange.import_batch(scene.id, [("completed.zip", output.getvalue())])
    assert len(result.suggestions) == len(initial_cues)
    assert len(repository.get_scene_cues(scene.id)) == len(initial_cues) + 1
    assert len(repository.list_revisions(scene.id)) == initial_revisions + 1
    assert scene_is_editorially_prepared(repository, scene.id)


def test_external_batch_rejects_duplicate_chunks_without_mutation(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'duplicate.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-batch-duplicates",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    exchange._CUES_PER_CHUNK = 1
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        first = json.loads(
            archive.read(
                next(name for name in archive.namelist() if name.endswith("-result.json"))
            )
        )
    original = repository.get_scene_cues(scene.id)
    for suggestion in first["suggestions"]:
        suggestion["approved_pt"] = "Tradução."
        for word in suggestion["word_translations"]:
            word["pt"] = "tradução"
    serialized = json.dumps(first).encode("utf-8")
    with pytest.raises(EditorialAssistanceError, match="duplicate chunk_id"):
        exchange.import_batch(
            scene.id,
            [("first.json", serialized), ("duplicate.json", serialized)],
        )
    assert repository.get_scene_cues(scene.id) == original


def test_ai_coalesces_adjacent_turns_with_the_same_speaker(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'coalesce.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-coalesce",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        name = next(
            name for name in archive.namelist() if name.endswith("-result.json")
        )
        payload = json.loads(archive.read(name))
    suggestion = payload["suggestions"][0]
    suggestion["approved_pt"] = "Eu não posso ir?"
    for word in suggestion["word_translations"]:
        word["pt"] = "tradução"
    word_ids = [word["word_id"] for word in suggestion["word_translations"]]
    suggestion["speaker_turns"] = [
        {
            "word_ids": word_ids[:1],
            "speaker": "Liam",
            "approved_pt": "Eu",
            "confidence": "medium",
        },
        {
            "word_ids": word_ids[1:],
            "speaker": "Liam",
            "approved_pt": "não posso ir?",
            "confidence": "medium",
        },
    ]
    result = exchange.import_batch(
        scene.id, [(name, json.dumps(payload).encode("utf-8"))]
    )
    assert len(result.suggestions) == 1
    cues = repository.get_scene_cues(scene.id)
    assert len(cues) == 1
    assert cues[0].speaker == "Liam"
    assert cues[0].approved_pt == "Eu não posso ir?"
    assert len(repository.get_cue_words(cues[0].id)) == 3


def test_ai_merge_with_previous_preserves_words_and_is_one_revision(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'ai-merge.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-ai-merge",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    original = repository.get_scene_cues(scene.id)[0]
    original_words = repository.get_cue_words(original.id)
    other_id = uuid4()
    other = replace(
        original, id=other_id, order=2,
        speech_start_ms=2200, speech_end_ms=4100,
        subtitle_start_ms=2200, subtitle_end_ms=4100,
    )
    new_words = [
        replace(
            word, id=uuid4(), cue_id=other_id,
            start_ms=word.start_ms + 2100,
            end_ms=word.end_ms + 2100,
            original_start_ms=word.original_start_ms + 2100,
            original_end_ms=word.original_end_ms + 2100,
        )
        for word in original_words
    ]
    repository.replace_scene_cues(
        scene.id, [(original, original_words), (other, new_words)]
    )
    exchange = ExternalEditorialExchange(repository, tmp_path)
    exchange._CUES_PER_CHUNK = 1
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        names = sorted(
            name for name in archive.namelist() if name.endswith("-result.json")
        )
        payloads = [json.loads(archive.read(name)) for name in names]
    for payload in payloads:
        for suggestion in payload["suggestions"]:
            suggestion["approved_pt"] = "Tradução contextual."
            for word in suggestion["word_translations"]:
                word["pt"] = "tradução"
    payloads[1]["suggestions"][0]["merge_with_previous"] = True
    before_revisions = len(repository.list_revisions(scene.id))
    result = exchange.import_batch(
        scene.id,
        [
            (name, json.dumps(payload).encode("utf-8"))
            for name, payload in zip(names, payloads, strict=True)
        ],
    )
    assert len(result.suggestions) == 2
    cues = repository.get_scene_cues(scene.id)
    assert len(cues) == 1
    assert cues[0].provenance["ai_merged_from"]
    assert len(repository.get_cue_words(cues[0].id)) == 6
    assert len(repository.list_revisions(scene.id)) == before_revisions + 1


def test_ai_english_in_context_requires_explicit_highlight(tmp_path: Path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'highlight.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="external-highlight-validation",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        name = next(
            name for name in archive.namelist() if name.endswith("-result.json")
        )
        payload = json.loads(archive.read(name))
        instructions = archive.read("INSTRUCOES.md").decode("utf-8")
    assert manifest["english_in_context"]["highlight_required"] is True
    assert "highlight" in instructions
    for suggestion in payload["suggestions"]:
        suggestion["approved_pt"] = "Tradução da fala."
        for word in suggestion["word_translations"]:
            word["pt"] = "tradução"
    first = payload["suggestions"][0]
    first_word = first["word_translations"][0]
    expression = first_word["surface"].strip()
    first["context_practices"] = [{
        "type": "vocabulary",
        "word_ids": [first_word["word_id"]],
        "expression_en": expression,
        "meaning_pt": "Uma palavra da cena.",
        "explanation_pt": "Uma explicação didática.",
        "example_en": "This is an example.",
        "example_pt": "Este é um exemplo.",
    }]
    uploads = [(name, json.dumps(payload).encode("utf-8"))]
    before = len(repository.list_revisions(scene.id))
    with pytest.raises(EditorialAssistanceError, match="highlight"):
        exchange.import_batch(scene.id, uploads)
    assert len(repository.list_revisions(scene.id)) == before
    first["context_practices"][0]["highlight"] = "another word"
    with pytest.raises(EditorialAssistanceError, match="highlight"):
        exchange.import_batch(scene.id, [(name, json.dumps(payload).encode("utf-8"))])
    assert len(repository.list_revisions(scene.id)) == before
