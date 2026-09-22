from __future__ import annotations

import json
import os
from hashlib import sha256
from pathlib import Path

from nova_generator.application.ports.anki_package_writer import AnkiPackageWriter
from nova_generator.application.ports.audio_reel_renderer import AudioReelRenderer
from nova_generator.application.ports.reel_validator import ReelValidator
from nova_generator.application.ports.wav_probe import WavProbe
from nova_generator.core.observability import metrics
from nova_generator.domain.exports import AnkiAudioExport, ExportCue
from nova_generator.domain.voices import VoiceProfileSnapshot


class ExportAnkiReel:
    """Build Anki and a publishable reel from the same immutable per-cue WAVs."""

    def __init__(
        self,
        package_writer: AnkiPackageWriter,
        reel_renderer: AudioReelRenderer,
        wav_probe: WavProbe,
        reel_validator: ReelValidator,
    ) -> None:
        self._package_writer = package_writer
        self._reel_renderer = reel_renderer
        self._wav_probe = wav_probe
        self._reel_validator = reel_validator

    def execute(
        self,
        *,
        cues: list[ExportCue],
        voice: VoiceProfileSnapshot,
        output_directory: Path,
        deck_name: str,
    ) -> AnkiAudioExport:
        if not cues or [cue.order for cue in cues] != sorted({cue.order for cue in cues}):
            raise ValueError("A exportação requer cues ordenados sem ordens repetidas.")
        for cue in cues:
            duration, _rate, _channels = self._wav_probe.inspect_wav(cue.audio_path)
            if abs(duration - cue.duration_ms) > 100:
                raise ValueError(f"Duração do WAV diverge do cue {cue.order}.")
        output_directory.mkdir(parents=True, exist_ok=True)
        apkg = self._package_writer.write(
            cues=cues, output=output_directory / "anki.apkg", deck_name=deck_name
        )
        reel, intervals = self._reel_renderer.render(
            cues=cues, output=output_directory / "anki-reel.mp4"
        )
        if [interval.cue_order for interval in intervals] != [cue.order for cue in cues]:
            raise ValueError("O reel não retornou um intervalo para cada cue.")
        self._reel_validator.validate(reel=reel, intervals=intervals)
        manifest = output_directory / "anki-audio-manifest.json"
        payload = {
            "schema": "nova-generator-anki-audio",
            "schema_version": "1.0",
            "voice": _voice_payload(voice),
            "apkg_sha256": _file_hash(apkg),
            "reel_sha256": _file_hash(reel),
            "cues": [
                {
                    "cue_order": interval.cue_order,
                    "start_ms": interval.start_ms,
                    "end_ms": interval.end_ms,
                    "audio_sha256": interval.audio_sha256,
                    "text_sha256": interval.text_sha256,
                }
                for interval in intervals
            ],
        }
        staging = manifest.with_suffix(".tmp.json")
        staging.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(staging, manifest)
        metrics.record("anki_export_succeeded")
        return AnkiAudioExport(apkg, reel, manifest, voice, tuple(intervals))


def _file_hash(path: Path) -> str:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Artefato ausente: {path.name}")
    return sha256(path.read_bytes()).hexdigest()


def _voice_payload(voice: VoiceProfileSnapshot) -> dict[str, object]:
    return {
        "profile_id": str(voice.profile_id),
        "name": voice.name,
        "version": voice.version,
        "model_id": voice.model_id,
        "model_sha256": voice.model_sha256,
        "reference_audio_sha256": voice.reference_audio_sha256,
        "parameters": voice.parameters,
        "snapshot_sha256": voice.sha256,
    }
