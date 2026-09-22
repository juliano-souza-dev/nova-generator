import json
import logging

import pytest
from pydantic import ValidationError

from nova_generator.core.observability import JsonFormatter, OperationalMetrics
from nova_generator.core.settings import Settings


def test_settings_defaults_and_runtime_directories(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("shutil.which", lambda value: value)
    settings = Settings(_env_file=None)
    assert settings.database_url == "sqlite:///./data/nova-generator.db"
    assert settings.whisper_model == "small"
    settings.validate_runtime()
    assert (tmp_path / "media_cache").is_dir()
    assert (tmp_path / "data/projects").is_dir()


def test_invalid_database_url_and_missing_executable(tmp_path, monkeypatch) -> None:
    with pytest.raises(ValidationError, match="DATABASE_URL"):
        Settings(_env_file=None, database_url="postgresql://localhost/test")
    monkeypatch.setattr("shutil.which", lambda value: None)
    settings = Settings(_env_file=None, media_cache_root=tmp_path / "cache")
    with pytest.raises(RuntimeError, match="NOVA_GENERATOR_FFMPEG_EXECUTABLE"):
        settings.validate_runtime()


def test_json_logging_allows_ids_but_drops_private_data() -> None:
    record = logging.makeLogRecord(
        {
            "name": "nova_generator",
            "levelno": logging.INFO,
            "levelname": "INFO",
            "msg": "job_failed",
            "job_id": "job-1",
            "token": "secret",
            "text": "private lesson",
            "error": "private exception",
        }
    )
    payload = json.loads(JsonFormatter().format(record))
    assert payload["job_id"] == "job-1"
    assert "secret" not in json.dumps(payload)
    assert "private lesson" not in json.dumps(payload)


def test_metrics_count_and_duration() -> None:
    telemetry = OperationalMetrics()
    telemetry.record("job_failed", duration_ms=42)
    telemetry.record("job_failed", duration_ms=8)
    assert telemetry.snapshot() == {"counts": {"job_failed": 2}, "duration_ms": {"job_failed": 50}}
