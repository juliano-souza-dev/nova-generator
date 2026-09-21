from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ai_provider import groq_json_completion, load_ai_settings

Progress = Callable[[int, str], None]

# Same provider strategy used by the old Generator: stay below common 8k TPM
# ceilings, persist fragments, and never resend already completed chunks.
SAFE_TPM_BUDGET = max(2500, int(os.getenv("GROQ_SAFE_TPM_BUDGET", "6500")))
CUE_OUTPUT_TOKENS = max(700, int(os.getenv("GROQ_MATERIAL_CUE_OUTPUT_TOKENS", "1800")))
GLOBAL_OUTPUT_TOKENS = max(900, int(os.getenv("GROQ_MATERIAL_GLOBAL_OUTPUT_TOKENS", "2400")))
CS_OUTPUT_TOKENS = max(500, int(os.getenv("GROQ_MATERIAL_CS_OUTPUT_TOKENS", "1200")))
CUE_INPUT_TARGET_TOKENS = max(650, int(os.getenv("GROQ_MATERIAL_CUE_INPUT_TARGET_TOKENS", "1900")))
RATE_WINDOW_SECONDS = 60.0
MAX_BLOCK_RETRIES = max(2, int(os.getenv("GROQ_MATERIAL_BLOCK_RETRIES", "3")))


class MaterialsGroqError(RuntimeError):
    pass


@dataclass
class _RateEvent:
    at: float
    estimated_tokens: int


class _TokenWindow:
    def __init__(self, manifest: dict[str, Any], save_manifest: Callable[[], None], progress: Progress | None) -> None:
        self.manifest = manifest
        self.save_manifest = save_manifest
        self.progress = progress
        now = time.time()
        self.events: list[_RateEvent] = []
        for row in manifest.get("rate_events") or []:
            if not isinstance(row, dict):
                continue
            try:
                at = float(row.get("at"))
                tokens = int(row.get("estimated_tokens"))
            except (TypeError, ValueError):
                continue
            if now - at < RATE_WINDOW_SECONDS:
                self.events.append(_RateEvent(at=at, estimated_tokens=max(0, tokens)))
        self._persist()

    def _persist(self) -> None:
        self.manifest["rate_events"] = [
            {"at": event.at, "estimated_tokens": event.estimated_tokens}
            for event in self.events
        ]
        self.save_manifest()

    def _prune(self) -> None:
        cutoff = time.time() - RATE_WINDOW_SECONDS
        self.events = [event for event in self.events if event.at > cutoff]

    def wait(self, estimated_tokens: int, *, label: str, percent: int) -> None:
        estimated_tokens = max(1, int(estimated_tokens))
        if estimated_tokens > SAFE_TPM_BUDGET:
            raise MaterialsGroqError(
                f"Bloco interno '{label}' excede o orçamento seguro da Groq "
                f"({estimated_tokens} > {SAFE_TPM_BUDGET} tokens estimados)."
            )
        while True:
            self._prune()
            used = sum(event.estimated_tokens for event in self.events)
            if used + estimated_tokens <= SAFE_TPM_BUDGET:
                break
            oldest = min(event.at for event in self.events)
            remaining = max(1.0, RATE_WINDOW_SECONDS - (time.time() - oldest) + 0.6)
            if self.progress:
                self.progress(percent, f"Limite Groq protegido. {label}: continuando em ~{int(math.ceil(remaining))}s…")
            time.sleep(max(0.5, min(5.0, remaining)))
        self.events.append(_RateEvent(at=time.time(), estimated_tokens=estimated_tokens))
        self._persist()


def _progress(callback: Progress | None, percent: int, message: str) -> None:
    if callback:
        callback(max(0, min(99, int(percent))), str(message or "").strip())


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _estimate_tokens(text: str) -> int:
    return max(1, int(math.ceil(len(str(text or "")) / 3.45)) + 48)


def _request_estimate(system: str, user: str, max_completion_tokens: int) -> int:
    return _estimate_tokens(system) + _estimate_tokens(user) + max(64, int(max_completion_tokens))


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _sha256_json(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _cue_compact(cue: dict[str, Any], *, words: bool = False) -> dict[str, Any]:
    row: dict[str, Any] = {
        "order": int(cue.get("order") or 0),
        "speaker": str(cue.get("speaker") or ""),
        "en": str(cue.get("approved_en") or cue.get("original_en") or "").strip(),
        "pt": str(cue.get("pt") or "").strip(),
    }
    if words:
        row["words"] = [
            {"text": str(word.get("text") or ""), "pt": str(word.get("pt") or "")}
            for word in cue.get("words") or [] if isinstance(word, dict)
        ]
    return row


def _build_cue_blocks(cues: list[dict[str, Any]]) -> list[list[int]]:
    blocks: list[list[int]] = []
    current: list[int] = []
    current_tokens = 0
    for index, cue in enumerate(cues):
        cost = _estimate_tokens(_json_text(_cue_compact(cue, words=True)))
        if current and current_tokens + cost > CUE_INPUT_TARGET_TOKENS:
            blocks.append(current)
            current = []
            current_tokens = 0
        current.append(index)
        current_tokens += cost
    if current:
        blocks.append(current)
    return blocks


def _call_json(*, system: str, user: str, max_completion_tokens: int, limiter: _TokenWindow, label: str, percent: int) -> dict[str, Any]:
    limiter.wait(_request_estimate(system, user, max_completion_tokens), label=label, percent=percent)
    return groq_json_completion(system=system, user=user, max_completion_tokens=max_completion_tokens)


_CARDS_SYSTEM = """Você é o agente pedagógico do ImmersionHub. Gere SOMENTE JSON válido no formato {\"cards\":[...]}.\nTrabalhe apenas nas PRIMARY_CUES. CONTEXT_ONLY é contexto e nunca cria card por si só.\nObjetivo: selecionar chunks, estruturas, collocations e expressões reutilizáveis para Anki.\nRegras obrigatórias:\n- 0 a 2 cards por cue, somente quando houver material forte. Não preencha quantidade por obrigação.\n- cue_order deve ser uma PRIMARY_ORDER existente.\n- score inteiro 0..100.\n- campos obrigatórios: cue_order,score,key,type,focus,meaning,highlight_en,marked,markedPT,highlight_pt,explanation,example_en,example_pt,tags.\n- marked deve existir literalmente em highlight_en; markedPT deve existir literalmente em highlight_pt.\n- highlight_en deve ser sustentado pela cue. Não invente falas nem altere timing/texto canônico.\n- explanation, meaning e example_pt em pt-BR. example_en em inglês natural.\n- não use nomes de personagens/obra como foco pedagógico.\n- não duplique focus entre cards.\nRetorne apenas o objeto JSON."""


def _cards_fragment(cues: list[dict[str, Any]], indexes: list[int], limiter: _TokenWindow, percent: int) -> dict[str, Any]:
    primary = [cues[index] for index in indexes]
    expected = {int(cue.get("order") or 0) for cue in primary}
    context_indexes = sorted({i for index in indexes for i in (index - 1, index + 1) if 0 <= i < len(cues) and i not in indexes})
    user = (
        "PRIMARY_ORDERS=" + _json_text(sorted(expected)) + "\n"
        "PRIMARY_CUES=" + _json_text([_cue_compact(cue, words=True) for cue in primary]) + "\n"
        "CONTEXT_ONLY=" + _json_text([_cue_compact(cues[i], words=False) for i in context_indexes])
    )
    if _request_estimate(_CARDS_SYSTEM, user, CUE_OUTPUT_TOKENS) > SAFE_TPM_BUDGET and len(indexes) > 1:
        middle = max(1, len(indexes) // 2)
        left = _cards_fragment(cues, indexes[:middle], limiter, percent)
        right = _cards_fragment(cues, indexes[middle:], limiter, percent)
        return {"cards": list(left.get("cards") or []) + list(right.get("cards") or [])}

    last_error = "resposta inválida"
    for attempt in range(1, MAX_BLOCK_RETRIES + 1):
        try:
            result = _call_json(
                system=_CARDS_SYSTEM,
                user=user + (f"\nRETRY={attempt}: {last_error}" if attempt > 1 else ""),
                max_completion_tokens=CUE_OUTPUT_TOKENS,
                limiter=limiter,
                label=f"Anki cues {min(expected)}–{max(expected)} tentativa {attempt}",
                percent=percent,
            )
            cards = result.get("cards") if isinstance(result.get("cards"), list) else None
            if cards is None:
                last_error = "A resposta precisa conter cards como array."
                continue
            invalid = [card for card in cards if not isinstance(card, dict) or int(card.get("cue_order") or 0) not in expected]
            if invalid:
                last_error = "Há card com cue_order fora de PRIMARY_ORDERS."
                continue
            return {"cards": cards}
        except Exception as exc:
            last_error = str(exc)
            if "HTTP 413" in last_error and len(indexes) > 1:
                middle = max(1, len(indexes) // 2)
                left = _cards_fragment(cues, indexes[:middle], limiter, percent)
                right = _cards_fragment(cues, indexes[middle:], limiter, percent)
                return {"cards": list(left.get("cards") or []) + list(right.get("cards") or [])}
    if len(indexes) > 1:
        middle = max(1, len(indexes) // 2)
        left = _cards_fragment(cues, indexes[:middle], limiter, percent)
        right = _cards_fragment(cues, indexes[middle:], limiter, percent)
        return {"cards": list(left.get("cards") or []) + list(right.get("cards") or [])}
    raise MaterialsGroqError(f"Groq não devolveu um bloco Anki válido: {last_error}")

def _normalize_cards(raw_cards: list[Any], cue_map: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    required_text = (
        "key", "type", "focus", "meaning", "highlight_en", "marked", "markedPT",
        "highlight_pt", "explanation", "example_en", "example_pt",
    )
    per_cue: dict[int, int] = {}
    seen_focus: set[str] = set()
    valid: list[dict[str, Any]] = []
    for raw in raw_cards:
        if not isinstance(raw, dict):
            continue
        try:
            cue_order = int(raw.get("cue_order") or 0)
            score = max(0, min(100, int(raw.get("score") or 0)))
        except (TypeError, ValueError):
            continue
        if cue_order not in cue_map or per_cue.get(cue_order, 0) >= 2:
            continue
        item = {key: str(raw.get(key) or "").strip() for key in required_text}
        if any(not item[key] for key in required_text):
            continue
        tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
        item["tags"] = [str(tag).strip() for tag in tags if str(tag).strip()][:8]
        if item["marked"] not in item["highlight_en"] or item["markedPT"] not in item["highlight_pt"]:
            continue
        focus_key = re.sub(r"\s+", " ", item["focus"].lower()).strip()
        if not focus_key or focus_key in seen_focus:
            continue
        seen_focus.add(focus_key)
        per_cue[cue_order] = per_cue.get(cue_order, 0) + 1
        item.update({"cue_order": cue_order, "score": score})
        valid.append(item)
    valid.sort(key=lambda item: (-int(item["score"]), int(item["cue_order"])))
    return valid[:10]


_GLOBAL_SYSTEM = """Você cria o conteúdo-base de dois PDFs do ImmersionHub. Responda SOMENTE JSON válido.\nFormato obrigatório:\n{\"study_workbook\":{\"central_rule\":\"\",\"method_cycle\":\"\",\"intro\":\"\",\"modules\":[{\"title\":\"\",\"cue_orders\":[1],\"objective\":\"\",\"listening_challenge\":\"\",\"production_prompt\":\"\"}],\"seven_day_plan\":[{\"day\":1,\"focus\":\"\",\"delivery\":\"\"}]},\"guide_answer_key\":{\"usage_note\":\"\",\"active_recall_guidance\":\"\",\"transformation_guidance\":\"\",\"final_challenge\":\"\"}}\nUse somente cue_orders existentes. Não altere nem invente texto canônico. O conteúdo deve ser específico desta cena, em pt-BR, direto e utilizável; sem placeholders/TODO.\nOs cards Anki fornecidos são a fonte das estruturas praticadas."""


def _generate_global(cues: list[dict[str, Any]], cards: list[dict[str, Any]], limiter: _TokenWindow, percent: int) -> dict[str, Any]:
    compact_cues = [_cue_compact(cue, words=False) for cue in cues]
    card_view = [
        {key: card.get(key) for key in ("cue_order", "focus", "meaning", "example_en", "example_pt")}
        for card in cards
    ]
    user = "CUES=" + _json_text(compact_cues) + "\nANKI=" + _json_text(card_view)
    if _request_estimate(_GLOBAL_SYSTEM, user, GLOBAL_OUTPUT_TOKENS) > SAFE_TPM_BUDGET:
        compact_cues = [{"order": int(cue.get("order") or 0), "en": str(cue.get("approved_en") or cue.get("original_en") or "")[:180]} for cue in cues]
        user = "CUES=" + _json_text(compact_cues) + "\nANKI=" + _json_text(card_view)
    if _request_estimate(_GLOBAL_SYSTEM, user, GLOBAL_OUTPUT_TOKENS) > SAFE_TPM_BUDGET:
        raise MaterialsGroqError("Conteúdo global dos PDFs ainda excede o orçamento seguro mesmo após compactação local.")
    last_error = ""
    for attempt in range(1, MAX_BLOCK_RETRIES + 1):
        try:
            result = _call_json(
                system=_GLOBAL_SYSTEM,
                user=user + (f"\nRETRY={attempt}: {last_error}" if attempt > 1 else ""),
                max_completion_tokens=GLOBAL_OUTPUT_TOKENS,
                limiter=limiter,
                label=f"Conteúdo PDF tentativa {attempt}",
                percent=percent,
            )
            workbook = result.get("study_workbook")
            guide = result.get("guide_answer_key")
            valid_orders = {int(cue.get("order") or 0) for cue in cues}
            modules = workbook.get("modules") if isinstance(workbook, dict) else None
            if isinstance(workbook, dict) and isinstance(guide, dict) and isinstance(modules, list):
                bad_module = False
                for module in modules:
                    if not isinstance(module, dict):
                        bad_module = True
                        break
                    orders = module.get("cue_orders")
                    if not isinstance(orders, list) or not orders:
                        bad_module = True
                        break
                    try:
                        normalized_orders = [int(order) for order in orders]
                    except (TypeError, ValueError):
                        bad_module = True
                        break
                    if any(order not in valid_orders for order in normalized_orders):
                        bad_module = True
                        break
                    module["cue_orders"] = normalized_orders
                if not bad_module:
                    return {"study_workbook": workbook, "guide_answer_key": guide}
                last_error = "Um módulo do PDF usa cue_orders ausentes ou inválidos."
                continue
            last_error = "study_workbook e guide_answer_key precisam ser objetos; modules precisa ser array."
        except Exception as exc:
            last_error = str(exc)
    raise MaterialsGroqError(f"Groq não devolveu conteúdo PDF válido: {last_error}")

_CS_SYSTEM = """Você recebe Connected Speech já validado por áudio e APROVADO manualmente. Não reavalie nem invente fenômenos.\nResponda SOMENTE {\"items\":[...]}. Para cada entrada preserve sequence_order e produza: practice_tip (pt-BR), learner_note (pt-BR) e drill_steps (array com 2 a 4 passos curtos).\nA explicação precisa ser pedagógica e fiel ao fenômeno fornecido. Não transforme pronúncia artística/específica em regra universal."""


def _generate_cs_lab(approved_items: list[dict[str, Any]], limiter: _TokenWindow, progress: Progress | None, base_percent: int) -> list[dict[str, Any]]:
    if not approved_items:
        return []
    enriched: dict[int, dict[str, Any]] = {}
    chunks = [approved_items[i:i + 4] for i in range(0, len(approved_items), 4)]
    for index, chunk in enumerate(chunks, start=1):
        percent = base_percent + int((index - 1) / max(1, len(chunks)) * 8)
        payload = [
            {
                "sequence_order": int(item.get("sequenceOrder") or item.get("sequence_order") or 0),
                "cue_order": int(item.get("cue_order") or 0),
                "type": str(item.get("type") or ""),
                "source_text": str(item.get("source_text") or ""),
                "heard_as": str(item.get("heard_as") or ""),
                "explanation_pt": str(item.get("explanation_pt") or ""),
                "cue_en": str(item.get("cue_en") or ""),
                "cue_pt": str(item.get("cue_pt") or ""),
            }
            for item in chunk
        ]
        _progress(progress, percent, f"Groq preparando Connected Speech Lab {index}/{len(chunks)}…")
        expected_sequences = {int(item["sequence_order"]) for item in payload}
        rows: list[Any] = []
        last_error = "resposta inválida"
        for attempt in range(1, MAX_BLOCK_RETRIES + 1):
            try:
                result = _call_json(
                    system=_CS_SYSTEM,
                    user="APPROVED_CONNECTED_SPEECH=" + _json_text(payload) + (f"\nRETRY={attempt}: preserve todos os sequence_order fornecidos." if attempt > 1 else ""),
                    max_completion_tokens=CS_OUTPUT_TOKENS,
                    limiter=limiter,
                    label=f"Connected Speech Lab {index}/{len(chunks)} tentativa {attempt}",
                    percent=percent,
                )
                candidate = result.get("items") if isinstance(result.get("items"), list) else None
                if candidate is None:
                    last_error = "items precisa ser array."
                    continue
                returned_sequences: set[int] = set()
                invalid = False
                for row in candidate:
                    if not isinstance(row, dict):
                        invalid = True
                        break
                    try:
                        sequence = int(row.get("sequence_order") or 0)
                    except (TypeError, ValueError):
                        invalid = True
                        break
                    if sequence not in expected_sequences or sequence in returned_sequences:
                        invalid = True
                        break
                    returned_sequences.add(sequence)
                if invalid or returned_sequences != expected_sequences:
                    last_error = "sequence_order ausente, duplicado ou fora do lote."
                    continue
                rows = candidate
                break
            except Exception as exc:
                last_error = str(exc)
        else:
            raise MaterialsGroqError(f"Connected Speech Lab {index}/{len(chunks)} inválido: {last_error}")
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                sequence = int(row.get("sequence_order") or 0)
            except (TypeError, ValueError):
                continue
            if sequence:
                enriched[sequence] = row
    output: list[dict[str, Any]] = []
    for item in approved_items:
        sequence = int(item.get("sequenceOrder") or item.get("sequence_order") or 0)
        extra = enriched.get(sequence) or {}
        output.append({
            "sequence_order": sequence,
            "cue_order": int(item.get("cue_order") or 0),
            "type": str(item.get("type") or ""),
            "source_text": str(item.get("source_text") or ""),
            "heard_as": str(item.get("heard_as") or ""),
            "explanation_pt": str(item.get("explanation_pt") or ""),
            "cue_en": str(item.get("cue_en") or ""),
            "cue_pt": str(item.get("cue_pt") or ""),
            "start_ms": int(item.get("start_ms") or 0),
            "end_ms": int(item.get("end_ms") or 0),
            "practice_tip": str(extra.get("practice_tip") or "").strip(),
            "learner_note": str(extra.get("learner_note") or "").strip(),
            "drill_steps": [str(step).strip() for step in (extra.get("drill_steps") or []) if str(step).strip()][:4],
        })
    return output


def generate_materials_draft(
    canonical: dict[str, Any],
    connected_speech_review: dict[str, Any],
    *,
    progress: Progress | None = None,
    fragment_dir: Path,
) -> dict[str, Any]:
    if not isinstance(canonical, dict) or not str(canonical.get("snapshot_id") or ""):
        raise ValueError("JSON Canônico inválido para geração de materiais.")
    cues = canonical.get("cues") if isinstance(canonical.get("cues"), list) else []
    if not cues:
        raise ValueError("JSON Canônico sem cues.")
    if not isinstance(connected_speech_review, dict) or not bool(connected_speech_review.get("completed")):
        raise ValueError("A conferência de Connected Speech precisa estar concluída.")

    snapshot_id = str(canonical.get("snapshot_id") or "")
    canonical_sha = _sha256_json(canonical)
    cs_sha = _sha256_json(connected_speech_review)
    settings = load_ai_settings()
    model = str(settings.get("model") or "")
    identity = {"snapshot_id": snapshot_id, "canonical_sha256": canonical_sha, "cs_review_sha256": cs_sha, "model": model}

    manifest_file = fragment_dir / "manifest.json"
    manifest = _read_json(manifest_file) or {}
    if any(manifest.get(key) != value for key, value in identity.items()):
        shutil.rmtree(fragment_dir, ignore_errors=True)
        fragment_dir.mkdir(parents=True, exist_ok=True)
        manifest = {**identity, "version": 1, "created_at": time.time(), "rate_events": [], "completed": []}
    else:
        fragment_dir.mkdir(parents=True, exist_ok=True)

    def save_manifest() -> None:
        manifest["updated_at"] = time.time()
        _atomic_write_json(manifest_file, manifest)

    save_manifest()
    limiter = _TokenWindow(manifest, save_manifest, progress)
    cue_map = {int(cue.get("order") or 0): cue for cue in cues if int(cue.get("order") or 0) > 0}
    blocks = _build_cue_blocks(cues)
    fragments: list[dict[str, Any]] = []
    _progress(progress, 6, f"Materiais: {len(cues)} cues divididas em {len(blocks)} bloco(s) retomáveis.")

    for block_index, indexes in enumerate(blocks, start=1):
        orders = [int(cues[index].get("order") or 0) for index in indexes]
        path = fragment_dir / f"anki_{orders[0]:04d}_{orders[-1]:04d}.json"
        cached = _read_json(path)
        percent = 10 + int((block_index - 1) / max(1, len(blocks)) * 42)
        if cached and cached.get("identity") == identity and isinstance(cached.get("payload"), dict):
            fragments.append(copy.deepcopy(cached["payload"]))
            _progress(progress, percent, f"Anki {block_index}/{len(blocks)} recuperado do disco.")
            continue
        _progress(progress, percent, f"Groq gerando conteúdo Anki {block_index}/{len(blocks)} · cues {orders[0]}–{orders[-1]}…")
        payload = _cards_fragment(cues, indexes, limiter, percent)
        _atomic_write_json(path, {"identity": identity, "orders": orders, "payload": payload, "completed_at": time.time()})
        fragments.append(payload)
        manifest.setdefault("completed", []).append(path.name)
        save_manifest()

    raw_cards = [card for fragment in fragments for card in (fragment.get("cards") or [])]
    cards = _normalize_cards(raw_cards, cue_map)
    _progress(progress, 55, f"{len(cards)} card(s) pedagógicos fortes selecionados. Gerando conteúdo dos PDFs…")

    global_file = fragment_dir / "pdf_content.json"
    global_cached = _read_json(global_file)
    if global_cached and global_cached.get("identity") == identity and isinstance(global_cached.get("payload"), dict):
        global_payload = copy.deepcopy(global_cached["payload"])
        _progress(progress, 61, "Conteúdo dos PDFs recuperado do disco.")
    else:
        global_payload = _generate_global(cues, cards, limiter, 61)
        _atomic_write_json(global_file, {"identity": identity, "payload": global_payload, "completed_at": time.time()})

    approved_cs = [item for item in connected_speech_review.get("items") or [] if isinstance(item, dict) and item.get("decision") == "approved"]
    _progress(progress, 70, f"Preparando Connected Speech Lab com {len(approved_cs)} item(ns) aprovado(s)…")
    cs_lab = _generate_cs_lab(approved_cs, limiter, progress, 70)

    transcript_original = [
        {
            "order": int(cue.get("order") or 0),
            "speaker": str(cue.get("speaker") or ""),
            "start_ms": int(cue.get("speech_start_ms") or 0),
            "end_ms": int(cue.get("speech_end_ms") or 0),
            "en": str(cue.get("approved_en") or cue.get("original_en") or ""),
        }
        for cue in cues
    ]
    transcript_bilingual = [
        {**row, "pt": str(cue.get("pt") or "")}
        for row, cue in zip(transcript_original, cues)
    ]

    draft = {
        "schema": "immersionhub-materials-groq-draft",
        "schema_version": "1.0",
        "source_snapshot_id": snapshot_id,
        "source_canonical_sha256": canonical_sha,
        "source_connected_speech_review_sha256": cs_sha,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "groq": {
            "model": settings.get("model"),
            "tts_model": settings.get("tts_model"),
            "tts_voice": settings.get("tts_voice"),
        },
        "pdf_content": {
            "study_workbook": global_payload.get("study_workbook") or {},
            "guide_answer_key": global_payload.get("guide_answer_key") or {},
            "transcript_original": {"cues": transcript_original},
            "transcript_bilingual": {"cues": transcript_bilingual},
            "connected_speech_lab": {"items": cs_lab},
        },
        "anki": {"items": cards},
        "audio": {"strategy": "groq_tts_by_source_cue", "items": []},
    }
    manifest["status"] = "content_ready"
    save_manifest()
    _progress(progress, 82, "Conteúdo Groq validado localmente. Preparando TTS…")
    return draft
