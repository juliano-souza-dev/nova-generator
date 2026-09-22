from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from nova_generator.api.dependencies import (
    get_enqueue_job,
    get_job,
    get_manage_voice_profiles,
    get_session_factory,
)
from nova_generator.application.use_cases.manage_jobs import EnqueueJob, GetJob
from nova_generator.application.use_cases.manage_voice_profiles import ManageVoiceProfiles
from nova_generator.core.settings import get_settings
from nova_generator.domain.projects.entities import Cue
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache

router = APIRouter(prefix="/projects/{project_id}/materials", tags=["materials"])


class SelectionInput(BaseModel):
    included: bool


class VoiceInput(BaseModel):
    voice_id: UUID


class CardResponse(BaseModel):
    cue_id: UUID
    scene_order: int
    cue_order: int
    approved_en: str
    approved_pt: str
    tags: list[str]
    included: bool
    speaker: str
    speech_start_ms: int
    speech_end_ms: int
    reel_start_ms: int | None
    reel_end_ms: int | None
    audio_ready: bool
    audio_url: str | None
    audio_error: str | None = None


class MaterialListResponse(BaseModel):
    cards: list[CardResponse]
    voice_id: UUID | None
    voice_version: int | None


class JobRefResponse(BaseModel):
    id: UUID
    status: str


class ExportResponse(BaseModel):
    job_id: UUID
    status: str
    apkg_url: str | None = None
    manifest_url: str | None = None
    reel_url: str | None = None


def _repository() -> SqlAlchemyEditorialProjectRepository:
    return SqlAlchemyEditorialProjectRepository(get_session_factory())


def _project_cues(project_id: UUID) -> list[tuple[int, Cue]]:
    repository = _repository()
    if repository.get_project(project_id) is None:
        raise HTTPException(404, detail="project not found")
    return [
        (scene.order, cue)
        for scene in repository.get_project_scenes(project_id)
        for cue in repository.get_scene_cues(scene.id)
        if cue.approved_en and cue.approved_pt
    ]


def _voice(voices: ManageVoiceProfiles, voice_id: UUID) -> VoiceProfileSnapshot:
    profile = voices.get(voice_id)
    if profile is None:
        raise HTTPException(404, detail="voice profile not found")
    return profile.snapshot()


def _card(
    project_id: UUID,
    scene_order: int,
    cue: Cue,
    voice: VoiceProfileSnapshot | None,
    reel_start: int | None,
) -> CardResponse:
    speech = None
    if voice is not None:
        cache = FileSpeechCache(get_settings().media_cache_root)
        key = cache.cache_key(text=cue.approved_en, profile=voice, parameters={})
        speech = cache.find(key)
    tags = cue.provenance.get("tags", [])
    return CardResponse(
        cue_id=cue.id, scene_order=scene_order, cue_order=cue.order,
        approved_en=cue.approved_en, approved_pt=cue.approved_pt,
        tags=[tag for tag in tags if isinstance(tag, str)] if isinstance(tags, list) else [],
        included=cue.provenance.get("anki_included") is not False,
        speaker=cue.speaker, speech_start_ms=cue.speech_start_ms,
        speech_end_ms=cue.speech_end_ms,
        reel_start_ms=reel_start if speech and reel_start is not None else None,
        reel_end_ms=reel_start + speech.duration_ms if speech and reel_start is not None else None,
        audio_ready=speech is not None,
        audio_url=(
            f"{get_settings().api_prefix}/projects/{project_id}/materials/{cue.id}/audio"
            f"?voice_id={voice.profile_id}&voice_version={voice.version}"
            if speech and voice else None
        ),
    )


@router.get("", response_model=MaterialListResponse)
def list_materials(
    project_id: UUID,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    voice_id: UUID | None = None,
) -> MaterialListResponse:
    voice = _voice(voices, voice_id) if voice_id else None
    cursor: int | None = 0
    cards: list[CardResponse] = []
    for scene_order, cue in _project_cues(project_id):
        card = _card(project_id, scene_order, cue, voice, cursor)
        cards.append(card)
        if card.included:
            cursor = card.reel_end_ms if card.audio_ready else None
    return MaterialListResponse(
        cards=cards, voice_id=voice.profile_id if voice else None,
        voice_version=voice.version if voice else None,
    )


@router.patch("/{cue_id}", response_model=CardResponse)
def update_material(project_id: UUID, cue_id: UUID, payload: SelectionInput) -> CardResponse:
    match = next(((order, cue) for order, cue in _project_cues(project_id) if cue.id == cue_id), None)
    if match is None:
        raise HTTPException(404, detail="card not found")
    scene_order, cue = match
    updated = replace(cue, provenance={**cue.provenance, "anki_included": payload.included})
    repository = _repository()
    repository.save_cue(updated, repository.get_cue_words(cue.id))
    return _card(project_id, scene_order, updated, None, None)


@router.get("/{cue_id}/audio")
def stream_material_audio(
    project_id: UUID, cue_id: UUID,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    voice_id: UUID, voice_version: int,
) -> FileResponse:
    cue = next((cue for _, cue in _project_cues(project_id) if cue.id == cue_id), None)
    if cue is None:
        raise HTTPException(404, detail="card not found")
    profile = voices.get(voice_id, voice_version)
    if profile is None:
        raise HTTPException(404, detail="voice profile not found")
    cache = FileSpeechCache(get_settings().media_cache_root)
    speech = cache.find(cache.cache_key(text=cue.approved_en, profile=profile.snapshot(), parameters={}))
    if speech is None:
        raise HTTPException(404, detail="canonical WAV not ready")
    return FileResponse(speech.audio_path, media_type="audio/wav", filename=f"cue-{cue.id}.wav")


@router.post("/{cue_id}/audio", response_model=JobRefResponse, status_code=status.HTTP_202_ACCEPTED)
def prepare_material_audio(
    project_id: UUID, cue_id: UUID, payload: VoiceInput,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> JobRefResponse:
    cue = next((cue for _, cue in _project_cues(project_id) if cue.id == cue_id), None)
    if cue is None:
        raise HTTPException(404, detail="card not found")
    voice = _voice(voices, payload.voice_id)
    job = enqueue.execute(
        kind="synthesize_material_audio",
        input={"project_id": str(project_id), "cue_id": str(cue_id),
               "approved_en": cue.approved_en, "voice_snapshot": _voice_payload(voice)},
        idempotency_key=None,
    )
    return JobRefResponse(id=job.id, status=job.status)


@router.post("/exports", response_model=ExportResponse, status_code=status.HTTP_202_ACCEPTED)
def export_materials(
    project_id: UUID, payload: VoiceInput,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> ExportResponse:
    selected = [cue for _, cue in _project_cues(project_id) if cue.provenance.get("anki_included") is not False]
    if not selected:
        raise HTTPException(422, detail="select at least one card")
    voice = _voice(voices, payload.voice_id)
    cache = FileSpeechCache(get_settings().media_cache_root)
    for cue in selected:
        if cache.find(cache.cache_key(text=cue.approved_en, profile=voice, parameters={})) is None:
            raise HTTPException(422, detail=f"canonical WAV not ready for cue {cue.id}")
    job = enqueue.execute(
        kind="export_materials",
        input={"project_id": str(project_id), "cue_ids": [str(cue.id) for cue in selected],
               "text_hashes": {str(cue.id): cue.approved_en_sha256 for cue in selected},
               "voice_snapshot": _voice_payload(voice)},
        idempotency_key=None,
    )
    return ExportResponse(job_id=job.id, status=job.status)


@router.get("/exports/{job_id}", response_model=ExportResponse)
def get_material_export(
    project_id: UUID, job_id: UUID, jobs: Annotated[GetJob, Depends(get_job)]
) -> ExportResponse:
    job = jobs.execute(str(job_id))
    if job is None or job.kind != "export_materials" or job.input.get("project_id") != str(project_id):
        raise HTTPException(404, detail="export not found")
    base = f"{get_settings().api_prefix}/projects/{project_id}/materials/exports/{job_id}"
    return ExportResponse(
        job_id=job.id, status=job.status,
        apkg_url=f"{base}/anki.apkg" if job.status == "succeeded" else None,
        manifest_url=f"{base}/anki-audio-manifest.json" if job.status == "succeeded" else None,
        reel_url=f"{base}/anki-reel.mp4" if job.status == "succeeded" else None,
    )


@router.get("/exports/{job_id}/{artifact}")
def download_material_export(
    project_id: UUID, job_id: UUID, artifact: str,
    jobs: Annotated[GetJob, Depends(get_job)],
) -> FileResponse:
    if artifact not in {"anki.apkg", "anki-audio-manifest.json", "anki-reel.mp4"}:
        raise HTTPException(404, detail="artifact not found")
    job = jobs.execute(str(job_id))
    if job is None or job.kind != "export_materials" or job.status != "succeeded" or job.input.get("project_id") != str(project_id):
        raise HTTPException(404, detail="export not found")
    path = Path(get_settings().media_cache_root) / "exports" / str(job_id) / artifact
    if not path.is_file():
        raise HTTPException(404, detail="artifact not found")
    return FileResponse(path, filename=artifact)


def _voice_payload(snapshot: VoiceProfileSnapshot) -> dict[str, object]:
    return {
        "profile_id": str(snapshot.profile_id), "name": snapshot.name,
        "version": snapshot.version, "model_id": snapshot.model_id,
        "model_sha256": snapshot.model_sha256,
        "reference_audio_sha256": snapshot.reference_audio_sha256,
        "parameters": snapshot.parameters, "snapshot_sha256": snapshot.sha256,
    }
