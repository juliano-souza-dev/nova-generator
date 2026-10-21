"""Versioned external-AI material exchange based on frozen post-editorial snapshots."""

from __future__ import annotations

import json
import os
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.anki_proposal import (
    AnkiProposal,
    DidacticAnkiCard,
    DidacticAnkiProposal,
    legacy_to_didactic,
    reconcile_anki_proposal,
    reconcile_didactic_proposal,
    validate_didactic_cards,
)
from nova_generator.application.use_cases.editorial_assistance import build_editorial_prompt

INPUT_CONTRACT = "nova-generator-materials-input/1.0"
OUTPUT_CONTRACT = "nova-generator-materials-output/1.0"
SECTION_IDS = (
    "learning_path",
    "vocabulary",
    "structures",
    "guided_practice",
    "activities",
    "challenge",
    "review",
)


class MaterialsAiError(ValueError):
    pass


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class Exercise(StrictModel):
    prompt: str = Field(min_length=1, max_length=6000)
    answer: str = Field(min_length=1, max_length=6000)


class MaterialSection(StrictModel):
    id: Literal[
        "learning_path", "vocabulary", "structures", "guided_practice",
        "activities", "challenge", "review",
    ]
    title: str = Field(min_length=1, max_length=180)
    paragraphs: list[str] = Field(min_length=1, max_length=30)
    exercises: list[Exercise] = Field(default_factory=list, max_length=30)


class MaterialCard(StrictModel):
    cue_id: UUID
    front_en: str = Field(min_length=1)
    back_pt: str = Field(min_length=1)
    explanation_pt: str = Field(min_length=1, max_length=3000)
    # Same fields used by iHub's flashcard renderer. Optional for old v1 responses.
    card_type: str = Field(default="EXPRESSION", max_length=80)
    focus_text: str = Field(default="", max_length=255)
    meaning: str = Field(default="", max_length=500)
    marked_en: str = Field(default="", max_length=255)
    marked_pt: str = Field(default="", max_length=255)
    example_en: str = Field(default="", max_length=1500)
    example_pt: str = Field(default="", max_length=1500)
    tags: list[str] = Field(default_factory=list, max_length=12)


class MaterialOutput(StrictModel):
    contract: Literal["nova-generator-materials-output/1.0"]
    project_id: UUID
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    title: str = Field(min_length=1, max_length=255)
    sections: list[MaterialSection] = Field(min_length=7, max_length=7)
    anki_cards: list[MaterialCard] = Field(min_length=1)


class MaterialsAiExchange:
    def __init__(self, repository: EditorialProjectRepository, project_root: Path):
        self.repository = repository
        self.project_root = project_root

    def package(self, project_id: UUID) -> dict[str, Any]:
        project = self.repository.get_project(project_id)
        if project is None:
            raise MaterialsAiError("project not found")
        scenes = []
        for scene in self.repository.get_project_scenes(project_id):
            cues = []
            for cue in sorted(
                self.repository.get_scene_cues(scene.id), key=lambda item: item.order
            ):
                if cue.provenance.get("approval") == "draft":
                    raise MaterialsAiError("editorial approval is required for all cues")
                cues.append({
                    "id": str(cue.id),
                    "order": cue.order,
                    "approved_en": cue.approved_en,
                    "approved_pt": cue.approved_pt,
                    "speaker": cue.speaker,
                    "speech_start_ms": cue.speech_start_ms,
                    "speech_end_ms": cue.speech_end_ms,
                    "words": [
                        {
                            "id": str(word.id),
                            "surface": word.surface,
                            "pt": word.provenance.get("pt", ""),
                            "semantic_group_id": word.provenance.get("semantic_group_id"),
                        }
                        for word in self.repository.get_cue_words(cue.id)
                    ],
                })
            scenes.append({
                "scene_id": str(scene.id),
                "order": scene.order,
                "duration_ms": scene.duration_ms,
                "cues": cues,
            })
        source = {
            "project_id": str(project.id),
            "title": project.title,
            "content_type": project.content_type,
            "scenes": scenes,
        }
        # Reuse Anki prepared at first export for each scene independently.
        # If the editorial later changes a cue, keep it out of publication
        # and flag the prepared card for manual reconciliation.
        available = {
            cue["id"]: cue
            for scene in scenes for cue in scene["cues"]
        }
        prepared_cards: list[dict[str, Any]] = []
        needs_review = 0
        found_draft = False
        for scene in scenes:
            prepared = self._read(project_id, f"anki-prepared-{scene['scene_id']}.json")
            if not prepared or prepared.get("contract") not in {
                "nova-generator-anki-proposal/1.0", "nova-generator-anki-proposal/2.0"
            }:
                continue
            found_draft = True
            if prepared["contract"] == "nova-generator-anki-proposal/1.0":
                prepared = legacy_to_didactic(
                    AnkiProposal.model_validate_json(json.dumps(prepared)),
                    {cue_id: (cue["approved_en"], cue["approved_pt"])
                     for cue_id, cue in available.items()},
                ).model_dump(mode="json")
            candidates = prepared.get("anki_cards", [])
            if not isinstance(candidates, list):
                continue
            for card in candidates:
                if not isinstance(card, dict):
                    needs_review += 1
                    continue
                approved = available.get(card.get("cue_id"))
                if (
                    approved is not None
                    and card.get("source_context_en") == approved["approved_en"]
                    and card.get("source_context_pt") == approved["approved_pt"]
                ):
                    prepared_cards.append({**card, "scene_id": scene["scene_id"]})
                else:
                    needs_review += 1
        if found_draft:
            source["anki_prepared"] = prepared_cards
            source["anki_prepared_needs_review"] = needs_review
        fingerprint = sha256(json.dumps(
            source, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")).hexdigest()
        return {
            "contract": INPUT_CONTRACT,
            "source_sha256": fingerprint,
            "source": source,
            "instructions": {
                "output_contract": OUTPUT_CONTRACT,
                "required_section_ids_in_order": list(SECTION_IDS),
                "language": "Português do Brasil para explicações; preserve inglês da fonte.",
                "policy": (
                    "Gere texto pedagógico real para cada seção, incluindo "
                    "exercícios com respostas. "
                    "Os cards Anki devem usar cue_id existentes. source_context_en e "
                    "source_context_pt preservam literalmente a fala aprovada; front_en "
                    "e back_pt devem ensinar uma estrutura em frases didáticas naturais, "
                    "não repetir automaticamente a legenda. Se source.anki_prepared estiver "
                    "presente, reutilize essas mini-aulas já preparadas no primeiro pacote "
                    "e não as gere novamente. Cards com cue alterada exigem revisão. "
                    "Inclua card_type, focus_text, "
                    "meaning, marked_en, marked_pt, explanation_pt, example_en e example_pt "
                    "para reproduzir a mini lesson do iHub. O marked_en/marked_pt deve existir "
                    "respectivamente em front_en e back_pt; os exemplos devem ter EN e PT. "
                    "Não altere IDs ou tempos. "
                    "Retorne apenas JSON validado pelo contrato de saída."
                ),
            },
        }

    def import_anki_proposal(self, project_id: UUID, data: Any) -> dict[str, Any]:
        """Import the Anki-only proposal without pretending it is a seven-section workbook."""
        try:
            # Strict Pydantic models accept UUID strings through JSON parsing.
            is_didactic = data.get("contract") == "nova-generator-anki-proposal/2.0"
            proposal = (
                DidacticAnkiProposal if is_didactic else AnkiProposal
            ).model_validate_json(json.dumps(data, ensure_ascii=False))
        except (ValidationError, ValueError, TypeError) as error:
            raise MaterialsAiError(f"invalid Anki proposal: {error}") from error

        scene = next(
            (
                item for item in self.repository.get_project_scenes(project_id)
                if item.id == proposal.scene_id
            ),
            None,
        )
        if scene is None:
            raise MaterialsAiError(
                "Anki scene_id does not belong to the selected project"
            )
        manifest_path = (
            self.project_root / str(project_id) / "editorial-ai"
            / f"scene-{scene.id}-external-ai-manifest.json"
        )
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            expected_hash = manifest.get("input_sha256")
        except (OSError, ValueError):
            # Standalone import is possible only for a matching current snapshot.
            expected_hash, _cues = build_editorial_prompt(self.repository, scene.id)
        if proposal.input_sha256 != expected_hash:
            raise MaterialsAiError(
                "Anki input_sha256 differs from the scene's exported editorial package; "
                "use the Anki JSON for the current scene or export a new package"
            )

        cues = self.repository.get_scene_cues(scene.id)
        if any(cue.provenance.get("approval") == "draft" for cue in cues):
            raise MaterialsAiError(
                "approve the current editorial cues before importing Anki content"
            )
        try:
            proposal = (
                reconcile_didactic_proposal(proposal, cues)
                if is_didactic else reconcile_anki_proposal(proposal, cues)
            )
        except ValueError as error:
            raise MaterialsAiError(str(error)) from error

        # Do not mark the workbook approved or overwrite its sections.
        self._write(
            project_id,
            f"anki-prepared-{scene.id}.json",
            proposal.model_dump(mode="json"),
        )
        return {**self.status(project_id), "imported": "anki"}

    def import_result(self, project_id: UUID, data: Any) -> dict[str, Any]:
        if isinstance(data, dict):
            if data.get("contract") in {
                "nova-generator-anki-proposal/1.0", "nova-generator-anki-proposal/2.0"
            }:
                return self.import_anki_proposal(project_id, data)
            if data.get("contract") != OUTPUT_CONTRACT:
                raise MaterialsAiError(
                    "unsupported material contract: expected nova-generator-materials-output/1.0 "
                    "or nova-generator-anki-proposal/1.0 or nova-generator-anki-proposal/2.0"
                )
        source = self.package(project_id)
        try:
            output = MaterialOutput.model_validate(data)
        except ValidationError as error:
            raise MaterialsAiError(f"invalid material content: {error}") from error
        if str(output.project_id) != str(project_id):
            raise MaterialsAiError("material belongs to another project")
        if output.source_sha256 != source["source_sha256"]:
            raise MaterialsAiError("editorial content changed; export a new package")
        if tuple(section.id for section in output.sections) != SECTION_IDS:
            raise MaterialsAiError(
                "the seven pedagogical sections must be present in contract order"
            )
        if any(not all(p.strip() for p in section.paragraphs) for section in output.sections):
            raise MaterialsAiError("each material paragraph must contain useful content")
        for section in output.sections:
            if (
                section.id in {"guided_practice", "activities", "challenge"}
                and not section.exercises
            ):
                raise MaterialsAiError(f"section {section.id} requires exercises and answers")
        cue_by_id = {
            cue["id"]: cue
            for scene in source["source"]["scenes"]
            for cue in scene["cues"]
        }
        used: set[tuple[str, str]] = set()
        for card in output.anki_cards:
            cue_id = str(card.cue_id)
            source_cue = cue_by_id.get(cue_id)
            if not source_cue:
                raise MaterialsAiError(f"Anki cue_id {cue_id} does not belong to the source")
            focus_key = (cue_id, card.focus_text.strip().casefold())
            if focus_key in used:
                raise MaterialsAiError(
                    f"Anki cue_id {cue_id} has the same pedagogical focus repeated"
                )
            used.add(focus_key)
            if (
                card.front_en != source_cue["approved_en"]
                or card.back_pt != source_cue["approved_pt"]
            ):
                raise MaterialsAiError(f"Anki card {cue_id} changed the approved literal text")
            if card.marked_en and card.marked_en.casefold() not in card.front_en.casefold():
                raise MaterialsAiError(f"Anki card {cue_id} has marked_en outside the approved cue")
            if card.marked_pt and card.marked_pt.casefold() not in card.back_pt.casefold():
                raise MaterialsAiError(f"Anki card {cue_id} has marked_pt outside the approved cue")
            if bool(card.example_en.strip()) != bool(card.example_pt.strip()):
                raise MaterialsAiError(f"Anki card {cue_id} needs both example_en and example_pt")
        document = output.model_dump(mode="json")
        # A new import reopens review even when the prior material was approved.
        self._path(project_id, "approved.json").unlink(missing_ok=True)
        self._write(project_id, "external-draft.json", document)
        return {"status": "draft", "source_sha256": source["source_sha256"], "document": document}

    def update_anki_card(
        self, project_id: UUID, scene_id: UUID, card_id: UUID,
        data: Any, *, expected_sha256: str,
    ) -> dict[str, Any]:
        """Save one edited didactic card atomically without changing any editorial cue."""
        if not any(
            scene.id == scene_id for scene in self.repository.get_project_scenes(project_id)
        ):
            raise MaterialsAiError("scene not found in project")
        filename = f"anki-prepared-{scene_id}.json"
        original = self._read(project_id, filename)
        if original is None:
            raise MaterialsAiError("Anki preparation not found for this scene")
        original_hash = sha256(
            json.dumps(original, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        if expected_sha256 != original_hash:
            raise MaterialsAiError("Anki draft changed; reload before saving your edits")
        approved = {
            str(cue.id): (cue.approved_en, cue.approved_pt)
            for cue in self.repository.get_scene_cues(scene_id)
        }
        try:
            if original["contract"] == "nova-generator-anki-proposal/1.0":
                proposal = legacy_to_didactic(
                    AnkiProposal.model_validate_json(json.dumps(original)), approved
                )
            else:
                proposal = DidacticAnkiProposal.model_validate_json(json.dumps(original))
            update = DidacticAnkiCard.model_validate_json(
                json.dumps(data, ensure_ascii=False)
            )
        except (ValidationError, TypeError, ValueError) as error:
            raise MaterialsAiError(f"invalid edited Anki card: {error}") from error
        if update.card_id != card_id:
            raise MaterialsAiError("Anki card identity mismatch")
        original_cards = proposal.anki_cards
        if not any(card.card_id == card_id for card in original_cards):
            raise MaterialsAiError("Anki card not found")
        edited = [update if card.card_id == card_id else card for card in original_cards]
        revised = proposal.model_copy(update={"anki_cards": edited})
        try:
            validate_didactic_cards(revised, approved)
        except ValueError as error:
            raise MaterialsAiError(str(error)) from error
        self._write(project_id, filename, revised.model_dump(mode="json"))
        return self.status(project_id)

    def status(self, project_id: UUID) -> dict[str, Any]:
        source = self.package(project_id)
        revision_by_scene = {}
        for scene in self.repository.get_project_scenes(project_id):
            saved = self._read(project_id, f"anki-prepared-{scene.id}.json")
            if saved is not None:
                revision_by_scene[str(scene.id)] = sha256(
                    json.dumps(saved, sort_keys=True, ensure_ascii=False).encode("utf-8")
                ).hexdigest()
        anki = {
            "anki_prepared": source["source"].get("anki_prepared", []),
            "anki_needs_review": source["source"].get("anki_prepared_needs_review", 0),
            "anki_revisions": revision_by_scene,
        }
        for state, filename in (("approved", "approved.json"), ("draft", "external-draft.json")):
            data = self._read(project_id, filename)
            if data and data.get("source_sha256") == source["source_sha256"]:
                return {
                    "status": state,
                    "source_sha256": source["source_sha256"],
                    "document": data,
                    **anki,
                }
        return {
            "status": "pending",
            "source_sha256": source["source_sha256"],
            "document": None,
            **anki,
        }

    def approve(self, project_id: UUID, source_sha256: str) -> dict[str, Any]:
        current = self.status(project_id)
        if current["source_sha256"] != source_sha256:
            raise MaterialsAiError("materials source changed; reload the review")
        if current["status"] == "pending":
            raise MaterialsAiError("import the AI-generated pedagogical content first")
        if current["status"] == "draft":
            self._write(project_id, "approved.json", current["document"])
        return {**current, "status": "approved"}

    def _path(self, project_id: UUID, name: str) -> Path:
        return self.project_root / str(project_id) / "materials" / name

    def _read(self, project_id: UUID, name: str) -> dict[str, Any] | None:
        path = self._path(project_id, name)
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
            return result if isinstance(result, dict) else None
        except (OSError, ValueError):
            return None

    def _write(self, project_id: UUID, name: str, value: dict[str, Any]) -> None:
        path = self._path(project_id, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        try:
            temp.write_text(
                json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
