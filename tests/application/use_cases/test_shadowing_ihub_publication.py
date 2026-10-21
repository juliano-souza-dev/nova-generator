"""Approved Generator Shadowing reaches iHub unchanged and with playable cues."""

from __future__ import annotations

import json
from dataclasses import replace
from hashlib import sha256
from unittest.mock import Mock
from uuid import uuid4

import pytest

from nova_generator.application.use_cases import publish_anki_reel as publication_module
from nova_generator.application.use_cases.editorial_publication_snapshot import (
    editorial_publication_sha256,
)
from nova_generator.application.use_cases.prepare_shadowing import PrepareShadowing
from nova_generator.application.use_cases.publish_anki_reel import (
    AnkiPublicationError,
    PublishAnkiReel,
)
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import (
    Cue,
    Project,
    Scene,
    WordTiming,
    utf8_sha256,
)
from nova_generator.domain.voices import VoiceProfile


@pytest.mark.parametrize("content_type", ["dialogue", "music"])
def test_republishing_carries_approved_shadowing_with_complete_scene(
    tmp_path, monkeypatch, content_type
):
    project_id, scene_id, job_id = uuid4(), uuid4(), uuid4()
    scene = Scene(scene_id, project_id, 1, 4000)
    project = Project(
        project_id,
        "Workplace English",
        content_type,
        {"youtube_url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"},
    )
    sentences = [
        ("Hello.", "Olá.", 100, 700),
        ("Thank you.", "Obrigado.", 1100, 1700),
        ("Welcome.", "Bem-vindo.", 2150, 2850),
    ]
    source_cues = []
    words_by_id = {}
    for index, (en, pt, start, end) in enumerate(sentences, 1):
        cue = Cue(
            uuid4(), scene_id, index, start, end, start, end,
            "Ana", en, en, pt,
            provenance={"approval": "approved"},
        )
        source_cues.append(cue)
        words_by_id[cue.id] = [
            WordTiming(uuid4(), cue.id, 1, en, start, end, start, end)
        ]
    chosen = source_cues[0]
    voice = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    repository = Mock()
    repository.get_project.return_value = project
    repository.get_project_scenes.return_value = [scene]
    repository.get_scene_cues.return_value = source_cues
    repository.get_cue.side_effect = lambda cue_id: next(
        (cue for cue in source_cues if cue.id == cue_id), None
    )
    repository.get_cue_words.side_effect = lambda cue_id: words_by_id[cue_id]
    repository.get_scene_project_id.return_value = project_id
    authoring = PrepareShadowing(repository, tmp_path / "projects")

    cards = []
    for i in range(2):
        cards.append({
            "card_id": str(uuid4()),
            "cue_id": str(chosen.id),
            "scene_id": str(scene_id),
            "source_context_en": chosen.approved_en,
            "source_context_pt": chosen.approved_pt,
            "front_en": f"Hello, colleague number {i + 1}.",
            "back_pt": f"Olá, colega número {i + 1}.",
            "uses_literal_scene_line": False,
            "card_type": "EXPRESSION",
            "focus_text": "Hello",
            "meaning": "Olá",
            "marked_en": "Hello",
            "marked_pt": "Olá",
            "explanation_pt": "Saudação profissional.",
            "example_en": "Hello, team.",
            "example_pt": "Olá, equipe.",
            "tags": ["work"],
        })
    monkeypatch.setattr(
        publication_module, "MaterialsAiExchange",
        lambda *_args: type("Cards", (), {
            "find_anki_card": lambda self, _project, cid: next(
                card for card in cards if card["card_id"] == str(cid)
            ),
        })(),
    )

    folder = tmp_path / "exports" / str(job_id)
    folder.mkdir(parents=True)
    apkg, reel = folder / "anki.apkg", folder / "anki-reel.mp4"
    apkg.write_bytes(b"packaged APKG")
    reel.write_bytes(b"prepared reel")
    intervals = [
        {
            "cue_order": i + 1,
            "start_ms": i * 1400,
            "end_ms": i * 1400 + 1000,
            "audio_sha256": ("b" if i == 0 else "c") * 64,
            "text_sha256": utf8_sha256(card["front_en"]),
        }
        for i, card in enumerate(cards)
    ]
    (folder / "anki-audio-manifest.json").write_text(json.dumps({
        "schema": "nova-generator-anki-audio",
        "schema_version": "1.0",
        "voice": {
            "profile_id": str(voice.profile_id),
            "name": voice.name,
            "version": voice.version,
            "model_id": voice.model_id,
            "model_sha256": voice.model_sha256,
            "reference_audio_sha256": None,
            "parameters": voice.parameters,
            "snapshot_sha256": voice.sha256,
        },
        "apkg_sha256": sha256(apkg.read_bytes()).hexdigest(),
        "reel_sha256": sha256(reel.read_bytes()).hexdigest(),
        "cues": intervals,
    }), encoding="utf-8")
    job = Job(
        job_id, "export_materials", "succeeded",
        {
            "mode": "didactic",
            "project_id": str(project_id),
            "cue_ids": [str(chosen.id), str(chosen.id)],
            "anki_cards": cards,
            "text_hashes": {
                card["card_id"]: utf8_sha256(card["front_en"]) for card in cards
            },
            "pt_hashes": {
                card["card_id"]: utf8_sha256(card["back_pt"]) for card in cards
            },
            "audio_hashes": {
                card["card_id"]: interval["audio_sha256"]
                for card, interval in zip(cards, intervals, strict=True)
            },
            "editorial_sha256": editorial_publication_sha256(
                project, [scene], [(chosen, words_by_id[chosen.id])]
            ),
            "voice_snapshot": {"snapshot_sha256": voice.sha256},
        },
        None, 1, 3,
    )
    publisher = PublishAnkiReel(
        repository, Mock(), tmp_path / "exports", tmp_path / "projects"
    )

    # The reel can be published before any Shadowing approval.
    original = publisher.execute(
        project_id=project_id, job=job, youtube="bbbbbbbbbbb"
    )
    before = json.loads(original.path.read_text(encoding="utf-8"))
    assert "generatorShadowing" not in before
    assert len(before["cues"]) == 1

    # Shadowing approval happens later, without regenerating WAVs or reel.
    preview = authoring.scene(project_id, scene_id)
    assert preview["status"] == "draft"
    approved = authoring.approve(
        project_id, scene_id, preview["source_sha256"], preview["plan_sha256"]
    )
    assert approved["status"] == "approved"
    assert len(approved["blocks"]) >= 1
    artifact = publisher.execute(
        project_id=project_id, job=job, youtube="bbbbbbbbbbb"
    )
    doc = json.loads(artifact.path.read_text(encoding="utf-8"))
    assert doc["generatorShadowing"] == [approved]
    assert [cue["final_en"] for cue in doc["cues"]] == [row[0] for row in sentences]
    assert [cue["pt"] for cue in doc["cues"]] == [row[1] for row in sentences]
    assert doc["generator"]["source_cue_ids"] == [
        str(cue.id) for cue in source_cues
    ]
    assert [cue["order"] for cue in doc["cues"]] == [1, 2, 3]
    assert len(doc["cues"][0]["anki"]["items"]) == 2
    assert all(
        not cue["anki"]["include"] and cue["anki"]["items"] == []
        for cue in doc["cues"][1:]
    )
    assert len(doc["ankiAudio"]["cues"]) == 2
    assert [
        interval["source_cue_order"] for interval in doc["ankiAudio"]["cues"]
    ] == [1, 1]
    assert doc["ankiAudio"]["youtube"]["video_id"] == "bbbbbbbbbbb"
    assert doc["project"]["youtube"] == "https://www.youtube.com/watch?v=aaaaaaaaaaa"
    assert doc["kit"]["scene_start_ms"] == 100
    assert doc["kit"]["scene_end_ms"] == 2850
    offset = 100 if content_type == "music" else 0
    for cue, source, source_id in zip(
        doc["cues"], source_cues, doc["generator"]["source_cue_ids"], strict=True
    ):
        assert source_id == str(source.id)
        assert round(cue["start"] * 1000) + offset == source.speech_start_ms
        assert round(cue["end"] * 1000) + offset == source.speech_end_ms
        assert cue["words"][0]["text"] == source.approved_en
    assert publisher.execute(
        project_id=project_id, job=job, youtube="bbbbbbbbbbb"
    ) == artifact

    # A subsequent edit invalidates the stored approval, not silently reparsed.
    source_cues[1] = replace(source_cues[1], approved_pt="Obrigado, senhor.")
    with pytest.raises(AnkiPublicationError, match="aprove novamente"):
        publisher.execute(project_id=project_id, job=job, youtube="bbbbbbbbbbb")


def test_unapproved_shadowing_is_not_promoted(tmp_path):
    project_id, scene_id = uuid4(), uuid4()
    repository = Mock()
    repository.get_project.return_value = Project(project_id, "Scene", "dialogue")
    repository.get_project_scenes.return_value = [Scene(scene_id, project_id, 1, 1500)]
    cue = Cue(uuid4(), scene_id, 1, 100, 700, 100, 700, "Ana", "Hello.", "Hello.", "Olá.")
    repository.get_scene_cues.return_value = [cue]
    shadowing = PrepareShadowing(repository, tmp_path)
    draft = shadowing.scene(project_id, scene_id)
    from nova_generator.application.use_cases.shadowing_publication import (
        approved_shadowing_transport,
    )
    assert draft["status"] == "draft"
    selected = approved_shadowing_transport(
        repository, tmp_path, project_id,
        repository.get_project_scenes.return_value, [cue]
    )
    assert selected.plans == ()
    assert selected.additional_cues == ()
