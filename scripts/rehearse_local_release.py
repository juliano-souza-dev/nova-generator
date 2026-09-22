"""Run a local media/ASR/TTS/Anki/reel rehearsal without a YouTube upload.

Example: python scripts/rehearse_local_release.py --model-file PATH/TO/t3_nano_v1.safetensors
Outputs stay under data/ and are deliberately excluded from Git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path
from uuid import UUID

from nova_generator.application.use_cases.export_anki_reel import ExportAnkiReel
from nova_generator.application.use_cases.ingest_scene_media import IngestSceneMedia
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.exports import ExportCue
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.exports.ffmpeg_audio_reel_renderer import FfmpegAudioReelRenderer
from nova_generator.infrastructure.exports.ffprobe_reel_validator import FfprobeReelValidator
from nova_generator.infrastructure.exports.genanki_package_writer import GenankiPackageWriter
from nova_generator.infrastructure.ingestion.faster_whisper_transcriber import (
    FasterWhisperTranscriber,
)
from nova_generator.infrastructure.ingestion.ffmpeg_source_cutter import FfmpegSourceCutter
from nova_generator.infrastructure.ingestion.ffmpeg_waveform_generator import (
    FfmpegWaveformGenerator,
)
from nova_generator.infrastructure.speech.chatterbox_nano_synthesizer import (
    ChatterboxNanoSynthesizer,
)
from nova_generator.infrastructure.speech.ffprobe_wav_probe import FfprobeWavProbe
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache

ENGLISH = '"Hello," she said. This is a local voice preview.'
PORTUGUESE = '"Olá", ela disse. Esta é uma prévia de voz local.'


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _source_video(audio: Path, output: Path) -> None:
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=640x360:r=25",
            "-i",
            str(audio),
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(output),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if result.returncode or not output.is_file():
        raise RuntimeError(result.stderr or "FFmpeg did not create source video")


def run(model_file: Path, output: Path, whisper_model: str) -> dict[str, object]:
    if not model_file.is_file():
        raise FileNotFoundError(f"Chatterbox model file not found: {model_file}")
    output.mkdir(parents=True, exist_ok=True)
    voice = VoiceProfileSnapshot(
        UUID("00000000-0000-4000-8000-000000000020"),
        "Issue 20 local rehearsal",
        1,
        "chatterbox-nano",
        _sha256(model_file),
        None,
        {},
    )
    runner = (
        Path(__file__).resolve().parents[1]
        / "src/nova_generator/infrastructure/speech/chatterbox_nano_runner.py"
    )
    speech = SynthesizeSpeech(
        FileSpeechCache(output / "cache"),
        ChatterboxNanoSynthesizer(runner, executable=sys.executable),
    ).execute(text=ENGLISH, profile=voice)
    wav = Path(speech.audio_path)
    source = output / "source.mp4"
    _source_video(wav, source)
    end_ms = min(speech.duration_ms, 2_000)
    ingested = IngestSceneMedia(
        FfmpegSourceCutter(),
        FfmpegWaveformGenerator(),
        FasterWhisperTranscriber(whisper_model, device="cpu", compute_type="int8"),
    ).execute(
        source=source, output=output / "project-cut.mp4", start_ms=0, end_ms=end_ms, language="en"
    )
    cue = ExportCue(
        UUID("00000000-0000-4000-8000-000000000021"),
        1,
        ENGLISH,
        PORTUGUESE,
        wav,
        speech.duration_ms,
        hashlib.sha256(ENGLISH.encode("utf-8")).hexdigest(),
    )
    export = ExportAnkiReel(
        GenankiPackageWriter(),
        FfmpegAudioReelRenderer(),
        FfprobeWavProbe(),
        FfprobeReelValidator(),
    ).execute(
        cues=[cue],
        voice=voice,
        output_directory=output / "export",
        deck_name="Nova Generator release rehearsal",
    )
    with zipfile.ZipFile(export.apkg_path) as package:
        mapping = json.loads(package.read("media"))
        members = [member for member, name in mapping.items() if name == "cue_0001.wav"]
        if (
            len(members) != 1
            or hashlib.sha256(package.read(members[0])).hexdigest() != cue.audio_sha256
        ):
            raise RuntimeError("Anki audio differs from the canonical WAV")
        with tempfile.TemporaryDirectory() as temporary:
            collection = Path(temporary) / "collection.anki2"
            collection.write_bytes(package.read("collection.anki2"))
            with closing(sqlite3.connect(collection)) as database:
                fields = database.execute("SELECT flds FROM notes").fetchone()[0].split("\x1f")
            if fields[:2] != [ENGLISH, PORTUGUESE]:
                raise RuntimeError("Anki text differs from approved EN/PT literals")
    manifest = json.loads(export.manifest_path.read_text(encoding="utf-8"))
    if manifest["cues"][0]["audio_sha256"] != cue.audio_sha256:
        raise RuntimeError("Reel manifest differs from the canonical WAV")
    report: dict[str, object] = {
        "scope": (
            "local technical rehearsal; external YouTube publication and iHub import not exercised"
        ),
        "approved_en": ENGLISH,
        "approved_pt": PORTUGUESE,
        "model_checkpoint_sha256": voice.model_sha256,
        "voice_snapshot_sha256": voice.sha256,
        "canonical_wav_sha256": cue.audio_sha256,
        "anki_audio_sha256": cue.audio_sha256,
        "source_sha256": _sha256(source),
        "project_cut_sha256": _sha256(ingested.cut_file),
        "apkg_sha256": _sha256(export.apkg_path),
        "reel_sha256": _sha256(export.reel_path),
        "reel_interval": {
            "start_ms": export.intervals[0].start_ms,
            "end_ms": export.intervals[0].end_ms,
        },
        "asr_candidate_cues": len(ingested.transcript_candidate.cues),
        "waveform_buckets": len(ingested.waveform.peaks),
        "artifacts": {
            name: str(path)
            for name, path in {
                "source": source,
                "project_cut": ingested.cut_file,
                "wav": wav,
                "apkg": export.apkg_path,
                "reel": export.reel_path,
                "manifest": export.manifest_path,
            }.items()
        },
    }
    (output / "rehearsal-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/release-issue20"))
    parser.add_argument("--whisper-model", default="small")
    args = parser.parse_args()
    print(json.dumps(run(args.model_file, args.output, args.whisper_model), ensure_ascii=False))
