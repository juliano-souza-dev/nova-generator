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
