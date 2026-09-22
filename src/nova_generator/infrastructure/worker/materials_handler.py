from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.export_anki_reel import ExportAnkiReel
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.exports import ExportCue
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import utf8_sha256
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


class MaterialsJobHandler:
    def __init__(
        self,
        repository: SqlAlchemyEditorialProjectRepository,
        cache: FileSpeechCache,
        synthesis: SynthesizeSpeech,
        exporter: ExportAnkiReel,
        export_root: Path,
    ) -> None:
        self._repository = repository
        self._cache = cache
        self._synthesis = synthesis
        self._exporter = exporter
        self._export_root = export_root

    def synthesize(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project_id = UUID(str(job.input["project_id"]))
        cue_id = UUID(str(job.input["cue_id"]))
        cue = self._repository.get_cue(cue_id)
        if cue is None or self._repository.get_scene_project_id(cue.scene_id) != project_id:
            raise ValueError("card no longer belongs to project")
        text = str(job.input["approved_en"])
        if cue.approved_en != text:
            raise ValueError("approved cue changed; request fresh audio")
        voice = _snapshot(job.input["voice_snapshot"])
        speech = self._synthesis.execute(text=text, profile=voice)
        execution.heartbeat()
        return {
            "cue_id": str(cue_id),
            "duration_ms": speech.duration_ms,
            "audio_sha256": ExportCue(
                cue_id,
                1,
                text,
                cue.approved_pt,
                Path(speech.audio_path),
                speech.duration_ms,
                utf8_sha256(text),
            ).audio_sha256,
        }

    def export(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project_id = UUID(str(job.input["project_id"]))
        voice = _snapshot(job.input["voice_snapshot"])
        raw_ids = job.input["cue_ids"]
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValueError("export requires selected cards")
        cues: list[ExportCue] = []
        for order, raw_id in enumerate(raw_ids, 1):
            cue = self._repository.get_cue(UUID(str(raw_id)))
            if cue is None or self._repository.get_scene_project_id(cue.scene_id) != project_id:
                raise ValueError(f"selected card {raw_id} no longer belongs to project")
            if cue.provenance.get("anki_included") is False:
                raise ValueError(f"selected card {raw_id} was excluded after enqueue")
            if cue.approved_en_sha256 != job.input.get("text_hashes", {}).get(str(raw_id)):
                raise ValueError(f"approved text changed for card {raw_id}; enqueue a new export")
            if utf8_sha256(cue.approved_pt) != job.input.get("pt_hashes", {}).get(str(raw_id)):
                raise ValueError(
                    f"approved translation changed for card {raw_id}; enqueue a new export"
                )
            key = self._cache.cache_key(text=cue.approved_en, profile=voice, parameters={})
            speech = self._cache.find(key)
            if speech is None:
                raise ValueError(f"canonical WAV missing for card {raw_id}; reprocess this card")
            export_cue = ExportCue(
                cue.id,
                order,
                cue.approved_en,
                cue.approved_pt,
                Path(speech.audio_path),
                speech.duration_ms,
                utf8_sha256(cue.approved_en),
            )
            if export_cue.audio_sha256 != job.input.get("audio_hashes", {}).get(str(raw_id)):
                raise ValueError(f"canonical WAV changed for card {raw_id}; enqueue a new export")
            cues.append(export_cue)
            execution.heartbeat()
        project = self._repository.get_project(project_id)
        if project is None:
            raise ValueError("project no longer exists")
        result = self._exporter.execute(
            cues=cues,
            voice=voice,
            output_directory=self._export_root / str(job.id),
            deck_name=project.title,
        )
        execution.heartbeat()
        return {
            "apkg": str(result.apkg_path),
            "manifest": str(result.manifest_path),
            "reel": str(result.reel_path),
            "cards": len(cues),
        }


def _snapshot(raw: object) -> VoiceProfileSnapshot:
    if not isinstance(raw, dict):
        raise ValueError("voice snapshot missing")
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
        raise ValueError("voice snapshot hash mismatch")
    return snapshot
