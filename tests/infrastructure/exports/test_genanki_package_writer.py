"""Regression tests for the Anki model shown in the contextual lesson reference."""

from __future__ import annotations

import json
import sqlite3
import wave
import zipfile
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import pytest

from nova_generator.domain.exports import ExportCue
from nova_generator.infrastructure.exports.genanki_package_writer import (
    GenankiPackageWriter,
    _highlight_literal,
)


def _cue(tmp_path: Path) -> ExportCue:
    audio = tmp_path / "approved.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\x00\x00" * 1200)
    english = "The one that got you in."
    return ExportCue(
        uuid4(),
        1,
        english,
        "Aquela que te fez entrar.",
        audio,
        50,
        sha256(english.encode()).hexdigest(),
    )


def _read_package(apkg: Path, tmp_path: Path) -> tuple[list[str], dict, dict]:
    with zipfile.ZipFile(apkg) as archive:
        sqlite_file = "collection.anki2"
        assert sqlite_file in archive.namelist()
        db = tmp_path / "collection.sqlite"
        db.write_bytes(archive.read(sqlite_file))
        media = json.loads(archive.read("media"))
    with sqlite3.connect(db) as conn:
        stored_fields = conn.execute("SELECT flds FROM notes").fetchone()[0]
        models = json.loads(conn.execute("SELECT models FROM col").fetchone()[0])
    model = models["1607392321"]
    return stored_fields.split("\x1f"), model, media


def test_rich_apkg_has_all_fields_highlights_minilesson_and_canonical_audio(
    tmp_path: Path,
) -> None:
    cue = _cue(tmp_path)
    rich = {
        "front_en": cue.approved_en,
        "back_pt": cue.approved_pt,
        "card_type": "STRUCTURE",
        "focus_text": "get someone in",
        "meaning": "fazer alguém entrar / conseguir a entrada de alguém",
        "marked_en": "got you in",
        "marked_pt": "te fez entrar",
        "explanation_pt": "Aqui, get someone in significa conseguir a entrada.",
        "example_en": "She got me in.",
        "example_pt": "Ela me fez entrar.",
    }
    output = tmp_path / "rich.apkg"
    GenankiPackageWriter().write(
        cues=[cue],
        output=output,
        deck_name="Aulas",
        rich_cards={str(cue.cue_id): rich},
    )
    fields, model, media = _read_package(output, tmp_path)
    assert len(fields) == len(model["flds"]) == 11
    assert fields[0] == cue.approved_en
    assert fields[1] == cue.approved_pt
    assert fields[2] == "[sound:cue_0001.wav]"
    assert fields[3].count('class="ih-mark"') == 1
    assert '<span class="ih-mark">got you in</span>' in fields[3]
    assert '<span class="ih-mark">te fez entrar</span>' in fields[4]
    assert fields[5] == "STRUCTURE"
    assert fields[6] == "get someone in"
    assert "conseguir a entrada" in fields[7]
    assert "Aqui, get someone in" in fields[8]
    assert fields[9] == "She got me in."
    assert "MINI AULA" in model["tmpls"][0]["afmt"]
    assert "COMO ENTENDER / USAR" in model["tmpls"][0]["afmt"]
    assert "{{PortugueseStyled}}" in model["tmpls"][0]["afmt"]
    assert "{{EnglishStyled}}" in model["tmpls"][0]["qfmt"]
    assert "{{#Explanation}}" in model["tmpls"][0]["afmt"]
    assert "ih-panel" in model["css"]
    assert list(media.values()) == ["cue_0001.wav"]


def test_plain_apkg_still_has_readable_layout_without_fake_lesson(
    tmp_path: Path,
) -> None:
    cue = _cue(tmp_path)
    output = tmp_path / "plain.apkg"
    GenankiPackageWriter().write(cues=[cue], output=output, deck_name="Aulas")
    fields, model, media = _read_package(output, tmp_path)
    assert len(fields) == 11
    assert fields[3] == cue.approved_en
    assert fields[4] == cue.approved_pt
    assert fields[6] == fields[7] == fields[8] == fields[9] == fields[10] == ""
    assert "{{#Explanation}}" in model["tmpls"][0]["afmt"]
    assert list(media.values()) == ["cue_0001.wav"]


def test_silent_apkg_omits_audio_but_keeps_same_contextual_model(tmp_path: Path) -> None:
    cue = _cue(tmp_path)
    output = tmp_path / "silent.apkg"
    GenankiPackageWriter().write(
        cues=[cue], output=output, deck_name="Aulas", include_audio=False
    )
    fields, model, media = _read_package(output, tmp_path)
    assert len(fields) == len(model["flds"]) == 11
    assert fields[2] == ""
    assert media == {}


def test_approved_text_cannot_be_replaced_by_pedagogical_payload(tmp_path: Path) -> None:
    cue = _cue(tmp_path)
    with pytest.raises(ValueError, match="approved editorial text"):
        GenankiPackageWriter().write(
            cues=[cue],
            output=tmp_path / "reject.apkg",
            deck_name="Aulas",
            rich_cards={str(cue.cue_id): {
                "front_en": "Changed by AI",
                "back_pt": cue.approved_pt,
            }},
        )


def test_incomplete_rich_card_is_never_silently_reduced_to_plain(tmp_path: Path) -> None:
    cue = _cue(tmp_path)
    with pytest.raises(ValueError, match="missing approved mini lesson"):
        GenankiPackageWriter().write(
            cues=[cue],
            output=tmp_path / "reject.apkg",
            deck_name="Aulas",
            rich_cards={},
        )


def test_highlight_escapes_user_text_and_uses_literal_match() -> None:
    assert _highlight_literal("<script>X</script>", "X") == (
        '&lt;script&gt;<span class="ih-mark">X</span>&lt;/script&gt;'
    )
    assert _highlight_literal("Hello.", "no match") == "Hello."
