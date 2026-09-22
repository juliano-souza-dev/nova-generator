from pathlib import Path
from typing import Any, Protocol

from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot


class SpeechSynthesizer(Protocol):
    """Produces canonical WAV through a local, isolated model runner."""

    def synthesize(
        self, *, text: str, profile: VoiceProfileSnapshot, parameters: dict[str, Any], output: Path
    ) -> SynthesizedSpeech: ...
