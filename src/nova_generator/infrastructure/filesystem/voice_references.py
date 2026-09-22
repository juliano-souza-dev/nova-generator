"""Content-addressed, validated local WAV references for Chatterbox profiles."""

from __future__ import annotations

import io
import os
import re
import tempfile
import wave
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

MAX_WAV_BYTES = 10 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")


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
