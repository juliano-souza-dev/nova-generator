"""Run the durable local job worker: ``python -m nova_generator.worker``."""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path
from threading import Event

from nova_generator.api.dependencies import get_session_factory
from nova_generator.application.use_cases.download_youtube_source import DownloadYoutubeSource
from nova_generator.application.use_cases.export_anki_reel import ExportAnkiReel
from nova_generator.application.use_cases.ingest_scene_media import IngestSceneMedia
from nova_generator.application.use_cases.render_story import RenderStory
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.core.settings import get_settings
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.exports.ffmpeg_audio_reel_renderer import FfmpegAudioReelRenderer
from nova_generator.infrastructure.exports.ffmpeg_story_video_renderer import (
    FfmpegStoryVideoRenderer,
)
from nova_generator.infrastructure.exports.ffprobe_reel_validator import FfprobeReelValidator
from nova_generator.infrastructure.exports.genanki_package_writer import GenankiPackageWriter
from nova_generator.infrastructure.filesystem.voice_references import FileVoiceReferenceStore
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache
from nova_generator.infrastructure.ingestion.faster_whisper_transcriber import (
    FasterWhisperTranscriber,
)
from nova_generator.infrastructure.ingestion.ffmpeg_source_cutter import FfmpegSourceCutter
from nova_generator.infrastructure.ingestion.ffmpeg_waveform_generator import (
    FfmpegWaveformGenerator,
)
from nova_generator.infrastructure.media.ffprobe_media_probe import FfprobeMediaProbe
from nova_generator.infrastructure.media.ytdlp_youtube_downloader import YtDlpYoutubeDownloader
from nova_generator.infrastructure.speech.chatterbox_nano_synthesizer import (
    ChatterboxNanoSynthesizer,
)
from nova_generator.infrastructure.speech.ffprobe_wav_probe import FfprobeWavProbe
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache
from nova_generator.infrastructure.worker.ingest_scene_media_handler import (
    IngestSceneMediaJobHandler,
)
from nova_generator.infrastructure.worker.materials_handler import MaterialsJobHandler
from nova_generator.infrastructure.worker.persistent_worker import PersistentWorker
from nova_generator.infrastructure.worker.project_media_handler import ProjectMediaJobHandler
from nova_generator.infrastructure.worker.story_render_handler import make_story_render_handler
from nova_generator.infrastructure.worker.voice_preview_handler import make_voice_preview_handler


def main() -> None:
    settings = get_settings()
    runner = Path(__file__).parent / "infrastructure" / "speech" / "chatterbox_nano_runner.py"
    synthesizer = ChatterboxNanoSynthesizer(
        runner,
        executable=os.environ.get("NOVA_GENERATOR_TTS_PYTHON", sys.executable),
        reference_store=FileVoiceReferenceStore(settings.media_cache_root),
    )
    speech = SynthesizeSpeech(FileSpeechCache(settings.media_cache_root), synthesizer)
    materials = MaterialsJobHandler(
        SqlAlchemyEditorialProjectRepository(get_session_factory()),
        FileSpeechCache(settings.media_cache_root),
        speech,
        ExportAnkiReel(
            GenankiPackageWriter(),
            FfmpegAudioReelRenderer(),
            FfprobeWavProbe(),
            FfprobeReelValidator(),
        ),
        settings.media_cache_root / "exports",
    )
    media_cache = FileYoutubeMediaCache(settings.media_cache_root)
    project_media = ProjectMediaJobHandler(
        SqlAlchemyEditorialProjectRepository(get_session_factory()),
        media_cache,
        DownloadYoutubeSource(
            media_cache,
            YtDlpYoutubeDownloader(),
            FfprobeMediaProbe(settings.ffprobe_executable),
        ),
        IngestSceneMediaJobHandler(
            IngestSceneMedia(
                FfmpegSourceCutter(settings.ffmpeg_executable),
                FfmpegWaveformGenerator(settings.ffmpeg_executable),
                FasterWhisperTranscriber(settings.whisper_model),
            )
        ),
        settings.project_root,
    )
    worker = PersistentWorker(
        SqlAlchemyJobRepository(get_session_factory()),
        worker_id=f"local-{os.getpid()}",
        handlers={
            "synthesize_voice_preview": make_voice_preview_handler(speech),
            "story.render": make_story_render_handler(
                settings.media_cache_root, RenderStory(speech, FfmpegStoryVideoRenderer())
            ),
            "synthesize_material_audio": materials.synthesize,
            "export_materials": materials.export,
            "download_youtube": project_media.download,
            "ingest_scene_media": project_media.ingest,
        },
    )
    stopped = Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    worker.run_forever(poll_interval_seconds=2, stop_event=stopped)


if __name__ == "__main__":
    main()
