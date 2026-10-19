from __future__ import annotations

from dataclasses import replace
from uuid import UUID

import pytest

from nova_generator.application.use_cases.pre_editorial_package import PreEditorialPackage
from nova_generator.application.use_cases.prepare_shadowing import (
    PrepareShadowing,
    ShadowingError,
)
from nova_generator.application.use_cases.review_asr_candidate import _candidate_entries
from nova_generator.domain.projects.entities import Scene


PROJECT_ID = UUID("00000000-0000-4000-8000-000000001234")
JOB_ID = UUID("00000000-0000-4000-8000-000000005678")


def source() -> dict:
    return {
        "duration_ms": 6000,
        "transcript_candidate": {
            "engine": "fixture",
            "cues": [
                {
                    "start_ms": 200,
                    "end_ms": 1400,
                    "text": "Hello there.",
                    "words": [
                        {"surface": "Hello", "start_ms": 200, "end_ms": 600},
                        {"surface": "there.", "start_ms": 650, "end_ms": 1400},
                    ],
                },
                {
                    "start_ms": 2000,
                    "end_ms": 2900,
                    "text": "Good morning!",
                    "words": [
                        {"surface": "Good", "start_ms": 2000, "end_ms": 2300},
                        {"surface": "morning!", "start_ms": 2350, "end_ms": 2900},
                    ],
                },
            ],
        },
    }


class DraftRepository:
    def __init__(self, scene, cues):
        self._scene = scene
        self._cues = cues

    def get_project(self, project_id):
        return object() if project_id == PROJECT_ID else None

    def get_project_scenes(self, project_id):
        return [self._scene]

    def get_scene_cues(self, scene_id):
        return self._cues


def test_preparation_is_deterministic_and_staged_once(tmp_path):
    service = PreEditorialPackage(tmp_path)
    initial = service.stage(PROJECT_ID, JOB_ID, source())
    assert initial["contract"] == "nova-generator-unified-preparation-input/1.0"
    assert initial["input_sha256"] == initial["editorial"]["input_sha256"]
    assert initial["shadowing"]["origin"] == "automatic"
    assert initial["shadowing"]["ai_must_not_modify"] is True
    assert len(initial["shadowing"]["blocks"]) == 2
    assert initial["shadowing"]["blocks"][0]["en"] == "Hello there."
    assert initial["editorial"]["cues"][0]["original_en"] == "Hello there."
    assert "anki_cards" in initial["instructions"]["output_shape"]["materials"]
    assert len(initial["instructions"]["output_shape"]["materials"]["sections"]) == 7
    assert service.load(PROJECT_ID, UUID(initial["scene_id"])) == initial
    assert service.stage(PROJECT_ID, JOB_ID, source()) == initial


def test_shadowing_from_transcription_survives_editorial_approval(tmp_path):
    input_data = PreEditorialPackage(tmp_path).stage(PROJECT_ID, JOB_ID, source())
    scene_id = UUID(input_data["scene_id"])
    entries, duration = _candidate_entries(source(), scene_id, JOB_ID)
    scene = Scene(scene_id, PROJECT_ID, 1, duration, None, {})
    repository = DraftRepository(scene, [item[0] for item in entries])
    shadowing = PrepareShadowing(repository, tmp_path)
    draft = shadowing.scene(PROJECT_ID, scene_id)
    early_groups = [block["cue_ids"] for block in input_data["shadowing"]["blocks"]]
    assert [block["cue_ids"] for block in draft["blocks"]] == early_groups
    with pytest.raises(ShadowingError, match="Editorial"):
        shadowing.approve(PROJECT_ID, scene_id, draft["source_sha256"])
    repository._cues = [
        replace(
            cue,
            approved_en=cue.original_en,
            approved_pt="Olá!" if index == 0 else "Bom dia!",
            provenance={**cue.provenance, "approval": "approved"},
        )
        for index, cue in enumerate(repository._cues)
    ]
    reviewed = shadowing.scene(PROJECT_ID, scene_id)
    assert [block["cue_ids"] for block in reviewed["blocks"]] == early_groups
    assert reviewed["blocks"][0]["pt"] == "Olá!"
    assert shadowing.approve(PROJECT_ID, scene_id, reviewed["source_sha256"])["status"] == "approved"
