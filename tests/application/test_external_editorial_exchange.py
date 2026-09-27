import json
import zipfile
from dataclasses import replace
from pathlib import Path

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
