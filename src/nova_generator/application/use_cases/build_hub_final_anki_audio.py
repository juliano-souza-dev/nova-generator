from __future__ import annotations

import re
from typing import Any

from nova_generator.domain.exports import AnkiAudioExport

_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def add_anki_audio(
    hub_final: dict[str, Any], *, export: AnkiAudioExport,
    youtube_video_id: str | None = None, direct_audio_base_url: str | None = None,
) -> dict[str, Any]:
    """Attach one or both approved Card-audio delivery modes to ``hub_final``.

    Files are addressed deterministically as ``card-0001.wav`` and are never
    inferred from the source-video timeline.  The Hub can prefer hosted files
    and retain the YouTube reel as a fallback when both are supplied.
    """
    raw_youtube = (youtube_video_id or "").strip()
    base_url = (direct_audio_base_url or "").strip().rstrip("/")
    if not raw_youtube and not base_url:
        raise ValueError("Informe um reel do YouTube ou a URL base dos áudios hospedados.")
    if raw_youtube and not _YOUTUBE_ID.fullmatch(raw_youtube):
        raise ValueError("O ID de vídeo do YouTube deve ter 11 caracteres válidos.")
    if base_url and not (base_url.startswith("https://") or base_url.startswith("http://") or base_url.startswith("/")):
        raise ValueError("A URL base dos áudios deve começar com https://, http:// ou /.")

    result = dict(hub_final)
    audio: dict[str, Any] = {}
    if raw_youtube:
        audio["youtube"] = {"video_id": raw_youtube}
        audio["cues"] = [
            {
                "cue_order": interval.cue_order,
                "start_ms": interval.start_ms,
                "end_ms": interval.end_ms,
                "voice_id": str(export.voice.profile_id),
                "voice_name": export.voice.name,
                "variant_index": 0,
            }
            for interval in export.intervals
        ]
    if base_url:
        audio["direct"] = {
            "base_url": base_url,
            "cards": [
                {"cue_order": interval.cue_order, "file": f"card-{interval.cue_order:04d}.wav"}
                for interval in export.intervals
            ],
        }
    result["ankiAudio"] = audio
    return result


def add_manual_youtube_anki_audio(
    hub_final: dict[str, Any], *, youtube_video_id: str, export: AnkiAudioExport
) -> dict[str, Any]:
    """Backward-compatible YouTube-only wrapper."""
    return add_anki_audio(hub_final, export=export, youtube_video_id=youtube_video_id)
