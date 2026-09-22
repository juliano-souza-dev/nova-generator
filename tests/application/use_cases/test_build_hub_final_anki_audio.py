from pathlib import Path
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.build_hub_final_anki_audio import (
    add_manual_youtube_anki_audio,
)
from nova_generator.domain.exports import AnkiAudioExport, ReelInterval
from nova_generator.domain.voices import VoiceProfile


def _export() -> AnkiAudioExport:
    voice = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    interval = ReelInterval(1, 0, 1000, "b" * 64, "c" * 64)
    return AnkiAudioExport(
        Path("anki.apkg"), Path("reel.mp4"), Path("manifest.json"), voice, (interval,)
    )


def test_manual_youtube_id_builds_hub_contract_without_uploading() -> None:
    document = add_manual_youtube_anki_audio({}, youtube_video_id="dQw4w9WgXcQ", export=_export())
    assert document["ankiAudio"]["youtube"]["video_id"] == "dQw4w9WgXcQ"
    assert document["ankiAudio"]["cues"][0]["start_ms"] == 0


def test_invalid_youtube_id_is_rejected() -> None:
    with pytest.raises(ValueError, match="YouTube"):
        add_manual_youtube_anki_audio({}, youtube_video_id="invalid", export=_export())
