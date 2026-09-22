from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.domain.projects.entities import Cue, EditorialRevision, Scene, WordTiming


class CandidateReviewError(ValueError):
    pass


class ReviewAsrCandidate:
    """Create draft editorial records from a completed ingest job, once per job."""

    def __init__(self, projects: EditorialProjectRepository, jobs: JobRepository) -> None:
        self._projects, self._jobs = projects, jobs

    def execute(self, project_id: UUID, ingest_job_id: UUID, *, author: str) -> Scene:
        project = self._projects.get_project(project_id)
        if project is None:
            raise CandidateReviewError("project not found")
        job = self._jobs.get(str(ingest_job_id))
        if job is None:
            raise CandidateReviewError("ingest job not found")
        if (
            job.kind != "ingest_scene_media"
            or job.status != "succeeded"
            or job.input.get("project_id") != str(project_id)
            or not isinstance(job.output, dict)
        ):
            raise CandidateReviewError("ingest job must have succeeded for this project")
        scene_id = uuid5(NAMESPACE_URL, f"nova-generator/asr-scene/{ingest_job_id}")
        prior = next(
            (
                scene
                for scene in self._projects.get_project_scenes(project_id)
                if scene.id == scene_id
            ),
            None,
        )
        if prior and self._projects.get_scene_cues(scene_id):
            return prior
        entries, duration_ms = _candidate_entries(job.output, scene_id, ingest_job_id)
        if prior is None:
            scenes = self._projects.get_project_scenes(project_id)
            scene = Scene(
                scene_id,
                project_id,
                max((item.order for item in scenes), default=0) + 1,
                duration_ms,
                job.output.get("video_id") if isinstance(job.output.get("video_id"), str) else None,
                {"source": "asr_candidate", "ingest_job_id": str(ingest_job_id)},
            )
            self._projects.save_scene(scene)
        else:
            scene = prior
        self._projects.replace_scene_cues(scene_id, entries)
        self._projects.save_revision(
            EditorialRevision(
                uuid4(),
                project_id,
                scene_id,
                None,
                1,
                "import_asr_candidate",
                author,
                "ingest_scene_media",
                {},
                {"cues": [_snapshot_entry(cue, words) for cue, words in entries]},
                datetime.now(UTC),
            )
        )
        return scene


def _candidate_entries(
    output: dict[str, Any], scene_id: UUID, job_id: UUID
) -> tuple[list[tuple[Cue, list[WordTiming]]], int]:
    candidate = output.get("transcript_candidate")
    if not isinstance(candidate, dict) or not isinstance(candidate.get("cues"), list):
        raise CandidateReviewError("ingest job has no transcript candidate")
    raw_cues = candidate["cues"]
    if not raw_cues:
        raise CandidateReviewError("transcript candidate has no cues")
    entries: list[tuple[Cue, list[WordTiming]]] = []
    last_end = 0
    for index, raw in enumerate(raw_cues, 1):
        if not isinstance(raw, dict):
            raise CandidateReviewError("candidate cue must be an object")
        start, end = _range(raw.get("start_ms"), raw.get("end_ms"), "cue")
        if start < last_end:
            raise CandidateReviewError("candidate cues must be ordered and non-overlapping")
        text = raw.get("text")
        if not isinstance(text, str) or not text:
            raise CandidateReviewError("candidate cue needs literal text")
        cue_id = uuid5(NAMESPACE_URL, f"nova-generator/asr-cue/{job_id}/{index}")
        raw_words = raw.get("words")
        if not isinstance(raw_words, list):
            raise CandidateReviewError("candidate cue needs words")
        words: list[WordTiming] = []
        word_end = start
        for position, item in enumerate(raw_words, 1):
            if not isinstance(item, dict) or not isinstance(item.get("surface"), str):
                raise CandidateReviewError("candidate word needs literal surface")
            word_start, word_finish = _range(item.get("start_ms"), item.get("end_ms"), "word")
            if word_start < word_end or word_start < start or word_finish > end:
                raise CandidateReviewError("candidate words must be ordered inside their cue")
            words.append(
                WordTiming(
                    uuid5(NAMESPACE_URL, f"nova-generator/asr-word/{job_id}/{index}/{position}"),
                    cue_id,
                    position,
                    item["surface"],
                    word_start,
                    word_finish,
                    word_start,
                    word_finish,
                    {"source": "asr_candidate", "ingest_job_id": str(job_id)},
                )
            )
            word_end = word_finish
        cue = Cue(
            cue_id,
            scene_id,
            index,
            start,
            end,
            start,
            end,
            "",
            text,
            "",
            "",
            1,
            {"source": "asr_candidate", "ingest_job_id": str(job_id), "approval": "draft"},
        )
        entries.append((cue, words))
        last_end = end
    duration = output.get("duration_ms")
    if not isinstance(duration, int) or isinstance(duration, bool) or duration < last_end:
        raise CandidateReviewError("candidate timing exceeds the ingested scene duration")
    return entries, duration


def _range(start: object, end: object, field: str) -> tuple[int, int]:
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or start < 0
        or end <= start
    ):
        raise CandidateReviewError(f"{field} timing must be a positive millisecond range")
    return start, end


def _snapshot_entry(cue: Cue, words: list[WordTiming]) -> dict[str, Any]:
    return {
        "cue": {
            "id": str(cue.id),
            "scene_id": str(cue.scene_id),
            "order": cue.order,
            "speech_start_ms": cue.speech_start_ms,
            "speech_end_ms": cue.speech_end_ms,
            "subtitle_start_ms": cue.subtitle_start_ms,
            "subtitle_end_ms": cue.subtitle_end_ms,
            "speaker": cue.speaker,
            "original_en": cue.original_en,
            "approved_en": cue.approved_en,
            "approved_pt": cue.approved_pt,
            "revision": cue.revision,
            "provenance": cue.provenance,
        },
        "words": [
            {
                "id": str(word.id),
                "cue_id": str(word.cue_id),
                "order": word.order,
                "surface": word.surface,
                "start_ms": word.start_ms,
                "end_ms": word.end_ms,
                "original_start_ms": word.original_start_ms,
                "original_end_ms": word.original_end_ms,
                "provenance": word.provenance,
            }
            for word in words
        ],
    }
