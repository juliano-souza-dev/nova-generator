"""Publish a completed Anki reel to the iHub transport envelope after manual upload."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.application.use_cases.build_hub_final_anki_audio import (
    add_manual_youtube_anki_audio,
)
from nova_generator.domain.exports import AnkiAudioExport, ReelInterval
from nova_generator.domain.jobs import Job
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.domain.projects.entities import Cue, utf8_sha256
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.integration.ihub_contracts import validate_anki_audio


class AnkiPublicationError(ValueError):
    pass


@dataclass(frozen=True)
class AnkiPublication:
    path: Path
    youtube_video_id: str
    youtube_url: str


class PublishAnkiReel:
    def __init__(
        self,
        repository: EditorialProjectRepository,
        jobs: JobRepository,
        export_root: Path,
        project_root: Path,
    ) -> None:
        self._repository = repository
        self._jobs = jobs
        self._export_root = export_root
        self._project_root = project_root

    def execute(self, *, project_id: UUID, job: Job, youtube: str) -> AnkiPublication:
        if job.kind != "export_materials" or job.status != "succeeded":
            raise AnkiPublicationError("Conclua a exportação Anki antes de publicar.")
        if job.input.get("project_id") != str(project_id):
            raise AnkiPublicationError("A exportação não pertence a este projeto.")
        raw = youtube.strip()
        try:
            video = YoutubeVideo(raw) if len(raw) == 11 else YoutubeVideo.from_url(raw)
        except ValueError as error:
            raise AnkiPublicationError(str(error)) from error
        project = self._repository.get_project(project_id)
        if project is None:
            raise AnkiPublicationError("Projeto não encontrado.")
        export = self._read_export(job)
        cues = self._approved_cues(project_id, job, export)
        source_url = project.provenance.get("youtube_url")
        has_source = isinstance(source_url, str) and bool(source_url)
        cue_times = (
            self._source_times(project_id, cues)
            if has_source
            else [(interval.start_ms, interval.end_ms) for interval in export.intervals]
        )
        scene_start = min(start for start, _ in cue_times)
        scene_end = max(end for _, end in cue_times)
        if any(cue_times[index][0] < cue_times[index - 1][1] for index in range(1, len(cue_times))):
            raise AnkiPublicationError(
                "Cues selecionadas se sobrepõem na fonte. Revise a ordem e os tempos."
            )
        kit_youtube = source_url if has_source else video.canonical_url
        base: dict[str, Any] = {
            "version": 3,
            "source_snapshot_id": str(job.id),
            "project": {
                "content_type": project.content_type,
                "youtube": kit_youtube,
                "source_video_start_ms": scene_start,
                "source_video_end_ms": scene_end,
            },
            "kit": {
                "contentType": "music" if project.content_type == "music" else "immersion",
                "title": project.title,
                "youtube": kit_youtube,
                "scene_start_ms": scene_start,
                "scene_end_ms": scene_end,
                "scene_duration_ms": scene_end - scene_start,
            },
            "cues": [
                {
                    "order": interval.cue_order,
                    "speaker": cue.speaker,
                    "original_en": cue.original_en,
                    "approved_en": cue.approved_en,
                    "final_en": cue.approved_en,
                    "pt": cue.approved_pt,
                    "speech_start_ms": timing[0],
                    "speech_end_ms": timing[1],
                    "subtitle_start_ms": timing[0],
                    "subtitle_end_ms": timing[1],
                    "words": [
                        {
                            "text": word.surface,
                            "start_ms": word.start_ms + timing[0] - cue.speech_start_ms,
                            "end_ms": word.end_ms + timing[0] - cue.speech_start_ms,
                            "original_start_ms": word.original_start_ms,
                            "original_end_ms": word.original_end_ms,
                        }
                        for word in self._repository.get_cue_words(cue.id)
                    ],
                    "anki": {
                        "include": True,
                        "items": [
                            {
                                "key": f"cue-{cue.id}",
                                "type": "sentence",
                                "focus": cue.approved_en,
                                "meaning": cue.approved_pt,
                                "example_en": cue.approved_en,
                                "example_pt": cue.approved_pt,
                                "tags": [
                                    tag
                                    for tag in cue.provenance.get("tags", [])
                                    if isinstance(tag, str)
                                ]
                                if isinstance(cue.provenance.get("tags"), list)
                                else [],
                            }
                        ],
                    },
                }
                for cue, interval, timing in zip(cues, export.intervals, cue_times, strict=True)
            ],
            "materials": [{"label": "Anki", "type": "ANKI", "fileName": "anki.apkg"}],
            "generator": {
                "project_id": str(project_id),
                "export_job_id": str(job.id),
                "source_cue_ids": [str(cue.id) for cue in cues],
                "anki_manifest_sha256": _file_hash(export.manifest_path),
            },
        }
        document = add_manual_youtube_anki_audio(
            base, youtube_video_id=video.video_id, export=export
        )
        validate_anki_audio(document)
        path = self.publication_path(project_id, job.id)
        if path.is_file():
            existing = json.loads(path.read_text(encoding="utf-8"))
            old_video = existing.get("ankiAudio", {}).get("youtube", {}).get("video_id")
            if old_video != video.video_id:
                raise AnkiPublicationError(
                    "Esta exportação já foi vinculada a outro vídeo. "
                    "Crie uma nova exportação para corrigir o vínculo."
                )
            return AnkiPublication(path, video.video_id, video.canonical_url)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp.json")
        temporary.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, path)
        return AnkiPublication(path, video.video_id, video.canonical_url)

    def publication_path(self, project_id: UUID, job_id: UUID) -> Path:
        return (
            self._project_root / str(project_id) / "publications" / str(job_id) / "hub_final.json"
        )

    def _read_export(self, job: Job) -> AnkiAudioExport:
        directory = self._export_root / str(job.id)
        apkg, reel, manifest = (
            directory / "anki.apkg",
            directory / "anki-reel.mp4",
            directory / "anki-audio-manifest.json",
        )
        try:
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            voice = _snapshot(payload["voice"])
            intervals = tuple(
                ReelInterval(
                    int(item["cue_order"]),
                    int(item["start_ms"]),
                    int(item["end_ms"]),
                    str(item["audio_sha256"]),
                    str(item["text_sha256"]),
                )
                for item in payload["cues"]
            )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise AnkiPublicationError("Manifesto Anki ausente ou inválido.") from error
        if (
            payload.get("schema") != "nova-generator-anki-audio"
            or payload.get("schema_version") != "1.0"
        ):
            raise AnkiPublicationError("Versão do manifesto Anki não suportada.")
        if voice.sha256 != job.input.get("voice_snapshot", {}).get("snapshot_sha256"):
            raise AnkiPublicationError("Perfil de voz diverge da exportação Anki.")
        if payload.get("apkg_sha256") != _file_hash(apkg) or payload.get(
            "reel_sha256"
        ) != _file_hash(reel):
            raise AnkiPublicationError("APKG ou reel diverge do manifesto Anki.")
        if not intervals:
            raise AnkiPublicationError("Manifesto Anki sem cues.")
        return AnkiAudioExport(apkg, reel, manifest, voice, intervals)

    def _approved_cues(self, project_id: UUID, job: Job, export: AnkiAudioExport) -> list[Cue]:
        raw_ids = job.input.get("cue_ids")
        if not isinstance(raw_ids, list) or len(raw_ids) != len(export.intervals):
            raise AnkiPublicationError("Seleção de cards diverge do manifesto Anki.")
        cues: list[Cue] = []
        for raw_id, interval in zip(raw_ids, export.intervals, strict=True):
            try:
                cue = self._repository.get_cue(UUID(str(raw_id)))
            except ValueError as error:
                raise AnkiPublicationError("ID de card inválido na exportação.") from error
            if cue is None or self._repository.get_scene_project_id(cue.scene_id) != project_id:
                raise AnkiPublicationError(f"Card {raw_id} não pertence mais ao projeto.")
            if (
                cue.approved_en_sha256 != interval.text_sha256
                or cue.approved_en_sha256 != job.input.get("text_hashes", {}).get(str(raw_id))
                or utf8_sha256(cue.approved_pt) != job.input.get("pt_hashes", {}).get(str(raw_id))
                or interval.audio_sha256 != job.input.get("audio_hashes", {}).get(str(raw_id))
            ):
                raise AnkiPublicationError(
                    f"Texto ou WAV do card {raw_id} mudou após a exportação. Exporte novamente."
                )
            cues.append(cue)
        return cues

    def _source_times(self, project_id: UUID, cues: list[Cue]) -> list[tuple[int, int]]:
        scenes = {scene.id: scene for scene in self._repository.get_project_scenes(project_id)}
        times: list[tuple[int, int]] = []
        for cue in cues:
            scene = scenes.get(cue.scene_id)
            if scene is None:
                raise AnkiPublicationError(f"Cena do card {cue.id} não encontrada.")
            offset = 0
            ingest_job_id = scene.provenance.get("ingest_job_id")
            if isinstance(ingest_job_id, str):
                source_job = self._jobs.get(ingest_job_id)
                if (
                    source_job is None
                    or source_job.kind != "ingest_scene_media"
                    or source_job.status != "succeeded"
                    or source_job.input.get("project_id") != str(project_id)
                    or not isinstance(source_job.output, dict)
                ):
                    raise AnkiPublicationError(f"Job de origem da cena {scene.id} indisponível.")
                offset = source_job.output.get("start_ms")
                if not isinstance(offset, int) or offset < 0:
                    raise AnkiPublicationError(f"Início da cena {scene.id} inválido.")
            start, end = cue.speech_start_ms + offset, cue.speech_end_ms + offset
            if end <= start:
                raise AnkiPublicationError(f"Tempo do card {cue.id} inválido.")
            times.append((start, end))
        return times


def _snapshot(raw: dict[str, Any]) -> VoiceProfileSnapshot:
    snapshot = VoiceProfileSnapshot(
        profile_id=UUID(str(raw["profile_id"])),
        name=str(raw["name"]),
        version=int(raw["version"]),
        model_id=str(raw["model_id"]),
        model_sha256=str(raw["model_sha256"]),
        reference_audio_sha256=str(raw["reference_audio_sha256"])
        if raw.get("reference_audio_sha256")
        else None,
        parameters=dict(raw["parameters"]),
    )
    if snapshot.sha256 != raw.get("snapshot_sha256"):
        raise AnkiPublicationError("Perfil de voz diverge do manifesto Anki.")
    return snapshot


def _file_hash(path: Path) -> str:
    if not path.is_file() or path.stat().st_size == 0:
        raise AnkiPublicationError(f"Artefato ausente: {path.name}")
    return sha256(path.read_bytes()).hexdigest()
