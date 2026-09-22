from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import (
    Cue,
    EditorialRevision,
    Project,
    Scene,
    WordTiming,
)


class LegacyEditorialImportError(ValueError):
    pass


class ImportLegacyEditorialProject:
    """Import a legacy canonical JSON as an auditable initial editorial revision."""

    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, document: dict[str, Any], *, legacy_key: str, imported_by: str) -> UUID:
        project_data = _object(document, "project")
        cues_data = document.get("cues")
        if not isinstance(cues_data, list) or not cues_data:
            raise LegacyEditorialImportError("O documento legado precisa conter cues não vazios.")
        duration_ms = _positive_int(project_data.get("scene_duration_ms"), "project.duration_ms")
        project_id = _stable_id("project", legacy_key)
        scene_id = _stable_id("scene", legacy_key, "1")
        raw_title = project_data.get("youtube_title") or project_data.get("youtube") or legacy_key
        title = _literal(raw_title, "project.title")
        self._repository.save_project(
            Project(
                project_id,
                title,
                str(project_data.get("content_type") or "dialogue"),
                {"source": "legacy/generator-base", "legacy_key": legacy_key},
            )
        )
        self._repository.save_scene(
            Scene(
                scene_id,
                project_id,
                1,
                duration_ms,
                _optional_literal(project_data.get("youtube_video_id")),
                {
                    "timeline": str(project_data.get("timeline") or "scene_local_ms"),
                    "source": "legacy",
                },
            )
        )
        snapshot_cues: list[dict[str, Any]] = []
        for index, raw_cue in enumerate(cues_data, start=1):
            cue, words, snapshot = _legacy_cue(raw_cue, scene_id, legacy_key, index, duration_ms)
            self._repository.save_cue(cue, words)
            snapshot_cues.append(snapshot)
        snapshot = {"project": project_data, "cues": snapshot_cues}
        self._repository.save_revision(
            EditorialRevision(
                _stable_id("revision", legacy_key, "initial-import"),
                project_id,
                scene_id,
                None,
                1,
                "import_legacy_canonical",
                imported_by,
                "legacy/generator-base",
                {},
                snapshot,
                datetime.now(UTC),
            )
        )
        return project_id


def _legacy_cue(
    raw: object,
    scene_id: UUID,
    key: str,
    fallback_order: int,
    duration: int,
) -> tuple[Cue, list[WordTiming], dict[str, Any]]:
    if not isinstance(raw, dict):
        raise LegacyEditorialImportError("Cada cue legado precisa ser um objeto.")
    order = _positive_int(raw.get("order", fallback_order), "cue.order")
    speech_start = _non_negative_int(raw.get("speech_start_ms"), "cue.speech_start_ms")
    speech_end = _positive_int(raw.get("speech_end_ms"), "cue.speech_end_ms")
    if speech_start >= speech_end or speech_end > duration:
        raise LegacyEditorialImportError("Timing de fala legado inválido.")
    cue_id = _stable_id("cue", key, str(order))
    original_en = _literal(raw.get("original_en") or raw.get("approved_en"), "cue.original_en")
    approved_en = _literal(raw.get("approved_en") or original_en, "cue.approved_en")
    approved_pt = _literal(
        raw.get("approved_pt") if "approved_pt" in raw else raw.get("pt", ""),
        "cue.approved_pt",
        allow_empty=True,
    )
    cue = Cue(
        cue_id,
        scene_id,
        order,
        speech_start,
        speech_end,
        _non_negative_int(raw.get("subtitle_start_ms", speech_start), "cue.subtitle_start"),
        _positive_int(raw.get("subtitle_end_ms", speech_end), "cue.subtitle_end"),
        _optional_literal(raw.get("speaker")) or "",
        original_en,
        approved_en,
        approved_pt,
        1,
        {"source": "legacy", "legacy_order": order},
    )
    raw_words = raw.get("words")
    if not isinstance(raw_words, list):
        raise LegacyEditorialImportError("Cada cue legado precisa conter words.")
    words = [
        _legacy_word(item, cue_id, key, order, position, speech_start, speech_end)
        for position, item in enumerate(raw_words, 1)
    ]
    return (
        cue,
        words,
        {
            "id": str(cue_id),
            "order": order,
            "original_en": original_en,
            "approved_en": approved_en,
            "approved_pt": approved_pt,
        },
    )


def _legacy_word(
    raw: object,
    cue_id: UUID,
    key: str,
    cue_order: int,
    position: int,
    lower: int,
    upper: int,
) -> WordTiming:
    if not isinstance(raw, dict):
        raise LegacyEditorialImportError("Cada palavra legado precisa ser um objeto.")
    start = _non_negative_int(raw.get("start_ms"), "word.start_ms")
    end = _positive_int(raw.get("end_ms"), "word.end_ms")
    if not lower <= start < end <= upper:
        raise LegacyEditorialImportError("Timing de palavra legado fora do cue.")
    return WordTiming(
        _stable_id("word", key, str(cue_order), str(position)),
        cue_id,
        position,
        _literal(raw.get("text"), "word.text"),
        start,
        end,
        _non_negative_int(raw.get("original_start_ms", start), "word.original_start_ms"),
        _positive_int(raw.get("original_end_ms", end), "word.original_end_ms"),
        {"source": "legacy", "payload": raw},
    )


def _stable_id(*parts: str) -> UUID:
    return uuid5(NAMESPACE_URL, "nova-generator/" + "/".join(parts))


def _object(value: dict[str, Any], key: str) -> dict[str, Any]:
    child = value.get(key)
    if not isinstance(child, dict):
        raise LegacyEditorialImportError(f"{key} precisa ser um objeto.")
    return child


def _literal(value: object, name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise LegacyEditorialImportError(f"{name} precisa ser texto literal.")
    return value


def _optional_literal(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _non_negative_int(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise LegacyEditorialImportError(f"{name} precisa ser inteiro não negativo.")
    return value


def _positive_int(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise LegacyEditorialImportError(f"{name} precisa ser inteiro positivo.")
    return value
