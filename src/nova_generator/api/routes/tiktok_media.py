"""Independent vertical-media studio: project drafts, audio and queued MP4 exports."""

from __future__ import annotations

import json
import os
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, ValidationError

from nova_generator.api.dependencies import get_enqueue_job, get_manage_voice_profiles
from nova_generator.application.use_cases.manage_voice_profiles import _payload
from nova_generator.core.settings import get_settings
from nova_generator.domain.tiktok_media import (
    MediaFormat,
    MediaProject,
    MediaProjectEdit,
    MediaSlide,
)
from nova_generator.infrastructure.filesystem.tiktok_media_store import (
    MediaConflict,
    MediaProjectStore,
)

router = APIRouter(prefix="/tiktok-media", tags=["tiktok-media"])
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_PNG_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 50 * 1024 * 1024


def _store() -> MediaProjectStore:
    return MediaProjectStore(get_settings().media_cache_root)


def _get(project_id: UUID) -> MediaProject:
    project = _store().get(project_id)
    if project is None:
        raise HTTPException(404, "Projeto de mídia não encontrado.")
    return project


class CreateMediaRequest(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    format: MediaFormat = "carousel"


@router.get("/projects", response_model=list[MediaProject])
def list_media_projects() -> list[MediaProject]:
    return _store().list()


@router.post("/projects", status_code=201, response_model=MediaProject)
def create_media_project(input: CreateMediaRequest) -> MediaProject:
    return _store().create(input.title, input.format)


@router.get("/projects/{project_id}", response_model=MediaProject)
def get_media_project(project_id: UUID) -> MediaProject:
    return _get(project_id)


@router.put("/projects/{project_id}", response_model=MediaProject)
def update_media_project(project_id: UUID, edit: MediaProjectEdit) -> MediaProject:
    try:
        return _store().update(project_id, edit)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except MediaConflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/projects/{project_id}/audio", response_model=MediaProject)
async def upload_media_audio(
    project_id: UUID, file: Annotated[UploadFile, File(...)]
) -> MediaProject:
    _get(project_id)
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mp3", ".wav", ".ogg"}:
        raise HTTPException(422, "Envie áudio MP3, WAV ou OGG.")
    content = await file.read(MAX_AUDIO_BYTES + 1)
    if not content or len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "O áudio deve ter até 50 MiB.")
    directory = _store().directory(project_id) / "assets"
    directory.mkdir(parents=True, exist_ok=True)
    staging = directory / "audio.upload"
    staging.write_bytes(content)
    try:
        result = subprocess.run(
            [get_settings().ffprobe_executable, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1",
             str(staging)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if result.returncode or "codec_type=audio" not in result.stdout:
            raise HTTPException(422, "O arquivo enviado não contém áudio válido.")
        filename = f"audio{suffix}"
        os.replace(staging, directory / filename)
        return _store().set_audio(project_id, filename)
    finally:
        staging.unlink(missing_ok=True)


@router.get("/projects/{project_id}/audio")
def stream_media_audio(project_id: UUID) -> FileResponse:
    project = _get(project_id)
    if not project.audio_filename:
        raise HTTPException(404, "Nenhum áudio associado.")
    file = _store().directory(project_id) / "assets" / project.audio_filename
    if not file.is_file():
        raise HTTPException(404, "Arquivo de áudio indisponível.")
    return FileResponse(file, content_disposition_type="inline")


class IdeaRequest(BaseModel):
    prompt: str = Field(min_length=10, max_length=4000)
    format: MediaFormat
    count: int = Field(default=5, ge=2, le=10)


class IdeaResponse(BaseModel):
    slides: list[MediaSlide]
    provider: Literal["groq"] = "groq"
    needs_review: bool = True


@router.post("/ideas", response_model=IdeaResponse)
def suggest_media_ideas(input: IdeaRequest) -> IdeaResponse:
    settings = get_settings()
    if not settings.groq_api_key:
        raise HTTPException(503, "IA local não configurada. Importe o JSON de uma IA externa.")
    try:
        from groq import Groq

        client = Groq(api_key=settings.groq_api_key, max_retries=0, timeout=40.0)
        result = client.chat.completions.create(
            model=settings.groq_editorial_model,
            temperature=0.35,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Create original educational English/Portuguese content for a vertical "
                        "short-video storyboard. Return ONLY JSON object {slides:[...]} with "
                        "exactly the requested number of slides. Each slide has kind, heading, "
                        "en, pt, note, highlight, speaker, duration_ms. Allowed kind values: "
                        "cover,lesson,example,challenge,lyric. duration_ms 1000..20000. "
                        "Use Brazilian Portuguese. EN/PT must convey exactly the same meaning; "
                        "do not fabricate quotations or attribute lines to copyrighted media. "
                        "If asked for songs, write original sample lines unless user supplies "
                        "licensed lines. No markdown. Output drafts for human fact review."
                    ),
                },
                {"role": "user", "content": json.dumps(input.model_dump(), ensure_ascii=False)},
            ],
        )
        content = result.choices[0].message.content
        payload = json.loads(content or "{}")
        slides = [MediaSlide.model_validate(slide) for slide in payload["slides"]]
        if len(slides) != input.count:
            raise ValueError("Quantidade de quadros inconsistente")
        return IdeaResponse(slides=slides)
    except (ValidationError, KeyError, TypeError, ValueError, IndexError) as exc:
        raise HTTPException(502, "A IA retornou um roteiro inválido. Tente novamente.") from exc
    except Exception as exc:
        raise HTTPException(
            503, "A IA está indisponível. Você pode importar um roteiro externo em JSON."
        ) from exc


@router.post("/projects/{project_id}/render", status_code=202)
async def render_media_project(
    project_id: UUID,
    images: Annotated[list[UploadFile], File(...)],
    revision: Annotated[int, Form(...)],
    audio_mode: Annotated[Literal["silent", "uploaded", "voice"], Form(...)] = "silent",
    voice_profile_id: Annotated[str | None, Form()] = None,
) -> dict[str, str]:
    project = _get(project_id)
    if revision != project.revision:
        raise HTTPException(409, "Salve e recarregue o projeto antes de renderizar.")
    if len(images) != len(project.slides):
        raise HTTPException(422, "Envie exatamente uma imagem por quadro.")
    if audio_mode == "uploaded" and not project.audio_filename:
        raise HTTPException(422, "Envie a música antes de exportar.")
    snapshot = None
    if audio_mode == "voice":
        if not voice_profile_id:
            raise HTTPException(422, "Selecione a voz para a narração.")
        try:
            voice_id = UUID(voice_profile_id)
        except ValueError as exc:
            raise HTTPException(422, "Perfil de voz inválido.") from exc
        voice = get_manage_voice_profiles().get(voice_id)
        if voice is None:
            raise HTTPException(404, "Perfil de voz não encontrado.")
        snapshot = _payload(voice.snapshot())
    audio_hash = None
    if audio_mode == "uploaded":
        audio = _store().directory(project_id) / "assets" / str(project.audio_filename)
        if not audio.is_file():
            raise HTTPException(409, "Arquivo de áudio indisponível.")
        audio_hash = sha256(audio.read_bytes()).hexdigest()
    render_id = uuid4()
    directory = _store().directory(project_id) / "renders" / str(render_id)
    directory.mkdir(parents=True)
    image_hashes = []
    for index, image in enumerate(images):
        content = await image.read(MAX_PNG_BYTES + 1)
        if not content.startswith(PNG_SIGNATURE) or len(content) > MAX_PNG_BYTES:
            raise HTTPException(422, f"O quadro {index + 1} deve ser PNG de até 8 MiB.")
        (directory / f"{index:03d}.png").write_bytes(content)
        image_hashes.append(sha256(content).hexdigest())
    payload = {
        "project": project.model_dump(mode="json"),
        "image_hashes": image_hashes,
        "audio_mode": audio_mode,
        "voice_snapshot": snapshot,
        "audio_sha256": audio_hash,
    }
    content = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    (directory / "snapshot.json").write_bytes(content)
    job = get_enqueue_job().execute(
        kind="tiktok.render",
        input={
            "project_id": str(project_id),
            "render_id": str(render_id),
            "snapshot_sha256": sha256(content).hexdigest(),
        },
        max_attempts=2,
    )
    return {"job_id": str(job.id), "render_id": str(render_id), "status": job.status}


def _finished_render(project_id: UUID, render_id: UUID) -> Path:
    _get(project_id)
    directory = _store().directory(project_id) / "renders" / str(render_id)
    if not (directory / "manifest.json").is_file():
        raise HTTPException(404, "A renderização ainda não foi concluída.")
    return directory


@router.get("/projects/{project_id}/renders/{render_id}/video")
def download_media_video(project_id: UUID, render_id: UUID) -> FileResponse:
    path = _finished_render(project_id, render_id) / "final.mp4"
    if not path.is_file():
        raise HTTPException(404, "Vídeo indisponível.")
    return FileResponse(
        path, media_type="video/mp4", filename="tiktok-media.mp4",
        content_disposition_type="inline",
    )


@router.post("/projects/{project_id}/slides.zip")
async def export_media_carousel(
    project_id: UUID,
    images: Annotated[list[UploadFile], File(...)],
    revision: Annotated[int, Form(...)],
) -> Response:
    project = _get(project_id)
    if revision != project.revision:
        raise HTTPException(409, "Salve o projeto antes da exportação.")
    if len(images) != len(project.slides):
        raise HTTPException(422, "Envie um PNG para cada quadro.")
    import io

    stream = io.BytesIO()
    with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
        for index, image in enumerate(images):
            content = await image.read(MAX_PNG_BYTES + 1)
            if not content.startswith(PNG_SIGNATURE) or len(content) > MAX_PNG_BYTES:
                raise HTTPException(422, f"Quadro {index + 1} inválido.")
            archive.writestr(f"slide-{index + 1:02d}.png", content)
    return Response(
        stream.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="tiktok-carrossel.zip"'},
    )


@router.get("/projects/{project_id}/renders/{render_id}/slides.zip")
def download_media_slides(project_id: UUID, render_id: UUID) -> Response:
    directory = _finished_render(project_id, render_id)
    import io

    stream = io.BytesIO()
    with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
        for image in sorted(directory.glob("[0-9][0-9][0-9].png")):
            archive.write(image, arcname=f"slide-{int(image.stem) + 1:02d}.png")
    return Response(
        stream.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="tiktok-slides.zip"'},
    )
