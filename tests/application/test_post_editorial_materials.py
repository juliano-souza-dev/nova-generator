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
    assert first["blocks"][0]["start_ms"] == 0
    assert first["blocks"][0]["end_ms"] == 2000
    assert first["blocks"][0]["pause_duration_ms"] == 3500
    approved = use_case.approve(PROJECT, SCENE, first["source_sha256"])
    assert approved["status"] == "approved"
    assert use_case.scene(PROJECT, SCENE) == approved
    repo.cue = replace(repo.cue, approved_en="Hi.", revision=2)
    changed = use_case.scene(PROJECT, SCENE)
    assert changed["status"] == "draft"
    assert changed["source_sha256"] != first["source_sha256"]
    with pytest.raises(ShadowingError, match="reload"):
        use_case.approve(PROJECT, SCENE, first["source_sha256"])


def test_material_contract_requires_shadowing_and_exact_approved_text(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    with pytest.raises(MaterialsAiError, match="shadowing"):
        exchange.package(PROJECT)
    shadow = PrepareShadowing(repo, tmp_path)
    draft = shadow.scene(PROJECT, SCENE)
    shadow.approve(PROJECT, SCENE, draft["source_sha256"])

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
    shadow = PrepareShadowing(repo, tmp_path)
    plan = shadow.scene(PROJECT, SCENE)
    shadow.approve(PROJECT, SCENE, plan["source_sha256"])
    exchange = MaterialsAiExchange(repo, tmp_path)
    original = exchange.package(PROJECT)
    repo.cue = replace(repo.cue, approved_pt="Bom dia.", revision=2)
    with pytest.raises(MaterialsAiError, match="shadowing"):
        exchange.import_result(PROJECT, material_result(original["source_sha256"]))
