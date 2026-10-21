"""The initial external AI ZIP must prepare Anki in the same round trip."""

from __future__ import annotations

import json
import zipfile
from io import BytesIO
from pathlib import Path

import jsonschema
import pytest

from nova_generator.application.use_cases.editorial_assistance import EditorialAssistanceError
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


def _setup(tmp_path):
    engine = create_database_engine(f"sqlite:///{tmp_path / 'anki.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="anki-initial-contract",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    exchange = ExternalEditorialExchange(repository, tmp_path)
    exchange._CUES_PER_CHUNK = 100
    return exchange, scene, project_id


def _completed_package(exchange, scene, *, include_anki=True, invalid_anki=False):
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        manifest = archive.read("manifest.json")
        source = json.loads(archive.read("anki/anki-ai-input.json"))
        anki_template = json.loads(archive.read("anki/anki-ai-result-template.json"))
        chunk_names = [
            name for name in archive.namelist()
            if name.startswith("chunks/") and name.endswith("-result.json")
        ]
        chunks = []
        for name in chunk_names:
            result = json.loads(archive.read(name))
            for item in result["suggestions"]:
                item["approved_pt"] = "Tradução natural."
                for word in item["word_translations"]:
                    word["pt"] = "tradução"
            chunks.append((name, result))
    selected = chunks[0][1]["suggestions"][0]
    anki_template["anki_cards"] = [
        {
            "cue_id": selected["cue_id"],
            "front_en": selected["approved_en"],
            "back_pt": selected["approved_pt"],
            "card_type": "EXPRESSION",
            "focus_text": "I cannot",
            "meaning": "Não posso",
            "marked_en": selected["approved_en"].strip(),
            "marked_pt": selected["approved_pt"],
            "explanation_pt": "Expressão de impossibilidade no contexto da conversa.",
            "example_en": "I cannot attend the meeting.",
            "example_pt": "Não posso participar da reunião.",
            "tags": ["conversation"],
        }
    ]
    assert source["contract"] == "nova-generator-anki-input/1.0"
    contracts = Path(__file__).parents[2] / "contracts" / "anki-ai" / "v1"
    jsonschema.validate(source, json.loads((contracts / "input.schema.json").read_text()))
    jsonschema.validate(anki_template, json.loads((contracts / "output.schema.json").read_text()))
    if invalid_anki:
        anki_template["anki_cards"][0].pop("explanation_pt")
    target = BytesIO()
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("manifest.json", manifest)
        for name, result in chunks:
            archive.writestr(name, json.dumps(result, ensure_ascii=False))
        if include_anki:
            archive.writestr("anki/anki-ai-result.json", json.dumps(anki_template, ensure_ascii=False))
    return target.getvalue()


def test_export_includes_explicit_anki_contract(tmp_path):
    exchange, scene, _project = _setup(tmp_path)
    with zipfile.ZipFile(exchange.build_package(scene.id)) as archive:
        assert {"anki/anki-ai-input.json", "anki/anki-ai-result-template.json",
                "anki/anki-ai-prompt.md"} <= set(archive.namelist())
        assert json.loads(archive.read("manifest.json"))["anki"]["required"] is True
        assert "explanation_pt" in archive.read("INSTRUCOES.md").decode("utf-8")


def test_combined_import_persists_valid_anki_draft(tmp_path):
    exchange, scene, project_id = _setup(tmp_path)
    completed = _completed_package(exchange, scene)
    exchange.import_batch(scene.id, [("completed.zip", completed)])
    draft = tmp_path / str(project_id) / "materials" / "anki-prepared.json"
    result = json.loads(draft.read_text(encoding="utf-8"))
    assert result["contract"] == "nova-generator-anki-proposal/1.0"
    assert len(result["anki_cards"]) == 1
    assert result["anki_cards"][0]["explanation_pt"]


def test_completed_zip_without_anki_is_rejected(tmp_path):
    exchange, scene, project_id = _setup(tmp_path)
    completed = _completed_package(exchange, scene, include_anki=False)
    with pytest.raises(EditorialAssistanceError, match="Anki result is required"):
        exchange.import_batch(scene.id, [("completed.zip", completed)])
    assert not (tmp_path / str(project_id) / "materials" / "anki-prepared.json").exists()


def test_invalid_anki_rejected_before_editorial_changes(tmp_path):
    exchange, scene, project_id = _setup(tmp_path)
    original = exchange._repository.get_scene_cues(scene.id)
    completed = _completed_package(exchange, scene, invalid_anki=True)
    with pytest.raises(EditorialAssistanceError, match="Anki result violates"):
        exchange.import_batch(scene.id, [("completed.zip", completed)])
    assert exchange._repository.get_scene_cues(scene.id) == original
    assert not (tmp_path / str(project_id) / "materials" / "anki-prepared.json").exists()
