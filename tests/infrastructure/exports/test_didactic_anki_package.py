"""The APKG and published iHub cards must share all pedagogical content."""

import html
import json
import re
import sqlite3
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock
from uuid import uuid4
from zipfile import ZipFile

import pytest

from nova_generator.application.use_cases.build_delivery_zip import (
    DeliveryAsset,
    DeliveryError,
    build_delivery_zip,
    verify_didactic_publication,
)
from nova_generator.application.use_cases.rebuild_anki_package import (
    AnkiPackageRebuildError,
    rebuild_didactic_apkg,
)
from nova_generator.domain.exports import ExportCue
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import Cue, Project, utf8_sha256
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfile
from nova_generator.infrastructure.exports.genanki_package_writer import (
    DIDACTIC_DECK_ID,
    DIDACTIC_MODEL_ID,
    DIDACTIC_MODEL_NAME,
    GenankiPackageWriter,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache


def _lesson(index: int) -> dict:
    return {
        "card_id": str(uuid4()),
        "cue_id": str(uuid4()),
        "scene_id": str(uuid4()),
        "source_context_en": "You'll also answer to him.",
        "source_context_pt": "Você também terá de prestar contas a ele.",
        "front_en": f"New associates answer to the partner {index}.",
        "back_pt": f"Novos associados prestam contas ao sócio {index}.",
        "uses_literal_scene_line": False,
        "card_type": "PHRASAL_VERB",
        "focus_text": "answer to",
        "meaning": "prestar contas a",
        "marked_en": "answer to",
        "marked_pt": "prestam contas",
        "explanation_pt": "Na cena, os associados respondem aos sócios.",
        "example_en": "We answer to the managing partner.",
        "example_pt": "Prestamos contas ao sócio administrador.",
        "tags": ["hierarchy", "law"],
    }


def test_didactic_apkg_has_same_face_back_and_mini_lesson_as_ihub(tmp_path):
    pytest.importorskip("genanki")
    lessons = [_lesson(1), _lesson(2)]
    cues = []
    for index, lesson in enumerate(lessons, 1):
        wav = tmp_path / f"{index}.wav"
        wav.write_bytes(b"wav-placeholder-for-package-test")
        cues.append(ExportCue(
            uuid4(), index, lesson["front_en"], lesson["back_pt"],
            wav, 900, sha256(lesson["front_en"].encode()).hexdigest(),
            lesson=lesson,
        ))
    apkg = GenankiPackageWriter().write(
        cues=cues, output=tmp_path / "anki.apkg", deck_name="Suits"
    )
    with ZipFile(apkg) as archive, TemporaryDirectory() as directory:
        dbname = next(
            item for item in archive.namelist() if item.startswith("collection.anki")
        )
        database = Path(directory) / "collection.db"
        database.write_bytes(archive.read(dbname))
        with sqlite3.connect(database) as connection:
            notes = connection.execute("SELECT flds FROM notes ORDER BY id").fetchall()
            model = json.loads(
                connection.execute("SELECT models FROM col").fetchone()[0]
            )
            decks = json.loads(
                connection.execute("SELECT decks FROM col").fetchone()[0]
            )
    assert str(DIDACTIC_DECK_ID) in decks
    assert len(notes) == 2
    fields = [note[0].split("\x1f") for note in notes]
    assert all(len(item) == 12 for item in fields)
    for lesson, field in zip(lessons, fields, strict=True):
        assert re.sub(r"<[^>]+>", "", field[0]) == lesson["front_en"]
        assert '<span class="ihub-highlight">answer to</span>' in field[0]
        assert re.sub(r"<[^>]+>", "", field[1]) == lesson["back_pt"]
        assert '<span class="ihub-highlight">prestam contas</span>' in field[1]
        assert field[3] == lesson["focus_text"]
        assert field[4] == lesson["meaning"]
        assert field[5] == lesson["explanation_pt"]
        assert field[6] == lesson["example_en"]
        assert field[7] == lesson["example_pt"]
        assert field[8] == lesson["card_type"]
        assert field[9] == ", ".join(lesson["tags"])
        assert html.unescape(field[10]) == lesson["source_context_en"]
        assert html.unescape(field[11]) == lesson["source_context_pt"]
    template = next(iter(model.values()))
    assert template["id"] == DIDACTIC_MODEL_ID
    assert template["name"] == DIDACTIC_MODEL_NAME
    assert "EN → PT" in template["tmpls"][0]["qfmt"]
    assert "{{Front}}" in template["tmpls"][0]["qfmt"]
    assert "{{Audio}}" in template["tmpls"][0]["qfmt"]
    assert "{{Back}}" in template["tmpls"][0]["afmt"]
    assert "MINI AULA" in template["tmpls"][0]["afmt"]
    assert "COMO ENTENDER / USAR" in template["tmpls"][0]["afmt"]
    assert "OUTRO EXEMPLO" in template["tmpls"][0]["afmt"]
    assert "{{Explanation}}" in template["tmpls"][0]["afmt"]
    assert "{{Focus}}" in template["tmpls"][0]["afmt"]
    assert "{{Meaning}}" in template["tmpls"][0]["afmt"]
    assert "{{ExamplePt}}" in template["tmpls"][0]["afmt"]
    assert ".ihub-pill" in template["css"]
    assert ".ihub-sentence.ihub-pt" in template["css"]
    assert "#ffcf65" in template["css"]
    assert ".ihub-highlight" in template["css"]


def test_delivery_zip_contains_every_frozen_asset_and_checksums(tmp_path):
    assets = []
    for name, data in [
        ("hub_final.json", b'{"version":3}'),
        ("anki/anki.apkg", b"apkg"),
        ("anki/anki-reel.mp4", b"reel"),
        ("anki/anki-audio-manifest.json", b"manifest"),
        ("audio/wav/a.wav", b"wav"),
        ("shadowing/scene.json", b"shadowing"),
    ]:
        file = tmp_path / name.replace("/", "_")
        file.write_bytes(data)
        assets.append(DeliveryAsset(name, file, sha256(data).hexdigest()))
    card = _lesson(1)
    archive = build_delivery_zip(
        tmp_path / "kit.zip",
        project_id=str(uuid4()),
        job_id=str(uuid4()),
        assets=assets,
        didactic_cards=[card],
    )
    with ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        names = zipped.namelist()
        assert "LEIA-ME.txt" in names
        assert "manifesto-entrega.json" in names
        assert "anki/anki-cards.json" in names
        assert set(asset.name for asset in assets) <= set(names)
        manifesto = json.loads(zipped.read("manifesto-entrega.json"))
        assert len(manifesto["files"]) == len(assets) + 1
        for item in manifesto["files"]:
            assert sha256(zipped.read(item["file"])).hexdigest() == item["sha256"]
        assert json.loads(zipped.read("anki/anki-cards.json"))["cards"] == [card]
    bad = list(assets)
    bad[-1] = DeliveryAsset(
        "shadowing/scene.json", bad[-1].source, "0" * 64
    )
    with pytest.raises(DeliveryError, match="alterado"):
        build_delivery_zip(tmp_path / "tampered.zip", project_id="p", job_id="j", assets=bad)


def test_bundle_rejects_wrong_ihub_card_content_before_delivery():
    card = _lesson(1)
    published = {
        "cues": [{
            "anki": {"items": [{
                "key": f"anki-{card['card_id']}",
                "focus": card["front_en"],
                "meaning": card["back_pt"],
                "focus_text": card["focus_text"],
                "explanation": card["explanation_pt"],
                "example_en": card["example_en"],
                "example_pt": card["example_pt"],
                "marked_en": card["marked_en"],
                "marked_pt": card["marked_pt"],
                "tags": card["tags"],
            }]},
        }],
        "ankiAudio": {"cues": [{"card_key": f"anki-{card['card_id']}"}]},
    }
    verify_didactic_publication([card], published)
    published["cues"][0]["anki"]["items"][0]["explanation"] = "Outra mini-aula."
    with pytest.raises(DeliveryError, match="explanation"):
        verify_didactic_publication([card], published)


def _rebuild_setup(tmp_path, monkeypatch):
    import nova_generator.application.use_cases.rebuild_anki_package as rebuild_module

    project_id, job_id, scene_id = uuid4(), uuid4(), uuid4()
    card = _lesson(1)
    card["scene_id"] = str(scene_id)
    cue_id = uuid4()
    card["cue_id"] = str(cue_id)
    original = Cue(
        cue_id, scene_id, 1, 100, 950, 100, 950,
        "Teacher", card["source_context_en"], card["source_context_en"],
        card["source_context_pt"], provenance={"approval": "approved"},
    )
    project = Project(project_id, "Legal English", "dialogue")
    repository = Mock()
    repository.get_cue.return_value = original
    repository.get_scene_project_id.return_value = project_id
    repository.get_project.return_value = project
    monkeypatch.setattr(
        rebuild_module,
        "MaterialsAiExchange",
        lambda *_args: type(
            "Exchange", (), {"find_anki_card": lambda self, pid, cid: dict(card)}
        )(),
    )
    voice = VoiceProfile(uuid4(), "Trainer", 1, "sample-model", "d" * 64).snapshot()
    cache = FileSpeechCache(tmp_path / "cache")
    key = cache.cache_key(text=card["front_en"], profile=voice, parameters={})
    staging = cache.staging_path(key)
    original_wav = b"RIFF" + b"example data" * 10
    staging.write_bytes(original_wav)
    speech = cache.save(
        key,
        SynthesizedSpeech(
            str(staging), utf8_sha256(card["front_en"]),
            voice, {}, 1000, 16000, 1,
        ),
    )
    sound_sha = sha256(original_wav).hexdigest()
    frozen_voice = {
        "profile_id": str(voice.profile_id),
        "name": voice.name,
        "version": voice.version,
        "model_id": voice.model_id,
        "model_sha256": voice.model_sha256,
        "reference_audio_sha256": None,
        "parameters": voice.parameters,
        "snapshot_sha256": voice.sha256,
    }
    job = Job(
        job_id, "export_materials", "succeeded",
        {
            "project_id": str(project_id),
            "mode": "didactic",
            "anki_cards": [card],
            "text_hashes": {card["card_id"]: utf8_sha256(card["front_en"])},
            "pt_hashes": {card["card_id"]: utf8_sha256(card["back_pt"])},
            "audio_hashes": {card["card_id"]: sound_sha},
            "voice_snapshot": frozen_voice,
        },
        None, 1, 3,
    )
    root = tmp_path / "exports"
    folder = root / str(job_id)
    folder.mkdir(parents=True)
    old_apkg = folder / "anki.apkg"
    old_reel = folder / "anki-reel.mp4"
    old_apkg.write_bytes(b"previous-anki-package")
    old_reel.write_bytes(b"previous-video-reel")
    manifest = folder / "anki-audio-manifest.json"
    manifest.write_text(json.dumps({
        "schema": "nova-generator-anki-audio",
        "schema_version": "1.0",
        "card_layout": "ihub-didactic-v2",
        "voice": frozen_voice,
        "apkg_sha256": sha256(old_apkg.read_bytes()).hexdigest(),
        "reel_sha256": sha256(old_reel.read_bytes()).hexdigest(),
        "cues": [{
            "cue_order": 1,
            "start_ms": 0,
            "end_ms": 1000,
            "audio_sha256": sound_sha,
            "text_sha256": utf8_sha256(card["front_en"]),
        }],
    }), encoding="utf-8")
    options = {
        "project_id": project_id,
        "job": job,
        "repository": repository,
        "export_root": root,
        "project_root": tmp_path / "projects",
        "media_cache_root": tmp_path / "cache",
    }
    return options, card, speech, folder


def test_rebuild_existing_anki_v2_package_to_v3_without_new_media(tmp_path, monkeypatch):
    pytest.importorskip("genanki")
    options, card, speech, folder = _rebuild_setup(tmp_path, monkeypatch)
    reel_path = folder / "anki-reel.mp4"
    initial_reel = reel_path.read_bytes()
    initial_sound = Path(speech.audio_path).read_bytes()
    republished = []
    layout = rebuild_didactic_apkg(
        **options, republish=lambda: republished.append(True)
    )
    assert layout == "ihub-didactic-v3"
    assert republished == [True]
    assert reel_path.read_bytes() == initial_reel
    assert Path(speech.audio_path).read_bytes() == initial_sound
    manifest = json.loads((folder / "anki-audio-manifest.json").read_text())
    assert manifest["card_layout"] == "ihub-didactic-v3"
    assert manifest["reel_sha256"] == sha256(initial_reel).hexdigest()
    assert manifest["apkg_sha256"] == sha256((folder / "anki.apkg").read_bytes()).hexdigest()
    with ZipFile(folder / "anki.apkg") as archive, TemporaryDirectory() as temp:
        dbname = next(name for name in archive.namelist() if name.startswith("collection.anki"))
        dbfile = Path(temp) / "anki.db"
        dbfile.write_bytes(archive.read(dbname))
        with sqlite3.connect(dbfile) as connection:
            model = json.loads(connection.execute("SELECT models FROM col").fetchone()[0])
            fields = connection.execute("SELECT flds FROM notes").fetchone()[0].split("\x1f")
    assert next(iter(model.values()))["id"] == DIDACTIC_MODEL_ID
    assert fields[3] == card["focus_text"]
    assert fields[5] == card["explanation_pt"]


def test_rebuild_rolls_back_files_when_republication_fails(tmp_path, monkeypatch):
    pytest.importorskip("genanki")
    options, _card, _speech, folder = _rebuild_setup(tmp_path, monkeypatch)
    before = {
        filename: (folder / filename).read_bytes()
        for filename in ("anki.apkg", "anki-reel.mp4", "anki-audio-manifest.json")
    }

    def reject():
        raise RuntimeError("Publication cannot be rewritten")

    with pytest.raises(RuntimeError, match="Publication cannot"):
        rebuild_didactic_apkg(**options, republish=reject)
    for name, payload in before.items():
        assert (folder / name).read_bytes() == payload


def test_rebuild_refuses_stale_edited_lesson(tmp_path, monkeypatch):
    options, card, _speech, folder = _rebuild_setup(tmp_path, monkeypatch)
    edited = dict(card, front_en="This card changed after export.")
    import nova_generator.application.use_cases.rebuild_anki_package as rebuild_module

    monkeypatch.setattr(
        rebuild_module, "MaterialsAiExchange",
        lambda *_args: type(
            "Exchange", (), {"find_anki_card": lambda self, pid, cid: edited}
        )(),
    )
    initial = (folder / "anki.apkg").read_bytes()
    with pytest.raises(AnkiPackageRebuildError, match="Faça uma nova exportação"):
        rebuild_didactic_apkg(**options)
    assert (folder / "anki.apkg").read_bytes() == initial
