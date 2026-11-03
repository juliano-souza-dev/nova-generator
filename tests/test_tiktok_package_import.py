"""ZIP package imports are isolated, ordered and safe."""
from __future__ import annotations

import json
import struct
import zlib
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from nova_generator.infrastructure.filesystem.tiktok_media_package import (
    MediaPackageError,
    import_media_package,
)
from nova_generator.infrastructure.filesystem.tiktok_media_store import MediaProjectStore


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(
        ">I", zlib.crc32(kind + data)
    )


def _portrait_png() -> bytes:
    header = struct.pack(">IIBBBBB", 1080, 1920, 8, 2, 0, 0, 0)
    scanline = b"\x00" + b"\x00" * (1080 * 3)
    pixels = zlib.compress(scanline * 1920)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", pixels)
        + _chunk(b"IEND", b"")
    )


def _package(manifest: dict, images: dict[str, bytes] | None = None) -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        for filename, content in (images or {}).items():
            archive.writestr(filename, content)
    return output.getvalue()


def _manifest() -> dict:
    return {
        "contract": "nova-tiktok-package/1",
        "title": "WATCH — contexto",
        "format": "lesson_video",
        "animated_scenes": True,
        "duration_ms": 14000,
        "slides": [
            {
                "order": 2,
                "kind": "example",
                "heading": "CUIDADO",
                "en": "Watch out!",
                "pt": "Cuidado!",
                "image": "images/b.png",
                "duration_ms": 8000,
                "motion": "pan_left",
            },
            {
                "order": 1,
                "kind": "cover",
                "heading": "WATCH",
                "en": "Watch",
                "pt": "Uma palavra, vários contextos.",
                "image": "images/a.png",
                "duration_ms": 6000,
                "motion": "zoom_in",
            },
        ],
    }


def test_import_creates_ordered_production_with_immutable_images(tmp_path: Path) -> None:
    manifest = _manifest()
    image = _portrait_png()
    store = MediaProjectStore(tmp_path)
    project = import_media_package(
        _package(manifest, {"images/a.png": image, "images/b.png": image}),
        store,
        "ffprobe",
    )

    assert project.title == "WATCH — contexto"
    assert project.animated_scenes is True
    assert [slide.en for slide in project.slides] == ["Watch", "Watch out!"]
    assert [slide.duration_ms for slide in project.slides] == [6000, 8000]
    for slide in project.slides:
        assert slide.background_image is not None
        picture = store.directory(project.id) / "assets" / slide.background_image
        assert picture.read_bytes() == image
    assert store.get(project.id) == project


@pytest.mark.parametrize("damage", ["wrong-order", "missing-image", "path-traversal", "bad-hash"])
def test_rejected_zip_does_not_create_project(tmp_path: Path, damage: str) -> None:
    manifest = _manifest()
    image = _portrait_png()
    assets = {"images/a.png": image, "images/b.png": image}
    if damage == "wrong-order":
        manifest["slides"][0]["order"] = 1
    elif damage == "missing-image":
        assets.pop("images/b.png")
    elif damage == "path-traversal":
        manifest["slides"][0]["image"] = "../b.png"
    else:
        manifest["slides"][0]["sha256"] = "0" * 64

    store = MediaProjectStore(tmp_path)
    with pytest.raises(MediaPackageError):
        import_media_package(_package(manifest, assets), store, "ffprobe")
    assert store.list() == []


def test_unicode_and_old_projects_remain_untouched(tmp_path: Path) -> None:
    store = MediaProjectStore(tmp_path)
    existing = store.create("Projeto anterior", "carousel")
    manifest = _manifest()
    import_media_package(
        _package(manifest, {"images/a.png": _portrait_png(), "images/b.png": _portrait_png()}),
        store,
        "ffprobe",
    )
    assert store.get(existing.id) == existing
    assert len(store.list()) == 2
