from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import materials_external as me


class MaterialsExternalContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.canonical = {
            "snapshot_id": "snap-123",
            "generated_at_utc": "2026-08-28T10:47:42+00:00",
            "project": {"content_type": "music"},
            "cues": [
                {"order": 1, "approved_en": "Can I help you?", "pt": "Posso ajudar você?", "speaker": "", "speech_start_ms": 0, "speech_end_ms": 1000, "words": []},
                {"order": 2, "approved_en": "Time runs out.", "pt": "O tempo acaba.", "speaker": "", "speech_start_ms": 1100, "speech_end_ms": 2000, "words": []},
            ],
        }
        self.cs = {"items": []}
        self.canonical_sha = "canonical-hash"
        self.cs_sha = "cs-hash"

    def _valid_return(self) -> dict:
        return {
            "schema": me.RETURN_SCHEMA,
            "schema_version": me.RETURN_SCHEMA_VERSION,
            "source_snapshot_id": self.canonical["snapshot_id"],
            "source_canonical_sha256": self.canonical_sha,
            "source_connected_speech_review_sha256": self.cs_sha,
            "pdf_content": {"immersion_workbook": {
                "kit_objective": "Compreender e reutilizar os chunks do trecho.",
                "day_5_diagnostic": {
                    "intro": "Faça sem apoio.",
                    "checks": [
                        {"title": "A", "cue_orders": [1], "instruction": "Ouça.", "success_criteria": "Entendeu."},
                        {"title": "B", "cue_orders": [1], "instruction": "Recupere.", "success_criteria": "Recuperou."},
                        {"title": "C", "cue_orders": [2], "instruction": "Produza.", "success_criteria": "Produziu."},
                    ],
                    "self_assessment": "Registre o que falta revisar.",
                },
                "connected_speech": {"items": []},
                "connected_speech_practice": {"items": []},
                "structures_from_scene": {"items": [{
                    "title": "Can I help you...?",
                    "cue_orders": [1],
                    "pattern": "Can I help you + complemento?",
                    "explanation_pt": "Estrutura para oferecer ajuda.",
                    "new_contexts": [
                        {"en": "Can I help you carry this?", "pt": "Posso ajudar você a carregar isto?"},
                        {"en": "Can I help you find it?", "pt": "Posso ajudar você a encontrar isso?"},
                    ],
                    "make_it_yours": "Crie uma pergunta sua.",
                }]},
                "activities": {
                    "intro": "Faça antes de conferir.",
                    "listening_reconstruction": [{"cue_orders": [1], "prompt": "Reconstrua o cue.", "answer": "Can I help you?"}],
                    "connected_speech_hunt": [],
                    "structure_transfer": [{"structure_title": "Can I help you...?", "prompt": "Crie duas frases.", "model_answers": ["Can I help you cook?", "Can I help you study?"]}],
                    "vocabulary_recall": [{"cue_orders": [2], "prompt": "O que significa runs out?", "answer": "acaba"}],
                    "shadowing_challenge": {},
                    "final_listening": {"prompt": "Ouça sem legendas.", "comprehension_record": "Anote o que entendeu."},
                },
                "finalization": {
                    "title": "Finalização",
                    "checklist": ["Item 1", "Item 2", "Item 3"],
                    "reflection_prompt": "Reflita sobre o que já domina.",
                    "next_review": "Revise somente o que ainda falha.",
                },
            }},
            "anki": {"items": []},
        }

    def test_exported_activity_contract_matches_validator_fields(self) -> None:
        payload = me.build_instruction_payload(
            self.canonical,
            self.cs,
            canonical_sha256=self.canonical_sha,
            connected_speech_review_sha256=self.cs_sha,
        )
        activities = payload["return_contract"]["pdf_content"]["immersion_workbook"]["activities"]
        self.assertEqual(activities["listening_reconstruction"]["item_required_fields"], ["cue_orders", "prompt", "answer"])
        self.assertEqual(activities["vocabulary_recall"]["item_required_fields"], ["cue_orders", "prompt", "answer"])
        self.assertEqual(activities["structure_transfer"]["item_required_fields"], ["structure_title", "prompt", "model_answers"])
        self.assertEqual(activities["final_listening"]["required_fields"], ["prompt", "comprehension_record"])
        self.assertEqual(activities["connected_speech_hunt"]["exact_value"], [])
        self.assertEqual(activities["shadowing_challenge"]["exact_value"], {})

    def test_contract_shaped_return_is_accepted(self) -> None:
        me.validate_return(
            self._valid_return(),
            self.canonical,
            self.cs,
            canonical_sha256=self.canonical_sha,
            connected_speech_review_sha256=self.cs_sha,
        )

    def test_old_instruction_field_is_rejected(self) -> None:
        returned = self._valid_return()
        returned["pdf_content"]["immersion_workbook"]["activities"]["listening_reconstruction"] = [
            {"cue_orders": [1], "instruction": "Campo antigo"}
        ]
        with self.assertRaisesRegex(me.MaterialsExternalError, "cue_orders, prompt e answer"):
            me.validate_return(
                returned,
                self.canonical,
                self.cs,
                canonical_sha256=self.canonical_sha,
                connected_speech_review_sha256=self.cs_sha,
            )

    def test_music_disabled_activity_fields_are_exact(self) -> None:
        for key, wrong in (("connected_speech_hunt", None), ("shadowing_challenge", None)):
            returned = self._valid_return()
            returned["pdf_content"]["immersion_workbook"]["activities"][key] = wrong
            with self.assertRaises(me.MaterialsExternalError):
                me.validate_return(
                    returned,
                    self.canonical,
                    self.cs,
                    canonical_sha256=self.canonical_sha,
                    connected_speech_review_sha256=self.cs_sha,
                )


if __name__ == "__main__":
    unittest.main()
