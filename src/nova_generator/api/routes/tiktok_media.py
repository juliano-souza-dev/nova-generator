"""Independent vertical-media studio: project drafts, audio and queued MP4 exports."""

from __future__ import annotations

import asyncio
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

from nova_generator.api.dependencies import (
    get_enqueue_job,
    get_manage_voice_profiles,
    get_session_factory,
)
from nova_generator.application.use_cases.manage_voice_profiles import _payload
from nova_generator.core.settings import get_settings
from nova_generator.domain.media.youtube import InvalidYoutubeUrl, YoutubeVideo
from nova_generator.domain.tiktok_media import (
    MediaFormat,
    MediaProject,
    MediaProjectEdit,
    MediaSlide,
)
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.filesystem.tiktok_media_store import (
    MediaConflict,
    MediaProjectStore,
)
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache

router = APIRouter(prefix="/tiktok-media", tags=["tiktok-media"])
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_PNG_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 50 * 1024 * 1024
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_SOURCE_DURATION_MS = 180_000


def _store() -> MediaProjectStore:
    return MediaProjectStore(get_settings().media_cache_root)


def _get(project_id: UUID) -> MediaProject:
    project = _store().get(project_id)
    if project is None:
        raise HTTPException(404, "Projeto de mídia não encontrado.")
    return project


def _video_cut(project: MediaProject) -> tuple[Path, int]:
    """Resolve the exact verified ingest cut linked to an owned editorial scene.

    The TikTok editor never downloads arbitrary links, never resolves an unverified
    filename from user input, and never silently switches to a newer source cut.
    """
    if project.source_cut_job_id is not None:
        job = SqlAlchemyJobRepository(get_session_factory()).get(str(project.source_cut_job_id))
        if (
            job is None
            or job.kind != "tiktok.ingest"
            or job.status != "succeeded"
            or job.input.get("project_id") != str(project.id)
            or job.input.get("video_id") != project.source_youtube_id
            or not isinstance(job.output, dict)
        ):
            raise HTTPException(409, "O corte independente não está disponível.")
        path = _store().directory(project.id) / "cuts" / f"{job.id}.mp4"
        duration_ms = job.output.get("duration_ms")
        if not path.is_file() or not isinstance(duration_ms, int) or duration_ms <= 0:
            raise HTTPException(409, "O corte independente foi removido.")
        if path.stat().st_size > MAX_SOURCE_BYTES or duration_ms > MAX_SOURCE_DURATION_MS:
            raise HTTPException(422, "O corte excede o limite de 3 minutos ou 512 MiB.")
        return path, duration_ms
    if project.source_project_id is None or project.source_scene_id is None:
        raise HTTPException(422, "Selecione uma cena revisada para usar o vídeo original.")
    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    scene = next(
        (
            item
            for item in repository.get_project_scenes(project.source_project_id)
            if item.id == project.source_scene_id
        ),
        None,
    )
    if scene is None:
        raise HTTPException(422, "A cena não pertence ao projeto de origem.")
    ingest_id = scene.provenance.get("ingest_job_id")
    if not isinstance(ingest_id, str):
        raise HTTPException(422, "Esta cena ainda não está ligada a um recorte verificado.")
    try:
        ingest_job_id = UUID(ingest_id)
    except ValueError as exc:
        raise HTTPException(422, "Identificador do recorte da cena inválido.") from exc
    job = SqlAlchemyJobRepository(get_session_factory()).get(str(ingest_job_id))
    if (
        job is None
        or job.kind != "ingest_scene_media"
        or job.status != "succeeded"
        or job.input.get("project_id") != str(project.source_project_id)
        or not isinstance(job.output, dict)
    ):
        raise HTTPException(409, "O recorte verificado não está disponível.")
    path = (
        get_settings().project_root
        / str(project.source_project_id)
        / "cuts"
        / f"{ingest_job_id}.mp4"
    )
    if not path.is_file() or path.stat().st_size == 0:
        raise HTTPException(409, "O vídeo recortado não está disponível.")
    if path.stat().st_size > MAX_SOURCE_BYTES:
        raise HTTPException(422, "O recorte ultrapassa 512 MiB. Escolha um trecho menor.")
    duration_ms = job.output.get("duration_ms")
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        raise HTTPException(409, "Não foi possível confirmar a duração do recorte.")
    if duration_ms > MAX_SOURCE_DURATION_MS:
        raise HTTPException(422, "O vídeo deve ter até 3 minutos. Escolha um recorte menor.")
    return path, duration_ms


def _freeze_cut(source_video: Path, destination: Path) -> str:
    """Copy source bytes and hash in a bounded streaming pass, off the async loop."""
    digest = sha256()
    with source_video.open("rb") as source_stream, destination.open("wb") as target_stream:
        while chunk := source_stream.read(1024 * 1024):
            digest.update(chunk)
            target_stream.write(chunk)
    return digest.hexdigest()


def _has_original_audio(source_video: Path) -> bool:
    try:
        result = subprocess.run(
            [
                get_settings().ffprobe_executable,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "default=noprint_wrappers=1",
                str(source_video),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and "codec_type=audio" in result.stdout


def _validate_video_captions(project: MediaProject, duration_ms: int) -> None:
    if not project.video_captions:
        raise HTTPException(422, "Transcreva ou crie legendas antes de gerar o vídeo.")
    approved = None
    if project.source_cut_job_id is None:
        assert project.source_scene_id is not None
        repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
        approved = {
            cue.id: cue
            for cue in repository.get_scene_cues(project.source_scene_id)
            if cue.approved_en.strip()
            and cue.approved_pt.strip()
            and cue.provenance.get("approval") != "draft"
        }
    previous_end = 0
    for caption in sorted(project.video_captions, key=lambda item: item.start_ms):
        if caption.enabled and not caption.en.strip():
            raise HTTPException(422, "Preencha o texto em inglês dos blocos ativos.")
        if approved is not None and caption.cue_id not in approved:
            raise HTTPException(422, "Existe legenda sem fala aprovada na cena selecionada.")
        if caption.end_ms > duration_ms:
            raise HTTPException(422, "Uma legenda ultrapassa a duração do recorte.")
        if caption.enabled:
            if caption.start_ms < previous_end:
                raise HTTPException(422, "As legendas ativas não podem se sobrepor.")
            previous_end = caption.end_ms


@router.get("/projects/{project_id}/source")
def stream_tiktok_source(project_id: UUID) -> FileResponse:
    project = _get(project_id)
    path, _duration_ms = _video_cut(project)
    return FileResponse(
        path,
        media_type="video/mp4",
        filename="source-cut.mp4",
        content_disposition_type="inline",
    )


class CreateMediaRequest(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    format: MediaFormat = "carousel"


class IndependentYoutubeSource(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    revision: int = Field(ge=1)


class IndependentCut(BaseModel):
    revision: int = Field(ge=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    language: str = Field(default="en", max_length=12)


@router.post("/projects/{project_id}/source/youtube", status_code=202)
def prepare_independent_youtube(project_id: UUID, input: IndependentYoutubeSource) -> dict:
    try:
        video = YoutubeVideo.from_url(input.url)
    except InvalidYoutubeUrl as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        project = _store().set_youtube_source(project_id, input.revision, video.video_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except MediaConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    job = get_enqueue_job().execute(
        kind="tiktok.download",
        input={"project_id": str(project_id), "video_id": video.video_id},
        idempotency_key=f"tiktok.download:{project_id}:{project.revision}",
    )
    return {"project": project.model_dump(mode="json"), "job_id": str(job.id)}


@router.get("/projects/{project_id}/source/status")
def independent_source_status(project_id: UUID) -> dict:
    project = _get(project_id)
    if project.source_youtube_id is None:
        return {
            "source_ready": False,
            "duration_ms": None,
            "download_status": None,
            "download_error": None,
            "ingest_status": None,
            "ingest_error": None,
            "ingest_job_id": None,
        }
    video = YoutubeVideo(project.source_youtube_id)
    metadata = FileYoutubeMediaCache(get_settings().media_cache_root).find_verified(video)
    jobs = SqlAlchemyJobRepository(get_session_factory())
    download = jobs.latest_for_project(str(project_id), "tiktok.download")
    ingest = jobs.latest_for_project(str(project_id), "tiktok.ingest")
    if download and download.input.get("video_id") != video.video_id:
        download = None
    if ingest and (
        ingest.input.get("video_id") != video.video_id
        or (
            ingest.status == "succeeded"
            and ingest.id != project.source_cut_job_id
            and ingest.input.get("revision") != project.revision
        )
    ):
        ingest = None
    return {
        "source_ready": metadata is not None,
        "duration_ms": metadata.duration_ms if metadata else None,
        "download_status": download.status if download else None,
        "download_error": download.error_message if download else None,
        "ingest_status": ingest.status if ingest else None,
        "ingest_error": ingest.error_message if ingest else None,
        "ingest_job_id": str(ingest.id) if ingest else None,
        "cut_ready": project.source_cut_job_id is not None,
    }


@router.get("/projects/{project_id}/source/original")
def stream_independent_original(project_id: UUID) -> FileResponse:
    project = _get(project_id)
    if project.source_youtube_id is None:
        raise HTTPException(404, "Adicione um link do YouTube primeiro.")
    video = YoutubeVideo(project.source_youtube_id)
    cache = FileYoutubeMediaCache(get_settings().media_cache_root)
    if cache.find_verified(video) is None:
        raise HTTPException(404, "A origem ainda está sendo baixada.")
    return FileResponse(
        cache.source_path(video), media_type="video/mp4", content_disposition_type="inline"
    )


@router.post("/projects/{project_id}/source/ingest", status_code=202)
def transcribe_independent_cut(project_id: UUID, input: IndependentCut) -> dict:
    project = _get(project_id)
    if project.revision != input.revision:
        raise HTTPException(409, "Aguarde o salvamento antes de transcrever.")
    if not project.source_youtube_id:
        raise HTTPException(422, "Adicione um vídeo primeiro.")
    video = YoutubeVideo(project.source_youtube_id)
    metadata = FileYoutubeMediaCache(get_settings().media_cache_root).find_verified(video)
    if metadata is None:
        raise HTTPException(409, "Aguarde o download do vídeo.")
    if input.end_ms <= input.start_ms or input.end_ms > metadata.duration_ms:
        raise HTTPException(422, "O corte precisa estar dentro do vídeo.")
    if input.end_ms - input.start_ms > MAX_SOURCE_DURATION_MS:
        raise HTTPException(422, "Selecione um trecho de até 3 minutos.")
    jobs = SqlAlchemyJobRepository(get_session_factory())
    current = jobs.latest_for_project(str(project_id), "tiktok.ingest")
    if current and current.status in {"queued", "running", "retryable"}:
        raise HTTPException(409, "Já existe uma transcrição em andamento.")
    job = get_enqueue_job().execute(
        kind="tiktok.ingest",
        input={
            "project_id": str(project_id),
            "video_id": video.video_id,
            "source_sha256": metadata.sha256,
            "revision": project.revision,
            "start_ms": input.start_ms,
            "end_ms": input.end_ms,
            "language": input.language,
        },
        idempotency_key=None,
    )
    return {"job_id": str(job.id), "status": job.status}


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
    current = _get(project_id)
    if (
        "source_youtube_id" in edit.model_fields_set
        and edit.source_youtube_id is not None
        and edit.source_youtube_id != current.source_youtube_id
    ):
        raise HTTPException(422, "Use a preparação de origem para trocar o vídeo.")
    if (
        "source_cut_job_id" in edit.model_fields_set
        and edit.source_cut_job_id is not None
        and edit.source_cut_job_id != current.source_cut_job_id
    ):
        raise HTTPException(422, "Um corte só pode ser vinculado pelo job de transcrição.")
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
            [
                get_settings().ffprobe_executable,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "default=noprint_wrappers=1",
                str(staging),
            ],
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
    revision: Annotated[int, Form(...)],
    images: Annotated[list[UploadFile] | None, File()] = None,
    visual_mode: Annotated[Literal["slides", "video_source"], Form()] = "slides",
    audio_mode: Annotated[Literal["silent", "uploaded", "voice", "original"], Form()] = "silent",
    voice_profile_id: Annotated[str | None, Form()] = None,
) -> dict[str, str]:
    project = _get(project_id)
    if revision != project.revision:
        raise HTTPException(409, "Salve e recarregue o projeto antes de renderizar.")
    if visual_mode == "slides" and (images is None or len(images) != len(project.slides)):
        raise HTTPException(422, "Envie exatamente uma imagem por quadro.")
    if visual_mode == "slides" and audio_mode == "original":
        raise HTTPException(422, "Áudio original exige um vídeo de origem.")
    if visual_mode == "video_source" and images:
        raise HTTPException(422, "O vídeo original não aceita quadros de imagem adicionais.")
    if visual_mode == "video_source" and audio_mode == "voice":
        raise HTTPException(422, "Narração de voz não é compatível com o vídeo original.")
    if audio_mode == "uploaded" and not project.audio_filename:
        raise HTTPException(422, "Envie a música antes de exportar.")

    source_video = None
    source_duration_ms = None
    if visual_mode == "video_source":
        source_video, source_duration_ms = _video_cut(project)
        _validate_video_captions(project, source_duration_ms)
        if audio_mode == "original" and not await asyncio.to_thread(
            _has_original_audio, source_video
        ):
            raise HTTPException(
                422, "O recorte não tem áudio original. Envie uma faixa ou exporte sem áudio."
            )

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
    for index, image in enumerate(images or []):
        content = await image.read(MAX_PNG_BYTES + 1)
        if not content.startswith(PNG_SIGNATURE) or len(content) > MAX_PNG_BYTES:
            raise HTTPException(422, f"O quadro {index + 1} deve ser PNG de até 8 MiB.")
        (directory / f"{index:03d}.png").write_bytes(content)
        image_hashes.append(sha256(content).hexdigest())
    source_sha256 = None
    if source_video is not None:
        # Freeze bytes before enqueueing. Changing/re-downloading the source
        # cannot alter an already requested export.
        frozen = directory / "source.mp4"
        source_sha256 = await asyncio.to_thread(_freeze_cut, source_video, frozen)
    payload = {
        "project": project.model_dump(mode="json"),
        "visual_mode": visual_mode,
        "image_hashes": image_hashes,
        "audio_mode": audio_mode,
        "voice_snapshot": snapshot,
        "audio_sha256": audio_hash,
        "source_video_sha256": source_sha256,
        "source_duration_ms": source_duration_ms,
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
        idempotency_key=f"tiktok.render:{render_id}",
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
        path,
        media_type="video/mp4",
        filename="tiktok-media.mp4",
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
        stream.getvalue(),
        media_type="application/zip",
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
        stream.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="tiktok-slides.zip"'},
    )
