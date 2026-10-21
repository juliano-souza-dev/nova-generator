import json
from dataclasses import replace
from hashlib import sha256
from unittest.mock import Mock
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.editorial_publication_snapshot import (
    editorial_publication_sha256,
)
from nova_generator.application.use_cases.publish_anki_reel import (
    AnkiPublicationError,
    PublishAnkiReel,
)
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import Cue, Project, Scene, WordTiming, utf8_sha256
from nova_generator.domain.voices import VoiceProfile


@pytest.mark.parametrize(
    ("content_type", "expected_start_ms"),
    [("dialogue", 10_100), ("music", 0)],
)
def test_publication_keeps_literal_text_words_and_card_timeline(
    tmp_path, content_type, expected_start_ms
):
    project_id, scene_id, cue_id, job_id = (uuid4() for _ in range(4))
    cue = Cue(
        cue_id,
        scene_id,
        1,
        100,
        700,
        100,
        700,
        "Ana",
        "“Café?”",
        "“Café?”",
        "Café!",
        provenance={"tags": ["lesson"], "editorial_preparation_trailing": "”"},
    )
    word = WordTiming(uuid4(), cue_id, 1, "“Café?", 100, 700, 100, 700)
    voice = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    repository = Mock()
    repository.get_project.return_value = Project(
        project_id,
        "Lesson",
        content_type,
        {"youtube_url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"},
    )
    repository.get_cue.return_value = cue
    repository.get_scene_project_id.return_value = project_id
    ingest_id = uuid4()
    repository.get_project_scenes.return_value = [
        Scene(scene_id, project_id, 1, 1000, provenance={"ingest_job_id": str(ingest_id)})
    ]
    repository.get_cue_words.return_value = [word]
    jobs = Mock()
    jobs.get.return_value = Job(
        ingest_id,
        "ingest_scene_media",
        "succeeded",
        {"project_id": str(project_id)},
        None,
        1,
        3,
        output={"start_ms": 10_000},
    )
    directory = tmp_path / "exports" / str(job_id)
    directory.mkdir(parents=True)
    apkg, reel = directory / "anki.apkg", directory / "anki-reel.mp4"
    apkg.write_bytes(b"apkg")
    reel.write_bytes(b"reel")

    def digest(path):
        return sha256(path.read_bytes()).hexdigest()

    manifest = {
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
        "apkg_sha256": digest(apkg),
        "reel_sha256": digest(reel),
        "cues": [
            {
                "cue_order": 1,
                "start_ms": 0,
                "end_ms": 600,
                "audio_sha256": "b" * 64,
                "text_sha256": cue.approved_en_sha256,
            }
        ],
    }
    (directory / "anki-audio-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    job = Job(
        job_id,
        "export_materials",
        "succeeded",
        {
            "project_id": str(project_id),
            "cue_ids": [str(cue_id)],
            "text_hashes": {str(cue_id): cue.approved_en_sha256},
            "pt_hashes": {str(cue_id): utf8_sha256(cue.approved_pt)},
            "audio_hashes": {str(cue_id): "b" * 64},
            "editorial_sha256": editorial_publication_sha256(
                repository.get_project.return_value,
                repository.get_project_scenes.return_value,
                [(cue, [word])],
            ),
            "voice_snapshot": {"snapshot_sha256": voice.sha256},
        },
        None,
        1,
        3,
    )
    publisher = PublishAnkiReel(repository, jobs, tmp_path / "exports", tmp_path / "projects")
    published = publisher.execute(project_id=project_id, job=job, youtube="bbbbbbbbbbb")
    document = json.loads(published.path.read_text(encoding="utf-8"))
    assert document["kit"]["contentType"] == ("music" if content_type == "music" else "immersion")
    assert document["kit"]["scene_start_ms"] == 10_100
    assert document["cues"][0]["final_en"] == "“Café?”"
    assert document["cues"][0]["pt"] == "Café!"
    assert document["cues"][0]["words"][0]["text"] == "“Café?"
    assert document["cues"][0]["trailing"] == "”"
    assert (
        "".join(word["text"] for word in document["cues"][0]["words"])
        + document["cues"][0]["trailing"]
        == document["cues"][0]["final_en"]
    )
    assert document["cues"][0]["start"] == expected_start_ms / 1000
    assert document["cues"][0]["end"] == (expected_start_ms + 600) / 1000
    assert document["cues"][0]["words"][0]["start_ms"] == expected_start_ms
    assert document["cues"][0]["words"][0]["original_start_ms"] == expected_start_ms
    ihub_offset = document["kit"]["scene_start_ms"] if content_type == "music" else 0
    assert round(document["cues"][0]["start"] * 1000) + ihub_offset == 10_100
    assert document["cues"][0]["words"][0]["start_ms"] + ihub_offset == 10_100
    assert document["cues"][0]["anki"]["items"][0]["focus"] == "“Café?”"
    assert document["ankiAudio"]["youtube"]["video_id"] == "bbbbbbbbbbb"
    assert document["ankiAudio"]["cues"][0]["start_ms"] == 0
    assert document["generator"]["editorial_sha256"] == job.input["editorial_sha256"]
    assert publisher.execute(project_id=project_id, job=job, youtube="bbbbbbbbbbb") == published
    with pytest.raises(AnkiPublicationError, match="outro vídeo"):
        publisher.execute(project_id=project_id, job=job, youtube="ccccccccccc")
    changed = Job(
        job.id,
        job.kind,
        job.status,
        {**job.input, "pt_hashes": {str(cue_id): "0" * 64}},
        None,
        1,
        3,
    )
    with pytest.raises(AnkiPublicationError, match="Texto ou WAV"):
        publisher.execute(project_id=project_id, job=changed, youtube="bbbbbbbbbbb")
    repository.get_cue_words.return_value = [replace(word, start_ms=150)]
    with pytest.raises(AnkiPublicationError, match="Timing, palavras"):
        publisher.execute(project_id=project_id, job=job, youtube="bbbbbbbbbbb")
    repository.get_cue_words.return_value = [word]
    repository.get_cue.return_value = replace(cue, speech_start_ms=150)
    with pytest.raises(AnkiPublicationError, match="Timing, palavras"):
        publisher.execute(project_id=project_id, job=job, youtube="bbbbbbbbbbb")
    repository.get_cue.return_value = replace(cue, provenance={"approval": "draft"})
    with pytest.raises(AnkiPublicationError, match="rascunho"):
        publisher.execute(project_id=project_id, job=job, youtube="bbbbbbbbbbb")


def test_didactic_publication_keeps_original_scene_and_separate_audio_per_card(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace

    from nova_generator.application.use_cases import publish_anki_reel as publication_module

    project_id, scene_id, cue_id, job_id = (uuid4() for _ in range(4))
    card_ids = [uuid4(), uuid4()]
    scene = Scene(scene_id, project_id, 1, 2000)
    project = Project(
        project_id, "Workplace English", "dialogue",
        {"youtube_url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"},
    )
    cue = Cue(
        cue_id, scene_id, 1, 100, 700, 100, 700,
        "Ana", "Hello.", "Hello.", "Olá.",
    )
    word = WordTiming(uuid4(), cue_id, 1, "Hello.", 100, 700, 100, 700)
    voice = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    original_english = cue.approved_en
    source = Mock()
    source.get_project.return_value = project
    source.get_project_scenes.return_value = [scene]
    source.get_scene_cues.return_value = [cue]
    source.get_cue.return_value = cue
    source.get_scene_project_id.return_value = project_id
    source.get_cue_words.return_value = [word]

    def card(card_id, front, back, focus):
        return {
            "card_id": str(card_id),
            "cue_id": str(cue_id),
            "scene_id": str(scene_id),
            "source_context_en": original_english,
            "source_context_pt": cue.approved_pt,
            "front_en": front,
            "back_pt": back,
            "uses_literal_scene_line": False,
            "card_type": "EXPRESSION",
            "focus_text": focus,
            "meaning": "Olá",
            "marked_en": focus,
            "marked_pt": "Olá",
            "explanation_pt": "Uma saudação em ambiente profissional.",
            "example_en": "Hello, everyone.",
            "example_pt": "Olá, pessoal.",
            "tags": ["work"],
        }

    cards = [
        card(
            card_ids[0], "Hello, welcome to the office.",
            "Olá, bem-vindo ao escritório.", "Hello",
        ),
        card(
            card_ids[1], "Hello, meet the partners.",
            "Olá, conheça os sócios.", "Hello.",
        ),
    ]
    # Two lessons can share one source cue while retaining distinct audio.
    current = {item["card_id"]: item for item in cards}
    monkeypatch.setattr(
        publication_module, "MaterialsAiExchange",
        lambda *_args: SimpleNamespace(
            find_anki_card=lambda _project, cid: current[str(cid)]
        ),
    )
    folder = tmp_path / "exports" / str(job_id)
    folder.mkdir(parents=True)
    apkg = folder / "anki.apkg"
    reel = folder / "anki-reel.mp4"
    apkg.write_bytes(b"real packaged audio")
    reel.write_bytes(b"real reel")

    def digest(path):
        return sha256(path.read_bytes()).hexdigest()

    intervals = [
        {
            "cue_order": index + 1,
            "start_ms": index * 1200,
            "end_ms": index * 1200 + 950,
            "audio_sha256": ("b" if index == 0 else "c") * 64,
            "text_sha256": utf8_sha256(item["front_en"]),
        }
        for index, item in enumerate(cards)
    ]
    manifest = {
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
        "apkg_sha256": digest(apkg),
        "reel_sha256": digest(reel),
        "cues": intervals,
    }
    (folder / "anki-audio-manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    job = Job(
        job_id, "export_materials", "succeeded",
        {
            "mode": "didactic",
            "project_id": str(project_id),
            "cue_ids": [str(cue_id), str(cue_id)],
            "anki_cards": cards,
            "text_hashes": {
                item["card_id"]: utf8_sha256(item["front_en"]) for item in cards
            },
            "pt_hashes": {
                item["card_id"]: utf8_sha256(item["back_pt"]) for item in cards
            },
            "audio_hashes": {
                card["card_id"]: interval["audio_sha256"]
                for card, interval in zip(cards, intervals, strict=True)
            },
            "editorial_sha256": editorial_publication_sha256(
                project, [scene], [(cue, [word])]
            ),
            "voice_snapshot": {"snapshot_sha256": voice.sha256},
        },
        None, 1, 3,
    )
    # The external AI prepared Notice independently from the Anki cards.
    # The expressions can coincide, but their explanations are independently authored.
    context_path = (
        tmp_path / "projects" / str(project_id) / "editorial-ai"
        / f"scene-{scene_id}-english-in-context.json"
    )
    context_path.parent.mkdir(parents=True, exist_ok=True)
    context_path.write_text(json.dumps({
        "scene_id": str(scene_id),
        "wbw_practices": [
            {
                "source_cue_id": str(cue_id),
                "word_ids": [str(word.id)],
                "type": "expression",
                "expression_en": "Hello.",
                "meaning_pt": "Saudação original da IA externa.",
                "explanation_pt": "Conteúdo independente do baralho Anki.",
                "example_en": "Hello, everyone.",
                "example_pt": "Olá, pessoal.",
            },
        ],
    }), encoding="utf-8")
    publisher = PublishAnkiReel(
        source, Mock(), tmp_path / "exports", tmp_path / "projects"
    )
    artifact = publisher.execute(
        project_id=project_id, job=job, youtube="bbbbbbbbbbb"
    )
    doc = json.loads(artifact.path.read_text(encoding="utf-8"))
    assert len(doc["cues"]) == 1
    assert doc["cues"][0]["final_en"] == "Hello."
    assert doc["cues"][0]["pt"] == "Olá."
    assert len(doc["cues"][0]["anki"]["items"]) == 2
    assert [item["focus"] for item in doc["cues"][0]["anki"]["items"]] == [
        card["front_en"] for card in cards
    ]
    assert len(doc["ankiAudio"]["cues"]) == 2
    # The same reviewed mini-lessons must also reach iHub stage 03 (Notice).
    assert len(doc["wbw_practices"]) == 1
    assert [practice["cue_order"] for practice in doc["wbw_practices"]] == [1]
    assert doc["wbw_practices"][0]["expression_en"] == "Hello."
    assert all(practice["word_indexes"] == [0] for practice in doc["wbw_practices"])
    assert all(practice["start_ms"] == 100 for practice in doc["wbw_practices"])
    assert all(practice["end_ms"] == 700 for practice in doc["wbw_practices"])
    assert doc["wbw_practices"][0]["meaning_pt"] == "Saudação original da IA externa."
    assert doc["wbw_practices"][0]["explanation_pt"] == (
        "Conteúdo independente do baralho Anki."
    )
    assert doc["wbw_practices"][0]["example_en"] == "Hello, everyone."
    assert doc["wbw_practices"][0]["example_pt"] == "Olá, pessoal."
    assert [interval["card_key"] for interval in doc["ankiAudio"]["cues"]] == [
        f"anki-{cid}" for cid in card_ids
    ]
    assert [interval["source_cue_order"] for interval in doc["ankiAudio"]["cues"]] == [1, 1]
    assert [
        (interval["start_ms"], interval["end_ms"])
        for interval in doc["ankiAudio"]["cues"]
    ] == [(0, 950), (1200, 2150)]
