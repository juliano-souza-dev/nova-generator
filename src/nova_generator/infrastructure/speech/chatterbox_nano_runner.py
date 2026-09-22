"""Isolated Chatterbox Nano entrypoint, intentionally outside the FastAPI process."""

from __future__ import annotations

import json
import sys
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
    reference = (profile.get("parameters") or {}).get("reference_audio_path")
    if reference:
        path = Path(reference)
        if not path.is_file():
            raise FileNotFoundError(f"Áudio de referência ausente: {path}")
        options["audio_prompt_path"] = str(path)
    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    waveform = model.generate(request["text"], **options)
    torchaudio.save(str(output), waveform, model.sr)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
