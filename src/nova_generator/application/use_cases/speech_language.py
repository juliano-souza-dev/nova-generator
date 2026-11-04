"""Explicit language routing for speech engines."""

from __future__ import annotations

from nova_generator.domain.voices import VoiceProfileSnapshot

_QWEN_MODEL_IDS = {"qwen3-tts-1.7b-voice-design", "qwen3-tts-1.7b-base"}


def synthesis_language_parameters(
    profile: VoiceProfileSnapshot, language: str
) -> dict[str, str]:
    """Add Qwen's language hint while preserving legacy engine contracts."""
    if language not in {"Portuguese", "English"}:
        raise ValueError("Idioma Qwen não suportado.")
    return {"language": language} if profile.model_id in _QWEN_MODEL_IDS else {}
