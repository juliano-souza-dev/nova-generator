from fastapi.testclient import TestClient


def test_job_can_be_enqueued_idempotently_and_cancelled(client: TestClient) -> None:
    payload = {"kind": "example", "input": {"value": 1}, "idempotency_key": "example-1"}
    created = client.post("/api/jobs", json=payload)
    duplicate = client.post("/api/jobs", json=payload)
    assert created.status_code == 202
    assert duplicate.json()["id"] == created.json()["id"]
    cancelled = client.post(f"/api/jobs/{created.json()['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"


def test_job_monitor_lists_snapshots_events_and_retries_cancelled_job(client: TestClient) -> None:
    created = client.post("/api/jobs", json={"kind": "render", "input": {"project_id": "p1"}})
    job_id = created.json()["id"]
    page = client.get("/api/jobs?limit=10")
    assert page.status_code == 200
    assert page.json()["total"] == 1
    snapshot = page.json()["items"][0]
    assert snapshot["kind"] == "render"
    assert snapshot["can_cancel"] is True
    detail = client.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200
    assert detail.json()["events"][0]["type"] == "queued"
    assert client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "cancelled"
    retried = client.post(f"/api/jobs/{job_id}/retry")
    assert retried.status_code == 200
    assert retried.json()["status"] == "queued"


def test_job_retry_is_rejected_while_job_is_active(client: TestClient) -> None:
    created = client.post("/api/jobs", json={"kind": "render", "input": {}})
    assert client.post(f"/api/jobs/{created.json()['id']}/retry").status_code == 409
