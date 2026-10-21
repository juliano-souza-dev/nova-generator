"""Transport independently authored English-in-Context lessons from the external AI.

Pedagogical text is never generated from Anki cards.  Stable editorial word IDs
are the link between the external response and the approved source timeline.
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import Cue


class StructuresInContextError(ValueError):
    """The external pedagogical material does not match the published source."""


def _token(value: object) -> str:
    value = unicodedata.normalize("NFKC", str(value or ""))
    for apostrophe in ("’", "‘", "`", "´"):
        value = value.replace(apostrophe, "'")
    text = value.casefold()
    start, end = 0, len(text)
    while start < end and not (text[start].isalnum() or text[start] == "'"):
        start += 1
    while end > start and not (text[end - 1].isalnum() or text[end - 1] == "'"):
        end -= 1
    return text[start:end]


def _tokens(value: object) -> list[str]:
    return [token for part in str(value).split() if (token := _token(part))]


def prepare_external_structures(suggestions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate AI selections against its *own* approved editorial word list.

    Every selected expression must have word IDs in the correct, contiguous
    order.  No artificial durations or Anki-derived text are introduced.
    """
    prepared: list[dict[str, Any]] = []
    for suggestion in suggestions:
        words = suggestion.get("word_translations", [])
        word_ids = [str(word.get("word_id", "")) for word in words]
        cue_id = str(suggestion["cue_id"])
        for practice in suggestion.get("context_practices", []):
            selected = [str(word_id) for word_id in practice["word_ids"]]
            try:
                positions = [word_ids.index(word_id) for word_id in selected]
            except ValueError as error:
                raise StructuresInContextError(
                    f"English in Context cue {cue_id}: unknown word ID"
                ) from error
            if len(set(positions)) != len(positions) or positions != list(
                range(positions[0], positions[-1] + 1)
            ):
                raise StructuresInContextError(
                    f"English in Context cue {cue_id}: word IDs must be contiguous"
                )
            source_text = "".join(
                str(words[index].get("leading") or "")
                + str(words[index].get("surface") or "")
                for index in positions
            ).strip()
            expression = str(practice["expression_en"]).strip()
            if _tokens(source_text) != _tokens(expression):
                raise StructuresInContextError(
                    f"English in Context cue {cue_id}: expression {expression!r} "
                    "does not match the selected editorial words"
                )
            prepared.append({
                "source_cue_id": cue_id,
                "word_ids": selected,
                "type": str(practice["type"]),
                "expression_en": expression,
                "meaning_pt": str(practice["meaning_pt"]),
                "explanation_pt": str(practice["explanation_pt"]),
                "example_en": str(practice["example_en"]),
                "example_pt": str(practice["example_pt"]),
            })
    return prepared


def external_structures_path(
    project_root: Path, project_id: UUID, scene_id: UUID
) -> Path:
    return (
        project_root / str(project_id) / "editorial-ai"
        / f"scene-{scene_id}-english-in-context.json"
    )


def write_external_structures(
    project_root: Path, project_id: UUID, scene_id: UUID,
    source_sha256: str, suggestions: list[dict[str, Any]],
) -> None:
    practices = prepare_external_structures(suggestions)
    path = external_structures_path(project_root, project_id, scene_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "contract": "nova-generator-english-in-context/1.0",
        "scene_id": str(scene_id),
        "input_sha256": source_sha256,
        "wbw_practices": practices,
    }
    temporary = path.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_external_structures(
    project_root: Path, project_id: UUID, scene_ids: list[UUID]
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for scene_id in scene_ids:
        path = external_structures_path(project_root, project_id, scene_id)
        if path.exists():
            body = json.loads(path.read_text(encoding="utf-8"))
            if body.get("scene_id") != str(scene_id) or not isinstance(
                body.get("wbw_practices"), list
            ):
                raise StructuresInContextError("Saved English in Context file is invalid")
            results.extend(body["wbw_practices"])
    return results


def resolve_external_context_cues(
    practices: list[dict[str, Any]],
    scenes: list[Any],
    repository: EditorialProjectRepository,
) -> list[Cue]:
    """Find approved source cues even when a speaker split changed cue IDs."""
    candidates = [
        cue for scene in scenes for cue in repository.get_scene_cues(scene.id)
    ]
    ids_by_cue = {
        cue.id: [str(word.id) for word in repository.get_cue_words(cue.id)]
        for cue in candidates
    }
    selected: dict[UUID, Cue] = {}
    for practice in practices:
        word_ids = [str(value) for value in practice["word_ids"]]
        possible = []
        for cue in candidates:
            ids = ids_by_cue[cue.id]
            if all(word_id in ids for word_id in word_ids):
                positions = [ids.index(word_id) for word_id in word_ids]
                if positions == list(range(positions[0], positions[-1] + 1)):
                    possible.append(cue)
        if len(possible) != 1:
            raise StructuresInContextError(
                f"External English in Context {practice['expression_en']!r} "
                "no longer matches a unique approved source cue"
            )
        cue = possible[0]
        if cue.provenance.get("approval") == "draft":
            raise StructuresInContextError(
                f"English in Context source cue {cue.id} still needs approval"
            )
        selected[cue.id] = cue
    return list(selected.values())


def publish_external_structures(
    *,
    practices: list[dict[str, Any]],
    source_rows: list[tuple[Cue, dict[str, Any]]],
    repository: EditorialProjectRepository,
) -> list[dict[str, Any]]:
    """Bind stored AI material to the current published source cue and words.

    The iHub requires cue_order, contiguous word_indexes and actual timing in
    the published audio timeline. Incompatible editorial edits fail visibly.
    """
    candidates = []
    for cue, row in source_rows:
        words = repository.get_cue_words(cue.id)
        candidates.append((row, words))
    published = []
    for practice in practices:
        wanted = [str(item) for item in practice["word_ids"]]
        matches = []
        for row, words in candidates:
            lookup = {str(word.id): index for index, word in enumerate(words)}
            if all(word_id in lookup for word_id in wanted):
                indexes = [lookup[word_id] for word_id in wanted]
                if indexes == list(range(indexes[0], indexes[-1] + 1)):
                    matches.append((row, indexes))
        if len(matches) != 1:
            raise StructuresInContextError(
                f"English in Context {practice['expression_en']!r} cannot be "
                "associated unambiguously with a published cue"
            )
        row, indexes = matches[0]
        word_rows = row["words"]
        expression = str(practice["expression_en"])
        if _tokens(expression) != [
            _token(word_rows[index]["text"])
            for index in indexes
            if _token(word_rows[index]["text"])
        ]:
            raise StructuresInContextError(
                f"English in Context {expression!r} no longer matches the approved text"
            )
        start = int(word_rows[indexes[0]]["start_ms"])
        end = int(word_rows[indexes[-1]]["end_ms"])
        if start < 0 or end <= start:
            raise StructuresInContextError(
                f"English in Context {expression!r} has invalid word times"
            )
        published.append({
            "cue_order": int(row["order"]),
            "type": practice["type"],
            "highlight": expression,
            "expression_en": expression,
            "word_indexes": indexes,
            "context_en": str(row["approved_en"]),
            "context_pt": str(row["pt"]),
            "meaning_pt": practice["meaning_pt"],
            "explanation_pt": practice["explanation_pt"],
            "examples": [{"en": practice["example_en"], "pt": practice["example_pt"]}],
            "example_en": practice["example_en"],
            "example_pt": practice["example_pt"],
            "start_ms": start,
            "end_ms": end,
        })
    return published
