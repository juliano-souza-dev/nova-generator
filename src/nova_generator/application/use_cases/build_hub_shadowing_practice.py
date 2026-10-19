"""Convert approved Generator Shadowing groups to the iHub v3 player contract.

All media times are derived from the published cue timeline, never from Anki
reel timings. Draft/stale plans are intentionally excluded.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.prepare_shadowing import PrepareShadowing, ShadowingError
from nova_generator.domain.projects.entities import Cue, Scene


def build_hub_shadowing_practice(
    *,
    project_id: UUID,
    repository: EditorialProjectRepository,
    project_root: Path,
    scenes: list[Scene],
    cues: list[Cue],
    cue_times: list[tuple[int, int]],
    playback_start_ms: int,
    playback_end_ms: int,
) -> dict[str, Any] | None:
    """Return a source-locked, iHub-compatible approved plan, or None.

    Partial Anki exports keep only fully exported approved Shadowing groups.
    Scene-local cue IDs are mapped to the *published* cue order and source time.
    """
    if len(cues) != len(cue_times):
        raise ValueError("Shadowing: cue/time count mismatch")
    duration_ms = playback_end_ms - playback_start_ms
    if duration_ms <= 0:
        raise ValueError("Shadowing: invalid published playback window")

    published = {
        str(cue.id): (order, cue.scene_id, start_ms, end_ms)
        for order, (cue, (start_ms, end_ms)) in enumerate(zip(cues, cue_times, strict=True), 1)
    }
    published_scenes = {cue.scene_id for cue in cues}
    planner = PrepareShadowing(repository, project_root)
    groups: list[dict[str, Any]] = []
    approved_sources: list[dict[str, str]] = []

    for scene in scenes:
        if scene.id not in published_scenes:
            continue
        try:
            plan = planner.scene(project_id, scene.id)
        except ShadowingError:
            # The Anki export is still valid without a prepared Shadowing plan.
            continue
        if plan.get("status") != "approved" or not plan.get("blocks"):
            continue

        scene_groups = 0
        for group in plan["blocks"]:
            cue_ids = group.get("cue_ids", [])
            if not cue_ids or any(str(cue_id) not in published for cue_id in cue_ids):
                continue
            source = [published[str(cue_id)] for cue_id in cue_ids]
            if any(item[1] != scene.id for item in source):
                raise ValueError("Shadowing: group references a cue in another scene")
            orders = [item[0] for item in source]
            if orders != sorted(orders) or len(set(orders)) != len(orders):
                raise ValueError("Shadowing: group cue order is invalid")

            start_ms = source[0][2] - playback_start_ms
            end_ms = source[-1][3] - playback_start_ms
            if not 0 <= start_ms < end_ms <= duration_ms:
                raise ValueError("Shadowing: approved group is outside the published clip")
            pause_ms = int(group["pause_duration_ms"])
            if pause_ms <= 0:
                raise ValueError("Shadowing: approved group has no repetition pause")

            groups.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "pause_at_ms": end_ms,
                "speech_duration_ms": end_ms - start_ms,
                "pause_duration_ms": pause_ms,
                "repeat_ms": pause_ms,
                "cueOrders": orders,
            })
            scene_groups += 1
        if scene_groups:
            approved_sources.append({
                "scene_id": str(scene.id),
                "source_sha256": str(plan["source_sha256"]),
                "plan_sha256": str(plan["plan_sha256"]),
            })

    if not groups:
        return None

    groups.sort(key=lambda group: group["start_ms"])
    for index, group in enumerate(groups):
        next_group = groups[index + 1] if index + 1 < len(groups) else None
        if next_group is not None and group["end_ms"] > next_group["start_ms"]:
            raise ValueError("Shadowing: approved groups overlap on the published timeline")
        group.update({
            "order": index + 1,
            "terminal": next_group is None,
            "boundary_type": "final_end" if next_group is None else "segment_end",
            "continue_at_ms": None if next_group is None else next_group["start_ms"],
        })

    return {
        "version": 3,
        "enabled": True,
        "mode": "discontinuous_segments",
        "timeline": "scene_relative_ms",
        "scene_duration_ms": duration_ms,
        "source_window": {"start_ms": 0, "end_ms": duration_ms},
        "source_windows": [
            {"start_ms": group["start_ms"], "end_ms": group["end_ms"]}
            for group in groups
        ],
        "blocks": groups,
        "generator": {
            "source_contract": "nova-generator-shadowing/2.0",
            "approved_sources": approved_sources,
        },
    }
