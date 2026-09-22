from __future__ import annotations

import re
from typing import Any

from nova_generator.domain.stories.render import StoryRender

_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def build_story_text_audio_export(
    render: StoryRender, *, youtube_video_id: str, description: str = ""
) -> dict[str, Any]:
    """Create the iHub payload only after manual upload supplies a verified ID."""
    if not _YOUTUBE_ID.fullmatch(youtube_video_id):
        raise ValueError("O ID de vídeo do YouTube deve ter 11 caracteres válidos.")
    if not render.final_video_path.is_file() or render.final_video_path.stat().st_size == 0:
        raise ValueError("O vídeo final da história não está disponível para publicação manual.")
    cursor = 0
    cues = []
    for rendered in render.cues:
        end = cursor + rendered.duration_ms
        cues.append(
            {
                "order": rendered.cue.order,
                "startMs": cursor,
                "endMs": end,
                "en": rendered.cue.en,
                "pt": rendered.cue.pt,
                "highlights": [
                    {"text": h.text, "type": h.type, "pt": h.pt, "occurrence": h.occurrence}
                    for h in rendered.cue.highlights
                ],
            }
        )
        cursor = end
    return {
        "schema": "immersionhub-text-audio",
        "schema_version": "1.1",
        "mode": "story",
        "title": render.package.title,
        "description": description,
        "youtubeUrl": f"https://www.youtube.com/watch?v={youtube_video_id}",
        "youtubeVideoId": youtube_video_id,
        "durationMs": cursor,
        "cues": cues,
    }
