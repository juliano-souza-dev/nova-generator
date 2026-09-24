import json
import zipfile
from pathlib import Path

import pytest

from nova_generator.application.use_cases.external_editorial_exchange import (
    EditorialAssistanceError,
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
    assert source["schema_version"] == "nova-generator-editorial-input/1.1"
    assert source["cues"][0]["words"][0]["surface"] == "I"
    template["suggestions"][0]["approved_pt"] = "“Não posso… ir?”"
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
    compatible = exchange.import_result(
        scene.id, json.dumps(legacy_result, ensure_ascii=False).encode("utf-8")
    )
    assert compatible.suggestions[0].semantic_units == ()
    template["input_sha256"] = "0" * 64
    with pytest.raises(EditorialAssistanceError, match="stale"):
        exchange.import_result(scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8"))


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
    template["suggestions"][0]["semantic_units"] = [
        {"word_ids": ids[:2], "pt": "Primeira"},
        {"word_ids": ids[1:], "pt": "Sobreposta"},
    ]
    with pytest.raises(EditorialAssistanceError, match="overlap"):
        exchange.import_result(scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8"))
