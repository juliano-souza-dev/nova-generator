from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from nova_generator.domain.stories.package import StoryCue, StoryPackage
from nova_generator.domain.voices import VoiceProfileSnapshot


def sha256_file(path: Path) -> str:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Artefato ausente ou vazio: {path}")
    return sha256(path.read_bytes()).hexdigest()


def cue_fingerprint(cue: StoryCue, *, image_sha256: str, voice: VoiceProfileSnapshot) -> str:
    """Fingerprint of all inputs that can affect one rendered cue."""
    payload = "\x1f".join((cue.en, cue.pt, image_sha256, voice.sha256))
    return sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RenderedStoryCue:
    cue: StoryCue
    audio_path: Path
    video_path: Path
    duration_ms: int
    input_sha256: str
    audio_sha256: str
    video_sha256: str


@dataclass(frozen=True)
class StoryRender:
    package: StoryPackage
    voice: VoiceProfileSnapshot
    output_directory: Path
    final_video_path: Path
    manifest_path: Path
    cues: tuple[RenderedStoryCue, ...]

    @property
    def duration_ms(self) -> int:
        return sum(cue.duration_ms for cue in self.cues)
