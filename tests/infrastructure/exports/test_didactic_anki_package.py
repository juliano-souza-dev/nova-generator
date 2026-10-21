"""The APKG and published iHub cards must share all pedagogical content."""

import json
import re
import sqlite3
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
from zipfile import ZipFile

import pytest

from nova_generator.application.use_cases.build_delivery_zip import (
    DeliveryAsset,
    DeliveryError,
    build_delivery_zip,
    verify_didactic_publication,
)
from nova_generator.domain.exports import ExportCue
from nova_generator.infrastructure.exports.genanki_package_writer import (
    GenankiPackageWriter,
)


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
        assert field[10] == lesson["source_context_en"]
        assert field[11] == lesson["source_context_pt"]
    template = next(iter(model.values()))
    assert "MINI LESSON" in template["tmpls"][0]["afmt"]
    assert "HOW TO UNDERSTAND / USE" in template["tmpls"][0]["afmt"]
    assert "ANOTHER EXAMPLE" in template["tmpls"][0]["afmt"]


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
