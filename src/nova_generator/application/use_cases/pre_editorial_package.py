"""Prepare a single external-AI package immediately after transcription.

This adapter reuses the existing Shadowing grouping rules without asking AI to
generate, rewrite or select Shadowing blocks.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, replace
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from nova_generator.application.ports.editorial_assistant import EditorialCuePrompt
from nova_generator.application.use_cases.editorial_assistance import _word_prompts
from nova_generator.application.use_cases.prepare_shadowing import (
    _automatic_groups,
    _validated_blocks,
)
from nova_generator.application.use_cases.review_asr_candidate import _candidate_entries

CONTRACT = "nova-generator-unified-preparation-input/1.0"
OUTPUT_CONTRACT = "nova-generator-unified-preparation-output/1.0"


class PreparationPackageError(ValueError):
    pass


class PreEditorialPackage:
    def __init__(self, project_root: Path):
        self.project_root = project_root

    def path(self, project_id: UUID, scene_id: UUID) -> Path:
        return self.project_root / str(project_id) / "preparation" / f"{scene_id}.json"

    def load(self, project_id: UUID, scene_id: UUID) -> dict[str, Any] | None:
        try:
            data = json.loads(self.path(project_id, scene_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) and data.get("contract") == CONTRACT else None

    def build(
        self, project_id: UUID, ingest_job_id: UUID, output: dict[str, Any]
    ) -> dict[str, Any]:
        scene_id = uuid5(NAMESPACE_URL, f"nova-generator/asr-scene/{ingest_job_id}")
        entries, duration_ms = _candidate_entries(output, scene_id, ingest_job_id)
        cues = [cue for cue, _ in entries]
        prompts = []
        for cue, words in entries:
            tokens, trailing = _word_prompts(words, cue.original_en)
            reconstructed = (
                "".join(f"{token.leading}{token.surface}" for token in tokens) + trailing
            )
            prompts.append(EditorialCuePrompt(
                id=str(cue.id),
                order=cue.order,
                original_en=cue.original_en,
                current_en=cue.approved_en,
                current_pt=cue.approved_pt,
                words=tokens,
                speech_start_ms=cue.speech_start_ms,
                speech_end_ms=cue.speech_end_ms,
                subtitle_start_ms=cue.subtitle_start_ms,
                subtitle_end_ms=cue.subtitle_end_ms,
                trailing=trailing,
                word_by_word_en=reconstructed,
                requires_reconciliation=reconstructed != cue.original_en,
            ))
        editorial_cues = [asdict(prompt) for prompt in prompts]
        input_hash = sha256(json.dumps(
            editorial_cues, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")).hexdigest()
        # Only the existing deterministic grouping algorithm may choose Shadowing.
        shadow_source = [replace(cue, approved_en=cue.original_en) for cue in cues]
        groups = _automatic_groups(shadow_source)
        shadowing = _validated_blocks(shadow_source, groups)
        output_data = {
            "contract": CONTRACT,
            "output_contract": OUTPUT_CONTRACT,
            "project_id": str(project_id),
            "scene_id": str(scene_id),
            "ingest_job_id": str(ingest_job_id),
            "input_sha256": input_hash,
            "duration_ms": duration_ms,
            "editorial": {
                "schema_version": "nova-generator-editorial-input/1.3",
                "scene_id": str(scene_id),
                "input_sha256": input_hash,
                "cues": editorial_cues,
            },
            "shadowing": {
                "origin": "automatic",
                "editable_after_editorial": True,
                "ai_must_not_modify": True,
                "blocks": shadowing,
            },
            "instructions": {
                "language": "Português brasileiro natural; preserve inglês e IDs literais.",
                "response_contract": OUTPUT_CONTRACT,
                "editorial": (
                    "Produza editorial no formato nova-generator-editorial-suggestions/1.3: "
                    "corrija EN, traduza PT, reconcilie cada token (leading, surface, "
                    "start_ms, end_ms, trailing), traduza cada palavra e sugira "
                    "unidades semânticas contíguas. Nunca altere IDs ou número de cues."
                ),
                "materials": (
                    "No MESMO retorno, gere sete seções didáticas nesta ordem: learning_path, "
                    "vocabulary, structures, guided_practice, activities, challenge, review. "
                    "Inclua exercícios e respostas em guided_practice, activities e challenge. "
                    "Selecione frases relevantes para Anki e gere mini lessons com cue_id, "
                    "front_en, back_pt, card_type, focus_text, meaning, marked_en, marked_pt, "
                    "explanation_pt, example_en, example_pt e tags. front_en e back_pt "
                    "devem ser idênticos às versões finais das sugestões editoriais; "
                    "os destaques precisam existir literalmente nas frases; "
                    "cada exemplo deve ter EN e PT."
                ),
                "shadowing": (
                    "O Shadowing já está produzido pelas regras do Generator. "
                    "Não gere, reordene, traduza, substitua ou modifique os blocos de Shadowing. "
                    "Não inclua Shadowing na resposta."
                ),
                "output_shape": {
                    "contract": OUTPUT_CONTRACT,
                    "project_id": str(project_id),
                    "scene_id": str(scene_id),
                    "input_sha256": input_hash,
                    "editorial": {
                        "schema_version": "nova-generator-editorial-suggestions/1.3",
                        "scene_id": str(scene_id),
                        "input_sha256": input_hash,
                        "suggestions": [
                            {
                                "cue_id": cue.id,
                                "order": cue.order,
                                "approved_en": cue.word_by_word_en,
                                "approved_pt": "",
                                "notes": "",
                                "trailing": cue.trailing,
                                "word_translations": [
                                    {
                                        "word_id": word.id,
                                        "order": word.order,
                                        "leading": word.leading,
                                        "surface": word.surface,
                                        "start_ms": word.start_ms,
                                        "end_ms": word.end_ms,
                                        "pt": "",
                                    }
                                    for word in cue.words
                                ],
                                "semantic_units": [],
                            }
                            for cue in prompts
                        ],
                    },
                    "materials": {
                        "sections": [
                            {"id": key, "title": "", "paragraphs": [], "exercises": []}
                            for key in (
                                "learning_path", "vocabulary", "structures",
                                "guided_practice", "activities", "challenge", "review",
                            )
                        ],
                        "anki_cards": [],
                    },
                },
            },
        }
        return output_data

    def stage(
        self, project_id: UUID, ingest_job_id: UUID, output: dict[str, Any]
    ) -> dict[str, Any]:
        candidate = self.build(project_id, ingest_job_id, output)
        scene_id = UUID(candidate["scene_id"])
        previous = self.load(project_id, scene_id)
        if previous and previous.get("input_sha256") == candidate["input_sha256"]:
            return previous
        path = self.path(project_id, scene_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        try:
            temp.write_text(
                json.dumps(candidate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
        return candidate
