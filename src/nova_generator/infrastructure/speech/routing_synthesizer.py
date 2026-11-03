"""Dispatch local TTS engines without changing canonical WAV consumers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nova_generator.application.ports.speech_synthesizer import SpeechSynthesizer
from nova_generator.core.settings import Settings
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.speech.qwen3_tts_models import (
    QWEN_MODELS,
    qwen_model_sha256,
)


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

    def synthesize(
        self,
        *,
        text: str,
        profile: VoiceProfileSnapshot,
        parameters: dict[str, Any],
        output: Path,
    ) -> SynthesizedSpeech:
        if profile.model_id in QWEN_MODELS:
            current_hash = qwen_model_sha256(self._settings, profile.model_id)
            if profile.model_sha256 != current_hash:
                raise ValueError(
                    "Os pesos locais do Qwen mudaram desde a criação desta voz. "
                    "Crie uma nova versão do perfil antes de sintetizar."
                )
            engine = self._qwen
        elif profile.model_id in {"chatterbox-turbo", "chatterbox-nano"}:
            engine = self._chatterbox
        else:
            raise ValueError(f"Modelo de voz não suportado: {profile.model_id}")
        return engine.synthesize(
            text=text, profile=profile, parameters=parameters, output=output
        )
