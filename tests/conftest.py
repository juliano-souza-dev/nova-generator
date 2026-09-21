import pytest
from fastapi.testclient import TestClient

from nova_generator.api.dependencies import get_session_factory
from nova_generator.core.settings import get_settings
from nova_generator.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("NOVA_GENERATOR_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    get_settings.cache_clear()
    get_session_factory.cache_clear()
    try:
        yield TestClient(create_app())
    finally:
        get_session_factory.cache_clear()
        get_settings.cache_clear()
