from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot


class FileSpeechCache:
    """Content-addressed WAV cache; manifests freeze the voice snapshot beside the audio."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def cache_key(
        self, *, text: str, profile: VoiceProfileSnapshot, parameters: dict[str, object]
    ) -> str:
        payload = {"text": text, "profile": profile.sha256, "parameters": parameters}
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        ).hexdigest()

    def find(self, key: str) -> SynthesizedSpeech | None:
        manifest = self._directory(key) / "manifest.json"
        audio = self._directory(key) / "speech.wav"
        if not manifest.is_file() or not audio.is_file() or audio.stat().st_size == 0:
            return None
        try:
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            return _speech_from_payload(payload, audio)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None

    def staging_path(self, key: str) -> Path:
        directory = self._directory(key)
        directory.mkdir(parents=True, exist_ok=True)
        return directory / ".speech.tmp.wav"

    def save(self, key: str, speech: SynthesizedSpeech) -> SynthesizedSpeech:
        source = Path(speech.audio_path)
        if source.suffix.lower() != ".wav" or not source.is_file() or source.stat().st_size == 0:
            raise ValueError("A síntese local deve produzir WAV não vazio.")
        directory = self._directory(key)
        directory.mkdir(parents=True, exist_ok=True)
        audio = directory / "speech.wav"
        os.replace(source, audio)
        saved = SynthesizedSpeech(
            str(audio),
            speech.text_sha256,
            speech.profile,
            speech.parameters,
            speech.duration_ms,
            speech.sample_rate,
            speech.channels,
        )
        temporary = directory / ".manifest.tmp.json"
        temporary.write_text(
            json.dumps(_payload(saved), ensure_ascii=False, sort_keys=True), encoding="utf-8"
        )
        os.replace(temporary, directory / "manifest.json")
        return saved

    def _directory(self, key: str) -> Path:
        if len(key) != 64:
            raise ValueError("Chave de cache de voz inválida.")
        return self._root / "speech" / key


def _payload(speech: SynthesizedSpeech) -> dict[str, object]:
    return {
        "text_sha256": speech.text_sha256,
        "profile": {
            "profile_id": str(speech.profile.profile_id),
            "name": speech.profile.name,
            "version": speech.profile.version,
            "model_id": speech.profile.model_id,
            "model_sha256": speech.profile.model_sha256,
            "reference_audio_sha256": speech.profile.reference_audio_sha256,
            "parameters": speech.profile.parameters,
        },
        "parameters": speech.parameters,
        "duration_ms": speech.duration_ms,
        "sample_rate": speech.sample_rate,
        "channels": speech.channels,
    }


def _speech_from_payload(payload: dict[str, object], audio: Path) -> SynthesizedSpeech:
    from uuid import UUID

    profile_data = payload["profile"]
    if not isinstance(profile_data, dict):
        raise ValueError("Perfil inválido")
    profile = VoiceProfileSnapshot(
        UUID(str(profile_data["profile_id"])),
        str(profile_data["name"]),
        int(profile_data["version"]),
        str(profile_data["model_id"]),
        str(profile_data["model_sha256"]),
        str(profile_data["reference_audio_sha256"])
        if profile_data.get("reference_audio_sha256")
        else None,
        dict(profile_data.get("parameters", {})),
    )
    return SynthesizedSpeech(
        str(audio),
        str(payload["text_sha256"]),
        profile,
        dict(payload.get("parameters", {})),
        int(payload["duration_ms"]),
        int(payload["sample_rate"]),
        int(payload["channels"]),
    )
