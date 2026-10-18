"""Content-addressed, validated local WAV references for Chatterbox profiles."""

from __future__ import annotations

import io
import os
import re
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

MAX_WAV_BYTES = 10 * 1024 * 1024
MAX_REFERENCE_UPLOAD_BYTES = MAX_WAV_BYTES
MIN_REFERENCE_DURATION_MS = 6000
REFERENCE_TOO_SHORT_MESSAGE = (
    "O áudio de referência deve ter pelo menos 6 segundos. "
    "Envie uma gravação mais longa, preferencialmente de 10 a 15 segundos."
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")


def normalize_reference_audio(content: bytes, extension: str) -> bytes:
    """Convert compressed voice samples to stable PCM WAV without changing WAV uploads.

    The final WAV, not the original compressed bytes, is content addressed and
    used for Chatterbox inference. Neither user filenames nor shell commands are
    used by the converter.
    """
    suffix = extension.lower().lstrip(".")
    if suffix not in {"wav", "mp3", "ogg"}:
        raise ValueError("Envie um arquivo WAV, MP3 ou OGG.")
    if not content or len(content) > MAX_REFERENCE_UPLOAD_BYTES:
        raise ValueError("O áudio de referência deve ter no máximo 10 MiB.")
    if suffix == "wav":
        return content
    with tempfile.TemporaryDirectory(prefix="nova_voice_import_") as temporary:
        root = Path(temporary)
        source = root / f"reference.{suffix}"
        output = root / "reference.wav"
        source.write_bytes(content)
        command = [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-t",
            "31",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            str(output),
        ]
        try:
            converted = subprocess.run(
                command, check=False, capture_output=True, timeout=30
            )
        except FileNotFoundError as exc:
            raise ValueError("FFmpeg não está instalado para converter MP3/OGG.") from exc
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError("Não foi possível converter o áudio de referência.") from exc
        if converted.returncode != 0 or not output.is_file():
            raise ValueError("Arquivo MP3/OGG inválido ou sem áudio decodificável.")
        result = output.read_bytes()
        _inspect(result)
        return result


@dataclass(frozen=True)
class VoiceReference:
    sha256: str
    duration_ms: int
    sample_rate: int
    channels: int
    size_bytes: int


class FileVoiceReferenceStore:
    def __init__(self, media_cache_root: Path) -> None:
        self.root = media_cache_root / "voice_references"

    def save(self, content: bytes) -> VoiceReference:
        metadata = _inspect(content)
        validate_reference_duration(metadata[0])
        digest = sha256(content).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / f"{digest}.wav"
        if target.exists() or target.is_symlink():
            if self.get(digest) is None:
                raise ValueError("Referência armazenada inválida; verifique a biblioteca local.")
            return VoiceReference(digest, *metadata, len(content))
        with tempfile.NamedTemporaryFile(dir=self.root, suffix=".tmp", delete=False) as file:
            staging = Path(file.name)
            file.write(content)
        try:
            os.replace(staging, target)
        finally:
            staging.unlink(missing_ok=True)
        return VoiceReference(digest, *metadata, len(content))

    def get(self, digest: str) -> tuple[VoiceReference, Path] | None:
        if not SHA256.fullmatch(digest):
            return None
        target = self.root / f"{digest}.wav"
        if target.is_symlink() or not target.is_file() or target.stat().st_size > MAX_WAV_BYTES:
            return None
        content = target.read_bytes()
        if sha256(content).hexdigest() != digest:
            return None
        try:
            metadata = _inspect(content)
        except ValueError:
            return None
        return VoiceReference(digest, *metadata, len(content)), target

    def list(self) -> list[VoiceReference]:
        if not self.root.is_dir():
            return []
        return [
            item[0]
            for path in sorted(self.root.glob("*.wav"))
            if (item := self.get(path.stem)) is not None
        ]


def validate_reference_duration(duration_ms: int) -> None:
    """Prevent Chatterbox Turbo from receiving references of 5 seconds or less."""
    if duration_ms < MIN_REFERENCE_DURATION_MS:
        raise ValueError(REFERENCE_TOO_SHORT_MESSAGE)


def validate_profile_reference(
    store: FileVoiceReferenceStore, digest: str | None
) -> None:
    """Check the voice's original sample, never the length of synthesized cards."""
    if digest is None:
        return
    stored = store.get(digest)
    if stored is None:
        raise ValueError(
            "O áudio original da voz não foi encontrado. "
            "Selecione outro perfil ou cadastre uma nova referência."
        )
    try:
        validate_reference_duration(stored[0].duration_ms)
    except ValueError as exc:
        raise ValueError(
            "A referência desta voz é curta demais para o Chatterbox Turbo. "
            "O áudio original precisa ter pelo menos 6 segundos. "
            "Grave uma nova referência de 10 a 15 segundos na Biblioteca de vozes. "
            "Os WAVs dos cards Anki podem ser mais curtos."
        ) from exc


def _inspect(content: bytes) -> tuple[int, int, int]:
    if len(content) > MAX_WAV_BYTES:
        raise ValueError("O WAV de referência deve ter no máximo 10 MiB.")
    try:
        with wave.open(io.BytesIO(content), "rb") as audio:
            channels = audio.getnchannels()
            sample_rate = audio.getframerate()
            frames = audio.getnframes()
            sample_width = audio.getsampwidth()
            compression = audio.getcomptype()
    except (EOFError, wave.Error) as exc:
        raise ValueError("Envie um WAV PCM válido.") from exc
    duration_ms = round(frames * 1000 / sample_rate) if sample_rate else 0
    if compression != "NONE" or sample_width not in (2, 3, 4):
        raise ValueError("O áudio de referência deve ser WAV PCM de 16, 24 ou 32 bits.")
    if channels not in (1, 2) or not 8000 <= sample_rate <= 96000:
        raise ValueError("O WAV precisa ter 1 ou 2 canais e taxa entre 8 e 96 kHz.")
    if not 1000 <= duration_ms <= 30000:
        raise ValueError("O áudio de referência deve durar de 1 a 30 segundos.")
    return duration_ms, sample_rate, channels
