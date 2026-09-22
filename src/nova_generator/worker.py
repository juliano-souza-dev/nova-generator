"""Run the durable local job worker: ``python -m nova_generator.worker``."""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path
from threading import Event

from nova_generator.api.dependencies import get_session_factory
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.core.settings import get_settings
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.speech.chatterbox_nano_synthesizer import (
    ChatterboxNanoSynthesizer,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache
from nova_generator.infrastructure.worker.persistent_worker import PersistentWorker
from nova_generator.infrastructure.worker.voice_preview_handler import make_voice_preview_handler


def main() -> None:
    settings = get_settings()
    runner = Path(__file__).parent / "infrastructure" / "speech" / "chatterbox_nano_runner.py"
    synthesizer = ChatterboxNanoSynthesizer(
        runner, executable=os.environ.get("NOVA_GENERATOR_TTS_PYTHON", sys.executable)
    )
    speech = SynthesizeSpeech(FileSpeechCache(settings.media_cache_root), synthesizer)
    worker = PersistentWorker(
        SqlAlchemyJobRepository(get_session_factory()),
        worker_id=f"local-{os.getpid()}",
        handlers={"synthesize_voice_preview": make_voice_preview_handler(speech)},
    )
    stopped = Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    worker.run_forever(poll_interval_seconds=2, stop_event=stopped)


if __name__ == "__main__":
    main()
