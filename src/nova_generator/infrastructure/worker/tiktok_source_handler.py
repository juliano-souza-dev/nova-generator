"""Download, trim and transcribe TikTok Media sources without editorial projects."""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import UUID, uuid4

from nova_generator.application.use_cases.download_youtube_source import DownloadYoutubeSource
from nova_generator.domain.jobs import Job
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.domain.tiktok_media import MediaCaption
from nova_generator.infrastructure.filesystem.tiktok_media_store import MediaProjectStore
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache
from nova_generator.infrastructure.worker.ingest_scene_media_handler import (
    IngestSceneMediaJobHandler,
)
from nova_generator.infrastructure.worker.persistent_worker import JobExecution
from nova_generator.infrastructure.worker.project_media_handler import _keep_lease


class TikTokSourceJobHandler:
    def __init__(
        self,
        store: MediaProjectStore,
        cache: FileYoutubeMediaCache,
        downloader: DownloadYoutubeSource,
        ingestion: IngestSceneMediaJobHandler,
    ) -> None:
        self.store = store
        self.cache = cache
        self.downloader = downloader
        self.ingestion = ingestion

    def _source(self, job: Job) -> tuple[UUID, YoutubeVideo]:
        project_id = UUID(str(job.input["project_id"]))
        project = self.store.get(project_id)
        video_id = job.input.get("video_id")
        if (
            project is None
            or not isinstance(video_id, str)
            or project.source_youtube_id != video_id
        ):
            raise ValueError("A origem desta produção mudou. Inicie uma nova preparação.")
        return project_id, YoutubeVideo(video_id)

    def download(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project_id, video = self._source(job)
        with _keep_lease(execution):
            result = self.downloader.execute(video.canonical_url)
        self._source(job)  # Never report an obsolete download as the active source.
        return {
            "project_id": str(project_id),
            "video_id": video.video_id,
            "duration_ms": result.metadata.duration_ms,
            "source_sha256": result.metadata.sha256,
            "cache_status": result.status,
        }

    def ingest(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project_id, video = self._source(job)
        metadata = self.cache.find_verified(video)
        if metadata is None or metadata.sha256 != job.input.get("source_sha256"):
            raise ValueError("O vídeo de origem mudou. Refaça a preparação.")
        start_ms, end_ms = job.input.get("start_ms"), job.input.get("end_ms")
        if (
            not isinstance(start_ms, int)
            or isinstance(start_ms, bool)
            or start_ms < 0
            or not isinstance(end_ms, int)
            or isinstance(end_ms, bool)
            or end_ms <= start_ms
            or end_ms > metadata.duration_ms
            or end_ms - start_ms > 180_000
        ):
            raise ValueError("Selecione até 3 minutos dentro da duração do vídeo.")
        output = self.store.directory(project_id) / "cuts" / f"{job.id}.mp4"
        safe_job = replace(
            job,
            input={
                "source": str(self.cache.source_path(video)),
                "output": str(output),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "language": job.input.get("language", "en"),
                "bucket_ms": 40,
            },
        )
        with _keep_lease(execution):
            result = self.ingestion(safe_job, execution)
        transcript = result["transcript_candidate"]
        captions: list[MediaCaption] = []
        previous_end = 0
        for cue in transcript["cues"]:
            spoken = str(cue.get("text", "")).strip()
            start = max(previous_end, int(cue["start_ms"]))
            end = min(end_ms - start_ms, int(cue["end_ms"]))
            if not spoken or end <= start:
                continue
            captions.append(
                MediaCaption(
                    cue_id=uuid4(),
                    start_ms=start,
                    end_ms=end,
                    en=spoken,
                    pt="",
                )
            )
            previous_end = end
        if not captions:
            raise ValueError("Nenhuma fala foi identificada no trecho. Escolha outro intervalo.")
        if len(captions) > 200:
            raise ValueError("Mais de 200 falas. Escolha um trecho menor.")
        self.store.attach_transcript(
            project_id,
            revision=int(job.input["revision"]),
            video_id=video.video_id,
            cut_job_id=job.id,
            captions=captions,
        )
        execution.heartbeat()
        return {
            "project_id": str(project_id),
            "video_id": video.video_id,
            "source_sha256": metadata.sha256,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "duration_ms": end_ms - start_ms,
            "caption_count": len(captions),
            "transcript_candidate": transcript,
        }
