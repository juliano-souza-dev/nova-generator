from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import (
    get_adjust_cue_timing,
    get_adjust_word_timing,
    get_edit_approved_text,
    get_editorial_repository,
    get_merge_cues,
    get_review_asr_candidate,
    get_session_factory,
    get_split_cue,
    get_undo_editorial_revision,
)
from nova_generator.application.use_cases.editorial_commands import (
    AdjustCueTiming,
    AdjustWordTiming,
    EditApprovedText,
    EditorialCommandError,
    MergeCues,
    SplitCue,
    UndoEditorialRevision,
)
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
    cut = (
        get_settings().project_root / str(project_id) / "cuts" / f"{job.id}.mp4"
        if job
        else None
    )
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
        cut_url=(
            f"{get_settings().api_prefix}/projects/{project_id}/media/cuts/{job.id}"
        ),
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
    }


def _command(action: Callable[[], Any]) -> Any:
    try:
        return action()
    except EditorialCommandError as error:
        message = str(error)
        status = 404 if message.endswith("not found") else 422
        raise HTTPException(status_code=status, detail=message) from error
