"""Validation for the private ``generator-story`` 1.0 ZIP input contract.

This module deliberately has no HTTP, database, renderer, or TTS dependency.
It validates an archive before anything is extracted, so callers can safely use
the returned literal story data to create a Story production.
"""

from __future__ import annotations

import io
import json
import posixpath
import zipfile
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, TypeGuard

_STORY_FILE = "story.json"
_IMAGE_PREFIX = "images/"
_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_HIGHLIGHT_TYPES = {"important_word", "structure", "phrasal_verb"}
_MAX_IMAGES = 80
_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024


@dataclass(frozen=True)
class ValidationIssue:
    """A field-level reason an input package cannot become a Story project."""

    path: str
    message: str

    def __str__(self) -> str:
        return f"{self.path}: {self.message}"


class StoryPackageViolation(ValueError):
    """Raised when a ZIP fails one or more input-contract rules."""

    def __init__(self, issues: list[ValidationIssue]) -> None:
        self.issues = tuple(issues)
        super().__init__("; ".join(str(issue) for issue in issues))


@dataclass(frozen=True)
class Highlight:
    text: str
    type: str
    pt: str
    occurrence: int


@dataclass(frozen=True)
class StoryCue:
    order: int
    image: str
    en: str
    pt: str
    highlights: tuple[Highlight, ...]


@dataclass(frozen=True)
class ImageAsset:
    path: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class StoryPackage:
    title: str
    language: str
    aspect_ratio: str
    cues: tuple[StoryCue, ...]
    images: tuple[ImageAsset, ...]


ArchiveSource = str | Path | BinaryIO | bytes


def validate_story_package(archive: ArchiveSource) -> StoryPackage:
    """Return a validated story package without extracting the ZIP.

    EN/PT strings and highlight text are returned exactly as UTF-8 decoded from
    ``story.json``. No trimming, normalization, case folding, or punctuation
    rewriting occurs in this layer.
    """
    try:
        with _open_archive(archive) as package:
            return _validate_open_archive(package)
    except zipfile.BadZipFile as exc:
        raise StoryPackageViolation([ValidationIssue("$", "must be a valid ZIP archive")]) from exc


def _open_archive(archive: ArchiveSource) -> zipfile.ZipFile:
    if isinstance(archive, bytes):
        return zipfile.ZipFile(io.BytesIO(archive))
    return zipfile.ZipFile(archive)


def _validate_open_archive(package: zipfile.ZipFile) -> StoryPackage:
    issues: list[ValidationIssue] = []
    entries: dict[str, zipfile.ZipInfo] = {}
    image_infos: dict[str, zipfile.ZipInfo] = {}
    total_uncompressed = 0

    for info in package.infolist():
        if info.is_dir():
            continue
        name = _safe_member_name(info.filename)
        if name is None:
            issues.append(ValidationIssue(f"zip:{info.filename}", "contains an unsafe path"))
            continue
        if name in entries:
            issues.append(ValidationIssue(f"zip:{name}", "is duplicated"))
            continue
        if _is_symlink(info):
            issues.append(ValidationIssue(f"zip:{name}", "must not be a symlink"))
            continue
        entries[name] = info
        total_uncompressed += info.file_size
        if name == _STORY_FILE:
            continue
        if (
            name.startswith(_IMAGE_PREFIX)
            and PurePosixPath(name).suffix.lower() in _IMAGE_EXTENSIONS
        ):
            image_infos[name] = info
            if info.file_size > _MAX_IMAGE_BYTES:
                issues.append(ValidationIssue(f"zip:{name}", "exceeds the 20 MiB image limit"))
        else:
            issues.append(
                ValidationIssue(
                    f"zip:{name}", "is not allowed; only story.json and images are accepted"
                )
            )

    if total_uncompressed > _MAX_ARCHIVE_BYTES:
        issues.append(ValidationIssue("zip", "exceeds the 200 MiB uncompressed limit"))
    if _STORY_FILE not in entries:
        issues.append(ValidationIssue("zip", "must contain exactly one story.json"))
    if len(image_infos) > _MAX_IMAGES:
        issues.append(ValidationIssue("zip:images", "contains more than 80 images"))
    if issues:
        raise StoryPackageViolation(issues)

    document = _load_story_json(package, entries[_STORY_FILE])
    story = _validate_document(document, image_infos)
    assets = tuple(_image_asset(package, path, info) for path, info in sorted(image_infos.items()))
    return StoryPackage(cues=story["cues"], images=assets, **story["metadata"])


def _safe_member_name(name: str) -> str | None:
    if not name or "\\" in name or name.startswith("/"):
        return None
    normalized = posixpath.normpath(name)
    if normalized in {".", ".."} or normalized.startswith("../") or normalized != name:
        return None
    return normalized


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return (info.external_attr >> 16) & 0o170000 == 0o120000


def _load_story_json(package: zipfile.ZipFile, info: zipfile.ZipInfo) -> dict[str, Any]:
    try:
        raw = package.read(info)
        parsed = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise StoryPackageViolation([ValidationIssue("story.json", "must be UTF-8")]) from exc
    except json.JSONDecodeError as exc:
        raise StoryPackageViolation(
            [ValidationIssue("story.json", f"invalid JSON at line {exc.lineno}")]
        ) from exc
    if not isinstance(parsed, dict):
        raise StoryPackageViolation([ValidationIssue("story.json", "must be an object")])
    return parsed


def _validate_document(
    document: dict[str, Any], images: dict[str, zipfile.ZipInfo]
) -> dict[str, Any]:
    issues: list[ValidationIssue] = []
    _expect(
        document.get("schema") == "generator-story", "$.schema", "must be generator-story", issues
    )
    _expect(document.get("schema_version") == "1.0", "$.schema_version", "must be 1.0", issues)
    title = _non_empty_string(document.get("title"), "$.title", issues)
    language = _non_empty_string(document.get("language"), "$.language", issues)
    aspect_ratio = _non_empty_string(document.get("aspect_ratio"), "$.aspect_ratio", issues)
    raw_cues = document.get("cues")
    if not isinstance(raw_cues, list) or not raw_cues:
        issues.append(ValidationIssue("$.cues", "must be a non-empty list"))
        raw_cues = []

    cues: list[StoryCue] = []
    referenced_images: set[str] = set()
    for index, raw_cue in enumerate(raw_cues):
        path = f"$.cues[{index}]"
        if not isinstance(raw_cue, dict):
            issues.append(ValidationIssue(path, "must be an object"))
            continue
        order = raw_cue.get("order")
        if not _is_int(order) or order != index + 1:
            issues.append(ValidationIssue(f"{path}.order", "must be sequential and start at 1"))
            continue
        image = _non_empty_string(raw_cue.get("image"), f"{path}.image", issues)
        en = _non_empty_string(raw_cue.get("en"), f"{path}.en", issues)
        pt = _non_empty_string(raw_cue.get("pt"), f"{path}.pt", issues)
        if image not in images:
            issues.append(
                ValidationIssue(f"{path}.image", "must reference an image present in the ZIP")
            )
        else:
            referenced_images.add(image)
        highlights = _validate_highlights(raw_cue.get("highlights"), path, en, issues)
        if image and en and pt:
            cues.append(
                StoryCue(order=order, image=image, en=en, pt=pt, highlights=tuple(highlights))
            )

    for image in sorted(set(images) - referenced_images):
        issues.append(ValidationIssue(f"zip:{image}", "is not referenced by any cue"))
    if issues:
        raise StoryPackageViolation(issues)
    return {
        "metadata": {"title": title, "language": language, "aspect_ratio": aspect_ratio},
        "cues": tuple(cues),
    }


def _validate_highlights(
    value: Any, cue_path: str, en: str, issues: list[ValidationIssue]
) -> list[Highlight]:
    path = f"{cue_path}.highlights"
    if not isinstance(value, list):
        issues.append(ValidationIssue(path, "must be a list"))
        return []
    highlights: list[Highlight] = []
    for index, raw in enumerate(value):
        item_path = f"{path}[{index}]"
        if not isinstance(raw, dict):
            issues.append(ValidationIssue(item_path, "must be an object"))
            continue
        text = _non_empty_string(raw.get("text"), f"{item_path}.text", issues)
        kind = raw.get("type")
        if kind not in _HIGHLIGHT_TYPES:
            issues.append(
                ValidationIssue(
                    f"{item_path}.type", "must be important_word, structure, or phrasal_verb"
                )
            )
        pt = _non_empty_string(raw.get("pt"), f"{item_path}.pt", issues)
        occurrence = raw.get("occurrence")
        if not _is_int(occurrence) or occurrence < 1:
            issues.append(ValidationIssue(f"{item_path}.occurrence", "must be a positive integer"))
        elif text and _occurrence_count(en, text) < occurrence:
            issues.append(
                ValidationIssue(
                    f"{item_path}.text", "does not occur at the declared occurrence in cue.en"
                )
            )
        if text and isinstance(kind, str) and pt and _is_int(occurrence) and occurrence > 0:
            highlights.append(Highlight(text=text, type=kind, pt=pt, occurrence=occurrence))
    return highlights


def _occurrence_count(text: str, needle: str) -> int:
    """Count literal, non-overlapping occurrences without changing Unicode text."""
    count = 0
    start = 0
    while True:
        found = text.find(needle, start)
        if found < 0:
            return count
        count += 1
        start = found + len(needle)


def _non_empty_string(value: Any, path: str, issues: list[ValidationIssue]) -> str:
    if not isinstance(value, str) or not value:
        issues.append(ValidationIssue(path, "must be a non-empty literal string"))
        return ""
    return value


def _expect(condition: bool, path: str, message: str, issues: list[ValidationIssue]) -> None:
    if not condition:
        issues.append(ValidationIssue(path, message))


def _is_int(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _image_asset(package: zipfile.ZipFile, path: str, info: zipfile.ZipInfo) -> ImageAsset:
    content = package.read(info)
    return ImageAsset(path=path, size_bytes=info.file_size, sha256=sha256(content).hexdigest())
