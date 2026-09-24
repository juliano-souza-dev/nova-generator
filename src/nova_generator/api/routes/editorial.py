from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import (
    get_adjust_cue_timing,
    get_adjust_word_timing,
    get_edit_approved_text,
    get_edit_word_translation,
    get_editorial_repository,
    get_enqueue_job,
    get_external_editorial_exchange,
    get_group_word_translation,
    get_merge_cues,
    get_realign_cue,
    get_replace_semantic_word_units,
    get_review_asr_candidate,
    get_session_factory,
    get_split_cue,
    get_undo_editorial_revision,
    get_ungroup_word_translation,
)
from nova_generator.application.use_cases.editorial_assistance import (
    EditorialAssistanceError,
    build_editorial_prompt,
)
from nova_generator.application.use_cases.editorial_commands import (
    AdjustCueTiming,
    AdjustWordTiming,
    EditApprovedText,
    EditorialCommandError,
    EditWordTranslation,
    GroupWordTranslation,
    MergeCues,
    RealignCue,
    ReplaceSemanticWordUnits,
    SplitCue,
    UndoEditorialRevision,
    UngroupWordTranslation,
)
from nova_generator.application.use_cases.external_editorial_exchange import (
    ExternalEditorialExchange,
)
from nova_generator.application.use_cases.manage_jobs import EnqueueJob
from nova_generator.application.use_cases.review_asr_candidate import (
    CandidateReviewError,
    ReviewAsrCandidate,
)
from nova_generator.core.settings import get_settings
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.domain.projects.entities import Cue, WordTiming
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache

router = APIRouter(prefix="/editorial", tags=["editorial"])


class ActorRequest(BaseModel):
    author: str = Field(min_length=1, max_length=255)


class TextRequest(ActorRequest):
    approved_en: str
    approved_pt: str
    approve: bool = True


class Timing(BaseModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


class CueTimingRequest(ActorRequest):
    speech_timing: Timing
    subtitle_timing: Timing


class WordTimingInput(Timing):
    id: UUID


class WordTimingRequest(ActorRequest):
    timings: list[WordTimingInput] = Field(min_length=1)


class RealignCueRequest(ActorRequest):
    target_start_ms: int = Field(ge=0)


class WordTranslationRequest(ActorRequest):
    word_id: UUID
    pt: str = Field(min_length=1)


class GroupWordRequest(WordTranslationRequest):
    direction: str = Field(pattern="^(previous|next)$")


class UngroupWordRequest(ActorRequest):
    word_id: UUID


class SemanticUnitInput(BaseModel):
    word_ids: list[UUID] = Field(min_length=2)
    pt: str = Field(min_length=1)


class ReplaceSemanticUnitsRequest(ActorRequest):
    expected_revision: int = Field(ge=1)
    units: list[SemanticUnitInput]


class CueText(BaseModel):
    original_en: str
    approved_en: str
    approved_pt: str


class SplitCueRequest(ActorRequest):
    after_word_id: UUID
    first: CueText
    second: CueText


class MergeCueRequest(ActorRequest):
    first_cue_id: UUID
    second_cue_id: UUID
    text: CueText


class UndoRequest(ActorRequest):
    revision_id: UUID


class WordResponse(BaseModel):
    id: UUID
    order: int
    surface: str
    start_ms: int
    end_ms: int
    original_start_ms: int
    original_end_ms: int
    provenance: dict[str, object]
    pt: str | None = None
    semantic_group_id: str | None = None
    semantic_group_role: str | None = None


class CueResponse(BaseModel):
    id: UUID
    scene_id: UUID
    order: int
    speech_timing: Timing
    subtitle_timing: Timing
    speaker: str
    original_en: str
    original_en_sha256: str
    approved_en: str
    approved_en_sha256: str
    approved_pt: str
    approved_pt_sha256: str
    revision: int
    provenance: dict[str, object]


class CueWithWordsResponse(CueResponse):
    words: list[WordResponse]


class SceneResponse(BaseModel):
    id: UUID
    project_id: UUID
    order: int
    duration_ms: int
    source_video_id: str | None
    provenance: dict[str, object]


class RevisionResponse(BaseModel):
    id: UUID
    sequence: int
    command: str
    author: str
    before_sha256: str
    after_sha256: str


class ReviewContextResponse(BaseModel):
    status: str
    scene: SceneResponse
    ingest_job_id: UUID
    cut_url: str


class EditorialAssistantStatusResponse(BaseModel):
    groq_configured: bool
    groq_model: str
    fallback_available: bool = True


class EditorialAssistanceJobResponse(BaseModel):
    job_id: str
    status: str


class EditorialSuggestionResponse(BaseModel):
    cue_id: str
    order: int
    approved_en: str
    approved_pt: str
    notes: str
    semantic_units: list[SemanticUnitInput] = Field(default_factory=list)


class EditorialAssistanceResponse(BaseModel):
    scene_id: str
    input_sha256: str
    provider: str
    model: str
    rate_limits: dict[str, str]
    suggestions: list[EditorialSuggestionResponse]


@router.get("/assistant/status", response_model=EditorialAssistantStatusResponse)
def editorial_assistant_status() -> EditorialAssistantStatusResponse:
    settings = get_settings()
    return EditorialAssistantStatusResponse(
        groq_configured=bool(settings.groq_api_key), groq_model=settings.groq_editorial_model
    )


@router.post(
    "/scenes/{scene_id}/assistance",
    response_model=EditorialAssistanceJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_editorial_assistance(
    scene_id: UUID,
    repository: Annotated[SqlAlchemyEditorialProjectRepository, Depends(get_editorial_repository)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> EditorialAssistanceJobResponse:
    try:
        input_sha256, _ = build_editorial_prompt(repository, scene_id)
    except EditorialAssistanceError as error:
        raise HTTPException(
            404 if str(error).endswith("not found") else 422, detail=str(error)
        ) from error
    project_id = repository.get_scene_project_id(scene_id)
    assert project_id is not None
    job = enqueue.execute(
        kind="editorial_assistance",
        input={"scene_id": str(scene_id), "project_id": str(project_id)},
        idempotency_key=f"editorial-assistance:{scene_id}:{input_sha256}",
        max_attempts=1,
    )
    return EditorialAssistanceJobResponse(job_id=str(job.id), status=job.status)


@router.get("/scenes/{scene_id}/external-package")
def download_external_editorial_package(
    scene_id: UUID,
    exchange: Annotated[ExternalEditorialExchange, Depends(get_external_editorial_exchange)],
) -> FileResponse:
    try:
        package = exchange.build_package(scene_id)
    except EditorialAssistanceError as error:
        raise HTTPException(
            404 if str(error).endswith("not found") else 422, detail=str(error)
        ) from error
    return FileResponse(package, media_type="application/zip", filename=package.name)


@router.post("/scenes/{scene_id}/external-result", response_model=EditorialAssistanceResponse)
async def import_external_editorial_result(
    scene_id: UUID,
    exchange: Annotated[ExternalEditorialExchange, Depends(get_external_editorial_exchange)],
    file: Annotated[UploadFile, File()],
) -> EditorialAssistanceResponse:
    try:
        result = exchange.import_result(scene_id, await file.read())
    except EditorialAssistanceError as error:
        raise HTTPException(422, detail=str(error)) from error
    return EditorialAssistanceResponse(
        scene_id=result.scene_id,
        input_sha256=result.input_sha256,
        provider=result.provider,
        model=result.model,
        rate_limits=result.rate_limits,
        suggestions=[
            EditorialSuggestionResponse.model_validate(asdict(item)) for item in result.suggestions
        ],
    )


@router.get("/projects/{project_id}/scenes", response_model=list[SceneResponse])
def list_scenes(
    project_id: UUID,
    repository: Annotated[SqlAlchemyEditorialProjectRepository, Depends(get_editorial_repository)],
) -> list[SceneResponse]:
    if repository.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return [
        SceneResponse.model_validate(scene, from_attributes=True)
        for scene in repository.get_project_scenes(project_id)
    ]


@router.get("/scenes/{scene_id}/cues", response_model=list[CueWithWordsResponse])
def list_scene_cues(
    scene_id: UUID,
    repository: Annotated[SqlAlchemyEditorialProjectRepository, Depends(get_editorial_repository)],
) -> list[dict[str, Any]]:
    if repository.get_scene_project_id(scene_id) is None:
        raise HTTPException(status_code=404, detail="scene not found")
    return [
        {
            **_cue_response(cue),
            "words": [_word_response(word) for word in repository.get_cue_words(cue.id)],
        }
        for cue in repository.get_scene_cues(scene_id)
    ]


@router.get("/scenes/{scene_id}/revisions", response_model=list[RevisionResponse])
def list_scene_revisions(
    scene_id: UUID,
    repository: Annotated[SqlAlchemyEditorialProjectRepository, Depends(get_editorial_repository)],
) -> list[RevisionResponse]:
    if repository.get_scene_project_id(scene_id) is None:
        raise HTTPException(status_code=404, detail="scene not found")
    return [
        RevisionResponse(
            id=item.id,
            sequence=item.sequence,
            command=item.command,
            author=item.author,
            before_sha256=item.before_sha256,
            after_sha256=item.after_sha256,
        )
        for item in repository.list_revisions(scene_id)
    ]


@router.post(
    "/projects/{project_id}/candidates/{ingest_job_id}/draft",
    response_model=SceneResponse,
    status_code=201,
)
def draft_from_candidate(
    project_id: UUID,
    ingest_job_id: UUID,
    payload: ActorRequest,
    use_case: Annotated[ReviewAsrCandidate, Depends(get_review_asr_candidate)],
) -> SceneResponse:
    try:
        scene = use_case.execute(project_id, ingest_job_id, author=payload.author)
    except CandidateReviewError as error:
        raise HTTPException(
            status_code=404 if str(error).endswith("not found") else 422,
            detail=str(error),
        ) from error
    return SceneResponse.model_validate(scene, from_attributes=True)


@router.post("/projects/{project_id}/review", response_model=ReviewContextResponse)
def open_latest_review(
    project_id: UUID,
    use_case: Annotated[ReviewAsrCandidate, Depends(get_review_asr_candidate)],
    repository: Annotated[SqlAlchemyEditorialProjectRepository, Depends(get_editorial_repository)],
) -> ReviewContextResponse:
    """Resolve and materialize the latest valid ASR candidate without exposing job IDs."""
    project = repository.get_project(project_id)
    if project is None:
        raise HTTPException(404, detail="project not found")
    job = SqlAlchemyJobRepository(get_session_factory()).latest_for_project(
        str(project_id), "ingest_scene_media", "succeeded"
    )
    video_id = project.provenance.get("youtube_video_id")
    metadata = (
        FileYoutubeMediaCache(get_settings().media_cache_root).find_verified(YoutubeVideo(video_id))
        if isinstance(video_id, str)
        else None
    )
    cut = get_settings().project_root / str(project_id) / "cuts" / f"{job.id}.mp4" if job else None
    if (
        job is None
        or not isinstance(job.output, dict)
        or metadata is None
        or job.output.get("source_sha256") != metadata.sha256
        or job.output.get("video_id") != video_id
        or cut is None
        or not cut.is_file()
        or cut.stat().st_size == 0
    ):
        raise HTTPException(409, detail="no current ASR candidate; process the latest cut first")
    try:
        scene = use_case.execute(project_id, job.id, author="local-editor")
    except CandidateReviewError as error:
        raise HTTPException(422, detail=str(error)) from error
    return ReviewContextResponse(
        status="ready",
        scene=SceneResponse.model_validate(scene, from_attributes=True),
        ingest_job_id=job.id,
        cut_url=(f"{get_settings().api_prefix}/projects/{project_id}/media/cuts/{job.id}"),
    )


@router.put("/cues/{cue_id}/text", response_model=CueResponse)
def edit_text(
    cue_id: UUID,
    payload: TextRequest,
    use_case: Annotated[EditApprovedText, Depends(get_edit_approved_text)],
) -> dict[str, Any]:
    cue = _command(lambda: use_case.execute(cue_id, **payload.model_dump()))
    return _cue_response(cue)


@router.put("/cues/{cue_id}/timing", response_model=CueResponse)
def edit_cue_timing(
    cue_id: UUID,
    payload: CueTimingRequest,
    use_case: Annotated[AdjustCueTiming, Depends(get_adjust_cue_timing)],
) -> dict[str, Any]:
    data = payload.model_dump()
    cue = _command(
        lambda: use_case.execute(
            cue_id,
            speech_start_ms=data["speech_timing"]["start_ms"],
            speech_end_ms=data["speech_timing"]["end_ms"],
            subtitle_start_ms=data["subtitle_timing"]["start_ms"],
            subtitle_end_ms=data["subtitle_timing"]["end_ms"],
            author=data["author"],
        )
    )
    return _cue_response(cue)


@router.put("/cues/{cue_id}/words/timing", response_model=list[WordResponse])
def edit_word_timing(
    cue_id: UUID,
    payload: WordTimingRequest,
    use_case: Annotated[AdjustWordTiming, Depends(get_adjust_word_timing)],
) -> list[dict[str, Any]]:
    words = _command(
        lambda: use_case.execute(
            cue_id,
            timings=[item.model_dump(mode="json") for item in payload.timings],
            author=payload.author,
        )
    )
    return [_word_response(word) for word in words]


@router.post("/cues/{cue_id}/realign", response_model=CueResponse)
def realign_cue(
    cue_id: UUID,
    payload: RealignCueRequest,
    use_case: Annotated[RealignCue, Depends(get_realign_cue)],
) -> dict[str, Any]:
    cue = _command(lambda: use_case.execute(cue_id, **payload.model_dump()))
    return _cue_response(cue)


@router.put("/cues/{cue_id}/words/translation", response_model=list[WordResponse])
def edit_word_translation(
    cue_id: UUID,
    payload: WordTranslationRequest,
    use_case: Annotated[EditWordTranslation, Depends(get_edit_word_translation)],
) -> list[dict[str, Any]]:
    words = _command(lambda: use_case.execute(cue_id, **payload.model_dump()))
    return [_word_response(word) for word in words]


@router.post("/cues/{cue_id}/words/group", response_model=list[WordResponse])
def group_word_translation(
    cue_id: UUID,
    payload: GroupWordRequest,
    use_case: Annotated[GroupWordTranslation, Depends(get_group_word_translation)],
) -> list[dict[str, Any]]:
    words = _command(lambda: use_case.execute(cue_id, **payload.model_dump()))
    return [_word_response(word) for word in words]


@router.post("/cues/{cue_id}/words/ungroup", response_model=list[WordResponse])
def ungroup_word_translation(
    cue_id: UUID,
    payload: UngroupWordRequest,
    use_case: Annotated[UngroupWordTranslation, Depends(get_ungroup_word_translation)],
) -> list[dict[str, Any]]:
    words = _command(lambda: use_case.execute(cue_id, **payload.model_dump()))
    return [_word_response(word) for word in words]


@router.put("/cues/{cue_id}/words/semantic-units", response_model=list[WordResponse])
def replace_semantic_word_units(
    cue_id: UUID,
    payload: ReplaceSemanticUnitsRequest,
    use_case: Annotated[ReplaceSemanticWordUnits, Depends(get_replace_semantic_word_units)],
) -> list[dict[str, Any]]:
    words = _command(
        lambda: use_case.execute(
            cue_id,
            expected_revision=payload.expected_revision,
            units=[unit.model_dump(mode="json") for unit in payload.units],
            author=payload.author,
        )
    )
    return [_word_response(word) for word in words]


@router.post("/cues/{cue_id}/split", response_model=list[CueResponse])
def split_cue(
    cue_id: UUID,
    payload: SplitCueRequest,
    use_case: Annotated[SplitCue, Depends(get_split_cue)],
) -> list[dict[str, Any]]:
    cues = _command(
        lambda: use_case.execute(
            cue_id,
            after_word_id=payload.after_word_id,
            first=payload.first.model_dump(),
            second=payload.second.model_dump(),
            author=payload.author,
        )
    )
    return [_cue_response(cue) for cue in cues]


@router.post("/cues/merge", response_model=CueResponse)
def merge_cues(
    payload: MergeCueRequest,
    use_case: Annotated[MergeCues, Depends(get_merge_cues)],
) -> dict[str, Any]:
    cue = _command(
        lambda: use_case.execute(
            payload.first_cue_id,
            payload.second_cue_id,
            text=payload.text.model_dump(),
            author=payload.author,
        )
    )
    return _cue_response(cue)


@router.post("/scenes/{scene_id}/undo", response_model=list[CueWithWordsResponse])
def undo(
    scene_id: UUID,
    payload: UndoRequest,
    use_case: Annotated[UndoEditorialRevision, Depends(get_undo_editorial_revision)],
) -> list[dict[str, Any]]:
    cues = _command(
        lambda: use_case.execute(scene_id, revision_id=payload.revision_id, author=payload.author)
    )
    return [
        {**_cue_response(cue), "words": [_word_response(word) for word in words]}
        for cue, words in cues
    ]


def _cue_response(cue: Cue) -> dict[str, Any]:
    return {
        "id": cue.id,
        "scene_id": cue.scene_id,
        "order": cue.order,
        "speech_timing": {"start_ms": cue.speech_start_ms, "end_ms": cue.speech_end_ms},
        "subtitle_timing": {"start_ms": cue.subtitle_start_ms, "end_ms": cue.subtitle_end_ms},
        "speaker": cue.speaker,
        "original_en": cue.original_en,
        "original_en_sha256": cue.original_en_sha256,
        "approved_en": cue.approved_en,
        "approved_en_sha256": cue.approved_en_sha256,
        "approved_pt": cue.approved_pt,
        "approved_pt_sha256": cue.approved_pt_sha256,
        "revision": cue.revision,
        "provenance": cue.provenance,
    }


def _word_response(word: WordTiming) -> dict[str, Any]:
    return {
        "id": word.id,
        "order": word.order,
        "surface": word.surface,
        "start_ms": word.start_ms,
        "end_ms": word.end_ms,
        "original_start_ms": word.original_start_ms,
        "original_end_ms": word.original_end_ms,
        "provenance": word.provenance,
        "pt": word.provenance.get("pt"),
        "semantic_group_id": word.provenance.get("semantic_group_id"),
        "semantic_group_role": word.provenance.get("semantic_group_role"),
    }


def _command(action: Callable[[], Any]) -> Any:
    try:
        return action()
    except EditorialCommandError as error:
        message = str(error)
        status = 404 if message.endswith("not found") else 422
        raise HTTPException(status_code=status, detail=message) from error
