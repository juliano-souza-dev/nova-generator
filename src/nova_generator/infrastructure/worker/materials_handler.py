from __future__ import annotations

import json
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.editorial_publication_snapshot import (
    editorial_publication_sha256,
)
from nova_generator.application.use_cases.export_anki_reel import ExportAnkiReel
from nova_generator.application.use_cases.materials_ai_exchange import MaterialsAiExchange
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.exports import ExportCue
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import utf8_sha256
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.exports.material_workbook_pdf import render_material_workbook
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
        project_root: Path | None = None,
    ) -> None:
        self._repository = repository
        self._cache = cache
        self._synthesis = synthesis
        self._exporter = exporter
        self._export_root = export_root
        self._project_root = project_root or Path("data/projects")

    def synthesize(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project_id = UUID(str(job.input["project_id"]))
        cue_id = UUID(str(job.input["cue_id"]))
        cue = self._repository.get_cue(cue_id)
        if cue is None or self._repository.get_scene_project_id(cue.scene_id) != project_id:
            raise ValueError("card no longer belongs to project")
        if cue.provenance.get("approval") == "draft":
            raise ValueError("card is a draft; approve it before generating materials")
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
        if job.input.get("generate_complete"):
            return self._generate_complete(job, execution)
        project_id = UUID(str(job.input["project_id"]))
        voice = _snapshot(job.input["voice_snapshot"])
        raw_ids = job.input["cue_ids"]
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValueError("export requires selected cards")
        cues: list[ExportCue] = []
        editorial_cards = []
        for order, raw_id in enumerate(raw_ids, 1):
            cue = self._repository.get_cue(UUID(str(raw_id)))
            if cue is None or self._repository.get_scene_project_id(cue.scene_id) != project_id:
                raise ValueError(f"selected card {raw_id} no longer belongs to project")
            if cue.provenance.get("approval") == "draft":
                raise ValueError(f"selected card {raw_id} is a draft; approve it before export")
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
            editorial_cards.append((cue, self._repository.get_cue_words(cue.id)))
            execution.heartbeat()
        project = self._repository.get_project(project_id)
        if project is None:
            raise ValueError("project no longer exists")
        if editorial_publication_sha256(
            project, self._repository.get_project_scenes(project_id), editorial_cards
        ) != job.input.get("editorial_sha256"):
            raise ValueError("editorial timing or words changed; enqueue a new export")
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


    def _generate_complete(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        """Reuse verified canonical WAVs; synthesize missing ones before the Anki exporter."""
        project_id = UUID(str(job.input["project_id"]))
        exchange = MaterialsAiExchange(self._repository, self._project_root)
        review = exchange.status(project_id)
        if review["status"] != "approved":
            raise ValueError("O conteúdo pedagógico não está aprovado. Revise antes de gerar.")
        document = review["document"]
        digest = sha256(
            json.dumps(
                document, sort_keys=True, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        ).hexdigest()
        if (
            digest != job.input.get("materials_sha256")
            or review["source_sha256"] != job.input.get("materials_source_sha256")
        ):
            raise ValueError("O material aprovado mudou depois do pedido. Gere novamente.")

        raw_ids = job.input["cue_ids"]
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValueError("Nenhum card selecionado para gerar material.")
        selected_cards = {card["cue_id"] for card in document["anki_cards"]}
        if not set(map(str, raw_ids)).issubset(selected_cards):
            raise ValueError("O conteúdo aprovado não contém todos os cards selecionados.")
        voice = _snapshot(job.input["voice_snapshot"])
        cues = []
        for raw_id in raw_ids:
            cue = self._repository.get_cue(UUID(str(raw_id)))
            if cue is None or self._repository.get_scene_project_id(cue.scene_id) != project_id:
                raise ValueError(f"Card {raw_id} não pertence mais ao projeto.")
            if (
                cue.provenance.get("approval") == "draft"
                or cue.provenance.get("anki_included") is False
                or cue.approved_en_sha256 != job.input["text_hashes"].get(str(raw_id))
                or utf8_sha256(cue.approved_pt) != job.input["pt_hashes"].get(str(raw_id))
            ):
                raise ValueError("Cards alterados durante a preparação. Gere novamente.")
            cues.append(cue)
        project = self._repository.get_project(project_id)
        if project is None:
            raise ValueError("Projeto indisponível.")
        snapshot = editorial_publication_sha256(
            project, self._repository.get_project_scenes(project_id),
            [(cue, self._repository.get_cue_words(cue.id)) for cue in cues],
        )
        if snapshot != job.input.get("editorial_sha256"):
            raise ValueError("O conteúdo ou timings do Editorial mudaram. Gere novamente.")

        audio_hashes: dict[str, str] = {}
        for cue in cues:
            execution.raise_if_cancelled()
            speech = self._synthesis.execute(text=cue.approved_en, profile=voice)
            audio_hashes[str(cue.id)] = sha256(Path(speech.audio_path).read_bytes()).hexdigest()
            execution.heartbeat()

        export_job = replace(
            job, input={
                **job.input,
                "generate_complete": False,
                "audio_hashes": audio_hashes,
            },
        )
        output = self.export(export_job, execution)
        execution.raise_if_cancelled()
        directory = self._export_root / str(job.id)
        workbook = render_material_workbook(document, directory / "material-didatico.pdf")
        snapshot_path = directory / "material-pedagogico.json"
        snapshot_path.write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        execution.heartbeat()
        return {
            **output,
            "workbook": str(workbook),
            "materials_sha256": digest,
            "audio_hashes": audio_hashes,
            "pedagogical_snapshot": str(snapshot_path),
            "sections": len(document["sections"]),
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
