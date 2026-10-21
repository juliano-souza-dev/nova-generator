import json
from uuid import UUID

from fastapi.testclient import TestClient

from nova_generator.api.dependencies import get_inspect_youtube_source
from nova_generator.application.ports.youtube_metadata_inspector import YoutubeSourceUnavailable
from nova_generator.application.use_cases.inspect_youtube_source import InspectYoutubeSource


def test_project_lifecycle_validates_youtube_and_hides_archived_projects(
    client: TestClient,
) -> None:
    invalid = client.post(
        "/api/projects", json={"title": "Legenda café", "youtube_url": "https://example.com/video"}
    )
    assert invalid.status_code == 422

    missing_url = client.post("/api/projects", json={"title": "Sem vídeo"})
    assert missing_url.status_code == 422

    inspection = client.post(
        "/api/projects/source-inspections",
        json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"},
    )
    assert inspection.status_code == 200
    assert inspection.json() == {
        "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "youtube_video_id": "dQw4w9WgXcQ",
        "title": "Título real — café?",
        "channel": "Canal de teste",
    }

    created = client.post(
        "/api/projects",
        json={
            "title": "Legenda café",
            "content_type": "dialogue",
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
        },
    )
    assert created.status_code == 201
    project = created.json()
    assert project["youtube_video_id"] == "dQw4w9WgXcQ"
    assert project["cache_status"] == "missing"
    assert project["job_status"] == "idle"

    inferred = client.post(
        "/api/projects", json={"youtube_url": "https://youtu.be/aaaaaaaaaaa"}
    )
    assert inferred.status_code == 201
    assert inferred.json()["title"] == "Título real — café?"
    assert inferred.json()["youtube_url"] == "https://www.youtube.com/watch?v=aaaaaaaaaaa"

    queued = client.post(
        "/api/jobs",
        json={"kind": "download_youtube", "input": {"project_id": project["id"]}},
    )
    assert queued.status_code == 202
    assert client.get(f"/api/projects/{project['id']}").json()["job_status"] == "queued"

    duplicate = client.post(f"/api/projects/{project['id']}/duplicate")
    assert duplicate.status_code == 201
    assert duplicate.json()["title"] == "Legenda café (cópia)"

    archived = client.post(f"/api/projects/{project['id']}/archive")
    assert archived.status_code == 200
    assert archived.json()["archived"] is True
    assert len(client.get("/api/projects").json()) == 2
    assert len(client.get("/api/projects?include_archived=true").json()) == 3

    restored = client.post(f"/api/projects/{project['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["archived"] is False
    assert client.delete(f"/api/projects/{project['id']}").status_code == 204


def test_project_search_and_missing_project(client: TestClient) -> None:
    client.post("/api/projects", json={"title": "First scene", "content_type": "story"})
    client.post("/api/projects", json={"title": "Second story", "content_type": "story"})
    listed = client.get("/api/projects?search=story")
    assert [project["title"] for project in listed.json()] == ["Second story"]
    assert client.get("/api/projects/00000000-0000-0000-0000-000000000000").status_code == 404


def test_source_inspection_reports_an_unavailable_video(client: TestClient) -> None:
    class UnavailableInspector:
        def inspect(self, _video):  # type: ignore[no-untyped-def]
            raise YoutubeSourceUnavailable("O vídeo é privado e não pode ser usado.")

    client.app.dependency_overrides[get_inspect_youtube_source] = lambda: InspectYoutubeSource(
        UnavailableInspector()
    )

    response = client.post(
        "/api/projects/source-inspections",
        json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "O vídeo é privado e não pode ser usado."


def test_recreate_project_from_ihub_keeps_only_video_and_cut(client: TestClient) -> None:
    from nova_generator.api.dependencies import get_session_factory
    from nova_generator.infrastructure.database.editorial_project_repository import (
        SqlAlchemyEditorialProjectRepository,
    )

    old_export = {
        "schema": "immersionhub-super-json",
        "schema_version": "1.0",
        "export": {"kind": "hub_generator_roundtrip", "source_kit_id": 73},
        "project": {
            "title": "Título antigo que não pode ser reaproveitado",
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
            "youtube_video_id": "dQw4w9WgXcQ",
            "scene_start_ms": 7360,
            "scene_end_ms": 163610,
        },
        "kit": {
            "title": "Kit obsoleto",
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "scene_start_ms": 7360,
            "scene_end_ms": 163610,
        },
        "cues": [{"order": 1, "approved_en": "OLD LINE", "pt": "tradução antiga"}],
        "wbw_practices": [{"highlight": "old expression"}],
        "shadowingPractice": {"blocks": [{"en": "old"}]},
        "ankiAudio": {"youtube": {"video_id": "old-anki"}},
    }
    response = client.post(
        "/api/projects/from-ihub",
        files={"file": ("old-kit.json", json.dumps(old_export), "application/json")},
    )
    assert response.status_code == 201, response.text
    project = response.json()
    assert project["title"] == "Título real — café?"
    assert project["youtube_video_id"] == "dQw4w9WgXcQ"
    assert project["youtube_url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert project["job_status"] == "idle"
    media = client.get(f"/api/projects/{project['id']}/media").json()
    assert media["suggested_cut_start_ms"] == 7360
    assert media["suggested_cut_end_ms"] == 163610
    assert media["cut_start_ms"] is None
    assert media["cut_end_ms"] is None
    assert media["transcript_candidate"] is None
    assert media["ingest_job_id"] is None

    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    stored = repository.get_project(UUID(project["id"]))
    assert stored is not None
    assert repository.get_project_scenes(stored.id) == []
    assert stored.provenance["initial_cut_start_ms"] == 7360
    assert stored.provenance["initial_cut_end_ms"] == 163610
    assert "source_kit_id" not in stored.provenance
    assert "cues" not in stored.provenance
    assert "wbw_practices" not in stored.provenance
    assert "shadowingPractice" not in stored.provenance


def test_import_from_ihub_rejects_invalid_cut_and_conflicting_sources(client: TestClient) -> None:
    original = {
        "schema": "immersionhub-super-json",
        "project": {
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
            "scene_start_ms": 900,
            "scene_end_ms": 700,
        },
        "kit": {
            "youtube_video_id": "dQw4w9WgXcQ",
            "scene_start_ms": 900,
            "scene_end_ms": 700,
        },
    }

    def post(payload: dict) -> object:
        return client.post(
            "/api/projects/from-ihub",
            files={"file": ("old-kit.json", json.dumps(payload), "application/json")},
        )

    assert post(original).status_code == 422
    original["project"]["scene_end_ms"] = 1200
    original["kit"]["scene_end_ms"] = 1200
    original["kit"]["youtube_video_id"] = "aaaaaaaaaaa"
    assert post(original).status_code == 422
    original["kit"]["youtube_video_id"] = "dQw4w9WgXcQ"
    original["kit"]["scene_start_ms"] = 1000
    assert post(original).status_code == 422
    original["kit"]["scene_start_ms"] = 900
    original["project"].pop("scene_start_ms")
    original["kit"].pop("scene_start_ms")
    assert post(original).status_code == 422
    assert client.post(
        "/api/projects/from-ihub",
        files={"file": ("bad.json", b"{invalid", "application/json")},
    ).status_code == 422
    assert post({"project": original["project"]}).status_code == 422
