"""Read-only discovery of completed TikTok Media MP4s from durable render manifests."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_JSON_BYTES = 2 * 1024 * 1024


def _read_json(path: Path) -> dict | None:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_JSON_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeError, ValueError):
        return None


def list_completed_tiktok_videos(cache_root: Path) -> list[dict]:
    """Find previously published MP4s, including exports made before the library existed.

    The worker atomically publishes manifest.json only after it validates final.mp4.
    Neither an in-progress render nor an orphaned snapshot is listed.
    """
    root = cache_root / "tiktok-media"
    if not root.is_dir():
        return []

    items: list[dict] = []
    for project_dir in root.iterdir():
        if not project_dir.is_dir():
            continue
        try:
            project_id = str(UUID(project_dir.name))
        except ValueError:
            continue
        # The existing download endpoint requires an owned production.
        current = _read_json(project_dir / "project.json")
        if current is None or current.get("id") != project_id:
            continue
        renders = project_dir / "renders"
        if not renders.is_dir():
            continue
        for render_dir in renders.iterdir():
            if not render_dir.is_dir():
                continue
            try:
                render_id = str(UUID(render_dir.name))
            except ValueError:
                continue
            manifest_file = render_dir / "manifest.json"
            manifest = _read_json(manifest_file)
            video = render_dir / "final.mp4"
            if (
                manifest is None
                or manifest.get("contract") != "nova-tiktok-media-render/1"
                or manifest.get("project_id") != project_id
                or manifest.get("render_id") != render_id
                or type(manifest.get("duration_ms")) is not int
                or manifest["duration_ms"] <= 0
                or not isinstance(manifest.get("video_sha256"), str)
                or _SHA256.fullmatch(manifest["video_sha256"]) is None
            ):
                continue
            try:
                video_size = video.stat().st_size
                if video_size < 12:
                    continue
                with video.open("rb") as stream:
                    if stream.read(12)[4:8] != b"ftyp":
                        continue
                completed_at = datetime.fromtimestamp(
                    manifest_file.stat().st_mtime, tz=timezone.utc
                ).isoformat()
            except OSError:
                continue
            snapshot = _read_json(render_dir / "snapshot.json")
            frozen = snapshot.get("project", {}) if snapshot else {}
            if not isinstance(frozen, dict):
                frozen = {}
            title = frozen.get("title") or current.get("title") or "Vídeo sem título"
            if not isinstance(title, str):
                title = "Vídeo sem título"
            video_format = frozen.get("format") or current.get("format")
            if not isinstance(video_format, str):
                video_format = "lesson_video"
            items.append(
                {
                    "project_id": project_id,
                    "render_id": render_id,
                    "title": title,
                    "format": video_format,
                    "visual_mode": manifest.get("visual_mode", "slides"),
                    "duration_ms": manifest["duration_ms"],
                    "size_bytes": video_size,
                    "completed_at": completed_at,
                }
            )
    return sorted(items, key=lambda item: item["completed_at"], reverse=True)
