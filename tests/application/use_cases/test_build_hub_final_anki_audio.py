from pathlib import Path
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.build_hub_final_anki_audio import (
    add_anki_audio,
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


def test_direct_audio_builds_deterministic_card_mapping() -> None:
    document = add_anki_audio(
        {}, export=_export(), direct_audio_base_url="https://cdn.example.test/kit-9/audio"
    )
    assert document["ankiAudio"]["direct"] == {
        "base_url": "https://cdn.example.test/kit-9/audio",
        "cards": [{"cue_order": 1, "file": "card-0001.wav"}],
    }

def test_audio_source_is_required() -> None:
    with pytest.raises(ValueError, match="reel do YouTube ou a URL base"):
        add_anki_audio({}, export=_export())
