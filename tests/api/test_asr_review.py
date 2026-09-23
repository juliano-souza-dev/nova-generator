import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from nova_generator.api.dependencies import get_session_factory
from nova_generator.domain.projects.entities import Project
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository


def _seed_candidate() -> tuple[str, str]:
    project_id = uuid4()
    projects = SqlAlchemyEditorialProjectRepository(get_session_factory())
    projects.save_project(Project(project_id, "Autorizado", "dialogue"))
    jobs = SqlAlchemyJobRepository(get_session_factory())
    queued = jobs.enqueue(
        kind="ingest_scene_media",
        input={"project_id": str(project_id), "start_ms": 0, "end_ms": 2000},
        idempotency_key=None,
        max_attempts=1,
    )
    claimed = jobs.claim_next(worker_id="test", now=datetime.now(UTC))
    assert claimed and claimed.id == queued.id
    jobs.succeed(
        job_id=str(queued.id),
        worker_id="test",
        now=datetime.now(UTC),
        output={
            **json.loads(
                (Path(__file__).parents[1] / "fixtures/asr_candidate_job_output.json").read_text(
                    encoding="utf-8"
                )
            ),
            "project_id": str(project_id),
        },
    )
    return str(project_id), str(queued.id)


def test_candidate_becomes_draft_then_literal_approval(client: TestClient) -> None:
    project_id, job_id = _seed_candidate()
    response = client.post(
        f"/api/editorial/projects/{project_id}/candidates/{job_id}/draft",
        json={"author": "editor"},
    )
    assert response.status_code == 201
    scene = response.json()
    assert scene["duration_ms"] == 2000
    assert scene["source_video_id"] == "video123456"
    cues = client.get(f"/api/editorial/scenes/{scene['id']}/cues").json()
    assert len(cues) == 1
    cue = cues[0]
    assert cue["original_en"] == "“I can't… go?”"
    assert cue["approved_en"] == cue["approved_pt"] == ""
    assert cue["provenance"]["approval"] == "draft"
    assert [word["surface"] for word in cue["words"]] == ["“I", "can't…", "go?”"]
    rejected = client.put(
        f"/api/editorial/cues/{cue['id']}/text",
        json={"author": "editor", "approved_en": "“I can't… go?”", "approved_pt": ""},
    )
    assert rejected.status_code == 422
    approved = client.put(
        f"/api/editorial/cues/{cue['id']}/text",
        json={
            "author": "editor",
            "approved_en": "“I can't… go?”",
            "approved_pt": "“Não posso… ir?”",
        },
    )
    assert approved.status_code == 200
    assert approved.json()["approved_pt"] == "“Não posso… ir?”"
    assert approved.json()["provenance"]["approval"] == "approved"
    revisions = client.get(f"/api/editorial/scenes/{scene['id']}/revisions").json()
    assert [item["command"] for item in revisions] == ["import_asr_candidate", "edit_approved_text"]
    repeated = client.post(
        f"/api/editorial/projects/{project_id}/candidates/{job_id}/draft",
        json={"author": "editor"},
    )
    assert repeated.status_code == 201
    assert repeated.json()["id"] == scene["id"]
    assert (
        client.get(f"/api/editorial/scenes/{scene['id']}/cues").json()[0]["approved_pt"]
        == "“Não posso… ir?”"
    )


def test_save_draft_is_literal_incomplete_and_never_approves(client: TestClient) -> None:
    project_id, job_id = _seed_candidate()
    scene = client.post(
        f"/api/editorial/projects/{project_id}/candidates/{job_id}/draft",
        json={"author": "editor"},
    ).json()
    cue = client.get(f"/api/editorial/scenes/{scene['id']}/cues").json()[0]
    url = f"/api/editorial/cues/{cue['id']}/text"
    payload = {
        "author": "editor",
        "approved_en": "  “I can't… go?”  ",
        "approved_pt": "",
        "approve": False,
    }
    draft = client.put(url, json=payload)
    assert draft.status_code == 200
    assert draft.json()["approved_en"] == payload["approved_en"]
    assert draft.json()["provenance"]["approval"] == "draft"
    assert client.put(url, json={**payload, "approve": True}).status_code == 422
    payload["approved_pt"] = "“Não posso… ir?”"
    assert client.put(url, json=payload).json()["provenance"]["approval"] == "draft"
    assert (
        client.put(url, json={**payload, "approve": True}).json()["provenance"]["approval"]
        == "approved"
    )
    assert client.put(url, json=payload).json()["provenance"]["approval"] == "draft"
    revisions = client.get(f"/api/editorial/scenes/{scene['id']}/revisions").json()
    assert revisions[-1]["command"] == "edit_draft_text"


def test_candidate_job_must_belong_to_project(client: TestClient) -> None:
    _, job_id = _seed_candidate()
    unrelated = uuid4()
    SqlAlchemyEditorialProjectRepository(get_session_factory()).save_project(
        Project(unrelated, "Outro", "dialogue")
    )
    response = client.post(
        f"/api/editorial/projects/{unrelated}/candidates/{job_id}/draft",
        json={"author": "editor"},
    )
    assert response.status_code == 422
    assert client.get(f"/api/editorial/projects/{unrelated}/scenes").json() == []
