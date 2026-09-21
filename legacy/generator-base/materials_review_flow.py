from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any

PDF_KEYS: tuple[str, ...] = ()
PDF_LABELS: dict[str, str] = {}
DECISIONS = {"pending", "approved", "rejected"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_review(draft: dict[str, Any]) -> dict[str, Any]:
    pdf_content = draft.get("pdf_content") if isinstance(draft.get("pdf_content"), dict) else {}
    content_type = str(draft.get("content_type") or "dialogue")
    pdfs: dict[str, Any] = {}
    for key in PDF_KEYS:
        content = copy.deepcopy(pdf_content.get(key) if isinstance(pdf_content.get(key), dict) else {})
        pdfs[key] = {
            "label": PDF_LABELS[key],
            "decision": "pending",
            "content": content,
        }

    anki_items: list[dict[str, Any]] = []
    for index, raw in enumerate(((draft.get("anki") or {}).get("items") or []), start=1):
        if not isinstance(raw, dict):
            continue
        item = copy.deepcopy(raw)
        item["review_id"] = str(item.get("key") or f"anki-{index}")
        item["decision"] = "pending"
        anki_items.append(item)

    return {
        "schema": "immersionhub-materials-review",
        "schema_version": "1.3",
        "source_snapshot_id": str(draft.get("source_snapshot_id") or ""),
        "source_canonical_sha256": str(draft.get("source_canonical_sha256") or ""),
        "source_connected_speech_review_sha256": str(draft.get("source_connected_speech_review_sha256") or ""),
        "status": "editing",
        "content_type": content_type,
        "pdfs": pdfs,
        "anki": {"items": anki_items},
        "created_at_utc": now_iso(),
        "updated_at_utc": now_iso(),
    }


def normalize_review(draft: dict[str, Any], incoming: Any) -> dict[str, Any]:
    base = build_review(draft)
    if not isinstance(incoming, dict):
        return base
    for key in ("source_snapshot_id", "source_canonical_sha256", "source_connected_speech_review_sha256"):
        expected = str(base.get(key) or "")
        got = str(incoming.get(key) or expected)
        if expected and got != expected:
            raise ValueError("A revisão de materiais pertence a outra versão das fontes.")

    source_pdfs = incoming.get("pdfs") if isinstance(incoming.get("pdfs"), dict) else {}
    for key in PDF_KEYS:
        row = source_pdfs.get(key) if isinstance(source_pdfs.get(key), dict) else {}
        decision = str(row.get("decision") or "pending").lower()
        if decision not in DECISIONS:
            decision = "pending"
        content = row.get("content")
        if not isinstance(content, dict):
            content = copy.deepcopy(base["pdfs"][key]["content"])
        base["pdfs"][key] = {
            "label": PDF_LABELS[key],
            "decision": decision,
            "content": copy.deepcopy(content),
        }

    valid_cues = {
        int(item.get("cue_order") or 0)
        for item in ((draft.get("anki") or {}).get("items") or [])
        if isinstance(item, dict) and int(item.get("cue_order") or 0) > 0
    }
    raw_items = ((incoming.get("anki") or {}).get("items") or []) if isinstance(incoming.get("anki"), dict) else []
    fallback = base["anki"]["items"]
    source_items = raw_items if isinstance(raw_items, list) and raw_items else fallback
    cleaned: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(source_items, start=1):
        if not isinstance(raw, dict):
            continue
        try:
            cue_order = int(raw.get("cue_order") or 0)
        except (TypeError, ValueError):
            continue
        if cue_order not in valid_cues:
            continue
        item = copy.deepcopy(raw)
        review_id = str(item.get("review_id") or item.get("key") or f"anki-{index}")
        if review_id in seen_ids:
            review_id = f"{review_id}-{index}"
        seen_ids.add(review_id)
        item["review_id"] = review_id
        decision = str(item.get("decision") or "pending").lower()
        item["decision"] = decision if decision in DECISIONS else "pending"
        tags = item.get("tags")
        if isinstance(tags, str):
            item["tags"] = [part.strip() for part in tags.split(",") if part.strip()]
        elif not isinstance(tags, list):
            item["tags"] = []
        cleaned.append(item)
    base["anki"] = {"items": cleaned}
    base["status"] = "approved" if str(incoming.get("status") or "editing") == "approved" else "editing"
    base["created_at_utc"] = str(incoming.get("created_at_utc") or base["created_at_utc"])
    base["updated_at_utc"] = now_iso()
    return base


def review_summary(review: dict[str, Any]) -> dict[str, int]:
    pdfs = review.get("pdfs") if isinstance(review.get("pdfs"), dict) else {}
    pdf_values = [str((pdfs.get(key) or {}).get("decision") or "pending") for key in PDF_KEYS]
    cards = ((review.get("anki") or {}).get("items") or []) if isinstance(review.get("anki"), dict) else []
    card_values = [str(item.get("decision") or "pending") for item in cards if isinstance(item, dict)]
    return {
        "pdf_total": len(pdf_values),
        "pdf_pending": sum(v == "pending" for v in pdf_values),
        "pdf_approved": sum(v == "approved" for v in pdf_values),
        "pdf_rejected": sum(v == "rejected" for v in pdf_values),
        "anki_total": len(card_values),
        "anki_pending": sum(v == "pending" for v in card_values),
        "anki_approved": sum(v == "approved" for v in card_values),
        "anki_rejected": sum(v == "rejected" for v in card_values),
    }


def validate_finalize(review: dict[str, Any]) -> list[str]:
    summary = review_summary(review)
    errors: list[str] = []
    if summary["anki_pending"]:
        errors.append(f"Ainda existem {summary['anki_pending']} card(s) Anki sem decisão.")
    if summary["anki_approved"] <= 0:
        errors.append("Aprove pelo menos um card Anki antes de finalizar.")
    return errors


def approved_payload(review: dict[str, Any]) -> dict[str, Any]:
    pdfs = review.get("pdfs") if isinstance(review.get("pdfs"), dict) else {}
    approved_pdfs = {
        key: copy.deepcopy((pdfs.get(key) or {}).get("content") or {})
        for key in PDF_KEYS
        if str((pdfs.get(key) or {}).get("decision") or "") == "approved"
    }
    cards = ((review.get("anki") or {}).get("items") or []) if isinstance(review.get("anki"), dict) else []
    approved_cards: list[dict[str, Any]] = []
    for raw in cards:
        if not isinstance(raw, dict) or str(raw.get("decision") or "") != "approved":
            continue
        item = {key: copy.deepcopy(value) for key, value in raw.items() if key not in {"decision", "review_id"}}
        approved_cards.append(item)
    return {
        "pdf_content": approved_pdfs,
        "anki": {"items": approved_cards},
    }
