from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from nova_generator.application.use_cases.export_anki_reel import ExportAnkiReel
from nova_generator.domain.exports import ExportCue, ReelInterval
from nova_generator.domain.voices import VoiceProfile


class FakeWavProbe:
    def inspect_wav(self, source: Path) -> tuple[int, int, int]:
        return int(source.stem.split("-")[-1]), 24000, 1


class FakePackageWriter:
    def write(self, *, cues, output: Path, deck_name: str) -> Path:
        output.write_bytes(b"apkg")
        return output


class FakeReelRenderer:
    def render(self, *, cues, output: Path):
        output.write_bytes(b"mp4")
        cursor = 0
        intervals = []
        for cue in cues:
            intervals.append(
                ReelInterval(
                    cue.order, cursor, cursor + cue.duration_ms, cue.audio_sha256, cue.text_sha256
                )
            )
            cursor += cue.duration_ms
        return output, intervals


class FakeReelValidator:
    def __init__(self) -> None:
        self.validated = False

    def validate(self, *, reel: Path, intervals) -> None:
        self.validated = reel.is_file() and bool(intervals)


def _cue(tmp_path: Path, order: int, duration: int) -> ExportCue:
    audio = tmp_path / f"cue-{duration}.wav"
    audio.write_bytes(f"wav {order}".encode())
    text = f'Hello, "cue {order}"!'
    return ExportCue(
        uuid4(), order, text, "Olá!", audio, duration, sha256(text.encode()).hexdigest()
    )


def test_export_uses_same_wavs_for_manifest_anki_and_reel(tmp_path: Path) -> None:
    voice = VoiceProfile(uuid4(), "Ana", 1, "chatterbox-nano", "a" * 64).snapshot()
    validator = FakeReelValidator()
    result = ExportAnkiReel(
        FakePackageWriter(), FakeReelRenderer(), FakeWavProbe(), validator
    ).execute(
        cues=[_cue(tmp_path, 1, 1200), _cue(tmp_path, 2, 800)],
        voice=voice,
        output_directory=tmp_path / "export",
        deck_name="Lesson",
    )
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert validator.validated
    assert result.apkg_path.is_file() and result.reel_path.is_file()
    assert manifest["voice"]["snapshot_sha256"] == voice.sha256
    assert [(cue["start_ms"], cue["end_ms"]) for cue in manifest["cues"]] == [
        (0, 1200),
        (1200, 2000),
    ]


def test_export_rejects_a_wav_with_different_observed_duration(tmp_path: Path) -> None:
    voice = VoiceProfile(uuid4(), "Ana", 1, "chatterbox-nano", "a" * 64).snapshot()
    cue = _cue(tmp_path, 1, 1200)
    cue = ExportCue(
        cue.cue_id, 1, cue.approved_en, cue.approved_pt, cue.audio_path, 900, cue.text_sha256
    )
    try:
        ExportAnkiReel(
            FakePackageWriter(), FakeReelRenderer(), FakeWavProbe(), FakeReelValidator()
        ).execute(cues=[cue], voice=voice, output_directory=tmp_path / "export", deck_name="Lesson")
    except ValueError as error:
        assert "Duração" in str(error)
    else:  # pragma: no cover
        raise AssertionError("Divergência de WAV deveria falhar")
