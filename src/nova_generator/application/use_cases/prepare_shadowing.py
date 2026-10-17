"""Pre-produce a shadowing exercise from reviewed scenes without changing editorial data."""

from __future__ import annotations

import json
import os
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import Cue, Scene


class ShadowingError(ValueError):
    pass


CONTRACT = "nova-generator-shadowing/1.0"
MAX_BLOCK_MS = 12_000
MIN_PAUSE_MS = 2_000
MAX_PAUSE_MS = 12_000
PAUSE_MARGIN_MS = 1_500


class PrepareShadowing:
    """Build deterministic blocks; approval is a separate, revision-checked operation."""

    def __init__(self, repository: EditorialProjectRepository, project_root: Path):
        self.repository = repository
        self.project_root = project_root

    def scenes(self, project_id: UUID) -> list[dict[str, Any]]:
        if self.repository.get_project(project_id) is None:
            raise ShadowingError("project not found")
        return [self.scene(project_id, scene.id) for scene in self.repository.get_project_scenes(project_id)]

    def scene(self, project_id: UUID, scene_id: UUID) -> dict[str, Any]:
        project = self.repository.get_project(project_id)
        scene = next(
            (item for item in self.repository.get_project_scenes(project_id) if item.id == scene_id),
            None,
        ) if project is not None else None
        if scene is None:
            raise ShadowingError("scene not found in project")
        cues = sorted(self.repository.get_scene_cues(scene_id), key=lambda item: item.order)
        if not cues:
            raise ShadowingError("scene has no reviewed cues")
        for cue in cues:
            if (
                cue.provenance.get("approval") == "draft"
                or not cue.approved_en.strip()
                or not cue.approved_pt.strip()
            ):
                raise ShadowingError("approve all cues before preparing shadowing")
            if cue.speech_start_ms < 0 or cue.speech_end_ms <= cue.speech_start_ms:
                raise ShadowingError(f"cue {cue.order} has invalid timing")
            if cue.speech_end_ms > scene.duration_ms:
                raise ShadowingError(f"cue {cue.order} exceeds scene duration")
        snapshot = _snapshot(scene, cues)
        fingerprint = sha256(
            json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        ).hexdigest()
        expected = {
            "contract": CONTRACT,
            "project_id": str(project_id),
            "scene_id": str(scene_id),
            "source_sha256": fingerprint,
            "duration_ms": scene.duration_ms,
            "status": "draft",
            "blocks": _blocks(scene, cues),
        }
        path = self._path(project_id, scene_id)
        if path.is_file():
            try:
                stored = json.loads(path.read_text(encoding="utf-8"))
                if (
                    stored.get("contract") == CONTRACT
                    and stored.get("source_sha256") == fingerprint
                    and stored.get("status") == "approved"
                    and stored.get("blocks") == expected["blocks"]
                ):
                    return stored
            except (OSError, ValueError, AttributeError):
                pass
        return expected

    def approve(self, project_id: UUID, scene_id: UUID, source_sha256: str) -> dict[str, Any]:
        plan = self.scene(project_id, scene_id)
        if plan["source_sha256"] != source_sha256:
            raise ShadowingError("editorial content changed; reload shadowing")
        plan = {**plan, "status": "approved"}
        path = self._path(project_id, scene_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        try:
            temp.write_text(
                json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
        return plan

    def _path(self, project_id: UUID, scene_id: UUID) -> Path:
        return self.project_root / str(project_id) / "shadowing" / f"{scene_id}.json"


def _snapshot(scene: Scene, cues: list[Cue]) -> dict[str, Any]:
    return {
        "scene_id": str(scene.id),
        "duration_ms": scene.duration_ms,
        "cues": [
            {
                "id": str(cue.id),
                "order": cue.order,
                "revision": cue.revision,
                "start_ms": cue.speech_start_ms,
                "end_ms": cue.speech_end_ms,
                "en": cue.approved_en,
                "pt": cue.approved_pt,
            }
            for cue in cues
        ],
    }


def _blocks(scene: Scene, cues: list[Cue]) -> list[dict[str, Any]]:
    grouped: list[list[Cue]] = []
    current: list[Cue] = []
    for cue in cues:
        if current and cue.speech_end_ms - current[0].speech_start_ms > MAX_BLOCK_MS:
            grouped.append(current)
            current = []
        current.append(cue)
    if current:
        grouped.append(current)

    blocks: list[dict[str, Any]] = []
    previous_end = 0
    for index, group in enumerate(grouped):
        end_ms = group[-1].speech_end_ms
        # Include the silence between blocks in the following block.
        start_ms = previous_end
        pause_ms = max(MIN_PAUSE_MS, min(MAX_PAUSE_MS, end_ms - start_ms + PAUSE_MARGIN_MS))
        blocks.append(
            {
                "id": f"block-{index + 1}",
                "start_ms": start_ms,
                "end_ms": end_ms,
                "pause_duration_ms": pause_ms,
                "cue_ids": [str(cue.id) for cue in group],
                "en": " ".join(cue.approved_en for cue in group),
                "pt": " ".join(cue.approved_pt for cue in group),
            }
        )
        previous_end = end_ms
    return blocks
