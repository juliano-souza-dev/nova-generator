from __future__ import annotations

import re
import tempfile
import time
import wave
from pathlib import Path

from ai_provider import groq_client, load_ai_settings

MAX_TTS_INPUT_CHARS = 200
SAFE_TTS_CHUNK_CHARS = 180


def split_tts_text(text: str, max_chars: int = SAFE_TTS_CHUNK_CHARS) -> list[str]:
    """Split on natural boundaries while guaranteeing every chunk is <= max_chars."""
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
    if not cleaned:
        return []
    max_chars = max(40, min(int(max_chars), MAX_TTS_INPUT_CHARS))
    if len(cleaned) <= max_chars:
        return [cleaned]

    sentences = re.split(r"(?<=[.!?;:,])\s+", cleaned)
    chunks: list[str] = []
    current = ""

    def push_piece(piece: str) -> None:
        nonlocal current
        piece = piece.strip()
        if not piece:
            return
        if len(piece) > max_chars:
            words = piece.split()
            for word in words:
                if len(word) > max_chars:
                    if current:
                        chunks.append(current)
                        current = ""
                    for start in range(0, len(word), max_chars):
                        chunks.append(word[start:start + max_chars])
                    continue
                candidate = f"{current} {word}".strip()
                if current and len(candidate) > max_chars:
                    chunks.append(current)
                    current = word
                else:
                    current = candidate
            return
        candidate = f"{current} {piece}".strip()
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = piece
        else:
            current = candidate

    for sentence in sentences:
        push_piece(sentence)
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if chunk]


def _retry_after_seconds(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _write_speech_chunk(*, text: str, output_path: Path, model: str, voice: str) -> None:
    client = groq_client()
    attempts = 0
    while True:
        attempts += 1
        try:
            response = client.audio.speech.create(
                model=model,
                voice=voice,
                input=text,
                response_format="wav",
            )
            response.write_to_file(output_path)
            return
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            if status != 429 or attempts >= 3:
                raise RuntimeError(f"Falha ao gerar voz na Groq: {exc}") from exc
            retry_after = _retry_after_seconds(exc)
            delay = retry_after if retry_after is not None else float(2 ** (attempts - 1))
            # Never freeze a local workflow for a long daily-limit window.
            if delay > 20:
                raise RuntimeError(
                    f"Limite da Groq atingido. Tente novamente depois de aproximadamente {delay:.0f}s."
                ) from exc
            time.sleep(max(0.5, delay))


def concat_wavs(parts: list[Path], output_path: Path) -> Path:
    if not parts:
        raise ValueError("Nenhum áudio TTS foi gerado.")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    params = None
    frames: list[bytes] = []
    for part in parts:
        with wave.open(str(part), "rb") as source:
            current = (
                source.getnchannels(),
                source.getsampwidth(),
                source.getframerate(),
                source.getcomptype(),
                source.getcompname(),
            )
            if params is None:
                params = current
            elif current != params:
                raise RuntimeError("A Groq retornou chunks WAV com formatos incompatíveis.")
            frames.append(source.readframes(source.getnframes()))

    assert params is not None
    channels, sample_width, frame_rate, comp_type, comp_name = params
    with wave.open(str(output_path), "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(sample_width)
        target.setframerate(frame_rate)
        target.setcomptype(comp_type, comp_name)
        for frame_data in frames:
            target.writeframes(frame_data)
    return output_path


def synthesize_tts(text: str, output_path: Path, *, voice: str | None = None) -> dict[str, object]:
    chunks = split_tts_text(text)
    if not chunks:
        raise ValueError("Informe um texto para gerar a voz.")

    settings = load_ai_settings()
    model = settings["tts_model"]
    selected_voice = str(voice or settings["tts_voice"]).strip().lower()
    if not selected_voice:
        raise ValueError("Informe uma voz para gerar o áudio.")

    with tempfile.TemporaryDirectory(prefix="ih_tts_") as temp_dir:
        temp_root = Path(temp_dir)
        parts: list[Path] = []
        for index, chunk in enumerate(chunks, start=1):
            part = temp_root / f"part_{index:03d}.wav"
            _write_speech_chunk(text=chunk, output_path=part, model=model, voice=selected_voice)
            parts.append(part)
        concat_wavs(parts, output_path)

    return {
        "path": str(output_path),
        "chunks": len(chunks),
        "model": model,
        "voice": selected_voice,
        "characters": len(str(text or "").strip()),
    }
