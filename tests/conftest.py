import pytest
from fastapi.testclient import TestClient

from nova_generator.api.dependencies import get_inspect_youtube_source, get_session_factory
from nova_generator.application.use_cases.inspect_youtube_source import InspectYoutubeSource
from nova_generator.core.settings import get_settings
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.infrastructure.database.base import Base
from nova_generator.infrastructure.database.session import create_database_engine
from nova_generator.main import create_app


class _YoutubeMetadata:
    def __init__(self, video: YoutubeVideo) -> None:
        self.video = video
        self.title = "Título real — café?"
        self.channel = "Canal de teste"


class _YoutubeInspector:
    def inspect(self, video: YoutubeVideo) -> _YoutubeMetadata:
        return _YoutubeMetadata(video)


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("NOVA_GENERATOR_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    get_settings.cache_clear()
    get_session_factory.cache_clear()
    Base.metadata.create_all(create_database_engine(f"sqlite:///{tmp_path / 'test.db'}"))
    try:
        app = create_app()
        source_inspection = InspectYoutubeSource(_YoutubeInspector())
        app.dependency_overrides[get_inspect_youtube_source] = lambda: source_inspection
        yield TestClient(app)
    finally:
        get_session_factory.cache_clear()
        get_settings.cache_clear()
