"""Offline Qwen3-TTS subprocess with structured, language-aware speech chunks."""

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
VOICE_DESIGN_SEED = 42
MAX_BATCH_SEGMENTS = 256


def parse_narration(text: str, default_language: str = "pt") -> list[tuple[str, str]]:
    """Read legacy language markup; new TikTok renders use structured segment objects."""
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
    if len(result) > MAX_BATCH_SEGMENTS:
        raise ValueError(f"O roteiro ultrapassa o limite de {MAX_BATCH_SEGMENTS} trechos.")
    return result


def has_language_tags(text: str) -> bool:
    """Tell non-Qwen engines to reject unsupported tagged narration."""
    return bool(_ANY_LANGUAGE_TAG.search(text))


def _validate_batch_segments(raw_segments: object) -> list[dict[str, object]]:
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("A lista de chunks Qwen está vazia ou inválida.")
    if len(raw_segments) > MAX_BATCH_SEGMENTS:
        raise ValueError(f"O lote Qwen ultrapassa {MAX_BATCH_SEGMENTS} chunks.")
    validated: list[dict[str, object]] = []
    for index, raw in enumerate(raw_segments, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"O chunk {index} precisa ser um objeto.")
        text = raw.get("text")
        language = raw.get("language")
        output = raw.get("output")
        seed = raw.get("seed")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"O texto do chunk {index} está vazio.")
        if not isinstance(language, str) or language not in LANGUAGES:
            raise ValueError(f"O idioma do chunk {index} deve ser pt ou en.")
        if not isinstance(output, str) or Path(output).suffix.lower() != ".wav":
            raise ValueError(f"O destino WAV do chunk {index} é inválido.")
        segment: dict[str, object] = {
            "text": text,
            "language": language,
            "output": output,
        }
        if seed is not None:
            if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
                raise ValueError(f"A seed do chunk {index} é inválida.")
            segment["seed"] = seed
        validated.append(segment)
    return validated


def _adapt_instruct_for_language(instruct: str, segment_language: str) -> str:
    """Keep the same designed speaker while giving English chunks natural pronunciation."""
    if segment_language != "en":
        return instruct
    adapted = re.sub(
        r"\bbrasileir[ao]s?\b",
        "bilíngue",
        instruct,
        flags=re.IGNORECASE,
    )
    suffix = (
        "Keep the same speaker identity and vocal timbre; "
        "use clear, natural American English pronunciation."
    )
    if suffix.lower() in adapted.lower():
        return adapted
    base = adapted.rstrip(". ")
    if len(base) + len(suffix) + 2 > 800:
        return adapted
    return f"{base}. {suffix}"


def _smooth_segment_edges(wave_array, sample_rate: int, fade_ms: int = 8):
    """Apply a tiny edge fade to avoid clicks when independently cached chunks are joined."""
    numpy = import_module("numpy")
    array = numpy.asarray(wave_array, dtype=numpy.float32).reshape(-1).copy()
    fade_samples = min(int(sample_rate * fade_ms / 1000), len(array) // 4)
    if fade_samples <= 0:
        return array
    fade_in = numpy.linspace(0.0, 1.0, fade_samples, dtype=numpy.float32)
    array[:fade_samples] *= fade_in
    array[-fade_samples:] *= fade_in[::-1]
    return array


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


def _set_seed(torch, seed: int, device: str) -> None:
    torch.manual_seed(seed)
    if device.startswith("cuda"):
        torch.cuda.manual_seed_all(seed)


def main() -> None:
    request = json.load(sys.stdin)
    profile = request["profile"]
    model_id = profile["model_id"]
    if model_id not in MODELS:
        raise ValueError("Modelo Qwen3-TTS não suportado.")
    params = profile.get("parameters") or {}
    runtime_params = request.get("parameters") or {}
    if not isinstance(params, dict) or not isinstance(runtime_params, dict):
        raise ValueError("Parâmetros de síntese Qwen inválidos.")

    is_voice_design = model_id == "qwen3-tts-1.7b-voice-design"
    allowed_runtime = {"instruct", "language", "seed"} if is_voice_design else {"language"}
    if not set(runtime_params).issubset(allowed_runtime):
        raise ValueError("Parâmetros de síntese Qwen não suportados.")
    default_language = runtime_params.get("language", "Portuguese")
    if default_language not in {"Portuguese", "English"}:
        raise ValueError("Idioma Qwen não suportado. Use Portuguese ou English.")

    raw_batch = request.get("segments")
    batch_mode = raw_batch is not None
    if batch_mode:
        segments = _validate_batch_segments(raw_batch)
    else:
        segments = [
            {
                "text": spoken,
                "language": language,
                "output": None,
                "seed": runtime_params.get("seed"),
            }
            for language, spoken in parse_narration(
                request["text"], "pt" if default_language == "Portuguese" else "en"
            )
        ]

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
    if is_voice_design:
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
    for index, segment in enumerate(segments, start=1):
        segment_language = str(segment["language"])
        spoken = str(segment["text"])
        print(
            f"voice_stage=qwen_segment part={index}/{len(segments)} language={segment_language}",
            file=sys.stderr,
            flush=True,
        )
        if is_voice_design:
            seed = segment.get("seed", runtime_params.get("seed", VOICE_DESIGN_SEED))
            if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
                raise ValueError("Seed de VoiceDesign inválida.")
            _set_seed(torch, seed, device)
            segment_instruct = _adapt_instruct_for_language(instruct, segment_language)
            wavs, sr = model.generate_voice_design(
                text=spoken,
                language=LANGUAGES[segment_language],
                instruct=segment_instruct,
                do_sample=True,
            )
        else:
            wavs, sr = model.generate_voice_clone(
                text=spoken,
                language=LANGUAGES[segment_language],
                ref_audio=str(ref_path),
                ref_text=transcript,
            )

        if batch_mode:
            output = Path(str(segment["output"]))
            output.parent.mkdir(parents=True, exist_ok=True)
            sf.write(
                str(output),
                _smooth_segment_edges(wavs[0], sr),
                sr,
                format="WAV",
                subtype="PCM_16",
            )
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError(f"O chunk {index} não produziu um WAV válido.")
        else:
            if sample_rate is not None and sr != sample_rate:
                raise RuntimeError("Os trechos de voz foram gerados com frequências diferentes.")
            sample_rate = sr
            waves.append(wavs[0])

    if batch_mode:
        print("voice_stage=qwen_completed", file=sys.stderr, flush=True)
        return

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
            parts.append(_smooth_segment_edges(wave, sample_rate))
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
