"""First external-AI export includes automatically prepared Shadowing with Anki."""

from __future__ import annotations

import json
import zipfile
from dataclasses import replace
from pathlib import Path

import jsonschema

from nova_generator.application.use_cases.external_editorial_exchange import (
    ExternalEditorialExchange,
)
from nova_generator.application.use_cases.import_legacy_editorial_project import (
    ImportLegacyEditorialProject,
)
from nova_generator.application.use_cases.prepare_shadowing import PrepareShadowing
from nova_generator.infrastructure.database.base import Base
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.session import (
    create_database_engine,
    create_session_factory,
)


def _setup(tmp_path):
    engine = create_database_engine(f"sqlite:///{tmp_path / 'shadowing.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    project_id = ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="shadowing-on-first-export",
        imported_by="test",
    )
    scene = repository.get_project_scenes(project_id)[0]
    return repository, project_id, scene


def test_initial_export_includes_auto_shadowing_anki_and_editorial(tmp_path):
    repository, project_id, scene = _setup(tmp_path)
    for cue in repository.get_scene_cues(scene.id):
        repository.save_cue(
            replace(cue, provenance={**cue.provenance, "approval": "draft"}),
            repository.get_cue_words(cue.id),
        )
    exchange = ExternalEditorialExchange(repository, tmp_path)
    package = exchange.build_package(scene.id)
    with zipfile.ZipFile(package) as archive:
        names = set(archive.namelist())
        assert {
            "editorial_input.json",
            "anki/anki-ai-input.json",
            "anki/anki-ai-prompt.md",
            "shadowing/shadowing-prepared.json",
            "shadowing/LEIA-ME.md",
        } <= names
        manifest = json.loads(archive.read("manifest.json"))
        preview = json.loads(archive.read("shadowing/shadowing-prepared.json"))
        source = json.loads(archive.read("editorial_input.json"))
        instructions = archive.read("INSTRUCOES.md").decode("utf-8")

    assert manifest["shadowing"]["generation"] == "automatic"
    assert manifest["shadowing"]["requires_external_ai_result"] is False
    assert manifest["shadowing"]["required_in_export"] is True
    assert manifest["anki"]["required"] is True
    assert manifest["shadowing"]["status"] == preview["status"]
    assert preview["contract"] == "nova-generator-shadowing-seed/1.0"
    assert preview["status"] == "provisional"
    assert preview["editorial_input_sha256"] == manifest["input_sha256"]
    assert preview["scene_id"] == str(scene.id)
    assert preview["source_cues"][0]["id"] == source["cues"][0]["id"]
    assert preview["blocks"][0]["cue_ids"] == [source["cues"][0]["id"]]
    assert preview["blocks"][0]["pause_duration_ms"] >= 2000
    assert "NÃO deve editar" in instructions
    assert "IA externa" in instructions

    schema = (
        Path(__file__).parents[2] / "contracts"
        / "shadowing-seed" / "v1" / "output.schema.json"
    )
    jsonschema.validate(preview, json.loads(schema.read_text(encoding="utf-8")))
    assert not (tmp_path / str(project_id) / "shadowing" / f"{scene.id}.json").exists()


def test_reexport_uses_canonical_shadowing_plan_if_editorial_approved(tmp_path):
    repository, project_id, scene = _setup(tmp_path)
    for cue in repository.get_scene_cues(scene.id):
        words = repository.get_cue_words(cue.id)
        repository.save_cue(
            replace(cue, provenance={**cue.provenance, "approval": "approved"}),
            words,
        )

    exchange = ExternalEditorialExchange(repository, tmp_path)
    package = exchange.build_package(scene.id)
    with zipfile.ZipFile(package) as archive:
        preview = json.loads(archive.read("shadowing/shadowing-prepared.json"))
        manifest = json.loads(archive.read("manifest.json"))

    canonical = PrepareShadowing(repository, tmp_path).scene(project_id, scene.id)
    assert preview["contract"] == "nova-generator-shadowing/2.0"
    assert preview["blocks"] == canonical["blocks"]
    assert preview["plan_sha256"] == canonical["plan_sha256"]
    assert preview["source_sha256"] == canonical["source_sha256"]
    assert manifest["shadowing"]["status"] == canonical["status"]
    assert preview["recompute_after_editorial"] is True
