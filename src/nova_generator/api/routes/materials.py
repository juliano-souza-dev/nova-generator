from __future__ import annotations

import json
import tempfile
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from nova_generator.api.dependencies import (
    get_enqueue_job,
    get_job,
    get_manage_voice_profiles,
    get_session_factory,
)
from nova_generator.application.use_cases.build_delivery_zip import (
    DeliveryAsset,
    DeliveryError,
    build_delivery_zip,
    verify_didactic_publication,
)
from nova_generator.application.use_cases.editorial_publication_snapshot import (
    editorial_publication_sha256,
)
from nova_generator.application.use_cases.manage_jobs import EnqueueJob, GetJob
from nova_generator.application.use_cases.manage_voice_profiles import ManageVoiceProfiles
from nova_generator.application.use_cases.materials_ai_exchange import (
    MaterialsAiError,
    MaterialsAiExchange,
)
from nova_generator.application.use_cases.prepare_shadowing import (
    PrepareShadowing,
    ShadowingError,
)
from nova_generator.application.use_cases.publish_anki_reel import (
    AnkiPublicationError,
    PublishAnkiReel,
)
from nova_generator.core.settings import get_settings
from nova_generator.domain.projects.entities import Cue, WordTiming, utf8_sha256
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.filesystem.voice_references import (
    FileVoiceReferenceStore,
    validate_profile_reference,
)
from nova_generator.infrastructure.integration.ihub_contracts import (
    ContractViolation,
    validate_anki_audio,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache

router = APIRouter(prefix="/projects/{project_id}/materials", tags=["materials"])


class SelectionInput(BaseModel):
    included: bool


class VoiceInput(BaseModel):
    voice_id: UUID


class PublicationInput(BaseModel):
    youtube: str
    confirmed: bool


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
    editorial_ready: bool
    highlights: list[PedagogicalHighlightResponse]


class PedagogicalHighlightResponse(BaseModel):
    en: str
    pt: str
    kind: str


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
    error_message: str | None = None
    apkg_url: str | None = None
    manifest_url: str | None = None
    reel_url: str | None = None
    hub_final_url: str | None = None
    bundle_url: str | None = None
    youtube_video_id: str | None = None


class PublicationResponse(BaseModel):
    youtube_video_id: str
    youtube_url: str
    hub_final_url: str


def _repository() -> SqlAlchemyEditorialProjectRepository:
    return SqlAlchemyEditorialProjectRepository(get_session_factory())


def _publisher() -> PublishAnkiReel:
    settings = get_settings()
    return PublishAnkiReel(
        _repository(),
        SqlAlchemyJobRepository(get_session_factory()),
        settings.media_cache_root / "exports",
        settings.project_root,
    )


def _export_job(project_id: UUID, job_id: UUID, jobs: GetJob):
    job = jobs.execute(str(job_id))
    if (
        job is None
        or job.kind != "export_materials"
        or job.input.get("project_id") != str(project_id)
    ):
        raise HTTPException(404, detail="export not found")
    return job


def _has_complete_anki_layout(job_id: UUID, *, didactic: bool) -> bool:
    if not didactic:
        return True
    manifest_path = (
        get_settings().media_cache_root / "exports" / str(job_id)
        / "anki-audio-manifest.json"
    )
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        return payload.get("card_layout") == "ihub-didactic-v3"
    except (OSError, ValueError, TypeError):
        return False


def _publication_document(project_id: UUID, job_id: UUID) -> dict | None:
    path = _publisher().publication_path(project_id, job_id)
    if not path.is_file():
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        validate_anki_audio(document)
        if document.get("generator", {}).get("project_id") != str(project_id) or document.get(
            "generator", {}
        ).get("export_job_id") != str(job_id):
            raise ValueError("publication identity mismatch")
    except (OSError, ValueError, ContractViolation, json.JSONDecodeError) as error:
        raise HTTPException(409, detail="published hub_final.json is invalid") from error
    return document


def _project_cues(project_id: UUID) -> list[tuple[int, Cue]]:
    repository = _repository()
    if repository.get_project(project_id) is None:
        raise HTTPException(404, detail="project not found")
    return [
        (scene.order, cue)
        for scene in repository.get_project_scenes(project_id)
        for cue in repository.get_scene_cues(scene.id)
        if cue.approved_en and cue.approved_pt and cue.provenance.get("approval") != "draft"
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
    repository = _repository()
    words = repository.get_cue_words(cue.id)
    tags = cue.provenance.get("tags", [])
    return CardResponse(
        cue_id=cue.id,
        scene_order=scene_order,
        cue_order=cue.order,
        approved_en=cue.approved_en,
        approved_pt=cue.approved_pt,
        tags=[tag for tag in tags if isinstance(tag, str)] if isinstance(tags, list) else [],
        included=cue.provenance.get("anki_included") is not False,
        speaker=cue.speaker,
        speech_start_ms=cue.speech_start_ms,
        speech_end_ms=cue.speech_end_ms,
        reel_start_ms=reel_start if speech and reel_start is not None else None,
        reel_end_ms=reel_start + speech.duration_ms if speech and reel_start is not None else None,
        audio_ready=speech is not None,
        audio_url=(
            f"{get_settings().api_prefix}/projects/{project_id}/materials/{cue.id}/audio"
            f"?voice_id={voice.profile_id}&voice_version={voice.version}"
            if speech and voice
            else None
        ),
        editorial_ready=_cue_is_editorially_prepared(cue, words),
        highlights=_highlights(words),
    )


def _cue_is_editorially_prepared(cue: Cue, words: list[WordTiming]) -> bool:
    return (
        cue.provenance.get("editorial_preparation") == "complete"
        and cue.provenance.get("editorial_preparation_contract")
        in {
            "nova-generator-editorial-suggestions/1.3",
            "nova-generator-editorial-suggestions/1.4",
            "nova-generator-editorial-suggestions/1.5",
        }
        and all(
            (
                isinstance(word.provenance.get("pt"), str)
                and bool(str(word.provenance["pt"]).strip())
            )
            or word.provenance.get("semantic_group_role") == "member"
            for word in words
        )
    )


def _highlights(words: list[WordTiming]) -> list[PedagogicalHighlightResponse]:
    groups: dict[str, list[WordTiming]] = {}
    for word in words:
        group_id = word.provenance.get("semantic_group_id")
        if isinstance(group_id, str):
            groups.setdefault(group_id, []).append(word)

    highlights: list[PedagogicalHighlightResponse] = []
    for group_words in groups.values():
        if len(group_words) < 2:
            continue
        ordered = sorted(group_words, key=lambda item: item.order)
        lead = next(
            (item for item in ordered if item.provenance.get("semantic_group_role") == "lead"),
            None,
        )
        pt = lead.provenance.get("pt") if lead else None
        if not isinstance(pt, str) or not pt.strip():
            continue
        highlights.append(
            PedagogicalHighlightResponse(
                en="".join(word.surface for word in ordered).strip(),
                pt=pt.strip(),
                kind="unidade semântica",
            )
        )
    return highlights


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
        cards=cards,
        voice_id=voice.profile_id if voice else None,
        voice_version=voice.version if voice else None,
    )


@router.patch("/{cue_id}", response_model=CardResponse)
def update_material(project_id: UUID, cue_id: UUID, payload: SelectionInput) -> CardResponse:
    match = next(
        ((order, cue) for order, cue in _project_cues(project_id) if cue.id == cue_id), None
    )
    if match is None:
        raise HTTPException(404, detail="card not found")
    scene_order, cue = match
    updated = replace(cue, provenance={**cue.provenance, "anki_included": payload.included})
    repository = _repository()
    repository.save_cue(updated, repository.get_cue_words(cue.id))
    return _card(project_id, scene_order, updated, None, None)


@router.get("/{cue_id}/audio")
def stream_material_audio(
    project_id: UUID,
    cue_id: UUID,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    voice_id: UUID,
    voice_version: int,
) -> FileResponse:
    cue = next((cue for _, cue in _project_cues(project_id) if cue.id == cue_id), None)
    if cue is None:
        raise HTTPException(404, detail="card not found")
    profile = voices.get(voice_id, voice_version)
    if profile is None:
        raise HTTPException(404, detail="voice profile not found")
    cache = FileSpeechCache(get_settings().media_cache_root)
    speech = cache.find(
        cache.cache_key(text=cue.approved_en, profile=profile.snapshot(), parameters={})
    )
    if speech is None:
        raise HTTPException(404, detail="canonical WAV not ready")
    return FileResponse(speech.audio_path, media_type="audio/wav", filename=f"cue-{cue.id}.wav")


@router.post("/{cue_id}/audio", response_model=JobRefResponse, status_code=status.HTTP_202_ACCEPTED)
def prepare_material_audio(
    project_id: UUID,
    cue_id: UUID,
    payload: VoiceInput,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> JobRefResponse:
    cue = next((cue for _, cue in _project_cues(project_id) if cue.id == cue_id), None)
    if cue is None:
        raise HTTPException(404, detail="card not found")
    voice = _voice(voices, payload.voice_id)
    try:
        validate_profile_reference(
            FileVoiceReferenceStore(get_settings().media_cache_root),
            voice.reference_audio_sha256,
        )
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc
    job = enqueue.execute(
        kind="synthesize_material_audio",
        input={
            "project_id": str(project_id),
            "cue_id": str(cue_id),
            "approved_en": cue.approved_en,
            "voice_snapshot": _voice_payload(voice),
        },
        idempotency_key=None,
    )
    return JobRefResponse(id=job.id, status=job.status)


@router.post("/exports", response_model=ExportResponse, status_code=status.HTTP_202_ACCEPTED)
def export_materials(
    project_id: UUID,
    payload: VoiceInput,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> ExportResponse:
    selected = [
        cue
        for _, cue in _project_cues(project_id)
        if cue.provenance.get("anki_included") is not False
    ]
    if not selected:
        raise HTTPException(422, detail="select at least one card")
    voice = _voice(voices, payload.voice_id)
    cache = FileSpeechCache(get_settings().media_cache_root)
    audio_hashes: dict[str, str] = {}
    for cue in selected:
        speech = cache.find(cache.cache_key(text=cue.approved_en, profile=voice, parameters={}))
        if speech is None:
            raise HTTPException(422, detail=f"canonical WAV not ready for cue {cue.id}")
        audio_hashes[str(cue.id)] = sha256(Path(speech.audio_path).read_bytes()).hexdigest()
    repository = _repository()
    project = repository.get_project(project_id)
    if project is None:
        raise HTTPException(404, detail="project not found")
    editorial_hash = editorial_publication_sha256(
        project,
        repository.get_project_scenes(project_id),
        [(cue, repository.get_cue_words(cue.id)) for cue in selected],
    )
    job = enqueue.execute(
        kind="export_materials",
        input={
            "project_id": str(project_id),
            "cue_ids": [str(cue.id) for cue in selected],
            "text_hashes": {str(cue.id): cue.approved_en_sha256 for cue in selected},
            "pt_hashes": {str(cue.id): utf8_sha256(cue.approved_pt) for cue in selected},
            "audio_hashes": audio_hashes,
            "editorial_sha256": editorial_hash,
            "voice_snapshot": _voice_payload(voice),
        },
        idempotency_key=None,
    )
    return ExportResponse(job_id=job.id, status=job.status)


def _didactic_exchange() -> MaterialsAiExchange:
    return MaterialsAiExchange(_repository(), get_settings().project_root)


def _didactic_card(project_id: UUID, card_id: UUID) -> dict:
    try:
        return _didactic_exchange().find_anki_card(project_id, card_id)
    except MaterialsAiError as error:
        raise HTTPException(409, detail=str(error)) from error


@router.get("/anki-audio")
def didactic_anki_audio_status(
    project_id: UUID,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    voice_id: UUID | None = None,
) -> dict:
    voice = _voice(voices, voice_id) if voice_id else None
    cache = FileSpeechCache(get_settings().media_cache_root)
    try:
        cards = _didactic_exchange().package(project_id)["source"].get("anki_prepared", [])
    except MaterialsAiError as error:
        raise HTTPException(409, detail=str(error)) from error
    return {
        "cards": [
            {
                "card_id": card["card_id"],
                "cue_id": card["cue_id"],
                "front_en": card["front_en"],
                "audio_ready": (
                    voice is not None
                    and cache.find(cache.cache_key(
                        text=card["front_en"], profile=voice, parameters={}
                    )) is not None
                ),
                "audio_url": (
                    f"{get_settings().api_prefix}/projects/{project_id}/materials/anki/"
                    f"{card['card_id']}/audio?voice_id={voice.profile_id}&voice_version={voice.version}"
                    if voice is not None
                    and cache.find(cache.cache_key(
                        text=card["front_en"], profile=voice, parameters={}
                    )) is not None else None
                ),
            }
            for card in cards
        ],
    }


@router.get("/anki/{card_id}/audio")
def stream_didactic_anki_audio(
    project_id: UUID,
    card_id: UUID,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    voice_id: UUID,
    voice_version: int,
) -> FileResponse:
    card = _didactic_card(project_id, card_id)
    voice = voices.get(voice_id, voice_version)
    if voice is None:
        raise HTTPException(404, detail="voice profile not found")
    cache = FileSpeechCache(get_settings().media_cache_root)
    speech = cache.find(cache.cache_key(
        text=card["front_en"], profile=voice.snapshot(), parameters={}
    ))
    if speech is None:
        raise HTTPException(404, detail="didactic card WAV not ready")
    return FileResponse(
        speech.audio_path, media_type="audio/wav", filename=f"anki-{card_id}.wav"
    )


@router.post(
    "/anki/{card_id}/audio",
    response_model=JobRefResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def prepare_didactic_anki_audio(
    project_id: UUID,
    card_id: UUID,
    payload: VoiceInput,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> JobRefResponse:
    card = _didactic_card(project_id, card_id)
    voice = _voice(voices, payload.voice_id)
    try:
        validate_profile_reference(
            FileVoiceReferenceStore(get_settings().media_cache_root),
            voice.reference_audio_sha256,
        )
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    job = enqueue.execute(
        kind="synthesize_material_audio",
        input={
            "project_id": str(project_id),
            "cue_id": card["cue_id"],
            "anki_card_id": str(card_id),
            "approved_en": card["front_en"],
            "voice_snapshot": _voice_payload(voice),
        },
        idempotency_key=None,
    )
    return JobRefResponse(id=job.id, status=job.status)


@router.post(
    "/anki-exports",
    response_model=ExportResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def export_didactic_anki(
    project_id: UUID,
    payload: VoiceInput,
    voices: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> ExportResponse:
    exchange = _didactic_exchange()
    try:
        prepared = exchange.package(project_id)["source"]
    except MaterialsAiError as error:
        raise HTTPException(409, detail=str(error)) from error
    cards = prepared.get("anki_prepared", [])
    if not cards:
        raise HTTPException(422, detail="No prepared didactic Anki cards found")
    # The reel must respect the chronology of the original scene, even when
    # the AI proposed cards in a different pedagogical order.
    repo = _repository()
    project_scenes = repo.get_project_scenes(project_id)
    scenes = {str(scene.id): scene.order for scene in project_scenes}
    cue_orders = {
        str(cue.id): cue.order
        for scene in project_scenes
        for cue in repo.get_scene_cues(scene.id)
    }
    cards = sorted(
        cards,
        key=lambda card: (
            scenes.get(card["scene_id"], 0),
            cue_orders.get(card["cue_id"], 0),
        ),
    )
    if prepared.get("anki_prepared_needs_review"):
        raise HTTPException(409, detail="Review outdated Anki cards before export")
    voice = _voice(voices, payload.voice_id)
    cache = FileSpeechCache(get_settings().media_cache_root)
    source_cues = {}
    audio_hashes = {}
    for card in cards:
        cue_id = UUID(card["cue_id"])
        cue = repo.get_cue(cue_id)
        if cue is None or cue.provenance.get("approval") == "draft":
            raise HTTPException(
                409, detail=f"Source cue for card {card['card_id']} is not approved"
            )
        source_cues[str(cue_id)] = cue
        speech = cache.find(cache.cache_key(text=card["front_en"], profile=voice, parameters={}))
        if speech is None:
            raise HTTPException(
                422,
                detail=f"Didactic card {card['card_id']} needs its own WAV before export",
            )
        audio_hashes[card["card_id"]] = sha256(Path(speech.audio_path).read_bytes()).hexdigest()
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(404, detail="project not found")
    editorial_hash = editorial_publication_sha256(
        project, repo.get_project_scenes(project_id),
        [(cue, repo.get_cue_words(cue.id)) for cue in source_cues.values()],
    )
    job = enqueue.execute(
        kind="export_materials",
        input={
            "mode": "didactic",
            "project_id": str(project_id),
            "cue_ids": [card["cue_id"] for card in cards],
            "anki_cards": cards,
            "text_hashes": {card["card_id"]: utf8_sha256(card["front_en"]) for card in cards},
            "pt_hashes": {card["card_id"]: utf8_sha256(card["back_pt"]) for card in cards},
            "audio_hashes": audio_hashes,
            "editorial_sha256": editorial_hash,
            "voice_snapshot": _voice_payload(voice),
        },
        idempotency_key=None,
    )
    return ExportResponse(job_id=job.id, status=job.status)


@router.get("/exports/{job_id}", response_model=ExportResponse)
def get_material_export(
    project_id: UUID, job_id: UUID, jobs: Annotated[GetJob, Depends(get_job)]
) -> ExportResponse:
    job = _export_job(project_id, job_id, jobs)
    base = f"{get_settings().api_prefix}/projects/{project_id}/materials/exports/{job_id}"
    publication = _publication_document(project_id, job_id) if job.status == "succeeded" else None
    return ExportResponse(
        job_id=job.id,
        status=job.status,
        error_message=job.error_message,
        apkg_url=f"{base}/anki.apkg" if job.status == "succeeded" else None,
        manifest_url=f"{base}/anki-audio-manifest.json" if job.status == "succeeded" else None,
        reel_url=f"{base}/anki-reel.mp4" if job.status == "succeeded" else None,
        hub_final_url=f"{base}/hub_final.json" if publication else None,
        bundle_url=(
            f"{base}/kit-completo.zip"
            if publication and _has_complete_anki_layout(
                job_id, didactic=job.input.get("mode") == "didactic"
            )
            else None
        ),
        youtube_video_id=publication["ankiAudio"]["youtube"]["video_id"] if publication else None,
    )


@router.get("/latest-export", response_model=ExportResponse)
def latest_material_export(project_id: UUID) -> ExportResponse:
    if _repository().get_project(project_id) is None:
        raise HTTPException(404, detail="project not found")
    job = SqlAlchemyJobRepository(get_session_factory()).latest_for_project(
        str(project_id), "export_materials"
    )
    if job is None:
        raise HTTPException(404, detail="export not found")
    return get_material_export(
        project_id, job.id, GetJob(SqlAlchemyJobRepository(get_session_factory()))
    )


@router.post("/exports/{job_id}/publication", response_model=PublicationResponse)
def publish_material_export(
    project_id: UUID,
    job_id: UUID,
    payload: PublicationInput,
    jobs: Annotated[GetJob, Depends(get_job)],
) -> PublicationResponse:
    if not payload.confirmed:
        raise HTTPException(422, detail="Confirme o upload e o ID do reel no YouTube.")
    job = _export_job(project_id, job_id, jobs)
    try:
        result = _publisher().execute(project_id=project_id, job=job, youtube=payload.youtube)
    except (AnkiPublicationError, ContractViolation) as error:
        raise HTTPException(409, detail=str(error)) from error
    return PublicationResponse(
        youtube_video_id=result.youtube_video_id,
        youtube_url=result.youtube_url,
        hub_final_url=(
            f"{get_settings().api_prefix}/projects/{project_id}/materials/exports/"
            f"{job_id}/hub_final.json"
        ),
    )


@router.post(
    "/exports/{job_id}/publication/regenerate",
    response_model=PublicationResponse,
)
def regenerate_final_materials(
    project_id: UUID,
    job_id: UUID,
    jobs: Annotated[GetJob, Depends(get_job)],
) -> PublicationResponse:
    """Rebuild the published JSON from current approved content and the frozen reel.

    No voice synthesis, APKG creation or YouTube upload is invoked here. The
    publisher checks original job hashes and keeps the existing video binding.
    """
    job = _export_job(project_id, job_id, jobs)
    if job.status != "succeeded":
        raise HTTPException(
            409, detail="A exportação precisa estar concluída para regerar os materiais finais."
        )
    existing = _publication_document(project_id, job_id)
    if existing is None:
        raise HTTPException(
            409,
            detail="O kit ainda não foi publicado. Primeiro vincule o reel ao YouTube.",
        )
    youtube_id = existing.get("ankiAudio", {}).get("youtube", {}).get("video_id")
    if not isinstance(youtube_id, str) or not youtube_id.strip():
        raise HTTPException(409, detail="O vínculo original com o YouTube está ausente.")
    try:
        result = _publisher().execute(
            project_id=project_id, job=job, youtube=youtube_id
        )
    except (AnkiPublicationError, ContractViolation) as error:
        raise HTTPException(409, detail=str(error)) from error
    return PublicationResponse(
        youtube_video_id=result.youtube_video_id,
        youtube_url=result.youtube_url,
        hub_final_url=(
            f"{get_settings().api_prefix}/projects/{project_id}/materials/exports/"
            f"{job_id}/hub_final.json"
        ),
    )


@router.get("/exports/{job_id}/hub_final.json")
def download_hub_final(
    project_id: UUID, job_id: UUID, jobs: Annotated[GetJob, Depends(get_job)]
) -> FileResponse:
    job = _export_job(project_id, job_id, jobs)
    if job.status != "succeeded" or _publication_document(project_id, job_id) is None:
        raise HTTPException(404, detail="publication not found")
    return FileResponse(
        _publisher().publication_path(project_id, job_id),
        filename="hub_final.json",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


@router.get("/exports/{job_id}/kit-completo.zip")
def download_complete_delivery(
    project_id: UUID,
    job_id: UUID,
    jobs: Annotated[GetJob, Depends(get_job)],
) -> FileResponse:
    """Package only the files from this successful, published export job."""
    job = _export_job(project_id, job_id, jobs)
    if job.status != "succeeded":
        raise HTTPException(409, detail="Conclua a exportação antes de baixar o kit.")
    publication = _publication_document(project_id, job_id)
    if publication is None:
        raise HTTPException(
            409, detail="Vincule o reel ao YouTube para gerar o JSON final antes do ZIP."
        )
    settings = get_settings()
    export_dir = settings.media_cache_root / "exports" / str(job_id)
    publication_path = _publisher().publication_path(project_id, job_id)
    manifest_path = export_dir / "anki-audio-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema") != "nova-generator-anki-audio":
            raise DeliveryError("Manifesto do reel incompatível com a entrega.")
        if (
            job.input.get("mode") == "didactic"
            and manifest.get("card_layout") != "ihub-didactic-v3"
        ):
            raise DeliveryError(
                "APKG gerado no formato antigo: exporte novamente o Anki didático "
                "para incluir frente, verso e mini-aula iguais ao iHub."
            )
        apkg_sha = manifest["apkg_sha256"]
        reel_sha = manifest["reel_sha256"]
        if not all(isinstance(value, str) and len(value) == 64
                   for value in (apkg_sha, reel_sha)):
            raise DeliveryError("Hashes inválidos no manifesto de áudio.")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(409, detail="Manifesto Anki indisponível ou inválido.") from error

    cards = job.input.get("anki_cards") if job.input.get("mode") == "didactic" else None
    if cards is not None:
        try:
            verify_didactic_publication(cards, publication)
        except (DeliveryError, KeyError, TypeError) as error:
            raise HTTPException(409, detail=str(error)) from error

    voice_data = job.input.get("voice_snapshot", {})
    try:
        snapshot = VoiceProfileSnapshot(
            profile_id=UUID(str(voice_data["profile_id"])),
            name=str(voice_data["name"]),
            version=int(voice_data["version"]),
            model_id=str(voice_data["model_id"]),
            model_sha256=str(voice_data["model_sha256"]),
            reference_audio_sha256=(
                str(voice_data["reference_audio_sha256"])
                if voice_data.get("reference_audio_sha256") else None
            ),
            parameters=dict(voice_data.get("parameters", {})),
        )
        if snapshot.sha256 != voice_data.get("snapshot_sha256"):
            raise DeliveryError("A voz da exportação foi alterada.")
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(409, detail="Snapshot de voz inválido.") from error

    cache = FileSpeechCache(settings.media_cache_root)
    assets = [
        DeliveryAsset("hub_final.json", publication_path),
        DeliveryAsset("anki/anki.apkg", export_dir / "anki.apkg", apkg_sha),
        DeliveryAsset("anki/anki-reel.mp4", export_dir / "anki-reel.mp4", reel_sha),
        DeliveryAsset("anki/anki-audio-manifest.json", manifest_path),
    ]
    repository = _repository()
    records = (
        [(str(card["card_id"]), str(card["front_en"])) for card in cards]
        if cards is not None
        else [
            (str(cue.id), cue.approved_en)
            for raw_id in job.input["cue_ids"]
            if (cue := repository.get_cue(UUID(str(raw_id)))) is not None
        ]
    )
    if len(records) != len(job.input["cue_ids"]):
        raise HTTPException(409, detail="Uma das cues originais não está disponível.")
    for card_id, sentence in records:
        speech = cache.find(cache.cache_key(
            text=sentence, profile=snapshot, parameters={}
        ))
        if speech is None:
            raise HTTPException(
                409, detail=f"Áudio original desta exportação indisponível: {card_id}"
            )
        expected_sha = job.input.get("audio_hashes", {}).get(card_id)
        if not isinstance(expected_sha, str):
            raise HTTPException(409, detail=f"Hash do WAV ausente: {card_id}")
        assets.append(DeliveryAsset(
            f"audio/wav/{card_id}.wav", Path(speech.audio_path), expected_sha
        ))

    temporary = tempfile.TemporaryDirectory(prefix="nova_kit_")
    try:
        temp_dir = Path(temporary.name)
        # Optional pedagogical material belongs to the same approved source.
        try:
            approved = MaterialsAiExchange(repository, settings.project_root).status(project_id)
            if approved["status"] == "approved" and approved["document"]:
                pedagogy = temp_dir / "material-didatico.json"
                pedagogy.write_text(
                    json.dumps(approved["document"], ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                assets.append(DeliveryAsset("materiais/material-didatico.json", pedagogy))
        except MaterialsAiError:
            pass
        shadowing = PrepareShadowing(repository, settings.project_root)
        for scene in repository.get_project_scenes(project_id):
            try:
                plan = shadowing.scene(project_id, scene.id)
            except ShadowingError:
                continue
            if plan.get("status") != "approved":
                continue
            plan_path = temp_dir / f"shadowing-{scene.id}.json"
            plan_path.write_text(
                json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            assets.append(
                DeliveryAsset(f"shadowing/{scene.id}.json", plan_path)
            )
        destination = temp_dir / "kit-completo.zip"
        build_delivery_zip(
            destination,
            project_id=str(project_id),
            job_id=str(job_id),
            assets=assets,
            didactic_cards=cards,
        )
        return FileResponse(
            destination,
            media_type="application/zip",
            filename=f"kit-completo-{project_id}.zip",
            background=BackgroundTask(temporary.cleanup),
            headers={"Cache-Control": "no-store"},
        )
    except (DeliveryError, OSError, TypeError, KeyError) as error:
        temporary.cleanup()
        raise HTTPException(409, detail=str(error)) from error


@router.get("/exports/{job_id}/{artifact}")
def download_material_export(
    project_id: UUID,
    job_id: UUID,
    artifact: str,
    jobs: Annotated[GetJob, Depends(get_job)],
) -> FileResponse:
    if artifact not in {"anki.apkg", "anki-audio-manifest.json", "anki-reel.mp4"}:
        raise HTTPException(404, detail="artifact not found")
    job = jobs.execute(str(job_id))
    if (
        job is None
        or job.kind != "export_materials"
        or job.status != "succeeded"
        or job.input.get("project_id") != str(project_id)
    ):
        raise HTTPException(404, detail="export not found")
    path = Path(get_settings().media_cache_root) / "exports" / str(job_id) / artifact
    if not path.is_file():
        raise HTTPException(404, detail="artifact not found")
    return FileResponse(path, filename=artifact)


def _voice_payload(snapshot: VoiceProfileSnapshot) -> dict[str, object]:
    return {
        "profile_id": str(snapshot.profile_id),
        "name": snapshot.name,
        "version": snapshot.version,
        "model_id": snapshot.model_id,
        "model_sha256": snapshot.model_sha256,
        "reference_audio_sha256": snapshot.reference_audio_sha256,
        "parameters": snapshot.parameters,
        "snapshot_sha256": snapshot.sha256,
    }
