from __future__ import annotations

from typing import Any

from nova_generator.application.ports.speech_cache import SpeechCache
from nova_generator.application.ports.speech_synthesizer import SpeechSynthesizer
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot


class SynthesizeSpeech:
    """Reuse deterministic local WAV output or synthesize it once via the selected profile."""

    def __init__(self, cache: SpeechCache, synthesizer: SpeechSynthesizer) -> None:
        self._cache = cache
        self._synthesizer = synthesizer

    def execute(
        self, *, text: str, profile: VoiceProfileSnapshot, parameters: dict[str, Any] | None = None
    ) -> SynthesizedSpeech:
        if not text:
            raise ValueError("O texto da narração não pode ser vazio.")
        params = parameters or {}
        key = self._cache.cache_key(text=text, profile=profile, parameters=params)
        if cached := self._cache.find(key):
            return cached
        staging = self._cache.staging_path(key)
        speech = self._synthesizer.synthesize(
            text=text, profile=profile, parameters=params, output=staging
        )
        return self._cache.save(key, speech)
