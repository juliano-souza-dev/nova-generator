from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_manage_voice_profiles
from nova_generator.application.use_cases.manage_voice_profiles import (
    PREVIEW_TEXT,
    ManageVoiceProfiles,
)
from nova_generator.core.settings import get_settings
from nova_generator.domain.voices import VoiceProfile
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache

router = APIRouter(prefix="/voices", tags=["voices"])


class VoiceInput(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    model_id: str = Field(default="chatterbox-nano", min_length=1, max_length=255)
    model_sha256: str = Field(min_length=64, max_length=64)
    reference_audio_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    parameters: dict[str, Any] = Field(default_factory=dict)


class VoiceResponse(VoiceInput):
    id: str
    version: int
    snapshot_sha256: str
    preview_url: str | None = None
    preview_ready: bool = False


@router.get("", response_model=list[VoiceResponse])
def list_voices(use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)]):
    return [_response(profile) for profile in use_case.list()]


@router.post("", response_model=VoiceResponse, status_code=status.HTTP_201_CREATED)
def create_voice(
    payload: VoiceInput,
    use_case: Annotated[ManageVoiceProfiles, Depends(get_manage_voice_profiles)],
):
    try:
        return _response(use_case.create(**payload.model_dump()))
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
        return _response(use_case.version(voice_id, **payload.model_dump()))
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
