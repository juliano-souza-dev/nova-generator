"""Source-locked, speaker-safe shadowing planning and AI proposal validation."""

from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest

from nova_generator.application.use_cases.prepare_shadowing import (
    CONTRACT,
    PROPOSAL_CONTRACT,
    PrepareShadowing,
    ShadowingError,
)
from nova_generator.domain.projects.entities import Cue, Project, Scene

PROJECT = UUID("00000000-0000-4000-8000-000000000201")
SCENE = UUID("00000000-0000-4000-8000-000000000202")
CUE_IDS = [
    UUID("00000000-0000-4000-8000-00000000020" + str(index))
    for index in range(3, 8)
]


class Repository:
    def __init__(self):
        self.project = Project(PROJECT, "Dialogue", "dialogue")
        self.scene = Scene(SCENE, PROJECT, 1, 18_000)
        self.cues = [
            self._cue(0, "Mike", "Hello.", "Olá.", 900, 1800),
            self._cue(1, "Donna", "What?", "O quê?", 2050, 2500),
            self._cue(2, "Mike", "I have a question.", "Tenho uma pergunta.", 2600, 3650),
            self._cue(3, "Mike", "Please help.", "Por favor, ajude.", 3850, 4500),
            self._cue(
                4,
                "Mike",
                "This is a very long sentence that no learner should need to repeat "
                "in a single attempt in any lesson today.",
                "Uma frase longa para a aula.",
                6000,
                15_000,
            ),
        ]

    @staticmethod
    def _cue(index, speaker, en, pt, start, end):
        return Cue(
            CUE_IDS[index], SCENE, index + 1, start, end, start, end,
            speaker, en, en, pt, 1, {"approval": "approved"},
        )

    def get_project(self, project_id):
        return self.project if project_id == PROJECT else None

    def get_project_scenes(self, project_id):
        return [self.scene] if project_id == PROJECT else []

    def get_scene_cues(self, scene_id):
        return self.cues if scene_id == SCENE else []


def _proposal(plan, groups):
    return {
        "contract": PROPOSAL_CONTRACT,
        "scene_id": str(SCENE),
        "source_sha256": plan["source_sha256"],
        "groups": [{"cue_ids": [str(item) for item in group]} for group in groups],
    }


def test_default_uses_single_speaker_short_cues_and_skips_oversized_speech(tmp_path):
    repo = Repository()
    plan = PrepareShadowing(repo, tmp_path).scene(PROJECT, SCENE)
    assert plan["contract"] == CONTRACT
    assert plan["origin"] == "automatic"
    assert len(plan["blocks"]) == 3
    assert [block["speaker"] for block in plan["blocks"]] == ["Mike", "Donna", "Mike"]
    assert plan["blocks"][2]["cue_ids"] == [str(CUE_IDS[2]), str(CUE_IDS[3])]
    assert plan["blocks"][2]["en"] == "I have a question. Please help."
    assert plan["blocks"][2]["start_ms"] == 2600
    assert plan["blocks"][2]["end_ms"] == 4500
    assert all(block["end_ms"] - block["start_ms"] <= 6500 for block in plan["blocks"])
    assert all(block["word_count"] <= 14 for block in plan["blocks"])
    assert plan["excluded_cues"][0]["id"] == str(CUE_IDS[4])
    assert plan["excluded_cues"][0]["eligible"] is False


def test_manual_merge_remove_restore_and_split_keep_editorial_untouched(tmp_path):
    repo = Repository()
    service = PrepareShadowing(repo, tmp_path)
    before = list(repo.cues)
    initial = service.scene(PROJECT, SCENE)
    revised = service.edit(
        PROJECT,
        SCENE,
        initial["source_sha256"],
        initial["plan_sha256"],
        [[str(CUE_IDS[0])], [str(CUE_IDS[2]), str(CUE_IDS[3])]],
    )
    assert revised["status"] == "draft"
    assert revised["origin"] == "manual"
    assert len(revised["excluded_cues"]) == 2
    assert {item["id"] for item in revised["excluded_cues"]} == {
        str(CUE_IDS[1]), str(CUE_IDS[4])
    }
    assert service.scene(PROJECT, SCENE) == revised
    with pytest.raises(ShadowingError, match="plano mudou"):
        service.edit(
            PROJECT, SCENE, revised["source_sha256"], initial["plan_sha256"], []
        )
    restored = service.edit(
        PROJECT, SCENE, revised["source_sha256"], revised["plan_sha256"],
        [[str(CUE_IDS[0])], [str(CUE_IDS[1])], [str(CUE_IDS[2])], [str(CUE_IDS[3])]],
    )
    assert len(restored["blocks"]) == 4
    assert repo.cues == before


@pytest.mark.parametrize(
    ("groups", "message"),
    [
        ([[0, 1]], "misturar personagens"),
        ([[0, 2]], "consecutivos"),
        ([[0], [0]], "apenas uma vez"),
        ([[4]], "longa demais"),
        ([[2, 3], [1]], "em ordem"),
    ],
)
def test_invalid_grouping_never_persists(tmp_path, groups, message):
    repo = Repository()
    service = PrepareShadowing(repo, tmp_path)
    current = service.scene(PROJECT, SCENE)
    with pytest.raises(ShadowingError, match=message):
        service.edit(
            PROJECT, SCENE, current["source_sha256"], current["plan_sha256"],
            [[str(CUE_IDS[index]) for index in group] for group in groups],
        )
    assert service.scene(PROJECT, SCENE) == current


def test_approval_is_version_bound_and_source_speaker_revision_invalidates(tmp_path):
    repo = Repository()
    service = PrepareShadowing(repo, tmp_path)
    initial = service.scene(PROJECT, SCENE)
    approved = service.approve(
        PROJECT, SCENE, initial["source_sha256"], initial["plan_sha256"]
    )
    assert approved["status"] == "approved"
    edited = service.edit(
        PROJECT, SCENE, approved["source_sha256"], approved["plan_sha256"],
        [[str(CUE_IDS[0])]],
    )
    assert edited["status"] == "draft"
    with pytest.raises(ShadowingError, match="plano mudou"):
        service.approve(PROJECT, SCENE, edited["source_sha256"], approved["plan_sha256"])
    repo.cues[0] = replace(repo.cues[0], speaker="Donna", revision=2)
    changed = service.scene(PROJECT, SCENE)
    assert changed["status"] == "draft"
    assert changed["source_sha256"] != initial["source_sha256"]
    with pytest.raises(ShadowingError, match="reload"):
        service.approve(PROJECT, SCENE, initial["source_sha256"], initial["plan_sha256"])


def test_external_contract_preserves_original_en_pt_and_rejects_fake_source(tmp_path):
    repo = Repository()
    service = PrepareShadowing(repo, tmp_path)
    package = service.package(PROJECT, SCENE)
    assert "speaker" in package["cues"][0]
    current = service.scene(PROJECT, SCENE)
    document = _proposal(current, [[CUE_IDS[0]], [CUE_IDS[2], CUE_IDS[3]]])
    imported = service.import_result(PROJECT, SCENE, document)
    assert imported["origin"] == "external"
    assert imported["blocks"][1]["en"] == repo.cues[2].approved_en + " " + repo.cues[3].approved_en
    assert imported["blocks"][1]["pt"] == repo.cues[2].approved_pt + " " + repo.cues[3].approved_pt
    with pytest.raises(ShadowingError, match="Editorial mudou"):
        service.import_result(
            PROJECT, SCENE, {**document, "source_sha256": "f" * 64}
        )
    with pytest.raises(ShadowingError, match="JSON de Shadowing inválido"):
        service.import_result(
            PROJECT, SCENE, {**document, "unapproved_text": "fake"}
        )


def test_groq_generation_uses_same_validated_proposal_and_does_not_change_cues(tmp_path):
    repo = Repository()
    service = PrepareShadowing(repo, tmp_path)
    initial = service.scene(PROJECT, SCENE)
    response = SimpleNamespace(
        choices=[SimpleNamespace(
            message=SimpleNamespace(
                content=json.dumps(_proposal(initial, [[CUE_IDS[0]], [CUE_IDS[2]]]))
            )
        )]
    )
    create = Mock(return_value=response)
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    before = list(repo.cues)
    plan = service.generate_groq(PROJECT, SCENE, api_key=None, model="fake", client=client)
    assert plan["origin"] == "groq"
    assert plan["status"] == "draft"
    assert plan["blocks"][1]["en"] == "I have a question."
    assert repo.cues == before
    assert create.call_args.kwargs["response_format"] == {"type": "json_object"}
    with pytest.raises(ShadowingError, match="Groq não configurada"):
        service.generate_groq(PROJECT, SCENE, api_key=None, model="fake")
