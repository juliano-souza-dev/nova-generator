from fastapi.testclient import TestClient


def test_project_lifecycle_validates_youtube_and_hides_archived_projects(
    client: TestClient,
) -> None:
    invalid = client.post(
        "/api/projects", json={"title": "Legenda café", "youtube_url": "https://example.com/video"}
    )
    assert invalid.status_code == 422

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
    assert len(client.get("/api/projects").json()) == 1
    assert len(client.get("/api/projects?include_archived=true").json()) == 2

    restored = client.post(f"/api/projects/{project['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["archived"] is False
    assert client.delete(f"/api/projects/{project['id']}").status_code == 204


def test_project_search_and_missing_project(client: TestClient) -> None:
    client.post("/api/projects", json={"title": "First scene"})
    client.post("/api/projects", json={"title": "Second story", "content_type": "story"})
    listed = client.get("/api/projects?search=story")
    assert [project["title"] for project in listed.json()] == ["Second story"]
    assert client.get("/api/projects/00000000-0000-0000-0000-000000000000").status_code == 404
