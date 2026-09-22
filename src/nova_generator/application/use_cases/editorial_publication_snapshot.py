"""Fingerprint the reviewed editorial data that a materials export will publish."""

from __future__ import annotations

import json
from hashlib import sha256

from nova_generator.domain.projects.entities import Cue, Project, Scene, WordTiming


def editorial_publication_sha256(
    project: Project,
    scenes: list[Scene],
    cards: list[tuple[Cue, list[WordTiming]]],
) -> str:
    by_id = {scene.id: scene for scene in scenes}
    payload = {
        "project": {
            "title": project.title,
            "content_type": project.content_type,
            "youtube_url": project.provenance.get("youtube_url"),
        },
        "cards": [],
    }
    for cue, words in cards:
        scene = by_id.get(cue.scene_id)
        if scene is None or scene.project_id != project.id:
            raise ValueError(f"Scene for card {cue.id} is missing from project")
        payload["cards"].append(
            {
                "cue_id": str(cue.id),
                "scene_id": str(scene.id),
                "scene_order": scene.order,
                "scene_source_video_id": scene.source_video_id,
                "scene_ingest_job_id": scene.provenance.get("ingest_job_id"),
                "cue_order": cue.order,
                "speech_start_ms": cue.speech_start_ms,
                "speech_end_ms": cue.speech_end_ms,
                "subtitle_start_ms": cue.subtitle_start_ms,
                "subtitle_end_ms": cue.subtitle_end_ms,
                "speaker": cue.speaker,
                "original_en": cue.original_en,
                "approved_en": cue.approved_en,
                "approved_pt": cue.approved_pt,
                "tags": cue.provenance.get("tags"),
                "words": [
                    {
                        "id": str(word.id),
                        "order": word.order,
                        "surface": word.surface,
                        "start_ms": word.start_ms,
                        "end_ms": word.end_ms,
                        "original_start_ms": word.original_start_ms,
                        "original_end_ms": word.original_end_ms,
                    }
                    for word in words
                ],
            }
        )
    return sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
