"""Cards-only imports remain independent of Editorial and full material kits."""
from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from zipfile import ZipFile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nova_generator.api.routes import cards_only
from nova_generator.application.use_cases.cards_only import CardsOnlyError, normalize_cards
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.worker import cards_only_handler


def _card() -> dict:
    return {
        "card_id": str(uuid4()),
        "cue_id": str(uuid4()),
        "source_context_en": "Could you help me?",
        "source_context_pt": "Você poderia me ajudar?",
        "front_en": "Could you help me with this task?",
        "back_pt": "Você poderia me ajudar com esta tarefa?",
        "uses_literal_scene_line": False,
        "card_type": "STRUCTURE",
        "focus_text": "Could you",
        "meaning": "Você poderia",
        "marked_en": "Could you",
        "marked_pt": "Você poderia",
        "explanation_pt": "Forma educada de fazer pedidos.",
        "example_en": "Could you send it today?",
        "example_pt": "Você poderia enviar isso hoje?",
        "tags": ["politeness"],
    }


def test_imports_only_anki_cards_from_full_material_output():
    card = _card()
    title, cards = normalize_cards({
        "contract": "nova-generator-materials-output/1.0",
        "title": "English",
        "sections": [{"id": "unrelated", "paragraphs": ["not exported"]}],
        "anki_cards": [card],
    })
    assert title == "English"
    assert cards[0]["front_en"] == card["front_en"]
    assert "sections" not in cards[0]


def test_rejects_fake_highlight_or_duplicate_identity():
    card = _card()
    with pytest.raises(CardsOnlyError, match="destaque inglês"):
        normalize_cards({"cards": [{**card, "marked_en": "invented"}]})
    with pytest.raises(CardsOnlyError, match="repetido"):
        normalize_cards({"cards": [card, card]})
    with pytest.raises(CardsOnlyError):
        normalize_cards({"cards": []})


def test_frozen_validation_api_and_youtube_job(monkeypatch, tmp_path: Path):
    app = FastAPI()
    app.include_router(cards_only.router)
    data = json.dumps({"title": "Mini aulas", "cards": [_card()]}, ensure_ascii=False).encode()
    client = TestClient(app)
    response = client.post(
        "/cards-only/validate", files={"file": ("cards.json", data, "application/json")}
    )
    assert response.status_code == 200, response.text
    assert response.json()["count"] == 1
    captured = []
    monkeypatch.setattr(
        cards_only, "get_manage_voice_profiles",
        lambda: SimpleNamespace(get=lambda _: SimpleNamespace(snapshot=lambda: object())),
    )
    monkeypatch.setattr(cards_only, "_payload", lambda _: {"snapshot_sha256": "trusted"})
    monkeypatch.setattr(
        cards_only, "get_settings",
        lambda: SimpleNamespace(media_cache_root=tmp_path),
    )
    monkeypatch.setattr(
        cards_only, "get_enqueue_job",
        lambda: SimpleNamespace(execute=lambda **kw: (
            captured.append(kw) or SimpleNamespace(id=uuid4(), status="queued")
        )),
    )
    enqueue = client.post(
        "/cards-only/exports",
        files={"file": ("cards.json", data, "application/json")},
        data={"voice_id": str(uuid4()), "youtube_url": "https://youtu.be/dQw4w9WgXcQ"},
    )
    assert enqueue.status_code == 202, enqueue.text
    assert captured[0]["kind"] == "cards-only.export"
    folder = tmp_path / "cards-only" / enqueue.json()["export_id"]
    assert sha256((folder / "input.json").read_bytes()).hexdigest() == (
        captured[0]["input"]["input_sha256"]
    )
    assert client.get(
        f"/cards-only/exports/{enqueue.json()['export_id']}/bundle"
    ).status_code == 404


def test_packaging_has_only_anki_cards_json_and_per_card_audio(tmp_path: Path, monkeypatch):
    card = _card()
    export_id = uuid4()
    folder = tmp_path / "cards-only" / str(export_id)
    folder.mkdir(parents=True)
    payload = json.dumps({"title": "New Cards", "cards": [card]}, sort_keys=True).encode()
    (folder / "input.json").write_bytes(payload)
    wav = tmp_path / "original.wav"
    wav.write_bytes(b"speech fixture")
    monkeypatch.setattr(
        cards_only_handler, "get_settings",
        lambda: SimpleNamespace(media_cache_root=tmp_path),
    )
    monkeypatch.setattr(cards_only_handler, "_voice_snapshot", lambda _: object())

    def fake_writer(self, *, cues, output, deck_name):
        assert len(cues) == 1
        assert cues[0].lesson["card_id"] == card["card_id"]
        assert cues[0].approved_en == card["front_en"]
        assert deck_name == "New Cards"
        output.write_bytes(b"anki fixture")
        return output

    monkeypatch.setattr(cards_only_handler.GenankiPackageWriter, "write", fake_writer)
    speech = SimpleNamespace(
        execute=lambda **kw: (
            SimpleNamespace(audio_path=str(wav), duration_ms=1000)
        )
    )
    job = Job(
        id=uuid4(), kind="cards-only.export", status="running",
        input={
            "export_id": str(export_id),
            "input_sha256": sha256(payload).hexdigest(),
            "voice_snapshot": {},
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
            "audio_extension": None,
            "audio_sha256": None,
        },
        idempotency_key=None, attempt=1, max_attempts=2,
    )
    execution = SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None)
    result = cards_only_handler.make_cards_only_handler(speech)(job, execution)
    assert result["card_count"] == 1
    with ZipFile(folder / "cards-only.zip") as archive:
        files = archive.namelist()
        assert "anki.apkg" in files
        assert "cards.json" in files
        assert f"audio/anki_{card['card_id']}.wav" in files
        assert "hub_final.json" not in files
        assert not any("shadowing" in name or "workbook" in name for name in files)
        exported = json.loads(archive.read("cards.json"))
        assert exported["source"]["type"] == "youtube"
        assert exported["cues"][0]["anki"]["items"][0]["key"] == (
            f"anki-{card['card_id']}"
        )
    assert (folder / "manifest.json").is_file()


def test_source_json_supports_ai_card_generation_without_editorial_projects():
    cue_id = uuid4()
    document = {
        "contract": "nova-generator-materials-input/1.0",
        "source": {
            "title": "English scene",
            "scenes": [{
                "scene_id": str(uuid4()),
                "cues": [{
                    "id": str(cue_id),
                    "approved_en": "Could you help me?",
                    "approved_pt": "Você poderia me ajudar?",
                }],
            }],
        },
    }
    title, cues = cards_only._source_cues(document)
    assert title == "English scene"
    assert cues == [{
        "cue_id": str(cue_id),
        "source_context_en": "Could you help me?",
        "source_context_pt": "Você poderia me ajudar?",
    }]
