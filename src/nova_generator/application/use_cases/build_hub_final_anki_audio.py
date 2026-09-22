from __future__ import annotations

import re
from typing import Any

from nova_generator.domain.exports import AnkiAudioExport

_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def add_manual_youtube_anki_audio(
    hub_final: dict[str, Any], *, youtube_video_id: str, export: AnkiAudioExport
) -> dict[str, Any]:
    """Add metadata after an operator uploads the reel; this function never uploads media."""
    if not _YOUTUBE_ID.fullmatch(youtube_video_id):
        raise ValueError("O ID de vídeo do YouTube deve ter 11 caracteres válidos.")
    result = dict(hub_final)
    result["ankiAudio"] = {
        "youtube": {"video_id": youtube_video_id},
        "cues": [
            {
                "cue_order": interval.cue_order,
                "start_ms": interval.start_ms,
                "end_ms": interval.end_ms,
                "voice_id": str(export.voice.profile_id),
                "voice_name": export.voice.name,
                "variant_index": 0,
            }
            for interval in export.intervals
        ],
    }
    return result
