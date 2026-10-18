"""HTTP contract for AI Shadowing proposal and manual cue group approval."""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from nova_generator.api.dependencies import get_session_factory
from nova_generator.core.settings import get_settings
from nova_generator.domain.projects.entities import Cue, Project, Scene
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)


def _seed() -> tuple[str, str, list[str]]:
    project_id, scene_id = uuid4(), uuid4()
    repo = SqlAlchemyEditorialProjectRepository(get_session_factory())
    repo.save_project(Project(project_id, "Suits lesson", "dialogue"))
    repo.save_scene(Scene(scene_id, project_id, 1, 10_000))
    ids = [uuid4() for _ in range(3)]
    for i, (speaker, en, pt, start, end) in enumerate(
        [
            ("Mike", "Hello.", "Olá.", 1000, 1700),
            ("Donna", "What?", "O quê?", 1900, 2350),
            ("Mike", "Yes.", "Sim.", 2600, 3100),
        ]
    ):
        repo.save_cue(
            Cue(
                ids[i], scene_id, i + 1, start, end, start, end,
                speaker, en, en, pt, 1, {"approval": "approved"},
            ),
            [],
        )
    return str(project_id), str(scene_id), [str(cue_id) for cue_id in ids]


def test_api_external_ai_edit_and_hash_bound_approval(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_PROJECT_ROOT", str(tmp_path / "projects"))
    get_settings.cache_clear()
    project_id, scene_id, cue_ids = _seed()
    base = f"/api/projects/{project_id}/shadowing"
    initial = client.get(base)
    assert initial.status_code == 200
    assert len(initial.json()) == 1
    plan = initial.json()[0]
    assert plan["contract"] == "nova-generator-shadowing/2.0"
    assert [block["speaker"] for block in plan["blocks"]] == ["Mike", "Donna", "Mike"]
    assert [block["cue_ids"] for block in plan["blocks"]] == [[cue_id] for cue_id in cue_ids]

    package = client.get(f"{base}/{scene_id}/package")
    assert package.status_code == 200
    assert package.json()["cues"][1]["speaker"] == "Donna"
    assert package.json()["source_sha256"] == plan["source_sha256"]

    invalid = client.put(
        f"{base}/{scene_id}/blocks",
        json={
            "source_sha256": plan["source_sha256"],
            "plan_sha256": plan["plan_sha256"],
            "groups": [[cue_ids[0], cue_ids[1]]],
        },
    )
    assert invalid.status_code == 409
    assert "misturar personagens" in invalid.json()["detail"]
    valid = client.put(
        f"{base}/{scene_id}/blocks",
        json={
            "source_sha256": plan["source_sha256"],
            "plan_sha256": plan["plan_sha256"],
            "groups": [[cue_ids[0]], [cue_ids[2]]],
        },
    )
    assert valid.status_code == 200
    edited = valid.json()
    assert edited["status"] == "draft"
    assert edited["origin"] == "manual"
    assert edited["plan_sha256"] != plan["plan_sha256"]
    assert [cue["id"] for cue in edited["excluded_cues"]] == [cue_ids[1]]

    stale = client.post(
        f"{base}/{scene_id}/approval",
        json={
            "source_sha256": edited["source_sha256"],
            "plan_sha256": plan["plan_sha256"],
        },
    )
    assert stale.status_code == 409
    approved = client.post(
        f"{base}/{scene_id}/approval",
        json={
            "source_sha256": edited["source_sha256"],
            "plan_sha256": edited["plan_sha256"],
        },
    )
    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    assert client.get(f"{base}/{scene_id}").json()["status"] == "approved"

    imported_document = {
        "contract": "nova-generator-shadowing-proposal/1.0",
        "scene_id": scene_id,
        "source_sha256": plan["source_sha256"],
        "groups": [{"cue_ids": [cue_ids[1]]}],
    }
    imported = client.post(
        f"{base}/{scene_id}/import",
        files={"file": ("proposal.json", json.dumps(imported_document), "application/json")},
    )
    assert imported.status_code == 200
    assert imported.json()["origin"] == "external"
    assert imported.json()["status"] == "draft"
    assert imported.json()["blocks"][0]["en"] == "What?"
    assert client.get(f"{base}/{scene_id}").json()["status"] == "draft"

    repo = SqlAlchemyEditorialProjectRepository(get_session_factory())
    assert [cue.approved_en for cue in repo.get_scene_cues(UUID(scene_id))] == [
        "Hello.", "What?", "Yes."
    ]


def test_api_rejects_stale_ai_response_and_unconfigured_groq(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_PROJECT_ROOT", str(tmp_path / "projects"))
    monkeypatch.delenv("NOVA_GENERATOR_GROQ_API_KEY", raising=False)
    get_settings.cache_clear()
    project_id, scene_id, cue_ids = _seed()
    base = f"/api/projects/{project_id}/shadowing/{scene_id}"
    stale = client.post(
        f"{base}/import",
        files={
            "file": (
                "stale.json",
                json.dumps(
                    {
                        "contract": "nova-generator-shadowing-proposal/1.0",
                        "scene_id": scene_id,
                        "source_sha256": "a" * 64,
                        "groups": [{"cue_ids": [cue_ids[0]]}],
                    }
                ),
                "application/json",
            )
        },
    )
    assert stale.status_code == 409
    assert "Editorial mudou" in stale.json()["detail"]

    unavailable = client.post(f"{base}/generate")
    assert unavailable.status_code == 409
    assert "Groq não configurada" in unavailable.json()["detail"]
    invalid_json = client.post(
        f"{base}/import", files={"file": ("broken.json", "{not-json}", "application/json")}
    )
    assert invalid_json.status_code == 422
