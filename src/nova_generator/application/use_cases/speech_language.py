"""Explicit language and deterministic sampling parameters for local speech engines."""

from __future__ import annotations

from nova_generator.domain.voices import VoiceProfileSnapshot

QWEN_VOICE_DESIGN_SEED = 42
_QWEN_MODEL_IDS = {"qwen3-tts-1.7b-voice-design", "qwen3-tts-1.7b-base"}
_QWEN_VOICE_DESIGN_ID = "qwen3-tts-1.7b-voice-design"


def synthesis_language_parameters(
    profile: VoiceProfileSnapshot, language: str
) -> dict[str, object]:
    """Return cache-significant language and sampling parameters for one chunk."""
    if language not in {"Portuguese", "English"}:
        raise ValueError("Idioma Qwen não suportado.")
    if profile.model_id not in _QWEN_MODEL_IDS:
        return {}
    parameters: dict[str, object] = {"language": language}
    if profile.model_id == _QWEN_VOICE_DESIGN_ID:
        parameters["seed"] = QWEN_VOICE_DESIGN_SEED
    return parameters
