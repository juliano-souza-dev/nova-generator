from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_manage_voice_profiles
from nova_generator.application.use_cases.manage_voice_profiles import (
    PREVIEW_TEXT,
    ManageVoiceProfiles,
)
from nova_generator.core.settings import get_settings
from nova_generator.domain.voices import VoiceProfile
from nova_generator.infrastructure.filesystem.voice_references import (
    MAX_WAV_BYTES,
    FileVoiceReferenceStore,
    VoiceReference,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache
from nova_generator.infrastructure.speech.model_checkpoint import checkpoint_sha256

router = APIRouter(prefix="/voices", tags=["voices"])


def _references() -> FileVoiceReferenceStore:
    return FileVoiceReferenceStore(get_settings().media_cache_root)


class ReferenceResponse(BaseModel):
    sha256: str
    duration_ms: int
    sample_rate: int
    channels: int
    size_bytes: int
    audio_url: str


def _reference_response(reference: VoiceReference) -> ReferenceResponse:
    return ReferenceResponse(
        **vars(reference),
        audio_url=f"{get_settings().api_prefix}/voices/references/{reference.sha256}",
    )


@router.get("/model")
def get_model_status() -> dict[str, str | bool]:
    try:
        return {"available": True, "model_sha256": checkpoint_sha256(get_settings())}
    except ValueError as exc:
        return {"available": False, "message": str(exc)}


@router.get("/references", response_model=list[ReferenceResponse])
def list_references() -> list[ReferenceResponse]:
    return [_reference_response(reference) for reference in _references().list()]


@router.post("/references", response_model=ReferenceResponse, status_code=201)
async def upload_reference(file: Annotated[UploadFile, File(...)]) -> ReferenceResponse:
    if not file.filename or not file.filename.lower().endswith(".wav"):
        raise HTTPException(422, "Envie um arquivo .wav.")
    content = await file.read(MAX_WAV_BYTES + 1)
    try:
        return _reference_response(_references().save(content))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/references/{digest}")
def get_reference(digest: str) -> FileResponse:
    stored = _references().get(digest)
    if stored is None:
        raise HTTPException(404, "Áudio de referência não encontrado")
    return FileResponse(stored[1], media_type="audio/wav", filename="reference.wav")


class VoiceInput(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    model_id: str = Field(default="chatterbox-nano", min_length=1, max_length=255)
    model_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    reference_audio_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    parameters: dict[str, Any] = Field(default_factory=dict)


class VoiceResponse(VoiceInput):
    id: str
    version: int
    snapshot_sha256: str
    preview_url: str | None = None
    preview_ready: bool = False


def _prepare(payload: VoiceInput) -> dict[str, Any]:
    values = payload.model_dump()
    parameters = values["parameters"]
    if any(key.lower().endswith(("_path", "_file")) for key in parameters):
        raise ValueError("Caminhos de arquivo não são aceitos nos parâmetros da voz.")
    digest = values["reference_audio_sha256"]
    if digest is not None and _references().get(digest) is None:
        raise ValueError("Envie ou selecione um WAV de referência da biblioteca local.")
    values["model_sha256"] = values["model_sha256"] or checkpoint_sha256(get_settings())
    return values


@router.get("", response_model=list[VoiceResponse])
def list_voices(use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)]):
    return [_response(profile) for profile in use_case.list()]


@router.post("", response_model=VoiceResponse, status_code=status.HTTP_201_CREATED)
def create_voice(
    payload: VoiceInput,
    use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
):
    try:
        return _response(use_case.create(**_prepare(payload)))
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc


@router.post(
    "/{voice_id}/versions", response_model=VoiceResponse, status_code=status.HTTP_201_CREATED
)
def create_version(
    voice_id: UUID,
    payload: VoiceInput,
    use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
):
    try:
        values = _prepare(payload)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc
    try:
        return _response(use_case.version(voice_id, **values))
    except ValueError as exc:
        raise HTTPException(404, detail=str(exc)) from exc


@router.get("/{voice_id}/versions/{version}", response_model=VoiceResponse)
def get_voice_version(
    voice_id: UUID,
    version: int,
    use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
):
    profile = use_case.get(voice_id, version)
    if profile is None:
        raise HTTPException(404, detail="voice profile not found")
    return _response(profile)


@router.get("/{voice_id}/versions/{version}/preview")
def get_voice_preview(
    voice_id: UUID,
    version: int,
    use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
):
    profile = use_case.get(voice_id, version)
    if profile is None:
        raise HTTPException(404, detail="voice profile not found")
    cache = FileSpeechCache(get_settings().media_cache_root)
    key = cache.cache_key(text=PREVIEW_TEXT, profile=profile.snapshot(), parameters={})
    speech = cache.find(key)
    if speech is None:
        raise HTTPException(404, detail="voice preview not ready")
    return FileResponse(speech.audio_path, media_type="audio/wav", filename="preview.wav")


def _response(profile: VoiceProfile) -> VoiceResponse:
    snapshot = profile.snapshot()
    cache = FileSpeechCache(get_settings().media_cache_root)
    key = cache.cache_key(text=PREVIEW_TEXT, profile=snapshot, parameters={})
    return VoiceResponse(
        id=str(profile.id),
        name=profile.name,
        version=profile.version,
        model_id=profile.model_id,
        model_sha256=profile.model_sha256,
        reference_audio_sha256=profile.reference_audio_sha256,
        parameters=profile.parameters,
        snapshot_sha256=snapshot.sha256,
        preview_url=f"{get_settings().api_prefix}/voices/{profile.id}/versions/"
        f"{profile.version}/preview",
        preview_ready=cache.find(key) is not None,
    )
