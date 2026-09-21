import json
from hashlib import sha256
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from nova_generator.application.use_cases.import_legacy_editorial_project import (
    ImportLegacyEditorialProject,
)
from nova_generator.infrastructure.database import models  # noqa: F401
from nova_generator.infrastructure.database.base import Base
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.session import (
    create_database_engine,
    create_session_factory,
)


def test_import_legacy_preserves_literal_text_hashes_and_provenance(tmp_path) -> None:
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))
    engine = create_database_engine(f"sqlite:///{tmp_path / 'editorial.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyEditorialProjectRepository(create_session_factory(engine))
    project_id = ImportLegacyEditorialProject(repository).execute(
        document, legacy_key="legacy-demo", imported_by="migration-test"
    )

    project = repository.get_project(project_id)
    assert project is not None
    assert project.title == "Can't stop — café?"
    second_id = ImportLegacyEditorialProject(repository).execute(
        document, legacy_key="legacy-demo", imported_by="migration-test"
    )
    assert second_id == project_id

    scene_id = uuid5(NAMESPACE_URL, "nova-generator/scene/legacy-demo/1")
    cue = repository.get_scene_cues(scene_id)[0]
    assert cue.original_en == "“I can't… go?”"
    assert cue.approved_pt == "“Eu não posso… ir?”"
    assert cue.original_en_sha256 == sha256(cue.original_en.encode("utf-8")).hexdigest()
    words = repository.get_cue_words(cue.id)
    assert [word.surface for word in words] == ["I", "can't", "go"]
    assert words[1].provenance["payload"]["pt"] == "não posso"
    revisions = repository.list_revisions(scene_id)
    assert len(revisions) == 1
    assert revisions[0].command == "import_legacy_canonical"
    assert revisions[0].after_sha256
