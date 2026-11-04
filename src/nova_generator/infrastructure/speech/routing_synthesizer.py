"""Dispatch local TTS engines without changing canonical WAV consumers."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from nova_generator.application.ports.speech_synthesizer import SpeechSynthesizer
from nova_generator.core.settings import Settings
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.speech.qwen3_tts_models import (
    QWEN_MODELS,
    qwen_model_sha256,
)
from nova_generator.infrastructure.speech.qwen3_tts_runner import has_language_tags


class RoutingSpeechSynthesizer:
    def __init__(
        self,
        *,
        chatterbox: SpeechSynthesizer,
        qwen: SpeechSynthesizer,
        settings: Settings,
    ) -> None:
        self._chatterbox = chatterbox
        self._qwen = qwen
        self._settings = settings

    def _validate_qwen_profile(self, profile: VoiceProfileSnapshot) -> None:
        current_hash = qwen_model_sha256(self._settings, profile.model_id)
        if profile.model_sha256 != current_hash:
            raise ValueError(
                "Os pesos locais do Qwen mudaram desde a criação desta voz. "
                "Crie uma nova versão do perfil antes de sintetizar."
            )

    def synthesize(
        self,
        *,
        text: str,
        profile: VoiceProfileSnapshot,
        parameters: dict[str, Any],
        output: Path,
    ) -> SynthesizedSpeech:
        if profile.model_id in QWEN_MODELS:
            self._validate_qwen_profile(profile)
            engine = self._qwen
        elif profile.model_id in {"chatterbox-turbo", "chatterbox-nano"}:
            if has_language_tags(text):
                raise ValueError(
                    "Roteiros com [pt]/[en] exigem uma voz Qwen3-TTS. "
                    "Selecione uma voz bilíngue na Biblioteca de vozes."
                )
            engine = self._chatterbox
        else:
            raise ValueError(f"Modelo de voz não suportado: {profile.model_id}")
        return engine.synthesize(
            text=text, profile=profile, parameters=parameters, output=output
        )

    def synthesize_many(
        self,
        *,
        profile: VoiceProfileSnapshot,
        requests: list[dict[str, Any]],
    ) -> list[SynthesizedSpeech]:
        """Use Qwen's batch runner so the model is loaded once for all cache misses."""
        if not requests:
            return []
        if profile.model_id in QWEN_MODELS:
            self._validate_qwen_profile(profile)
            batch = getattr(self._qwen, "synthesize_many", None)
            if callable(batch):
                return cast(
                    list[SynthesizedSpeech],
                    batch(profile=profile, requests=requests),
                )
            engine = self._qwen
        elif profile.model_id in {"chatterbox-turbo", "chatterbox-nano"}:
            if any(has_language_tags(str(request.get("text", ""))) for request in requests):
                raise ValueError(
                    "Roteiros com [pt]/[en] exigem uma voz Qwen3-TTS. "
                    "Selecione uma voz bilíngue na Biblioteca de vozes."
                )
            engine = self._chatterbox
        else:
            raise ValueError(f"Modelo de voz não suportado: {profile.model_id}")
        return [
            engine.synthesize(
                text=request["text"],
                profile=profile,
                parameters=request["parameters"],
                output=request["output"],
            )
            for request in requests
        ]
