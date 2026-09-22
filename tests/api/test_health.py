from fastapi.testclient import TestClient


def test_health_reports_api_and_database_readiness(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}
    assert response.headers["X-Request-ID"]


def test_request_id_is_reused_only_when_safe(client: TestClient) -> None:
    assert (
        client.get("/api/health", headers={"X-Request-ID": "caller_123"}).headers["X-Request-ID"]
        == "caller_123"
    )
    assert (
        client.get("/api/health", headers={"X-Request-ID": "secret /?"}).headers["X-Request-ID"]
        != "secret /?"
    )
