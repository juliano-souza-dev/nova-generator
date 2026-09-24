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
    template["suggestions"][0]["approved_pt"] = "“Não posso… ir?”"
    result = exchange.import_result(
        scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8")
    )
    assert result.provider == "external"
    assert result.suggestions[0].approved_pt == "“Não posso… ir?”"
    template["input_sha256"] = "0" * 64
    with pytest.raises(EditorialAssistanceError, match="stale"):
        exchange.import_result(scene.id, json.dumps(template, ensure_ascii=False).encode("utf-8"))
