from __future__ import annotations

from dataclasses import replace
from uuid import UUID

import pytest

from nova_generator.application.use_cases.materials_ai_exchange import (
    OUTPUT_CONTRACT,
    SECTION_IDS,
    MaterialsAiError,
    MaterialsAiExchange,
)
from nova_generator.application.use_cases.prepare_shadowing import (
    PrepareShadowing,
    ShadowingError,
)
from nova_generator.domain.projects.entities import Cue, Project, Scene, WordTiming

PROJECT = UUID("00000000-0000-4000-8000-000000000101")
SCENE = UUID("00000000-0000-4000-8000-000000000102")
CUE = UUID("00000000-0000-4000-8000-000000000103")
WORD = UUID("00000000-0000-4000-8000-000000000104")


class Repository:
    def __init__(self):
        self.project = Project(PROJECT, "Primeira aula", "dialogue")
        self.scene = Scene(SCENE, PROJECT, 1, 6000)
        self.cue = Cue(
            CUE, SCENE, 1, 500, 2000, 500, 2000,
            "", "Hello.", "Hello.", "Olá.", 1,
            {"approval": "approved"},
        )

    def get_project(self, project_id):
        return self.project if project_id == PROJECT else None

    def get_project_scenes(self, project_id):
        return [self.scene] if project_id == PROJECT else []

    def get_scene_cues(self, scene_id):
        return [self.cue] if scene_id == SCENE else []

    def get_cue_words(self, cue_id):
        if cue_id != CUE:
            return []
        return [WordTiming(WORD, CUE, 1, "Hello.", 500, 2000, 500, 2000, {"pt": "Olá."})]


def material_result(fingerprint):
    return {
        "contract": OUTPUT_CONTRACT,
        "project_id": str(PROJECT),
        "source_sha256": fingerprint,
        "title": "Aula de conversação",
        "sections": [
            {
                "id": name,
                "title": f"Parte {name}",
                "paragraphs": ["Uma explicação contextual completa para aprender inglês."],
                "exercises": [{"prompt": "Como responder?", "answer": "Uma resposta."}]
                if name in {"guided_practice", "activities", "challenge"} else [],
            }
            for name in SECTION_IDS
        ],
        "anki_cards": [
            {
                "cue_id": str(CUE),
                "front_en": "Hello.",
                "back_pt": "Olá.",
                "explanation_pt": "Saudação curta usada em conversas.",
                "tags": ["greetings"],
            }
        ],
    }


def test_prepared_shadowing_requires_approval_and_invalidates_when_cue_changes(tmp_path):
    repo = Repository()
    use_case = PrepareShadowing(repo, tmp_path)
    first = use_case.scene(PROJECT, SCENE)
    assert first["status"] == "draft"
    assert first["blocks"][0]["start_ms"] == 500
    assert first["blocks"][0]["end_ms"] == 2000
    assert first["blocks"][0]["pause_duration_ms"] == 3100
    approved = use_case.approve(PROJECT, SCENE, first["source_sha256"])
    assert approved["status"] == "approved"
    assert use_case.scene(PROJECT, SCENE) == approved
    repo.cue = replace(repo.cue, approved_en="Hi.", revision=2)
    changed = use_case.scene(PROJECT, SCENE)
    assert changed["status"] == "draft"
    assert changed["source_sha256"] != first["source_sha256"]
    with pytest.raises(ShadowingError, match="reload"):
        use_case.approve(PROJECT, SCENE, first["source_sha256"])


def test_material_contract_uses_approved_editorial_text(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    package = exchange.package(PROJECT)
    assert package["source"]["scenes"][0]["cues"][0]["approved_en"] == "Hello."
    result = material_result(package["source_sha256"])

    modified = material_result(package["source_sha256"])
    modified["anki_cards"][0]["front_en"] = "Changed English."
    with pytest.raises(MaterialsAiError, match="literal"):
        exchange.import_result(PROJECT, modified)

    modified = material_result(package["source_sha256"])
    modified["sections"][2]["paragraphs"] = [""]
    with pytest.raises(MaterialsAiError, match="paragraph"):
        exchange.import_result(PROJECT, modified)

    modified = material_result("f" * 64)
    with pytest.raises(MaterialsAiError, match="changed"):
        exchange.import_result(PROJECT, modified)

    modified = material_result(package["source_sha256"])
    modified["anki_cards"][0]["marked_en"] = "nonexistent expression"
    with pytest.raises(MaterialsAiError, match="marked_en"):
        exchange.import_result(PROJECT, modified)

    modified = material_result(package["source_sha256"])
    modified["anki_cards"][0]["example_en"] = "How are you?"
    with pytest.raises(MaterialsAiError, match="both example_en and example_pt"):
        exchange.import_result(PROJECT, modified)

    imported = exchange.import_result(PROJECT, result)
    assert imported["status"] == "draft"
    assert exchange.status(PROJECT)["status"] == "draft"
    approved = exchange.approve(PROJECT, package["source_sha256"])
    assert approved["status"] == "approved"
    assert exchange.status(PROJECT)["document"]["sections"][0]["paragraphs"]
    assert exchange.status(PROJECT)["status"] == "approved"

    # A new submission never silently inherits an earlier human approval.
    exchange.import_result(PROJECT, result)
    assert exchange.status(PROJECT)["status"] == "draft"


def test_material_contract_cannot_use_stale_or_unapproved_editorial(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    original = exchange.package(PROJECT)
    repo.cue = replace(repo.cue, approved_pt="Bom dia.", revision=2)
    with pytest.raises(MaterialsAiError, match="changed"):
        exchange.import_result(PROJECT, material_result(original["source_sha256"]))


def test_materials_package_reuses_anki_from_initial_external_export(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    prepared = {
        "contract": "nova-generator-anki-proposal/1.0",
        "scene_id": str(SCENE),
        "input_sha256": "a" * 64,
        "anki_cards": [
            {
                "cue_id": str(CUE),
                "front_en": "Hello.",
                "back_pt": "Olá.",
                "card_type": "EXPRESSION",
                "focus_text": "Hello.",
                "meaning": "Olá.",
                "marked_en": "Hello.",
                "marked_pt": "Olá.",
                "explanation_pt": "Saudação ao iniciar uma conversa.",
                "example_en": "Hello, team!",
                "example_pt": "Olá, equipe!",
                "tags": ["greetings"],
            }
        ],
    }
    exchange._write(PROJECT, f"anki-prepared-{SCENE}.json", prepared)
    ready = exchange.package(PROJECT)["source"]
    assert len(ready["anki_prepared"]) == 1
    assert ready["anki_prepared"][0]["front_en"] == "Hello."
    assert ready["anki_prepared"][0]["source_context_en"] == "Hello."
    assert ready["anki_prepared"][0]["uses_literal_scene_line"] is True
    assert ready["anki_prepared"][0]["scene_id"] == str(SCENE)
    assert ready["anki_prepared_needs_review"] == 0

    repo.cue = replace(repo.cue, approved_en="Hi.", revision=2)
    needs_review = exchange.package(PROJECT)["source"]
    assert needs_review["anki_prepared"] == []
    assert needs_review["anki_prepared_needs_review"] == 1


def anki_proposal(*, english="Hello.", portuguese="Olá.", digest="a" * 64):
    return {
        "contract": "nova-generator-anki-proposal/1.0",
        "scene_id": str(SCENE),
        "input_sha256": digest,
        "anki_cards": [
            {
                "cue_id": str(CUE),
                "front_en": english,
                "back_pt": portuguese,
                "card_type": "EXPRESSION",
                "focus_text": "Hello.",
                "meaning": "Olá.",
                "marked_en": "Hello.",
                "marked_pt": "Olá.",
                "explanation_pt": "Cumprimento natural nesta conversa.",
                "example_en": "Hello, my friend!",
                "example_pt": "Olá, meu amigo!",
                "tags": ["greetings"],
            }
        ],
    }


def test_material_import_accepts_anki_only_without_workbook_sections(tmp_path):
    import json

    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    manifest = tmp_path / str(PROJECT) / "editorial-ai" / f"scene-{SCENE}-external-ai-manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"input_sha256": "a" * 64}), encoding="utf-8")

    accepted = exchange.import_result(PROJECT, anki_proposal())
    assert accepted["imported"] == "anki"
    assert accepted["status"] == "pending"
    assert accepted["document"] is None
    assert len(accepted["anki_prepared"]) == 1
    assert accepted["anki_needs_review"] == 0
    assert exchange.status(PROJECT)["anki_prepared"][0]["focus_text"] == "Hello."

    saved = exchange._read(PROJECT, f"anki-prepared-{SCENE}.json")
    assert saved is not None and saved["contract"] == "nova-generator-anki-proposal/1.0"
    # Re-import is idempotent, not an attempt to fabricate a seven-section workbook.
    assert len(exchange.import_result(PROJECT, anki_proposal())["anki_prepared"]) == 1


def test_anki_only_import_rejects_wrong_source_and_unapproved_text(tmp_path):
    import json

    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    manifest = tmp_path / str(PROJECT) / "editorial-ai" / f"scene-{SCENE}-external-ai-manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"input_sha256": "a" * 64}), encoding="utf-8")

    with pytest.raises(MaterialsAiError, match="input_sha256"):
        exchange.import_result(PROJECT, anki_proposal(digest="b" * 64))
    with pytest.raises(MaterialsAiError, match="different from the approved"):
        exchange.import_result(PROJECT, anki_proposal(english="Good morning."))
    assert exchange._read(PROJECT, f"anki-prepared-{SCENE}.json") is None

    unknown = anki_proposal()
    unknown["contract"] = "nova-generator-wrong/1.0"
    with pytest.raises(MaterialsAiError, match="unsupported material contract"):
        exchange.import_result(PROJECT, unknown)


def test_didactic_anki_v2_can_be_edited_without_changing_editorial(tmp_path):
    import json
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    manifest = tmp_path / str(PROJECT) / "editorial-ai" / f"scene-{SCENE}-external-ai-manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"input_sha256": "a" * 64}), encoding="utf-8")

    original = anki_proposal()
    exchange.import_result(PROJECT, original)
    status = exchange.status(PROJECT)
    didactic = status["anki_prepared"][0]
    assert didactic["front_en"] == "Hello."

    edited = dict(didactic)
    edited.pop("scene_id")
    edited.update({
        "front_en": "Hello, welcome to our law office.",
        "back_pt": "Olá, seja bem-vindo ao nosso escritório de advocacia.",
        "uses_literal_scene_line": False,
        "marked_en": "Hello",
        "marked_pt": "Olá",
    })
    saved = exchange.update_anki_card(
        PROJECT, SCENE, UUID(didactic["card_id"]), edited,
        expected_sha256=status["anki_revisions"][str(SCENE)],
    )
    assert saved["anki_prepared"][0]["front_en"] == edited["front_en"]
    assert saved["anki_prepared"][0]["source_context_en"] == "Hello."
    assert repo.cue.approved_en == "Hello."
    assert repo.cue.approved_pt == "Olá."
    assert exchange._read(PROJECT, f"anki-prepared-{SCENE}.json")["contract"] == (
        "nova-generator-anki-proposal/2.0"
    )
    with pytest.raises(MaterialsAiError, match="draft changed"):
        exchange.update_anki_card(
            PROJECT, SCENE, UUID(didactic["card_id"]), edited,
            expected_sha256=status["anki_revisions"][str(SCENE)],
        )
    # Reject invented source phrase even when the didactic sentence itself is valid.
    newer = dict(edited, focus_text="unknown expression")
    with pytest.raises(MaterialsAiError, match="focus_text"):
        exchange.update_anki_card(
            PROJECT, SCENE, UUID(didactic["card_id"]), newer,
            expected_sha256=saved["anki_revisions"][str(SCENE)],
        )


def test_v2_anki_import_accepts_didactic_phrase_with_literal_source_context(tmp_path):
    import json

    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    manifest = tmp_path / str(PROJECT) / "editorial-ai" / f"scene-{SCENE}-external-ai-manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"input_sha256": "a" * 64}), encoding="utf-8")
    proposal = {
        "contract": "nova-generator-anki-proposal/2.0",
        "scene_id": str(SCENE),
        "input_sha256": "a" * 64,
        "anki_cards": [{
            "card_id": "00000000-0000-4000-8000-000000000167",
            "cue_id": str(CUE),
            "source_context_en": "Hello.",
            "source_context_pt": "Olá.",
            "front_en": "Hello, welcome to the firm.",
            "back_pt": "Olá, bem-vindo ao escritório.",
            "uses_literal_scene_line": False,
            "card_type": "EXPRESSION",
            "focus_text": "Hello",
            "meaning": "Saudação",
            "marked_en": "Hello",
            "marked_pt": "Olá",
            "explanation_pt": "Saudação em ambiente profissional.",
            "example_en": "Hello, everyone!",
            "example_pt": "Olá, pessoal!",
            "tags": ["greeting"],
        }],
    }
    result = exchange.import_result(PROJECT, proposal)
    assert result["status"] == "pending"
    assert result["anki_prepared"][0]["front_en"] != repo.cue.approved_en
    assert result["anki_prepared"][0]["source_context_en"] == repo.cue.approved_en
    assert result["anki_needs_review"] == 0
