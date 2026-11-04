"""Prepare and verify every Qwen3-TTS runtime/model before starting local services.

This is an explicit startup gate. It reuses the same isolated environment and
model directories as the background installer, and never starts API/worker/UI
when either supported Qwen model is incomplete.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from nova_generator.core.settings import get_settings
from nova_generator.infrastructure.speech.qwen3_installer import (
    _python_has_qwen,
    qwen_python,
)
from nova_generator.infrastructure.speech.qwen3_tts_models import QWEN_MODELS


DOWNLOAD_SCRIPT = r"""
import os
import sys
import time
from pathlib import Path

# Xet's native transfer backend can fail on Windows with
# "Internal Writer Error: Background writer channel closed". Set this before
# importing huggingface_hub so it selects the regular HTTP download backend.
os.environ["HF_HUB_DISABLE_XET"] = "1"

from huggingface_hub import snapshot_download

repo_id, target = sys.argv[1:3]
target_path = Path(target)
checkpoint = target_path / "model.safetensors"
last_error = None

if not checkpoint.is_file():
    for attempt in range(1, 5):
        try:
            print(
                f"Download HTTP do modelo {repo_id} (tentativa {attempt}/4). "
                "Arquivos já concluídos serão reaproveitados.",
                flush=True,
            )
            snapshot_download(
                repo_id=repo_id,
                local_dir=str(target_path),
                max_workers=1,
                force_download=False,
            )
            last_error = None
            break
        except Exception as exc:
            last_error = exc
            if attempt == 4:
                break
            delay = attempt * 8
            print(
                f"Download interrompido: {exc}. Nova tentativa em {delay}s...",
                flush=True,
            )
            time.sleep(delay)

if last_error is not None:
    raise RuntimeError(
        f"Não foi possível concluir o download de {repo_id} após 4 tentativas."
    ) from last_error
if not checkpoint.is_file():
    raise RuntimeError(f"Checkpoint Qwen ausente após o download: {checkpoint}")
"""


def run(argv: list[str], *, label: str) -> None:
    print(f"\n[Preparação] {label}", flush=True)
    completed = subprocess.run(argv, check=False)
    if completed.returncode:
        raise RuntimeError(f"{label} falhou (código {completed.returncode}).")


def ensure_runtime(settings) -> str:
    executable = qwen_python(settings)
    if settings.qwen_tts_python:
        if not Path(executable).is_file():
            raise RuntimeError(
                "O Python personalizado para Qwen3-TTS não foi encontrado. "
                "Corrija NOVA_GENERATOR_QWEN_TTS_PYTHON ou remova a configuração "
                "para permitir a instalação automática."
            )
        if not _python_has_qwen(executable):
            raise RuntimeError(
                "O Python personalizado para Qwen3-TTS não possui qwen-tts, torch, "
                "soundfile e huggingface_hub. Instale os pacotes nesse ambiente ou "
                "remova NOVA_GENERATOR_QWEN_TTS_PYTHON."
            )
        return executable

    venv_root = settings.qwen_venv_root.expanduser()
    if not Path(executable).is_file():
        print("Criando ambiente Python isolado para Qwen3-TTS...", flush=True)
        import venv

        venv_root.parent.mkdir(parents=True, exist_ok=True)
        venv.EnvBuilder(with_pip=True).create(str(venv_root))

    if not _python_has_qwen(executable):
        run(
            [
                executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "qwen-tts",
                "soundfile",
                "huggingface_hub",
            ],
            label="Instalação das dependências Qwen3-TTS",
        )
    if not _python_has_qwen(executable):
        raise RuntimeError(
            "O ambiente Qwen3-TTS foi instalado, mas não passou na validação "
            "de qwen_tts, torch, soundfile e huggingface_hub."
        )
    return executable


def ensure_model(executable: str, model_id: str, directory_name: str, root: Path) -> None:
    # Disable Xet in the child process as well as in the embedded script.
    # The environment setting must exist before huggingface_hub is imported.
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    target = root / directory_name
    checkpoint = target / "model.safetensors"
    config = target / "config.json"
    tokenizer = target / "speech_tokenizer"
    if checkpoint.is_file() and config.is_file() and tokenizer.is_dir():
        print(f"[Preparação] {directory_name}: pesos e tokenizer já verificados.", flush=True)
        return

    target.mkdir(parents=True, exist_ok=True)
    run(
        [
            executable,
            "-c",
            DOWNLOAD_SCRIPT,
            f"Qwen/{directory_name}",
            str(target),
        ],
        label=f"Download do modelo {directory_name}",
    )
    missing = [
        str(path)
        for path, valid in (
            (checkpoint, checkpoint.is_file()),
            (config, config.is_file()),
            (tokenizer, tokenizer.is_dir()),
        )
        if not valid
    ]
    if missing:
        raise RuntimeError(
            f"Instalação incompleta de {directory_name}. Recursos ausentes: "
            + ", ".join(missing)
        )


def main() -> int:
    settings = get_settings()
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    print(
        "O Nova Generator só será iniciado depois que todos os recursos Qwen "
        "estiverem instalados e validados.",
        flush=True,
    )
    executable = ensure_runtime(settings)
    root = settings.qwen_model_root.expanduser()
    for model_id, directory_name in QWEN_MODELS.items():
        ensure_model(executable, model_id, directory_name, root)
    print("\n[Preparação] Qwen3-TTS: ambiente e os dois modelos prontos.", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"\nERRO NA PREPARAÇÃO DO QWEN3-TTS: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc
