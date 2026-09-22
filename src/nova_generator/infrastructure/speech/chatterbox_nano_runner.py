"""Isolated Chatterbox Nano entrypoint, intentionally outside the FastAPI process."""

from __future__ import annotations

import json
import re
import sys
from hashlib import file_digest
from importlib import import_module
from pathlib import Path


def main() -> None:
    request = json.load(sys.stdin)
    try:
        torch = import_module("torch")
        torchaudio = import_module("torchaudio")
        chatterbox = import_module("chatterbox.tts_turbo")
    except ImportError as exc:
        raise RuntimeError(
            "Instale chatterbox-tts, torch e torchaudio no Python configurado para TTS."
        ) from exc
    profile = request["profile"]
    if profile["model_id"] != "chatterbox-nano":
        raise ValueError("Modelo de voz não suportado pelo runner local.")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = chatterbox.ChatterboxTurboTTS.from_pretrained(device=device, nano=True)
    options = dict(request.get("parameters") or {})
    if any(key.lower().endswith(("_path", "_file")) for key in options):
        raise ValueError("Caminhos de arquivo não são aceitos como parâmetros de síntese.")
    digest = request.get("reference_audio_sha256")
    if digest:
        options["audio_prompt_path"] = str(_resolve_reference(digest, request["reference_root"]))
    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    waveform = model.generate(request["text"], **options)
    torchaudio.save(str(output), waveform, model.sr)


def _resolve_reference(digest: str, raw_root: str) -> Path:
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Hash do áudio de referência inválido.")
    root = Path(raw_root).resolve()
    path = (root / f"{digest}.wav").resolve(strict=True)
    if path.parent != root or not path.is_file():
        raise ValueError("Áudio de referência fora da biblioteca local.")
    with path.open("rb") as file:
        if file_digest(file, "sha256").hexdigest() != digest:
            raise ValueError("Hash do áudio de referência diverge.")
    return path


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
