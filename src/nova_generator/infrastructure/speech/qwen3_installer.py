"""Automatic, resumable local installation of Qwen3-TTS on the worker host."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import venv
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import Any

from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.core.settings import Settings
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.speech.qwen3_tts_models import (
    QWEN_MODELS,
    VOICE_DESIGN,
    qwen_model_sha256,
)
from nova_generator.infrastructure.worker.persistent_worker import JobCancelled, JobExecution

SETUP_KIND = "qwen.setup"
TOKENIZER = "Qwen/Qwen3-TTS-Tokenizer-12Hz"
# The repository IDs are fixed; user input can never choose arbitrary packages or commands.
DOWNLOAD_SCRIPT = """
import sys
from huggingface_hub import snapshot_download
repo_id, target = sys.argv[1:3]
kwargs = {"repo_id": repo_id, "max_workers": 2}
if target != "-":
    kwargs["local_dir"] = target
try:
    snapshot_download(local_files_only=True, **kwargs)
except Exception:
    snapshot_download(local_files_only=False, **kwargs)
"""

STAGES = {
    "queued": "Aguardando preparação da voz",
    "environment": "Preparando o ambiente local",
    "dependencies": "Instalando os recursos de voz",
    "model": "Baixando a voz para o computador",
    "tokenizer": "Finalizando os recursos de áudio",
    "verification": "Verificando a instalação",
    "ready": "Voz pronta para uso",
    "failed": "Não foi possível preparar a voz",
    "cancelled": "Preparação interrompida",
}


def qwen_python(settings: Settings) -> str:
    if settings.qwen_tts_python:
        return settings.qwen_tts_python
    path = settings.qwen_venv_root.expanduser()
    return str(path / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))


def _status_path(settings: Settings, model_id: str) -> Path:
    if model_id not in QWEN_MODELS:
        raise ValueError("Modelo Qwen desconhecido.")
    return settings.qwen_model_root.expanduser() / "_setup" / f"{model_id}.json"


def setup_status(settings: Settings, model_id: str) -> dict[str, Any]:
    path = _status_path(settings, model_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(data, dict) or data.get("model_id") != model_id:
        return {}
    return data


def _write_status(settings: Settings, model_id: str, **fields: Any) -> None:
    path = _status_path(settings, model_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    prior = setup_status(settings, model_id)
    data = {
        **prior, "model_id": model_id, **fields,
        "updated_at": datetime.now(UTC).isoformat(),
    }
    # Fixed path: no user-supplied filenames or traversal.
    staging = path.with_suffix(f".{os.getpid()}.tmp")
    staging.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(staging, path)


def _python_has_qwen(executable: str) -> bool:
    try:
        checked = subprocess.run(
            [
                executable, "-c",
                "import importlib.util as u; "
                "assert all(u.find_spec(x) for x in ('qwen_tts','torch','soundfile','huggingface_hub'))",
            ],
            capture_output=True, timeout=20, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return checked.returncode == 0


def qwen_ready(settings: Settings, model_id: str) -> bool:
    try:
        qwen_model_sha256(settings, model_id)
    except ValueError:
        return False
    # A saved successful setup avoids expensive import checks on every UI poll.
    saved = setup_status(settings, model_id)
    if saved.get("stage") == "ready" and Path(qwen_python(settings)).is_file():
        return True
    return _python_has_qwen(qwen_python(settings))


def ensure_setup_queued(
    settings: Settings, repository: JobRepository, model_id: str = VOICE_DESIGN
) -> Job | None:
    """Queue installation when missing, reusing an active job across process starts."""
    if model_id not in QWEN_MODELS:
        raise ValueError("Modelo de voz não suportado.")
    if qwen_ready(settings, model_id):
        return None

    existing_id = setup_status(settings, model_id).get("job_id")
    previous = repository.get(existing_id) if isinstance(existing_id, str) else None
    if previous and previous.status in {"queued", "running", "retryable"}:
        return previous
    if previous and previous.status in {"failed", "cancelled"}:
        refreshed = repository.retry(job_id=str(previous.id), now=datetime.now(UTC))
        if refreshed:
            _write_status(settings, model_id, stage="queued", job_id=str(refreshed.id))
            return refreshed

    # A missing/corrupt install after a previously succeeded job gets a fresh attempt.
    job = repository.enqueue(
        kind=SETUP_KIND,
        input={"model_id": model_id},
        idempotency_key=f"qwen.setup:{model_id}:{time.time_ns()}",
        max_attempts=2,
    )
    _write_status(settings, model_id, stage="queued", job_id=str(job.id))
    return job


def _step(
    argv: list[str],
    execution: JobExecution,
    log: Path,
    timeout_seconds: int,
    stop_event: Event | None = None,
) -> None:
    started = time.monotonic()
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab") as output:
        with subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            shell=False,
        ) as process:
            try:
                while process.poll() is None:
                    execution.heartbeat()
                    execution.raise_if_cancelled()
                    if stop_event is not None and stop_event.is_set():
                        raise JobCancelled()
                    if time.monotonic() - started > timeout_seconds:
                        raise TimeoutError("A preparação excedeu o tempo limite.")
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        continue
            except BaseException:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise
            if process.returncode != 0:
                raise RuntimeError(
                    "Uma etapa da instalação falhou. Consulte o monitor de jobs "
                    "e o registro local da preparação."
                )


def make_setup_handler(settings: Settings, stop_event: Event | None = None):
    def handle(job: Job, execution: JobExecution) -> dict[str, Any]:
        model_id = job.input.get("model_id")
        if not isinstance(model_id, str) or model_id not in QWEN_MODELS:
            raise ValueError("Modelo Qwen inválido para instalação.")
        install_root = settings.qwen_model_root.expanduser()
        log = install_root / "_setup" / f"{model_id}.log"
        python = qwen_python(settings)
        try:
            if qwen_ready(settings, model_id):
                _write_status(settings, model_id, stage="ready", job_id=str(job.id))
                return {"model_id": model_id, "ready": True}
            _write_status(settings, model_id, stage="environment", job_id=str(job.id))
            if not settings.qwen_tts_python and not Path(python).is_file():
                settings.qwen_venv_root.expanduser().parent.mkdir(parents=True, exist_ok=True)
                venv.EnvBuilder(with_pip=True).create(str(settings.qwen_venv_root))
            if settings.qwen_tts_python and not Path(python).is_file():
                raise ValueError("O Python personalizado para vozes não foi encontrado.")
            if not _python_has_qwen(python):
                if settings.qwen_tts_python:
                    raise ValueError(
                        "O Python personalizado não possui Qwen. "
                        "Remova a configuração personalizada para instalação automática."
                    )
                _write_status(settings, model_id, stage="dependencies")
                _step(
                    [
                        python, "-m", "pip", "install", "--disable-pip-version-check",
                        "--no-input", "qwen-tts", "soundfile", "huggingface_hub",
                    ],
                    execution, log, 3600, stop_event,
                )
            if not _python_has_qwen(python):
                raise RuntimeError("O ambiente Qwen instalado não pôde ser validado.")

            if not _weights_present(settings, model_id):
                _write_status(settings, model_id, stage="model")
                _step(
                    [
                        python, "-c", DOWNLOAD_SCRIPT,
                        f"Qwen/{QWEN_MODELS[model_id]}",
                        str(install_root / QWEN_MODELS[model_id]),
                    ],
                    execution, log, 10800, stop_event,
                )
            _write_status(settings, model_id, stage="tokenizer")
            _step(
                [python, "-c", DOWNLOAD_SCRIPT, TOKENIZER, "-"],
                execution, log, 3600, stop_event,
            )
            _write_status(settings, model_id, stage="verification")
            digest = qwen_model_sha256(settings, model_id)
            if not _python_has_qwen(python):
                raise RuntimeError("Os recursos de voz não foram instalados corretamente.")
            _write_status(settings, model_id, stage="ready", model_sha256=digest)
            return {"model_id": model_id, "ready": True, "model_sha256": digest}
        except JobCancelled:
            _write_status(settings, model_id, stage="cancelled")
            raise
        except Exception:
            _write_status(settings, model_id, stage="failed")
            raise

    return handle


def _weights_present(settings: Settings, model_id: str) -> bool:
    try:
        qwen_model_sha256(settings, model_id)
    except ValueError:
        return False
    return True
