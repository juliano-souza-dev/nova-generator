"""Transport only approved, unmodified Shadowing plans to the iHub player.

This module does not choose groups, adjust pauses, or regenerate Shadowing.
It extends the *published scene transcript*, independently of which Anki
exercises were selected, so every approved Shadowing block can be played.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import (
    EditorialProjectRepository,
)
from nova_generator.application.use_cases.prepare_shadowing import (
    PrepareShadowing,
    ShadowingError,
)
from nova_generator.domain.projects.entities import Cue, Scene, WordTiming


class ShadowingPublicationError(ValueError):
    """The approved plan cannot be represented by the frozen publication."""


@dataclass(frozen=True)
class ShadowingTransport:
    plans: tuple[dict[str, Any], ...]
    additional_cues: tuple[Cue, ...]


def approved_shadowing_transport(
    repository: EditorialProjectRepository,
    project_root: Path,
    project_id: UUID,
    scenes: list[Scene],
    selected_cues: list[Cue],
) -> ShadowingTransport:
    """Read stored approvals, then revalidate them with the original authoring code."""
    selected_ids = {cue.id for cue in selected_cues}
    scene_ids = {cue.scene_id for cue in selected_cues}
    authoring = PrepareShadowing(repository, project_root)
    plans: list[dict[str, Any]] = []
    extras: list[Cue] = []
    for scene in scenes:
        if scene.id not in scene_ids:
            continue
        saved_path = project_root / str(project_id) / "shadowing" / f"{scene.id}.json"
        if not saved_path.is_file():
            continue
        try:
            stored = json.loads(saved_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ShadowingPublicationError(
                f"Plano Shadowing da cena {scene.id} não pode ser lido."
            ) from error
        if not isinstance(stored, dict) or stored.get("status") != "approved":
            continue
        try:
            plan = authoring.scene(project_id, scene.id)
        except ShadowingError as error:
            raise ShadowingPublicationError(
                f"Shadowing aprovado da cena {scene.id} ficou inválido: {error}"
            ) from error
        if plan.get("status") != "approved" or not plan.get("blocks"):
            raise ShadowingPublicationError(
                f"Shadowing da cena {scene.id} foi alterado após aprovação. "
                "Revise e aprove novamente antes de publicar."
            )
        if (
            plan.get("contract") != "nova-generator-shadowing/2.0"
            or plan.get("plan_sha256") != stored.get("plan_sha256")
            or plan.get("source_sha256") != stored.get("source_sha256")
        ):
            raise ShadowingPublicationError(
                f"Shadowing aprovado da cena {scene.id} diverge da fonte."
            )
        plans.append(plan)
        for cue in sorted(repository.get_scene_cues(scene.id), key=lambda item: item.order):
            if cue.id not in selected_ids:
                extras.append(cue)
                selected_ids.add(cue.id)
    return ShadowingTransport(tuple(plans), tuple(extras))


def additional_shadowing_cue(
    cue: Cue,
    words: list[WordTiming],
    timing: tuple[int, int],
    *,
    origin_ms: int,
) -> dict[str, Any]:
    """Represent the existing approved cue, with no invented Anki lesson."""
    if (
        cue.provenance.get("approval") == "draft"
        or not cue.approved_en.strip()
        or not cue.approved_pt.strip()
        or (
            "".join(word.surface for word in words)
            + str(cue.provenance.get("editorial_preparation_trailing", ""))
            != cue.approved_en
        )
    ):
        raise ShadowingPublicationError(
            f"Cue {cue.id} do Shadowing precisa de revisão editorial."
        )
    start, end = timing
    if end <= start:
        raise ShadowingPublicationError(f"Tempo inválido na cue {cue.id}.")
    return {
        "order": cue.order,
        "speaker": cue.speaker,
        "original_en": cue.original_en,
        "approved_en": cue.approved_en,
        "final_en": cue.approved_en,
        "pt": cue.approved_pt,
        "trailing": str(cue.provenance.get("editorial_preparation_trailing", "")),
        "start": (start - origin_ms) / 1000,
        "end": (end - origin_ms) / 1000,
        "speech_start_ms": start - origin_ms,
        "speech_end_ms": end - origin_ms,
        "subtitle_start_ms": start - origin_ms,
        "subtitle_end_ms": end - origin_ms,
        "words": [
            {
                "text": word.surface,
                "start_ms": word.start_ms + start - cue.speech_start_ms - origin_ms,
                "end_ms": word.end_ms + start - cue.speech_start_ms - origin_ms,
                "original_start_ms": (
                    word.original_start_ms + start - cue.speech_start_ms - origin_ms
                ),
                "original_end_ms": (
                    word.original_end_ms + start - cue.speech_start_ms - origin_ms
                ),
            }
            for word in words
        ],
        "anki": {"include": False, "items": []},
    }


def attach_approved_shadowing(
    document: dict[str, Any],
    *,
    selected_cues: list[Cue],
    additional_cues: tuple[Cue, ...],
    plans: tuple[dict[str, Any], ...],
    times_by_id: dict[str, tuple[int, int]],
    words_by_id: dict[str, list[WordTiming]],
    origin_ms: int,
    didactic: bool,
    card_to_cue: dict[str, str] | None = None,
) -> None:
    """Synchronize cues, IDs and audio links; keep approved plans unchanged."""
    if not plans:
        return
    selected_ids = list(dict.fromkeys(str(cue.id) for cue in selected_cues))
    if not didactic and additional_cues:
        raise ShadowingPublicationError(
            "O Anki legado selecionou apenas parte das falas aprovadas para Shadowing. "
            "Use a exportação Anki didática para incluir a cena completa."
        )
    rows = document.get("cues", [])
    if len(rows) != len(selected_ids):
        raise ShadowingPublicationError("Cues do iHub não coincidem com a seleção Anki.")
    by_id = dict(zip(selected_ids, rows, strict=True))
    for cue in additional_cues:
        by_id[str(cue.id)] = additional_shadowing_cue(
            cue,
            words_by_id[str(cue.id)],
            times_by_id[str(cue.id)],
            origin_ms=origin_ms,
        )
    ordered_ids = sorted(
        by_id,
        key=lambda cue_id: (times_by_id[cue_id][0], times_by_id[cue_id][1], cue_id),
    )
    for previous, current in zip(ordered_ids, ordered_ids[1:], strict=False):
        if times_by_id[previous][1] > times_by_id[current][0]:
            raise ShadowingPublicationError(
                "As cues do Shadowing se sobrepõem na cena publicada."
            )
    for order, cue_id in enumerate(ordered_ids, 1):
        by_id[cue_id]["order"] = order
    document["cues"] = [by_id[cue_id] for cue_id in ordered_ids]
    document["generator"]["source_cue_ids"] = ordered_ids
    if didactic:
        index = {cue_id: order for order, cue_id in enumerate(ordered_ids, 1)}
        for interval in document.get("ankiAudio", {}).get("cues", []):
            key = interval.get("card_key")
            cue_id = (card_to_cue or {}).get(key)
            if cue_id is None or cue_id not in index:
                raise ShadowingPublicationError(
                    f"Áudio Anki {key} sem vínculo com a cue original."
                )
            interval["source_cue_order"] = index[cue_id]
    source = set(ordered_ids)
    for plan in plans:
        for block in plan["blocks"]:
            if not set(block["cue_ids"]).issubset(source):
                raise ShadowingPublicationError(
                    "O plano aprovado contém cue ausente na publicação iHub."
                )
        for item in plan["source_cues"]:
            cue_id = str(item["id"])
            if cue_id not in by_id:
                continue
            row = by_id[cue_id]
            if (
                str(item["en"]).strip() != str(row["final_en"]).strip()
                or str(item["pt"]).strip() != str(row["pt"]).strip()
            ):
                raise ShadowingPublicationError(
                    f"Texto aprovado Shadowing não coincide com cue {cue_id}."
                )
    document["generatorShadowing"] = list(plans)
