"""Run a local media/ASR/TTS/Anki/reel rehearsal without a YouTube upload.

Example: python scripts/rehearse_local_release.py --model-file PATH/TO/t3_nano_v1.safetensors
Outputs stay under data/ and are deliberately excluded from Git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock
from uuid import NAMESPACE_URL, UUID, uuid5

from nova_generator.application.use_cases.export_anki_reel import ExportAnkiReel
from nova_generator.application.use_cases.ingest_scene_media import IngestSceneMedia
from nova_generator.application.use_cases.publish_anki_reel import PublishAnkiReel
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.exports import AnkiAudioExport, ExportCue
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import Cue, Project, Scene, utf8_sha256
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
PLACEHOLDER_YOUTUBE_ID = "AAAAAAAAAAA"


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


def _rehearse_hub_publication(
    output: Path, export: AnkiAudioExport, voice: VoiceProfileSnapshot, audio_sha256: str
) -> Path:
    """Exercise the real publisher with local artifacts and an unuploaded placeholder ID."""
    project_id = UUID("00000000-0000-4000-8000-000000000020")
    scene_id = UUID("00000000-0000-4000-8000-000000000022")
    cue_id = UUID("00000000-0000-4000-8000-000000000021")
    manifest_path = export.manifest_path
    job_id = uuid5(NAMESPACE_URL, _sha256(manifest_path))
    export_directory = output / "exports" / str(job_id)
    export_directory.mkdir(parents=True, exist_ok=True)
    for path in (export.apkg_path, export.reel_path, manifest_path):
        shutil.copy2(path, export_directory / path.name)
    interval = export.intervals[0]
    cue = Cue(
        cue_id,
        scene_id,
        1,
        interval.start_ms,
        interval.end_ms,
        interval.start_ms,
        interval.end_ms,
        "Narrator",
        ENGLISH,
        ENGLISH,
        PORTUGUESE,
    )
    repository = Mock()
    repository.get_project.return_value = Project(project_id, "Release rehearsal", "dialogue")
    repository.get_cue.return_value = cue
    repository.get_scene_project_id.return_value = project_id
    repository.get_project_scenes.return_value = [Scene(scene_id, project_id, 1, interval.end_ms)]
    repository.get_cue_words.return_value = []
    job = Job(
        job_id,
        "export_materials",
        "succeeded",
        {
            "project_id": str(project_id),
            "cue_ids": [str(cue_id)],
            "text_hashes": {str(cue_id): cue.approved_en_sha256},
            "pt_hashes": {str(cue_id): utf8_sha256(PORTUGUESE)},
            "audio_hashes": {str(cue_id): audio_sha256},
            "voice_snapshot": {"snapshot_sha256": voice.sha256},
        },
        None,
        1,
        3,
    )
    published = PublishAnkiReel(
        repository, Mock(), output / "exports", output / "projects"
    ).execute(project_id=project_id, job=job, youtube=PLACEHOLDER_YOUTUBE_ID)
    document = json.loads(published.path.read_text(encoding="utf-8"))
    selected = document["cues"][0]
    card = selected["anki"]["items"][0]
    audio = document["ankiAudio"]["cues"][0]
    if (
        selected["final_en"] != ENGLISH
        or selected["pt"] != PORTUGUESE
        or card["focus"] != ENGLISH
        or card["meaning"] != PORTUGUESE
        or audio["start_ms"] != interval.start_ms
        or audio["end_ms"] != interval.end_ms
        or document["ankiAudio"]["youtube"]["video_id"] != PLACEHOLDER_YOUTUBE_ID
    ):
        raise RuntimeError("Hub publication differs from the approved card and reel")
    return published.path


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
    hub_final = _rehearse_hub_publication(output, export, voice, cue.audio_sha256)
    report: dict[str, object] = {
        "scope": (
            "local technical rehearsal with placeholder hub_final; external YouTube upload "
            "and iHub import not exercised"
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
        "hub_final_sha256": _sha256(hub_final),
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
                "hub_final": hub_final,
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
