from pathlib import Path
from typing import Any, Protocol

from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot


class PartialBatchSynthesisError(RuntimeError):
    """A batch failed after producing some valid chunks that can be cached for retry."""

    def __init__(
        self, message: str, completed: list[tuple[int, SynthesizedSpeech]]
    ) -> None:
        super().__init__(message)
        self.completed = completed


class SpeechSynthesizer(Protocol):
    """Produces canonical WAV through a local, isolated model runner."""

    def synthesize(
        self, *, text: str, profile: VoiceProfileSnapshot, parameters: dict[str, Any], output: Path
    ) -> SynthesizedSpeech: ...
