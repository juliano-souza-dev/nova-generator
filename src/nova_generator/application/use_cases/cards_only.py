"""Standalone cards-only import: keep the current iHub/Anki didactic identity.

Accept the card portion of an external materials JSON, an Anki proposal,
a prepared source document, or a published hub_final. This adapter never
creates a project or silently rewrites the educational content.
"""
from __future__ import annotations

import json
from hashlib import sha256
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from pydantic import ValidationError

from nova_generator.application.use_cases.anki_proposal import DidacticAnkiCard


class CardsOnlyError(ValueError):
    pass


def normalize_cards(document: Any) -> tuple[str, list[dict[str, Any]]]:
    if not isinstance(document, dict):
        raise CardsOnlyError("O JSON de cards precisa ser um objeto.")
    raw_kit = document.get("kit")
    kit = raw_kit if isinstance(raw_kit, dict) else {}
    title = document.get("title") or kit.get("title") or "Cards IHUB"
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 255:
        raise CardsOnlyError("Título dos cards inválido.")
    raw = document.get("anki_cards")
    if raw is None and isinstance(document.get("source"), dict):
        raw = document["source"].get("anki_prepared")
    if raw is None:
        raw = document.get("cards")
    if raw is None and isinstance(document.get("cues"), list):
        raw = _from_hub_cues(document["cues"])
    if not isinstance(raw, list) or not 1 <= len(raw) <= 200:
        raise CardsOnlyError("Forneça de 1 a 200 cards em anki_cards, cards ou cues[].anki.items.")
    seen = set()
    cards = []
    for index, row in enumerate(raw, 1):
        if not isinstance(row, dict):
            raise CardsOnlyError(f"Card {index}: conteúdo inválido.")
        item = dict(row)
        if not item.get("card_id") and item.get("cue_id"):
            item["card_id"] = str(
                uuid5(NAMESPACE_URL, f"{item['cue_id']}:{item.get('focus_text', '')}")
            )
        if "source_context_en" not in item:
            item["source_context_en"] = item.get("front_en")
        if "source_context_pt" not in item:
            item["source_context_pt"] = item.get("back_pt")
        if "uses_literal_scene_line" not in item:
            item["uses_literal_scene_line"] = (
                item.get("front_en") == item.get("source_context_en")
                and item.get("back_pt") == item.get("source_context_pt")
            )
        if "tags" not in item:
            item["tags"] = []
        item.pop("scene_id", None)  # Kept in source materials; unrelated to card face.
        try:
            card = DidacticAnkiCard.model_validate_json(json.dumps(item, ensure_ascii=False))
        except (ValidationError, ValueError) as exc:
            raise CardsOnlyError(f"Card {index}: mini-aula incompatível: {exc}") from exc
        if card.card_id in seen:
            raise CardsOnlyError(f"Card repetido: {card.card_id}.")
        seen.add(card.card_id)
        if card.marked_en.casefold() not in card.front_en.casefold():
            raise CardsOnlyError(f"Card {index}: destaque inglês fora de front_en.")
        if card.marked_pt.casefold() not in card.back_pt.casefold():
            raise CardsOnlyError(f"Card {index}: destaque português fora de back_pt.")
        if card.focus_text.casefold() not in card.source_context_en.casefold():
            raise CardsOnlyError(f"Card {index}: foco não aparece no contexto de origem.")
        if card.uses_literal_scene_line != (
            card.front_en == card.source_context_en and card.back_pt == card.source_context_pt
        ):
            raise CardsOnlyError(f"Card {index}: uses_literal_scene_line inconsistente.")
        cards.append(card.model_dump(mode="json"))
    return title.strip(), cards


def _from_hub_cues(cues: list[Any]) -> list[dict[str, Any]]:
    rows = []
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        english = cue.get("final_en") or cue.get("approved_en") or cue.get("original_en")
        portuguese = cue.get("pt") or cue.get("approved_pt")
        if not isinstance(english, str) or not isinstance(portuguese, str):
            continue
        for item in cue.get("anki", {}).get("items", []):
            if not isinstance(item, dict):
                continue
            key = item.get("key", "")
            card_id = key[5:] if isinstance(key, str) and key.startswith("anki-") else ""
            cue_id = cue.get("cue_id") or cue.get("id") or str(
                uuid5(NAMESPACE_URL, f"ihub:cue:{cue.get('order')}:{english}:{portuguese}")
            )
            front = item.get("focus", "")
            back = item.get("meaning", "")
            rows.append({
                "card_id": card_id or str(uuid5(NAMESPACE_URL, f"ihub:{cue_id}:{front}")),
                "cue_id": cue_id,
                "source_context_en": english,
                "source_context_pt": portuguese,
                "front_en": front,
                "back_pt": back,
                "uses_literal_scene_line": front == english and back == portuguese,
                "card_type": item.get("type", ""),
                "focus_text": item.get("focus_text", ""),
                "meaning": item.get("highlight_pt", "") or item.get("meaning", ""),
                "marked_en": item.get("marked_en", ""),
                "marked_pt": item.get("marked_pt", ""),
                "explanation_pt": item.get("explanation", ""),
                "example_en": item.get("example_en", ""),
                "example_pt": item.get("example_pt", ""),
                "tags": item.get("tags", []),
            })
    return rows


def hub_item(card: dict[str, Any]) -> dict[str, Any]:
    """Use the exact item keys already emitted by PublishAnkiReel."""
    return {
        "key": f"anki-{card['card_id']}",
        "type": card["card_type"],
        "focus": card["front_en"],
        "meaning": card["back_pt"],
        "focus_text": card["focus_text"],
        "highlight_en": card["focus_text"],
        "highlight_pt": card["meaning"],
        "marked_en": card["marked_en"],
        "marked_pt": card["marked_pt"],
        "explanation": card["explanation_pt"],
        "example_en": card["example_en"],
        "example_pt": card["example_pt"],
        "tags": card["tags"],
    }


def card_fingerprint(cards: list[dict[str, Any]]) -> str:
    return sha256(json.dumps(cards, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
