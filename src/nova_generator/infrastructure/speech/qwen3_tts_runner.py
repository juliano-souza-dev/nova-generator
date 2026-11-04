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

_LANGUAGE_TAG = re.compile(r"\[/?(?:pt|en)\]", re.IGNORECASE)
_SEGMENT = re.compile(r"\[(pt|en)\](.*?)\[/\1\]", re.IGNORECASE | re.DOTALL)
_ANY_LANGUAGE_TAG = re.compile(r"\[/?[a-z]{2}(?:-[a-z]{2})?\]", re.IGNORECASE)
LANGUAGES = {"pt": "Portuguese", "en": "English"}


def parse_narration(text: str) -> list[tuple[str, str]]:
    """Preserve literal PT/EN spans and reject partially marked scripts."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("O texto da narração está vazio.")
    if not _LANGUAGE_TAG.search(text):
        if _ANY_LANGUAGE_TAG.search(text):
            raise ValueError("Use apenas trechos marcados em português [pt] ou inglês [en].")
        return [("pt", text.strip())]  # Preserve old unmarked Qwen behavior.
    result: list[tuple[str, str]] = []
    cursor = 0
    for match in _SEGMENT.finditer(text):
        if text[cursor : match.start()].strip():
            raise ValueError("Use somente trechos completos [pt]...[/pt] ou [en]...[/en].")
        spoken = match.group(2).strip()
        if not spoken:
            raise ValueError("Um trecho de narração não pode estar vazio.")
        if _ANY_LANGUAGE_TAG.search(spoken):
            raise ValueError("Não coloque marcações de idioma dentro de outro trecho.")
        result.append((match.group(1).lower(), spoken))
        cursor = match.end()
    if not result or text[cursor:].strip():
        raise ValueError("Feche todas as marcações de idioma do roteiro.")
    if len(result) > 20:
        raise ValueError("Divida o roteiro em até 20 trechos de idioma.")
    return result


def has_language_tags(text: str) -> bool:
    return bool(_LANGUAGE_TAG.search(text))


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

    segments = parse_narration(request["text"])
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
    digest = request.get("reference_audio_sha256")
    if model_id == "qwen3-tts-1.7b-voice-design":
        if digest:
            raise ValueError("VoiceDesign não aceita áudio de referência.")
        instruct = runtime_params.get("instruct", params.get("instruct"))
        if not isinstance(instruct, str) or not 10 <= len(instruct.strip()) <= 800:
            raise ValueError("Descrição de voz inválida.")
    else:
        transcript = params.get("reference_text")
        if not isinstance(transcript, str) or not transcript.strip():
            raise ValueError("A transcrição do áudio de referência é obrigatória.")
        if not isinstance(digest, str):
            raise ValueError("Áudio de referência ausente.")
        ref_path = _reference(digest, request.get("reference_root"))

    waves = []
    sample_rate = None
    for index, (language, spoken) in enumerate(segments):
        print(
            f"voice_stage=qwen_segment part={index + 1}/{len(segments)} language={language}",
            file=sys.stderr, flush=True,
        )
        if model_id == "qwen3-tts-1.7b-voice-design":
            wavs, sr = model.generate_voice_design(
                text=spoken, language=LANGUAGES[language], instruct=instruct
            )
        else:
            wavs, sr = model.generate_voice_clone(
                text=spoken, language=LANGUAGES[language],
                ref_audio=str(ref_path), ref_text=transcript,
            )
        if sample_rate is not None and sr != sample_rate:
            raise RuntimeError("Os trechos de voz foram gerados com frequências diferentes.")
        sample_rate = sr
        waves.append(wavs[0])

    if len(waves) == 1:
        combined = waves[0]
    else:
        numpy = import_module("numpy")
        gap = numpy.zeros(int(sample_rate * 0.3), dtype=numpy.float32)
        parts = []
        for index, wave in enumerate(waves):
            if index:
                parts.append(gap)
            parts.append(numpy.asarray(wave, dtype=numpy.float32).reshape(-1))
        combined = numpy.concatenate(parts)

    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), combined, sample_rate, format="WAV", subtype="PCM_16")
    print("voice_stage=qwen_completed", file=sys.stderr, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1) from exc
