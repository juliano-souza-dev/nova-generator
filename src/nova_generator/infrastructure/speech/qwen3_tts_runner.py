"""Offline Qwen3-TTS 1.7B subprocess: one WAV per frozen text and voice profile."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from hashlib import file_digest
from importlib import import_module
from pathlib import Path

MODELS = {
    "qwen3-tts-1.7b-voice-design": "Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "qwen3-tts-1.7b-base": "Qwen3-TTS-12Hz-1.7B-Base",
}


def _reference(digest: str, raw_root: str | None) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", digest or "") or not raw_root:
        raise ValueError("Referência Qwen inválida.")
    root = Path(raw_root).resolve()
    path = (root / f"{digest}.wav").resolve(strict=True)
    if path.parent != root or not path.is_file():
        raise ValueError("Referência fora da biblioteca de vozes.")
    with path.open("rb") as stream:
        if file_digest(stream, "sha256").hexdigest() != digest:
            raise ValueError("A referência foi alterada após o envio.")
    return path


def main() -> None:
    request = json.load(sys.stdin)
    profile = request["profile"]
    model_id = profile["model_id"]
    if model_id not in MODELS:
        raise ValueError("Modelo Qwen3-TTS não suportado.")

    params = profile.get("parameters") or {}
    runtime_params = request.get("parameters") or {}
    if runtime_params and (model_id != "qwen3-tts-1.7b-voice-design"
                           or set(runtime_params) != {"instruct"}):
        raise ValueError("Parâmetros de síntese Qwen não suportados.")
    model_root = os.environ.get("NOVA_GENERATOR_QWEN_MODEL_ROOT", "models/qwen3-tts")
    model_dir = Path(model_root).expanduser() / MODELS[model_id]
    if not (model_dir / "config.json").is_file():
        raise RuntimeError(f"Modelo Qwen3-TTS ausente: {model_dir}")

    # No network requests are permitted from the synthesis process.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        torch = import_module("torch")
        sf = import_module("soundfile")
        qwen = import_module("qwen_tts")
    except ImportError as exc:
        raise RuntimeError(
            "Instale qwen-tts, torch e soundfile no Python escolhido para Qwen3-TTS."
        ) from exc

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = (
        torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported()
        else (torch.float16 if torch.cuda.is_available() else torch.float32)
    )
    started = time.monotonic()
    print(f"voice_stage=qwen_loading device={device}", file=sys.stderr, flush=True)
    model = qwen.Qwen3TTSModel.from_pretrained(
        str(model_dir.resolve()),
        device_map=device,
        dtype=dtype,
        attn_implementation="sdpa",
    )
    print(
        f"voice_stage=qwen_ready elapsed_s={time.monotonic() - started:.1f}",
        file=sys.stderr,
        flush=True,
    )
    text = request["text"]
    if not isinstance(text, str) or not text.strip():
        raise ValueError("O texto da narração está vazio.")
    if model_id == "qwen3-tts-1.7b-voice-design":
        if request.get("reference_audio_sha256"):
            raise ValueError("VoiceDesign não aceita áudio de referência.")
        instruct = runtime_params.get("instruct", params.get("instruct"))
        if not isinstance(instruct, str) or not 10 <= len(instruct.strip()) <= 800:
            raise ValueError("Descrição de voz inválida.")
        wavs, sr = model.generate_voice_design(
            text=text, language="Portuguese", instruct=instruct
        )
    else:
        transcript = params.get("reference_text")
        if not isinstance(transcript, str) or not transcript.strip():
            raise ValueError("A transcrição do áudio de referência é obrigatória.")
        digest = request.get("reference_audio_sha256")
        if not isinstance(digest, str):
            raise ValueError("Áudio de referência ausente.")
        ref_path = _reference(digest, request.get("reference_root"))
        wavs, sr = model.generate_voice_clone(
            text=text, language="Portuguese", ref_audio=str(ref_path), ref_text=transcript
        )

    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), wavs[0], sr, format="WAV", subtype="PCM_16")
    print("voice_stage=qwen_completed", file=sys.stderr, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1) from exc
