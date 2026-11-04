from __future__ import annotations

from typing import Any, cast

from nova_generator.application.ports.speech_cache import SpeechCache
from nova_generator.application.ports.speech_synthesizer import (
    PartialBatchSynthesisError,
    SpeechSynthesizer,
)
from nova_generator.core.observability import metrics
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
            metrics.record("speech_cache_hit")
            return cached
        staging = self._cache.staging_path(key)
        speech = self._synthesizer.synthesize(
            text=text, profile=profile, parameters=params, output=staging
        )
        return self._cache.save(key, speech)

    def execute_many(
        self,
        *,
        segments: list[tuple[str, dict[str, Any]]],
        profile: VoiceProfileSnapshot,
    ) -> list[SynthesizedSpeech]:
        """Synthesize language-aware chunks with per-chunk cache and one batch model load."""
        if not segments:
            return []

        results: list[SynthesizedSpeech | None] = [None] * len(segments)
        pending: dict[str, dict[str, Any]] = {}
        pending_indexes: dict[str, list[int]] = {}

        for index, (text, raw_parameters) in enumerate(segments):
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Um trecho de narração não pode estar vazio.")
            parameters = dict(raw_parameters)
            key = self._cache.cache_key(
                text=text, profile=profile, parameters=parameters
            )
            cached = self._cache.find(key)
            if cached is not None:
                metrics.record("speech_cache_hit")
                results[index] = cached
                continue
            if key not in pending:
                pending[key] = {
                    "text": text,
                    "parameters": parameters,
                    "output": self._cache.staging_path(key),
                }
                pending_indexes[key] = []
            pending_indexes[key].append(index)

        if pending:
            requests = list(pending.values())
            batch_synthesizer = getattr(self._synthesizer, "synthesize_many", None)
            if callable(batch_synthesizer):
                try:
                    synthesized = cast(
                        list[SynthesizedSpeech],
                        batch_synthesizer(profile=profile, requests=requests),
                    )
                except PartialBatchSynthesisError as exc:
                    pending_keys = list(pending)
                    for request_index, speech in exc.completed:
                        if 0 <= request_index < len(pending_keys):
                            key = pending_keys[request_index]
                            saved = self._cache.save(key, speech)
                            for index in pending_indexes[key]:
                                results[index] = saved
                    raise
            else:
                synthesized = [
                    self._synthesizer.synthesize(
                        text=request["text"],
                        profile=profile,
                        parameters=request["parameters"],
                        output=request["output"],
                    )
                    for request in requests
                ]
            if len(synthesized) != len(requests):
                raise RuntimeError("O sintetizador retornou uma quantidade incorreta de chunks.")

            for (key, _request), speech in zip(pending.items(), synthesized, strict=True):
                saved = self._cache.save(key, speech)
                for index in pending_indexes[key]:
                    results[index] = saved

        if any(result is None for result in results):
            raise RuntimeError("Nem todos os chunks de narração foram processados.")
        return [result for result in results if result is not None]
