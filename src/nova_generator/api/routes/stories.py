"""Reviewable Story productions backed by validated, immutable ZIP uploads."""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import asdict
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from nova_generator.api.dependencies import get_enqueue_job, get_manage_voice_profiles
from nova_generator.application.use_cases.manage_voice_profiles import _payload
from nova_generator.core.settings import get_settings
from nova_generator.domain.media.youtube import InvalidYoutubeUrl, YoutubeVideo
from nova_generator.domain.stories import StoryPackageViolation, validate_story_package

router = APIRouter(prefix="/stories", tags=["stories"])
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _directory(production_id: str) -> Path:
    try:
        UUID(production_id)
    except ValueError as exc:
        raise HTTPException(404, "História não encontrada") from exc
    directory = get_settings().media_cache_root / "stories" / production_id
    if not (directory / "package.zip").is_file():
        raise HTTPException(404, "História não encontrada")
    return directory


def _package(directory: Path) -> dict:
    package = validate_story_package(directory / "package.zip")
    return {
        "id": directory.name,
        **asdict(package),
        "image_urls": {
            image.path: f"/api/stories/{directory.name}/images/{image.path}"
            for image in package.images
        },
        "preview_url": f"/api/stories/{directory.name}/preview"
        if (directory / "render" / "story_final.mp4").is_file()
        else None,
    }


@router.post("", status_code=201, response_model=None)
async def upload_story(file: Annotated[UploadFile, File(...)]) -> dict | JSONResponse:
    if not file.filename or not file.filename.lower().endswith(".zip"):
        return JSONResponse(
            status_code=422, content={"issues": [{"path": "file", "message": "Envie um ZIP."}]}
        )
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        return JSONResponse(
            status_code=413,
            content={"issues": [{"path": "file", "message": "ZIP excede 200 MiB."}]},
        )
    try:
        validate_story_package(content)
    except StoryPackageViolation as exc:
        return JSONResponse(status_code=422, content={"issues": [asdict(i) for i in exc.issues]})
    production_id = str(uuid4())
    directory = get_settings().media_cache_root / "stories" / production_id
    directory.mkdir(parents=True)
    (directory / "package.zip").write_bytes(content)
    return _package(directory)


@router.get("/{production_id}")
def get_story(production_id: str) -> dict:
    return _package(_directory(production_id))


@router.get("/{production_id}/images/{image_path:path}")
def get_story_image(production_id: str, image_path: str) -> FileResponse:
    directory = _directory(production_id)
    package = validate_story_package(directory / "package.zip")
    if image_path not in {image.path for image in package.images}:
        raise HTTPException(404, "Imagem não encontrada")
    # The validated ZIP has safe member paths; extract only the requested image.
    target = directory / "review" / image_path
    if not target.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(directory / "package.zip") as archive:
            target.write_bytes(archive.read(image_path))
    return FileResponse(target)


class RenderRequest(BaseModel):
    voice_profile_id: str


@router.post("/{production_id}/render", status_code=202)
def render_story(production_id: str, payload: RenderRequest) -> dict:
    _directory(production_id)
    try:
        voice_id = UUID(payload.voice_profile_id)
    except ValueError as exc:
        raise HTTPException(422, "Selecione um perfil de voz válido") from exc
    profile = get_manage_voice_profiles().get(voice_id)
    if profile is None:
        raise HTTPException(404, "Perfil de voz não encontrado")
    snapshot = profile.snapshot()
    job = get_enqueue_job().execute(
        kind="story.render",
        input={"production_id": production_id, "voice_snapshot": _payload(snapshot)},
        idempotency_key=f"story.render:{production_id}:{snapshot.sha256}",
        max_attempts=3,
    )
    return {"job_id": str(job.id), "status": job.status}


@router.get("/{production_id}/preview")
def preview_story(production_id: str) -> FileResponse:
    video = _directory(production_id) / "render" / "story_final.mp4"
    if not video.is_file():
        raise HTTPException(404, "Prévia ainda indisponível")
    return FileResponse(video, media_type="video/mp4")


class PublishRequest(BaseModel):
    youtube: str


@router.post("/{production_id}/publication")
def publish_story(production_id: str, payload: PublishRequest) -> dict:
    directory = _directory(production_id)
    raw = payload.youtube.strip()
    try:
        video = YoutubeVideo(raw) if YOUTUBE_ID.fullmatch(raw) else YoutubeVideo.from_url(raw)
    except InvalidYoutubeUrl as exc:
        raise HTTPException(422, str(exc)) from exc
    manifest_path = directory / "render" / "story-manifest.json"
    final_video = directory / "render" / "story_final.mp4"
    if not manifest_path.is_file() or not final_video.is_file():
        raise HTTPException(409, "Renderize a História antes de publicar")
    package = validate_story_package(directory / "package.zip")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    durations = [item["duration_ms"] for item in manifest["cues"]]
    if len(durations) != len(package.cues):
        raise HTTPException(409, "Manifesto de render incompatível com o pacote")
    cursor = 0
    cues = []
    for cue, duration in zip(package.cues, durations, strict=True):
        cues.append(
            {
                "order": cue.order,
                "startMs": cursor,
                "endMs": cursor + duration,
                "en": cue.en,
                "pt": cue.pt,
                "highlights": [asdict(h) for h in cue.highlights],
            }
        )
        cursor += duration
    export = {
        "schema": "immersionhub-text-audio",
        "schema_version": "1.1",
        "mode": "story",
        "title": package.title,
        "description": "",
        "youtubeUrl": video.canonical_url,
        "youtubeVideoId": video.video_id,
        "durationMs": cursor,
        "cues": cues,
    }
    from nova_generator.infrastructure.integration.ihub_contracts import validate_story

    validate_story(export)
    (directory / "publication.json").write_text(
        json.dumps(export, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return export
