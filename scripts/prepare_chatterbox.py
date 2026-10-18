"""Download Chatterbox Turbo weights once, outside the voice-preview job.

Run: python scripts/prepare_chatterbox.py
Optional: set HF_TOKEN in the environment for authenticated downloads.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("Instale chatterbox-tts e huggingface_hub no Python usado pelo worker.", file=sys.stderr)
        return 1

    repository = "ResembleAI/chatterbox-turbo"
    print(f"Preparando {repository}. Esta etapa pode transferir vários arquivos.", flush=True)
    try:
        location = snapshot_download(
            repo_id=repository,
            token=os.environ.get("HF_TOKEN") or None,
        )
    except Exception as exc:
        print(f"Falha ao preparar modelo: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    expected = Path(location) / "t3_turbo_v1.safetensors"
    if not expected.is_file():
        print(
            f"Download concluído, mas o checkpoint esperado não foi encontrado: {expected}",
            file=sys.stderr,
        )
        return 1
    print(f"Modelo preparado em: {location}", flush=True)
    print("Reinicie o worker e crie uma prévia de voz.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
