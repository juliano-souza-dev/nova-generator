from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from nova_generator.core.settings import Settings
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.speech import qwen3_installer as installer
from nova_generator.infrastructure.speech.qwen3_tts_models import VOICE_DESIGN


class MemoryJobs:
    def __init__(self):
        self.jobs = {}

    def get(self, job_id):
        return self.jobs.get(job_id)

    def enqueue(self, *, kind, input, idempotency_key, max_attempts):
        job = Job(uuid4(), kind, "queued", input, idempotency_key, 0, max_attempts)
        self.jobs[str(job.id)] = job
        return job


def test_auto_setup_is_enqueued_once_when_worker_starts(tmp_path, monkeypatch):
    settings = Settings(
        qwen_model_root=tmp_path / "models", qwen_venv_root=tmp_path / "venv"
    )
    monkeypatch.setattr(installer, "qwen_ready", lambda *args: False)
    repository = MemoryJobs()

    first = installer.ensure_setup_queued(settings, repository)
    again = installer.ensure_setup_queued(settings, repository)
    assert first is not None
    assert again is not None and again.id == first.id
    assert len(repository.jobs) == 1
    assert first.kind == "qwen.setup"
    assert first.input == {"model_id": VOICE_DESIGN}
    assert installer.setup_status(settings, VOICE_DESIGN)["stage"] == "queued"


def test_local_install_prepares_environment_weights_and_tokenizer(tmp_path, monkeypatch):
    settings = Settings(
        qwen_model_root=tmp_path / "models", qwen_venv_root=tmp_path / "venv"
    )

    class FakeVenv:
        def __init__(self, with_pip):
            assert with_pip

        def create(self, path):
            python = Path(path) / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("mock", encoding="utf-8")

    monkeypatch.setattr(installer.venv, "EnvBuilder", FakeVenv)
    installed = {"value": False}
    monkeypatch.setattr(
        installer, "_python_has_qwen", lambda path: installed["value"]
    )
    calls = []

    def fake_step(argv, execution, log, timeout_seconds, stop_event=None):
        calls.append(argv)
        if "pip" in argv:
            installed["value"] = True
        if installer.DOWNLOAD_SCRIPT in argv and argv[-2].endswith("VoiceDesign"):
            model_dir = Path(argv[-1])
            model_dir.mkdir(parents=True)
            (model_dir / "config.json").write_text("{}", encoding="utf-8")
            (model_dir / "model.safetensors").write_bytes(b"test")

    monkeypatch.setattr(installer, "_step", fake_step)
    fake_job = Job(
        uuid4(), "qwen.setup", "running",
        {"model_id": VOICE_DESIGN}, None, 1, 2,
    )
    result = installer.make_setup_handler(settings)(
        fake_job,
        SimpleNamespace(heartbeat=lambda: None, raise_if_cancelled=lambda: None),
    )
    assert result["ready"] is True
    assert installer.setup_status(settings, VOICE_DESIGN)["stage"] == "ready"
    assert any("pip" in argv for argv in calls)
    assert any(installer.TOKENIZER in argv for argv in calls)


def test_bad_setup_model_is_rejected_without_installing(tmp_path):
    settings = Settings(qwen_model_root=tmp_path / "models")
    fake_job = Job(uuid4(), "qwen.setup", "running", {"model_id": "../../other"}, None, 1, 2)
    try:
        installer.make_setup_handler(settings)(
            fake_job,
            SimpleNamespace(heartbeat=lambda: None, raise_if_cancelled=lambda: None),
        )
    except ValueError as error:
        assert "inválido" in str(error)
    else:
        raise AssertionError("invalid model was accepted")
