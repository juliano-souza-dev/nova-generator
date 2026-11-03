"""Build a bounded, immutable TikTok practice from an approved Shadowing plan."""

from __future__ import annotations

from typing import Any

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.prepare_shadowing import PrepareShadowing
from nova_generator.core.settings import get_settings
from nova_generator.domain.tiktok_media import MediaProject

MIN_TIKTOK_MS = 35_000
MAX_TIKTOK_MS = 60_000


class TikTokShadowingError(ValueError):
    pass


def resolve_tiktok_shadowing(
    project: MediaProject, repository: EditorialProjectRepository
) -> tuple[list[dict[str, Any]], int]:
    """Return selected blocks in source order after checking approval and both hashes.

    Re-evaluate this when queueing *and* when publishing: editorial edits or
    newly approved Shadowing plans must invalidate old TikTok selections.
    """
    clip = project.shadowing_clip
    if (
        project.format != "shadowing_video"
        or project.source_project_id is None
        or project.source_scene_id is None
        or project.source_cut_job_id is not None
        or clip is None
        or not clip.block_ids
    ):
        raise TikTokShadowingError("Selecione blocos de uma cena do Shadowing do Generator.")
    try:
        plan = PrepareShadowing(repository, get_settings().project_root).scene(
            project.source_project_id, project.source_scene_id
        )
    except ValueError as exc:
        raise TikTokShadowingError("A cena mudou. Reabra e aprove seu Shadowing.") from exc
    if plan["status"] != "approved":
        raise TikTokShadowingError("Aprove o Shadowing na área do projeto antes de exportar.")
    if (
        plan["source_sha256"] != clip.source_sha256
        or plan["plan_sha256"] != clip.plan_sha256
    ):
        raise TikTokShadowingError("O Shadowing foi alterado. Importe os blocos atualizados.")
    selected = set(clip.block_ids)
    blocks = [block for block in plan["blocks"] if block["id"] in selected]
    if len(blocks) != len(clip.block_ids):
        raise TikTokShadowingError("Um dos blocos selecionados não existe mais no Shadowing.")
    for block in blocks:
        if block["start_ms"] < 0 or block["end_ms"] > plan["duration_ms"]:
            raise TikTokShadowingError("Um bloco ultrapassa a duração da cena.")
    total = sum(
        block["end_ms"] - block["start_ms"] + block["pause_duration_ms"]
        for block in blocks
    )
    if not MIN_TIKTOK_MS <= total <= MAX_TIKTOK_MS:
        raise TikTokShadowingError(
            f"Escolha de 35 a 60 segundos de prática (seleção atual: {total / 1000:.1f} s)."
        )
    return blocks, total
