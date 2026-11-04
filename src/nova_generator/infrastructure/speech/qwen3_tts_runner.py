"""Offline Qwen3-TTS subprocess with explicit Portuguese/English narration."""

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
_ANY_LANGUAGE_TAG = re.compile(
    r"\[/?(?:pt|en|es|fr|de|it|pl|tr|ru|nl|cs|ar|zh-cn|ja|hu|ko|hi)\]", re.IGNORECASE
)
LANGUAGES = {"pt": "Portuguese", "en": "English"}
MODELS = {
    "qwen3-tts-1.7b-voice-design": "Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "qwen3-tts-1.7b-base": "Qwen3-TTS-12Hz-1.7B-Base",
}


def parse_narration(text: str, default_language: str = "pt") -> list[tuple[str, str]]:
    """Resolve nested PT/EN spans, preserving text order and rejecting broken markup."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("O texto da narração está vazio.")
    if not _LANGUAGE_TAG.search(text):
        if _ANY_LANGUAGE_TAG.search(text):
            raise ValueError("Use apenas trechos marcados em português [pt] ou inglês [en].")
        if default_language not in LANGUAGES:
            raise ValueError("Idioma padrão da narração inválido.")
        return [(default_language, text.strip())]
    result: list[tuple[str, str]] = []
    group: list[tuple[str, str]] = []
    stack: list[tuple[str, bool]] = []
    cursor = 0

    def add_text(chunk: str) -> None:
        if not stack:
            if chunk.strip():
                raise ValueError("Use somente trechos completos [pt]...[/pt] ou [en]...[/en].")
            return
        language = stack[-1][0]
        if group and group[-1][0] == language:
            group[-1] = (language, group[-1][1] + chunk)
        else:
            group.append((language, chunk))
        if chunk.strip():
            for index, (tag_language, _) in enumerate(stack):
                stack[index] = (tag_language, True)

    for match in _ANY_LANGUAGE_TAG.finditer(text):
        add_text(text[cursor : match.start()])
        tag = match.group()[1:-1].lower()
        closing = tag.startswith("/")
        language = tag[1:] if closing else tag
        if language not in LANGUAGES:
            raise ValueError("Use apenas trechos marcados em português [pt] ou inglês [en].")
        if closing:
            if not stack or stack[-1][0] != language:
                raise ValueError("Feche corretamente as marcações de idioma do roteiro.")
            _, has_speech = stack.pop()
            if not has_speech:
                raise ValueError("Um trecho de narração não pode estar vazio.")
            if not stack:
                result.extend((lang, spoken.strip()) for lang, spoken in group if spoken.strip())
                group = []
        else:
            stack.append((language, False))
        cursor = match.end()
    add_text(text[cursor:])
    if stack or not result:
        raise ValueError("Feche todas as marcações de idioma do roteiro.")
    if len(result) > 20:
        raise ValueError("Divida o roteiro em até 20 trechos de idioma.")
    return result


def has_language_tags(text: str) -> bool:
    """Tell non-Qwen engines to reject unsupported tagged narration."""
    return bool(_ANY_LANGUAGE_TAG.search(text))


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
    allowed_runtime = (
        {"instruct", "language"} if model_id == "qwen3-tts-1.7b-voice-design" else {"language"}
    )
    if not set(runtime_params).issubset(allowed_runtime):
        raise ValueError("Parâmetros de síntese Qwen não suportados.")
    language = runtime_params.get("language", "Portuguese")
    if language not in {"Portuguese", "English"}:
        raise ValueError("Idioma Qwen não suportado. Use Portuguese ou English.")
    segments = parse_narration(request["text"], "pt" if language == "Portuguese" else "en")
    model_root = os.environ.get("NOVA_GENERATOR_QWEN_MODEL_ROOT", "models/qwen3-tts")
    model_dir = Path(model_root).expanduser() / MODELS[model_id]
    if not (model_dir / "config.json").is_file():
        raise RuntimeError(f"Modelo Qwen3-TTS ausente: {model_dir}")
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
        torch.bfloat16
        if torch.cuda.is_available() and torch.cuda.is_bf16_supported()
        else (torch.float16 if torch.cuda.is_available() else torch.float32)
    )
    started = time.monotonic()
    print(f"voice_stage=qwen_loading device={device}", file=sys.stderr, flush=True)
    model = qwen.Qwen3TTSModel.from_pretrained(
        str(model_dir.resolve()), device_map=device, dtype=dtype, attn_implementation="sdpa"
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
    for index, (segment_language, spoken) in enumerate(segments):
        segment_status = (
            f"voice_stage=qwen_segment part={index + 1}/{len(segments)} "
            f"language={segment_language}"
        )
        print(
            segment_status,
            file=sys.stderr,
            flush=True,
        )
        if model_id == "qwen3-tts-1.7b-voice-design":
            wavs, sr = model.generate_voice_design(
                text=spoken, language=LANGUAGES[segment_language], instruct=instruct, do_sample=True
            )
        else:
            wavs, sr = model.generate_voice_clone(
                text=spoken,
                language=LANGUAGES[segment_language],
                ref_audio=str(ref_path),
                ref_text=transcript,
            )
        if sample_rate is not None and sr != sample_rate:
            raise RuntimeError("Os trechos de voz foram gerados com frequências diferentes.")
        sample_rate = sr
        waves.append(wavs[0])
    if sample_rate is None:
        raise RuntimeError("A voz não produziu nenhuma amostra de áudio.")
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
