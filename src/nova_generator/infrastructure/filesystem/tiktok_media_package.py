"""Safely import a complete TikTok Media ZIP into a new, reviewable production."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import struct
import subprocess
import zlib
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from zipfile import BadZipFile, ZipFile

from pydantic import ValidationError

from nova_generator.domain.tiktok_media import MediaProject, MediaSlide, new_media_project
from nova_generator.infrastructure.filesystem.tiktok_media_store import MediaProjectStore

MAX_PACKAGE_BYTES = 90 * 1024 * 1024
MAX_UNPACKED_BYTES = 120 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 50 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class MediaPackageError(ValueError):
    """Invalid package; no project is persisted."""


def _valid_portrait_png(content: bytes) -> bool:
    if not content.startswith(PNG_SIGNATURE):
        return False
    position = len(PNG_SIGNATURE)
    found_header = False
    found_pixels = False
    while position + 12 <= len(content):
        size = int.from_bytes(content[position : position + 4], "big")
        kind = content[position + 4 : position + 8]
        end = position + 8 + size
        if end + 4 > len(content):
            return False
        crc = int.from_bytes(content[end : end + 4], "big")
        if zlib.crc32(content[position + 4 : end]) != crc:
            return False
        if not found_header:
            if kind != b"IHDR" or size != 13:
                return False
            if struct.unpack(">II", content[position + 8 : position + 16]) != (1080, 1920):
                return False
            found_header = True
        elif kind == b"IDAT":
            found_pixels = True
        elif kind == b"IEND":
            return found_pixels and size == 0 and end + 4 == len(content)
        position = end + 4
    return False


def _read_member(archive: ZipFile, name: str, limit: int) -> bytes:
    info = archive.getinfo(name)
    if info.file_size <= 0 or info.file_size > limit:
        raise MediaPackageError(f"Arquivo vazio ou grande demais: {name}.")
    data = archive.read(name)
    if len(data) != info.file_size:
        raise MediaPackageError(f"Arquivo incompleto: {name}.")
    return data


def import_media_package(
    package: bytes, store: MediaProjectStore, ffprobe_executable: str
) -> MediaProject:
    """Validate all members before making a new project visible to the studio."""
    if not package or len(package) > MAX_PACKAGE_BYTES:
        raise MediaPackageError("O ZIP precisa ter até 90 MiB.")

    try:
        archive = ZipFile(BytesIO(package))
    except BadZipFile as exc:
        raise MediaPackageError("Arquivo ZIP inválido.") from exc

    with archive:
        members = archive.infolist()
        names = [item.filename for item in members]
        if len(names) != len(set(names)) or len(names) > 32 or "manifest.json" not in names:
            raise MediaPackageError("ZIP sem manifesto, com arquivos duplicados ou em excesso.")
        if sum(item.file_size for item in members) > MAX_UNPACKED_BYTES:
            raise MediaPackageError("O conteúdo descompactado ultrapassa 120 MiB.")
        for item in members:
            mode = item.external_attr >> 16
            if (
                item.is_dir()
                or item.flag_bits & 1
                or stat.S_IFMT(mode) == stat.S_IFLNK
                or item.filename.startswith("/")
                or "\\" in item.filename
                or ".." in Path(item.filename).parts
            ):
                raise MediaPackageError(f"Caminho inseguro no ZIP: {item.filename}.")

        try:
            manifest = json.loads(_read_member(archive, "manifest.json", 256_000))
        except (ValueError, UnicodeDecodeError) as exc:
            raise MediaPackageError("manifest.json inválido.") from exc
        if not isinstance(manifest, dict) or manifest.get("contract") != "nova-tiktok-package/1":
            raise MediaPackageError("Contrato esperado: nova-tiktok-package/1.")
        title = manifest.get("title")
        fmt = manifest.get("format", "lesson_video")
        animated = manifest.get("animated_scenes", True)
        theme = manifest.get("theme", "ihub")
        entries = manifest.get("slides")
        if (
            not isinstance(title, str)
            or not 1 <= len(title) <= 140
            or fmt not in {"lesson_video", "carousel", "lyrics_video"}
            or not isinstance(animated, bool)
            or theme not in {"ihub", "midnight", "warm"}
            or not isinstance(entries, list)
            or not 1 <= len(entries) <= 30
        ):
            raise MediaPackageError("Título, formato ou quadros inválidos.")

        if any(not isinstance(entry, dict) or type(entry.get("order")) is not int for entry in entries):
            raise MediaPackageError("Cada quadro precisa de uma ordem numérica.")
        ordered = sorted(entries, key=lambda entry: entry["order"])
        if [entry["order"] for entry in ordered] != list(range(1, len(ordered) + 1)):
            raise MediaPackageError("As ordens devem ser únicas e contínuas a partir de 1.")

        images: dict[str, bytes] = {}
        referenced = {"manifest.json"}
        slides: list[MediaSlide] = []
        try:
            for index, entry in enumerate(ordered, 1):
                image_ref = entry.get("image")
                background_image = None
                if image_ref is not None:
                    if (
                        not isinstance(image_ref, str)
                        or not re.fullmatch(r"images/[A-Za-z0-9._-]+\.png", image_ref)
                        or image_ref not in names
                        or image_ref in referenced
                    ):
                        raise MediaPackageError(f"Quadro {index}: imagem ausente ou duplicada.")
                    image = _read_member(archive, image_ref, MAX_IMAGE_BYTES)
                    if not _valid_portrait_png(image):
                        raise MediaPackageError(
                            f"Quadro {index}: imagem deve ser PNG íntegro de 1080×1920."
                        )
                    digest = entry.get("sha256")
                    if digest is not None and digest != sha256(image).hexdigest():
                        raise MediaPackageError(f"Quadro {index}: hash da imagem divergente.")
                    background_image = f"{uuid4().hex}.png"
                    images[background_image] = image
                    referenced.add(image_ref)
                slide = MediaSlide.model_validate(
                    {
                        **{
                            key: value
                            for key, value in entry.items()
                            if key not in {"order", "image", "sha256", "id", "background_image"}
                        },
                        "background_image": background_image,
                    }
                )
                slides.append(slide)
        except (ValidationError, TypeError) as exc:
            raise MediaPackageError(f"Quadro inválido: {exc}") from exc

        audio_ref = manifest.get("audio")
        audio_data = None
        audio_filename = None
        if audio_ref is not None:
            if (
                not isinstance(audio_ref, str)
                or not re.fullmatch(r"audio/[A-Za-z0-9._-]+\.(mp3|wav|ogg)", audio_ref)
                or audio_ref not in names
            ):
                raise MediaPackageError("Áudio indicado no manifesto não encontrado.")
            audio_data = _read_member(archive, audio_ref, MAX_AUDIO_BYTES)
            audio_filename = f"audio.{audio_ref.rsplit('.', 1)[1]}"
            digest = manifest.get("audio_sha256")
            if digest is not None and digest != sha256(audio_data).hexdigest():
                raise MediaPackageError("Hash do áudio divergente.")
            referenced.add(audio_ref)

        if set(names) != referenced:
            raise MediaPackageError("ZIP contém arquivos não declarados no manifesto.")

        if manifest.get("duration_ms") is not None and manifest["duration_ms"] != sum(
            slide.duration_ms for slide in slides
        ):
            raise MediaPackageError("A duração total não corresponde aos quadros.")

        try:
            base = new_media_project(title, fmt, animated_scenes=animated)
            project = MediaProject.model_validate(
                {
                    **base.model_dump(),
                    "theme": theme,
                    "slides": [slide.model_dump() for slide in slides],
                    "audio_filename": audio_filename,
                }
            )
        except ValidationError as exc:
            raise MediaPackageError(f"Dados da produção inválidos: {exc}") from exc

        store.root.mkdir(parents=True, exist_ok=True)
        stage = store.root / f".import-{project.id}"
        target = store.directory(project.id)
        stage.mkdir()
        try:
            assets = stage / "assets"
            assets.mkdir()
            for filename, content in images.items():
                (assets / filename).write_bytes(content)
            if audio_data is not None and audio_filename is not None:
                audio_path = assets / audio_filename
                audio_path.write_bytes(audio_data)
                try:
                    probe = subprocess.run(
                        [
                            ffprobe_executable, "-v", "error", "-select_streams", "a:0",
                            "-show_entries", "stream=codec_type",
                            "-of", "default=noprint_wrappers=1", str(audio_path),
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                        timeout=30,
                    )
                except (OSError, subprocess.TimeoutExpired) as exc:
                    raise MediaPackageError("Não foi possível validar a narração.") from exc
                if probe.returncode or "codec_type=audio" not in probe.stdout:
                    raise MediaPackageError("A narração não contém áudio válido.")
            (stage / "project.json").write_text(
                json.dumps(project.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(stage, target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        return project
