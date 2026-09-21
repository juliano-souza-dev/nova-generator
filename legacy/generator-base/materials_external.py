from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PDF_KEYS_EXTERNAL = ("immersion_workbook",)
CARD_TEXT_FIELDS = (
    "key", "type", "focus", "meaning", "highlight_en", "marked", "markedPT",
    "highlight_pt", "explanation", "example_en", "example_pt",
)

RETURN_SCHEMA = "immersionhub-materials-external-return"
RETURN_SCHEMA_VERSION = "1.3"
DAY5_CHECK_FIELDS = ("title", "cue_orders", "instruction", "success_criteria")
STRUCTURE_FIELDS = ("title", "cue_orders", "pattern", "explanation_pt", "new_contexts", "make_it_yours")
STRUCTURE_CONTEXT_FIELDS = ("en", "pt")
CS_EXPLANATION_FIELDS = ("sequence_order", "learner_note")
CS_PRACTICE_FIELDS = ("sequence_order", "practice_tip", "drill_steps")
ACTIVITY_QA_FIELDS = ("cue_orders", "prompt", "answer")
CS_HUNT_FIELDS = ("sequence_order", "prompt", "answer")
STRUCTURE_TRANSFER_FIELDS = ("structure_title", "prompt", "model_answers")
SHADOWING_ACTIVITY_FIELDS = ("cue_orders", "prompt", "success_criteria")
FINAL_LISTENING_FIELDS = ("prompt", "comprehension_record")
FINALIZATION_FIELDS = ("title", "checklist", "reflection_prompt", "next_review")
CONTRACT_LIMITS = {
    "day5_checks_min": 3,
    "day5_checks_max": 6,
    "structure_contexts_min": 2,
    "structure_contexts_max": 4,
    "cs_practice_steps_min": 2,
    "cs_practice_steps_max": 4,
    "structure_transfer_models_min": 2,
    "structure_transfer_models_max": 3,
    "finalization_checklist_min": 3,
    "finalization_checklist_max": 6,
    "anki_max_per_cue": 2,
    "anki_score_min": 0,
    "anki_score_max": 100,
}


class MaterialsExternalError(ValueError):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _text(value: Any) -> str:
    return str(value or "").strip()


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _approved_cs(review: dict[str, Any]) -> list[dict[str, Any]]:
    items = review.get("items") if isinstance(review.get("items"), list) else []
    return [copy.deepcopy(item) for item in items if isinstance(item, dict) and item.get("decision") == "approved"]


def _cue_reference(canonical: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for cue in canonical.get("cues") or []:
        if not isinstance(cue, dict):
            continue
        order = _as_int(cue.get("order"))
        if order <= 0:
            continue
        rows.append({
            "order": order,
            "speaker": _text(cue.get("speaker")),
            "speech_start_ms": _as_int(cue.get("speech_start_ms")),
            "speech_end_ms": _as_int(cue.get("speech_end_ms")),
            "approved_en": _text(cue.get("approved_en") or cue.get("original_en")),
            "pt": _text(cue.get("pt")),
            "words": [
                {
                    "text": _text(word.get("text")),
                    "pt": _text(word.get("pt")),
                    "start_ms": _as_int(word.get("start_ms")),
                    "end_ms": _as_int(word.get("end_ms")),
                }
                for word in (cue.get("words") or []) if isinstance(word, dict)
            ],
        })
    return rows


def _how_to_study(content_type: str) -> dict[str, Any]:
    """Generator-owned How To Study block. It is always block 1 after the cover."""
    if content_type == "music":
        return {
            "title": "How To Study",
            "intro": "Use sempre o mesmo microtrecho. O objetivo é compreender, recuperar e reutilizar o inglês — não decorar a música inteira.",
            "days": [
                {"day": 1, "title": "Lyrics + Text + Audio", "steps": [
                    "No HUB, acompanhe o microtrecho em Lyrics com o inglês visível.",
                    "Use tradução/Word by Word somente para fechar lacunas de sentido.",
                    "Finalize em Text + Audio e repita os chunks mais úteis em voz alta.",
                ]},
                {"day": 2, "title": "Cards + produção", "steps": [
                    "Baixe o Anki ou use os Cards do HUB e tente responder antes de revelar a resposta.",
                    "Volte ao microtrecho e recupere os chunks principais sem ler primeiro.",
                    "Crie frases novas com as estruturas do PDF, sem copiar a letra como frase isolada.",
                ]},
                {"day": 3, "title": "Escuta independente", "steps": [
                    "Escute o microtrecho sem ler a letra.",
                    "Reabra Lyrics apenas para conferir o que ainda escapou.",
                    "Revise os Cards difíceis e repita somente o vocabulário que ainda exige esforço.",
                ]},
            ],
        }
    return {
        "title": "How To Study",
        "intro": "Siga este ciclo com o mesmo kit. Connected Speech fica exclusivamente neste PDF; vídeo, Shadowing, Linha a Linha, Vocabulário e Cards continuam no HUB.",
        "days": [
            {"day": 1, "title": "Compreender + imitar", "steps": [
                "No HUB, veja o vídeo com legendas em inglês.",
                "Depois veja com legenda dupla apenas para fechar as lacunas de compreensão.",
                "Pratique o Shadowing e finalize a sessão em Texto + Áudio.",
            ]},
            {"day": 2, "title": "Recuperar + coletar", "steps": [
                "Baixe o Anki ou use os Cards do HUB e tente responder antes de virar o card.",
                "Faça outra sessão de Shadowing.",
                "Use Linha a Linha e salve no Vocabulário do HUB somente as palavras/expressões que realmente quer reter.",
            ]},
            {"day": 3, "title": "Ouvir sem apoio", "steps": [
                "Assista ao vídeo sem legendas.",
                "Faça Shadowing novamente, agora com menos apoio visual.",
                "Revise o Anki/Cards e repita apenas os pontos que ainda estiverem difíceis.",
            ]},
        ],
    }


def _build_return_contract(
    *,
    is_music: bool,
    approved_cs: list[dict[str, Any]],
    snapshot_id: str,
    canonical_sha256: str,
    connected_speech_review_sha256: str,
) -> dict[str, Any]:
    """Single source of truth for the external return shape accepted by validate_return."""
    approved_sequences = [] if is_music else sorted(_expected_cs_map(approved_cs))
    activity_qa = {
        "type": "array",
        "min_items": 1,
        "item_required_fields": list(ACTIVITY_QA_FIELDS),
        "item_shape": {"cue_orders": "non-empty array<int> of existing cue orders", "prompt": "non-empty string", "answer": "non-empty string"},
    }
    contract = {
        "schema": RETURN_SCHEMA,
        "schema_version": RETURN_SCHEMA_VERSION,
        "root": {
            "required_fields": [
                "schema", "schema_version", "source_snapshot_id", "source_canonical_sha256",
                "source_connected_speech_review_sha256", "pdf_content", "anki",
            ],
            "constants": {"schema": RETURN_SCHEMA, "schema_version": RETURN_SCHEMA_VERSION},
            "exact_values": {
                "source_snapshot_id": snapshot_id,
                "source_canonical_sha256": canonical_sha256,
                "source_connected_speech_review_sha256": connected_speech_review_sha256,
            },
        },
        "pdf_content": {
            "type": "object",
            "allowed_fields": ["immersion_workbook"],
            "required_fields": ["immersion_workbook"],
            "additional_fields": False,
            "immersion_workbook": {
                "required_fields": [
                    "kit_objective", "day_5_diagnostic", "connected_speech",
                    "connected_speech_practice", "structures_from_scene", "activities", "finalization",
                ],
                "kit_objective": {"type": "non-empty string"},
                "day_5_diagnostic": {
                    "type": "object",
                    "required_fields": ["intro", "checks", "self_assessment"],
                    "checks": {
                        "type": "array",
                        "min_items": CONTRACT_LIMITS["day5_checks_min"],
                        "max_items": CONTRACT_LIMITS["day5_checks_max"],
                        "item_required_fields": list(DAY5_CHECK_FIELDS),
                        "item_shape": {
                            "title": "non-empty string",
                            "cue_orders": "non-empty array<int> of existing cue orders",
                            "instruction": "non-empty string; do not include the answer",
                            "success_criteria": "non-empty string",
                        },
                    },
                    "intro": "non-empty string",
                    "self_assessment": "non-empty string",
                },
                "connected_speech": {
                    "type": "object",
                    "required_fields": ["items"],
                    "items": ({
                        "type": "array", "exact_items": 0, "exact_value": [],
                    } if is_music else {
                        "type": "array",
                        "exact_items": len(approved_sequences),
                        "approved_sequence_orders": approved_sequences,
                        "item_required_fields": list(CS_EXPLANATION_FIELDS),
                        "item_shape": {"sequence_order": "approved sequence_order, unique", "learner_note": "non-empty string"},
                    }),
                },
                "connected_speech_practice": {
                    "type": "object",
                    "required_fields": ["items"],
                    "items": ({
                        "type": "array", "exact_items": 0, "exact_value": [],
                    } if is_music else {
                        "type": "array",
                        "exact_items": len(approved_sequences),
                        "approved_sequence_orders": approved_sequences,
                        "item_required_fields": list(CS_PRACTICE_FIELDS),
                        "item_shape": {
                            "sequence_order": "approved sequence_order, unique",
                            "practice_tip": "non-empty string",
                            "drill_steps": f"array<string> with {CONTRACT_LIMITS['cs_practice_steps_min']}–{CONTRACT_LIMITS['cs_practice_steps_max']} non-empty items",
                        },
                    }),
                },
                "structures_from_scene": {
                    "type": "object",
                    "required_fields": ["items"],
                    "items": {
                        "type": "array",
                        "min_items": 1,
                        "item_required_fields": list(STRUCTURE_FIELDS),
                        "item_shape": {
                            "title": "non-empty string",
                            "cue_orders": "non-empty array<int> of existing cue orders",
                            "pattern": "non-empty string",
                            "explanation_pt": "non-empty string",
                            "new_contexts": {
                                "type": "array",
                                "min_items": CONTRACT_LIMITS["structure_contexts_min"],
                                "max_items": CONTRACT_LIMITS["structure_contexts_max"],
                                "item_required_fields": list(STRUCTURE_CONTEXT_FIELDS),
                                "item_shape": {"en": "non-empty string", "pt": "non-empty string"},
                            },
                            "make_it_yours": "non-empty string",
                        },
                    },
                },
                "activities": {
                    "type": "object",
                    "required_fields": [
                        "intro", "listening_reconstruction", "connected_speech_hunt", "structure_transfer",
                        "vocabulary_recall", "shadowing_challenge", "final_listening",
                    ],
                    "intro": "non-empty string",
                    "listening_reconstruction": copy.deepcopy(activity_qa),
                    "vocabulary_recall": copy.deepcopy(activity_qa),
                    "connected_speech_hunt": ({
                        "type": "array", "exact_items": 0, "exact_value": [],
                    } if not approved_sequences else {
                        "type": "array",
                        "min_items": 1,
                        "item_required_fields": list(CS_HUNT_FIELDS),
                        "item_shape": {
                            "sequence_order": "approved sequence_order",
                            "prompt": "non-empty string",
                            "answer": "non-empty string",
                        },
                    }),
                    "structure_transfer": {
                        "type": "array",
                        "min_items": 1,
                        "item_required_fields": list(STRUCTURE_TRANSFER_FIELDS),
                        "item_shape": {
                            "structure_title": "non-empty string",
                            "prompt": "non-empty string",
                            "model_answers": f"array<string> with {CONTRACT_LIMITS['structure_transfer_models_min']}–{CONTRACT_LIMITS['structure_transfer_models_max']} non-empty items",
                        },
                    },
                    "shadowing_challenge": ({
                        "type": "object", "exact_value": {},
                    } if is_music else {
                        "type": "object",
                        "required_fields": list(SHADOWING_ACTIVITY_FIELDS),
                        "shape": {
                            "cue_orders": "non-empty array<int> of existing cue orders",
                            "prompt": "non-empty string",
                            "success_criteria": "non-empty string",
                        },
                    }),
                    "final_listening": {
                        "type": "object",
                        "required_fields": list(FINAL_LISTENING_FIELDS),
                        "shape": {"prompt": "non-empty string", "comprehension_record": "non-empty string"},
                    },
                },
                "finalization": {
                    "type": "object",
                    "required_fields": list(FINALIZATION_FIELDS),
                    "shape": {
                        "title": "non-empty string",
                        "checklist": f"array<string> with {CONTRACT_LIMITS['finalization_checklist_min']}–{CONTRACT_LIMITS['finalization_checklist_max']} non-empty items",
                        "reflection_prompt": "non-empty string",
                        "next_review": "non-empty string",
                    },
                },
            },
        },
        "anki": {
            "type": "object",
            "required_fields": ["items"],
            "items": {
                "type": "array",
                "item_required_fields": list(CARD_TEXT_FIELDS) + ["cue_order", "score", "tags"],
                "constraints": {
                    "cue_order": "must exist in canonical cues",
                    "max_cards_per_cue": CONTRACT_LIMITS["anki_max_per_cue"],
                    "score": f"integer {CONTRACT_LIMITS['anki_score_min']}..{CONTRACT_LIMITS['anki_score_max']}",
                    "tags": "array<string>",
                    "marked": "literal substring of highlight_en (case-sensitive)",
                    "markedPT": "literal substring of highlight_pt (case-sensitive)",
                    "example_en": "must not copy highlight_en after whitespace/case normalization",
                    "key": "unique in kit, case-insensitive",
                    "focus": "unique in kit after whitespace/case normalization",
                },
            },
        },
    }
    return contract


def build_instruction_payload(
    canonical: dict[str, Any],
    connected_speech_review: dict[str, Any],
    *,
    canonical_sha256: str,
    connected_speech_review_sha256: str,
) -> dict[str, Any]:
    """Build the external-AI contract for the exact seven-block single PDF."""
    snapshot_id = _text(canonical.get("snapshot_id"))
    generated_at_utc = _text(canonical.get("generated_at_utc"))
    cues = _cue_reference(canonical)
    approved_cs = _approved_cs(connected_speech_review)
    content_type = _text((canonical.get("project") or {}).get("content_type")) or "dialogue"
    is_music = content_type == "music"
    return_contract = _build_return_contract(
        is_music=is_music,
        approved_cs=approved_cs,
        snapshot_id=snapshot_id,
        canonical_sha256=canonical_sha256,
        connected_speech_review_sha256=connected_speech_review_sha256,
    )
    return {
        "version": 5,
        "purpose": "external_ai_exact_seven_block_pdf_and_anki_material_generation",
        "content_type": content_type,
        "task": (
            "Use as fontes read-only para produzir somente os blocos editoriais pertencentes à IA externa. "
            "O Generator renderiza UM PDF com capa e exatamente 7 blocos de conteúdo, nesta ordem: "
            "How To Study; Day 5 — Diagnostic; Connected Speech; Connected Speech — Practice; "
            "Structures From This Scene; Activities; Finalization. "
            "How To Study é fixo e montado pelo Generator. Devolva o restante no schema 1.3. "
            "Anki continua sendo um artefato separado e deve ser preenchido em anki.items."
        ),
        "contract_authority": {
            "rule": "return_contract abaixo é o contrato exato de aceitação desta etapa. Gere a resposta somente com os campos e formatos descritos nele; não inferir nomes de campos alternativos.",
            "schema": RETURN_SCHEMA,
            "schema_version": RETURN_SCHEMA_VERSION,
        },
        "return_contract": return_contract,
        "critical_rules": [
            "Retorne SOMENTE um objeto JSON válido, sem Markdown, comentários ou texto externo.",
            "snapshot_id e generated_at_utc são protegidos: não regenere, não recalcule e não altere esses valores.",
            "source_snapshot_id deve copiar EXATAMENTE o snapshot_id canônico fornecido.",
            "Não altere timings, order, speaker, approved_en, pt, words, Shadowing, Dual Scene ou qualquer campo técnico do canônico.",
            "A saída de material em PDF é UM ÚNICO documento. Não devolva PDFs separados, transcript PDFs, guide PDF ou workbook PDF paralelo.",
            "How To Study é o BLOCO 1 depois da capa e é controlado pelo Generator. Não devolva nem reescreva esse bloco.",
            "Não inclua Anki como bloco do PDF. Os cards continuam em anki.items e são exportados separadamente pelo Generator/HUB.",
            ("Music não usa Connected Speech: connected_speech.items e connected_speech_practice.items devem ser []." if is_music else "Connected Speech vem somente da revisão por áudio real; não crie, remova, reclassifique ou reavalie fenômenos."),
            ("Não invente fenômenos de canto como Connected Speech." if is_music else "Use somente itens decision=approved como fonte de Connected Speech."),
            "Day 5 — Diagnostic deve diagnosticar o que o aluno consegue compreender/recuperar da cena sem ensinar conteúdo novo.",
            "Connected Speech explica o fenômeno; Connected Speech — Practice contém a prática. Não misture os dois blocos.",
            "Structures From This Scene usa somente estruturas realmente presentes nos cue_orders indicados e inclui 2 a 4 novos contextos por estrutura.",
            ("Activities em Music: Listening Reconstruction, Structure Transfer, Vocabulary Recall e Final Listening; Connected Speech Hunt e Shadowing Challenge ficam desativados." if is_music else "Activities deve conter exatamente: Listening Reconstruction, Connected Speech Hunt, Structure Transfer, Vocabulary Recall, Shadowing Challenge e Final Listening."),
            "Structure Transfer deve pedir 2–3 frases originais do aluno.",
            ("Em Music, shadowing_challenge deve ser {}." if is_music else "Shadowing Challenge deve cobrar ritmo, pausas e entonação."),
            "Final Listening deve ser sem legendas e deve pedir um registro do que foi compreendido.",
            "Finalization fecha o material; não introduza nova gramática, novo Connected Speech ou novas falas da cena.",
            "Anki deve vir completo. Não use TODO, placeholder, X ou conteúdo genérico.",
            "Não gere áudio/TTS. A Groq será usada posteriormente SOMENTE para os áudios dos cards aprovados.",
        ],
        "protected_sources": {
            "canonical": {"snapshot_id": snapshot_id, "generated_at_utc": generated_at_utc, "sha256": canonical_sha256, "rule": "read_only"},
            "connected_speech_review": {"sha256": connected_speech_review_sha256, "rule": ("disabled_for_music" if is_music else "read_only; approved only")},
        },
        "single_pdf_layout": {
            "filename": "01_immersionhub_workbook.pdf",
            "cover": {
                "brand": "ImmersionHub",
                "motto": "Less time preparing. More time actually practicing.",
                "objective_source": "pdf_content.immersion_workbook.kit_objective",
                "note": "A capa não conta como bloco de conteúdo.",
            },
            "content_block_order": [
                "1. How To Study (fixo no Generator)",
                "2. Day 5 — Diagnostic",
                ("3. Connected Speech (sem itens em Music)" if is_music else "3. Connected Speech (PDF-only; approved only)"),
                ("4. Connected Speech — Practice (sem itens em Music)" if is_music else "4. Connected Speech — Practice"),
                "5. Structures From This Scene",
                "6. Activities",
                "7. Finalization",
            ],
            "how_to_study": _how_to_study(content_type),
        },
        "day_5_diagnostic_contract": copy.deepcopy(return_contract["pdf_content"]["immersion_workbook"]["day_5_diagnostic"]),
        "connected_speech_contract": copy.deepcopy(return_contract["pdf_content"]["immersion_workbook"]["connected_speech"]),
        "connected_speech_practice_contract": copy.deepcopy(return_contract["pdf_content"]["immersion_workbook"]["connected_speech_practice"]),
        "structures_contract": copy.deepcopy(return_contract["pdf_content"]["immersion_workbook"]["structures_from_scene"]),
        "activities_contract": copy.deepcopy(return_contract["pdf_content"]["immersion_workbook"]["activities"]),
        "finalization_contract": copy.deepcopy(return_contract["pdf_content"]["immersion_workbook"]["finalization"]),
        "anki_contract": copy.deepcopy(return_contract["anki"]),
        "expected_return": {
            "filename": "materials_external_ai_return.json",
            "schema": RETURN_SCHEMA,
            "schema_version": RETURN_SCHEMA_VERSION,
            "required_root_fields": copy.deepcopy(return_contract["root"]["required_fields"]),
            "shape_source": "return_contract",
            "identity": {
                "source_snapshot_id": snapshot_id,
                "source_canonical_sha256": canonical_sha256,
                "source_connected_speech_review_sha256": connected_speech_review_sha256,
            },
        },
        "source_summary": {"cue_count": len(cues), "approved_connected_speech_count": len(approved_cs), "cue_orders": [row["order"] for row in cues]},
    }


def build_package(
    canonical: dict[str, Any],
    connected_speech_review: dict[str, Any],
    *,
    canonical_sha256: str,
    connected_speech_review_sha256: str,
    package_dir: Path,
    archive_file: Path,
) -> dict[str, Any]:
    package_dir.mkdir(parents=True, exist_ok=True)
    for path in package_dir.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)
    canonical_file = package_dir / "canonical_scene_current.json"
    cs_file = package_dir / "connected_speech_review.json"
    instructions_file = package_dir / "external_ai_materials_instructions.json"
    canonical_file.write_text(json.dumps(canonical, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    cs_file.write_text(json.dumps(connected_speech_review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    instructions = build_instruction_payload(
        canonical,
        connected_speech_review,
        canonical_sha256=canonical_sha256,
        connected_speech_review_sha256=connected_speech_review_sha256,
    )
    instructions_file.write_text(json.dumps(instructions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    archive_file.parent.mkdir(parents=True, exist_ok=True)
    archive_file.unlink(missing_ok=True)
    with zipfile.ZipFile(archive_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in (canonical_file, cs_file, instructions_file):
            archive.write(path, arcname=path.name)
    return {
        "archive": archive_file,
        "files": [canonical_file, cs_file, instructions_file],
        "expected_return": "materials_external_ai_return.json",
        "cue_count": len(_cue_reference(canonical)),
        "approved_connected_speech": len(_approved_cs(connected_speech_review)),
    }


def _validate_cards(raw: Any, cue_map: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise MaterialsExternalError("anki.items precisa ser um array.")
    seen_keys: set[str] = set()
    seen_focus: set[str] = set()
    per_cue: dict[int, int] = {}
    cards: list[dict[str, Any]] = []
    for index, item_raw in enumerate(raw, start=1):
        if not isinstance(item_raw, dict):
            raise MaterialsExternalError(f"Anki item {index}: precisa ser objeto.")
        cue_order = _as_int(item_raw.get("cue_order"))
        if cue_order not in cue_map:
            raise MaterialsExternalError(f"Anki item {index}: cue_order {cue_order} não existe no canônico.")
        per_cue[cue_order] = per_cue.get(cue_order, 0) + 1
        if per_cue[cue_order] > CONTRACT_LIMITS["anki_max_per_cue"]:
            raise MaterialsExternalError(f"Cue {cue_order}: máximo de {CONTRACT_LIMITS['anki_max_per_cue']} cards Anki.")
        item: dict[str, Any] = {key: _text(item_raw.get(key)) for key in CARD_TEXT_FIELDS}
        missing = [key for key in CARD_TEXT_FIELDS if not item[key]]
        if missing:
            raise MaterialsExternalError(f"Anki item {index}: campos vazios/ausentes: {', '.join(missing)}.")
        try:
            score = int(item_raw.get("score"))
        except (TypeError, ValueError):
            raise MaterialsExternalError(f"Anki item {index}: score deve ser inteiro 0..100.")
        if score < CONTRACT_LIMITS["anki_score_min"] or score > CONTRACT_LIMITS["anki_score_max"]:
            raise MaterialsExternalError(f"Anki item {index}: score fora de 0..100.")
        tags_raw = item_raw.get("tags")
        if not isinstance(tags_raw, list):
            raise MaterialsExternalError(f"Anki item {index}: tags deve ser array.")
        tags = [_text(tag) for tag in tags_raw if _text(tag)]
        if item["marked"] not in item["highlight_en"]:
            raise MaterialsExternalError(f"Anki item {index}: marked não existe literalmente em highlight_en.")
        if item["markedPT"] not in item["highlight_pt"]:
            raise MaterialsExternalError(f"Anki item {index}: markedPT não existe literalmente em highlight_pt.")
        if re.sub(r"\s+", " ", item["example_en"].casefold()).strip() == re.sub(r"\s+", " ", item["highlight_en"].casefold()).strip():
            raise MaterialsExternalError(f"Anki item {index}: example_en não pode copiar highlight_en.")
        key_norm = item["key"].casefold()
        focus_norm = re.sub(r"\s+", " ", item["focus"].casefold()).strip()
        if key_norm in seen_keys:
            raise MaterialsExternalError(f"Anki item {index}: key duplicada '{item['key']}'.")
        if focus_norm in seen_focus:
            raise MaterialsExternalError(f"Anki item {index}: focus duplicado '{item['focus']}'.")
        seen_keys.add(key_norm)
        seen_focus.add(focus_norm)
        item.update({"cue_order": cue_order, "score": score, "tags": tags[:12]})
        cards.append(item)
    cards.sort(key=lambda row: (-int(row["score"]), int(row["cue_order"])))
    return cards


def _validate_structures(raw: Any, cue_orders: set[int]) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list) or not raw.get("items"):
        raise MaterialsExternalError("structures_from_scene.items precisa ser array não vazio.")
    items: list[dict[str, Any]] = []
    for index, row_raw in enumerate(raw.get("items") or [], start=1):
        if not isinstance(row_raw, dict):
            raise MaterialsExternalError(f"Structure {index}: precisa ser objeto.")
        for key in ("title", "pattern", "explanation_pt", "make_it_yours"):
            if not _text(row_raw.get(key)):
                raise MaterialsExternalError(f"Structure {index}: {key} vazio.")
        orders_raw = row_raw.get("cue_orders")
        if not isinstance(orders_raw, list) or not orders_raw:
            raise MaterialsExternalError(f"Structure {index}: cue_orders precisa ser array não vazio.")
        orders = [_as_int(value) for value in orders_raw]
        bad = [order for order in orders if order not in cue_orders]
        if bad:
            raise MaterialsExternalError(f"Structure {index}: cue_orders inexistentes {bad}.")
        contexts_raw = row_raw.get("new_contexts")
        if not isinstance(contexts_raw, list) or not CONTRACT_LIMITS["structure_contexts_min"] <= len(contexts_raw) <= CONTRACT_LIMITS["structure_contexts_max"]:
            raise MaterialsExternalError(f"Structure {index}: new_contexts deve ter 2 a 4 itens.")
        contexts: list[dict[str, str]] = []
        for cidx, ctx in enumerate(contexts_raw, start=1):
            if not isinstance(ctx, dict) or not _text(ctx.get("en")) or not _text(ctx.get("pt")):
                raise MaterialsExternalError(f"Structure {index}, contexto {cidx}: en e pt são obrigatórios.")
            contexts.append({"en": _text(ctx.get("en")), "pt": _text(ctx.get("pt"))})
        items.append({
            "title": _text(row_raw.get("title")), "cue_orders": orders, "pattern": _text(row_raw.get("pattern")),
            "explanation_pt": _text(row_raw.get("explanation_pt")), "new_contexts": contexts,
            "make_it_yours": _text(row_raw.get("make_it_yours")),
        })
    return {"items": items}


def _validate_day_5_diagnostic(raw: Any, cue_orders: set[int]) -> dict[str, Any]:
    if not isinstance(raw, dict) or not _text(raw.get("intro")) or not _text(raw.get("self_assessment")):
        raise MaterialsExternalError("day_5_diagnostic precisa de intro e self_assessment.")
    checks_raw = raw.get("checks")
    if not isinstance(checks_raw, list) or not (CONTRACT_LIMITS["day5_checks_min"] <= len(checks_raw) <= CONTRACT_LIMITS["day5_checks_max"]):
        raise MaterialsExternalError("day_5_diagnostic.checks precisa ter de 3 a 6 itens.")
    checks=[]
    for index,item in enumerate(checks_raw,1):
        if not isinstance(item,dict):
            raise MaterialsExternalError(f"Day 5 Diagnostic check {index}: precisa ser objeto.")
        orders_raw=item.get("cue_orders")
        if not isinstance(orders_raw,list) or not orders_raw:
            raise MaterialsExternalError(f"Day 5 Diagnostic check {index}: cue_orders precisa ser array não vazio.")
        orders=[_as_int(v) for v in orders_raw]
        bad=[v for v in orders if v not in cue_orders]
        if bad:
            raise MaterialsExternalError(f"Day 5 Diagnostic check {index}: cue_orders inexistentes {bad}.")
        title=_text(item.get("title")); instruction=_text(item.get("instruction")); criteria=_text(item.get("success_criteria"))
        if not title or not instruction or not criteria:
            raise MaterialsExternalError(f"Day 5 Diagnostic check {index}: title, instruction e success_criteria são obrigatórios.")
        checks.append({"title":title,"cue_orders":orders,"instruction":instruction,"success_criteria":criteria})
    return {"intro":_text(raw.get("intro")),"checks":checks,"self_assessment":_text(raw.get("self_assessment"))}


def _expected_cs_map(approved_cs: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    expected={}
    for item in approved_cs:
        sequence=_as_int(item.get("sequenceOrder") or item.get("sequence_order"))
        if sequence>0:
            expected[sequence]=item
    return expected


def _validate_connected_speech_explanation(raw: Any, approved_cs: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(raw,dict) or not isinstance(raw.get("items"),list):
        raise MaterialsExternalError("connected_speech.items precisa ser array.")
    expected=_expected_cs_map(approved_cs); rows=raw.get("items") or []
    if len(rows)!=len(expected):
        raise MaterialsExternalError(f"Connected Speech deve conter exatamente {len(expected)} item(ns) aprovado(s); recebeu {len(rows)}.")
    received={}
    for index,row in enumerate(rows,1):
        if not isinstance(row,dict): raise MaterialsExternalError(f"Connected Speech item {index}: precisa ser objeto.")
        sequence=_as_int(row.get("sequence_order"))
        if sequence not in expected or sequence in received:
            raise MaterialsExternalError(f"Connected Speech item {index}: sequence_order inválido/duplicado.")
        note=_text(row.get("learner_note"))
        if not note: raise MaterialsExternalError(f"Connected Speech item {index}: learner_note é obrigatório.")
        source=expected[sequence]
        received[sequence]={
            "sequence_order":sequence,
            "cue_order":_as_int(source.get("cue_order") or source.get("cueOrder")),
            "type":_text(source.get("type")),
            "source_text":_text(source.get("source_text") or source.get("focusText") or source.get("focus_text")),
            "heard_as":_text(source.get("heard_as") or source.get("hearItAs") or source.get("naturalForm") or source.get("pronunciation")),
            "explanation_pt":_text(source.get("explanation_pt") or source.get("explanationPt")),
            "cue_en":_text(source.get("cue_en")), "cue_pt":_text(source.get("cue_pt")),
            "start_ms":_as_int(source.get("start_ms") or source.get("startMs")),
            "end_ms":_as_int(source.get("end_ms") or source.get("endMs")),
            "learner_note":note,
        }
    return {"items":[received[k] for k in sorted(received)]}


def _validate_connected_speech_practice(raw: Any, approved_cs: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(raw,dict) or not isinstance(raw.get("items"),list):
        raise MaterialsExternalError("connected_speech_practice.items precisa ser array.")
    expected=_expected_cs_map(approved_cs); rows=raw.get("items") or []
    if len(rows)!=len(expected):
        raise MaterialsExternalError(f"Connected Speech — Practice deve conter exatamente {len(expected)} item(ns); recebeu {len(rows)}.")
    received={}
    for index,row in enumerate(rows,1):
        if not isinstance(row,dict): raise MaterialsExternalError(f"Connected Speech — Practice item {index}: precisa ser objeto.")
        sequence=_as_int(row.get("sequence_order"))
        if sequence not in expected or sequence in received:
            raise MaterialsExternalError(f"Connected Speech — Practice item {index}: sequence_order inválido/duplicado.")
        tip=_text(row.get("practice_tip")); steps_raw=row.get("drill_steps")
        steps=[_text(v) for v in steps_raw if _text(v)] if isinstance(steps_raw,list) else []
        if not tip or not (CONTRACT_LIMITS["cs_practice_steps_min"]<=len(steps)<=CONTRACT_LIMITS["cs_practice_steps_max"]):
            raise MaterialsExternalError(f"Connected Speech — Practice item {index}: practice_tip e 2–4 drill_steps são obrigatórios.")
        received[sequence]={"sequence_order":sequence,"practice_tip":tip,"drill_steps":steps}
    return {"items":[received[k] for k in sorted(received)]}


def _validate_activity_list(raw: Any, cue_orders: set[int], label: str, *, answer_field: str="answer") -> list[dict[str, Any]]:
    if not isinstance(raw,list) or not raw:
        raise MaterialsExternalError(f"activities.{label} precisa ser array não vazio.")
    out=[]
    for index,item in enumerate(raw,1):
        if not isinstance(item,dict): raise MaterialsExternalError(f"activities.{label} item {index}: precisa ser objeto.")
        prompt=_text(item.get("prompt")); answer=_text(item.get(answer_field))
        orders_raw=item.get("cue_orders")
        if not prompt or not answer or not isinstance(orders_raw,list) or not orders_raw:
            raise MaterialsExternalError(f"activities.{label} item {index}: cue_orders, prompt e {answer_field} são obrigatórios.")
        orders=[_as_int(v) for v in orders_raw]; bad=[v for v in orders if v not in cue_orders]
        if bad: raise MaterialsExternalError(f"activities.{label} item {index}: cue_orders inexistentes {bad}.")
        out.append({"cue_orders":orders,"prompt":prompt,answer_field:answer})
    return out


def _validate_activities_exact(raw: Any, cue_orders: set[int], approved_cs: list[dict[str, Any]], *, is_music: bool = False) -> dict[str, Any]:
    if not isinstance(raw,dict) or not _text(raw.get("intro")):
        raise MaterialsExternalError("activities precisa ser objeto com intro.")
    required_activity_fields = (
        "intro", "listening_reconstruction", "connected_speech_hunt", "structure_transfer",
        "vocabulary_recall", "shadowing_challenge", "final_listening",
    )
    missing_activity_fields = [field for field in required_activity_fields if field not in raw]
    if missing_activity_fields:
        raise MaterialsExternalError("activities: campos obrigatórios ausentes: " + ", ".join(missing_activity_fields) + ".")
    listening=_validate_activity_list(raw.get("listening_reconstruction"),cue_orders,"listening_reconstruction")
    vocab=_validate_activity_list(raw.get("vocabulary_recall"),cue_orders,"vocabulary_recall")
    hunt_raw=raw.get("connected_speech_hunt")
    expected_cs=_expected_cs_map(approved_cs)
    hunt=[]
    if expected_cs:
        if not isinstance(hunt_raw,list) or not hunt_raw:
            raise MaterialsExternalError("activities.connected_speech_hunt precisa ser array não vazio quando houver Connected Speech aprovado.")
        for index,item in enumerate(hunt_raw,1):
            if not isinstance(item,dict): raise MaterialsExternalError(f"Connected Speech Hunt item {index}: precisa ser objeto.")
            seq=_as_int(item.get("sequence_order")); prompt=_text(item.get("prompt")); answer=_text(item.get("answer"))
            if seq not in expected_cs or not prompt or not answer:
                raise MaterialsExternalError(f"Connected Speech Hunt item {index}: sequence_order aprovado, prompt e answer são obrigatórios.")
            hunt.append({"sequence_order":seq,"prompt":prompt,"answer":answer})
    else:
        if hunt_raw != []:
            raise MaterialsExternalError("activities.connected_speech_hunt deve ser exatamente [] quando não houver Connected Speech aprovado.")
    transfer_raw=raw.get("structure_transfer")
    if not isinstance(transfer_raw,list) or not transfer_raw:
        raise MaterialsExternalError("activities.structure_transfer precisa ser array não vazio.")
    transfer=[]
    for index,item in enumerate(transfer_raw,1):
        if not isinstance(item,dict): raise MaterialsExternalError(f"Structure Transfer item {index}: precisa ser objeto.")
        title=_text(item.get("structure_title")); prompt=_text(item.get("prompt")); models=item.get("model_answers")
        models=[_text(v) for v in models if _text(v)] if isinstance(models,list) else []
        if not title or not prompt or not (CONTRACT_LIMITS["structure_transfer_models_min"]<=len(models)<=CONTRACT_LIMITS["structure_transfer_models_max"]):
            raise MaterialsExternalError(f"Structure Transfer item {index}: structure_title, prompt e 2–3 model_answers são obrigatórios.")
        transfer.append({"structure_title":title,"prompt":prompt,"model_answers":models})
    shadow=raw.get("shadowing_challenge")
    if is_music:
        if shadow != {}:
            raise MaterialsExternalError("activities.shadowing_challenge deve ser exatamente {} em Music.")
        shadow_orders=[]; shadow={}
    else:
        if not isinstance(shadow,dict): raise MaterialsExternalError("activities.shadowing_challenge precisa ser objeto.")
        shadow_orders=shadow.get("cue_orders"); shadow_orders=[_as_int(v) for v in shadow_orders] if isinstance(shadow_orders,list) else []
        if not shadow_orders or any(v not in cue_orders for v in shadow_orders) or not _text(shadow.get("prompt")) or not _text(shadow.get("success_criteria")):
            raise MaterialsExternalError("Shadowing Challenge precisa de cue_orders válidos, prompt e success_criteria.")
    final=raw.get("final_listening")
    if not isinstance(final,dict) or not _text(final.get("prompt")) or not _text(final.get("comprehension_record")):
        raise MaterialsExternalError("activities.final_listening precisa de prompt e comprehension_record.")
    return {
        "intro":_text(raw.get("intro")),
        "listening_reconstruction":listening,
        "connected_speech_hunt":hunt,
        "structure_transfer":transfer,
        "vocabulary_recall":vocab,
        "shadowing_challenge":({} if is_music else {"cue_orders":shadow_orders,"prompt":_text(shadow.get("prompt")),"success_criteria":_text(shadow.get("success_criteria"))}),
        "final_listening":{"prompt":_text(final.get("prompt")),"comprehension_record":_text(final.get("comprehension_record"))},
    }


def _validate_finalization(raw: Any) -> dict[str, Any]:
    if not isinstance(raw,dict): raise MaterialsExternalError("finalization precisa ser objeto.")
    title=_text(raw.get("title")); reflection=_text(raw.get("reflection_prompt")); next_review=_text(raw.get("next_review")); checklist=raw.get("checklist")
    checklist=[_text(v) for v in checklist if _text(v)] if isinstance(checklist,list) else []
    if not title or not reflection or not next_review or not (CONTRACT_LIMITS["finalization_checklist_min"]<=len(checklist)<=CONTRACT_LIMITS["finalization_checklist_max"]):
        raise MaterialsExternalError("finalization precisa de title, 3–6 checklist items, reflection_prompt e next_review.")
    return {"title":title,"checklist":checklist,"reflection_prompt":reflection,"next_review":next_review}


def validate_return(
    returned: dict[str, Any],
    canonical: dict[str, Any],
    connected_speech_review: dict[str, Any],
    *,
    canonical_sha256: str,
    connected_speech_review_sha256: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(returned, dict):
        raise MaterialsExternalError("A raiz do retorno precisa ser objeto JSON.")
    if returned.get("schema") != RETURN_SCHEMA:
        raise MaterialsExternalError(f"schema inválido. Esperado: {RETURN_SCHEMA}.")
    if str(returned.get("schema_version") or "") != RETURN_SCHEMA_VERSION:
        raise MaterialsExternalError(f"schema_version inválido. Esperado: {RETURN_SCHEMA_VERSION} para o PDF exato de 7 blocos.")
    snapshot_id = _text(canonical.get("snapshot_id"))
    if _text(returned.get("source_snapshot_id")) != snapshot_id:
        raise MaterialsExternalError("source_snapshot_id não pertence ao projeto atual.")
    if _text(returned.get("source_canonical_sha256")) != canonical_sha256:
        raise MaterialsExternalError("source_canonical_sha256 não corresponde ao canônico atual.")
    if _text(returned.get("source_connected_speech_review_sha256")) != connected_speech_review_sha256:
        raise MaterialsExternalError("source_connected_speech_review_sha256 não corresponde à conferência atual de Connected Speech.")

    cues=[cue for cue in (canonical.get("cues") or []) if isinstance(cue,dict) and _as_int(cue.get("order"))>0]
    cue_map={_as_int(cue.get("order")):cue for cue in cues}; cue_orders=set(cue_map)
    pdf_raw=returned.get("pdf_content")
    if not isinstance(pdf_raw,dict): raise MaterialsExternalError("pdf_content precisa ser objeto.")
    single_raw=pdf_raw.get("immersion_workbook")
    if not isinstance(single_raw,dict): raise MaterialsExternalError("pdf_content.immersion_workbook precisa ser objeto; PDFs separados não são aceitos.")
    extra=sorted(k for k in pdf_raw if k!="immersion_workbook")
    if extra: raise MaterialsExternalError("PDF único esperado; remova chaves extras de pdf_content: "+", ".join(extra)+".")
    objective=_text(single_raw.get("kit_objective"))
    if not objective: raise MaterialsExternalError("pdf_content.immersion_workbook.kit_objective é obrigatório.")
    anki_raw=returned.get("anki")
    if not isinstance(anki_raw,dict): raise MaterialsExternalError("anki precisa ser objeto.")

    approved_cs=_approved_cs(connected_speech_review)
    content_type=_text((canonical.get("project") or {}).get("content_type")) or "dialogue"
    is_music=content_type=="music"
    material_cs=[] if is_music else approved_cs
    cards=_validate_cards(anki_raw.get("items"),cue_map)
    diagnostic=_validate_day_5_diagnostic(single_raw.get("day_5_diagnostic"),cue_orders)
    cs=_validate_connected_speech_explanation(single_raw.get("connected_speech"),material_cs)
    cs_practice=_validate_connected_speech_practice(single_raw.get("connected_speech_practice"),material_cs)
    structures=_validate_structures(single_raw.get("structures_from_scene"),cue_orders)
    activities=_validate_activities_exact(single_raw.get("activities"),cue_orders,material_cs,is_music=is_music)
    finalization=_validate_finalization(single_raw.get("finalization"))
    if content_type=="music" and (cs.get("items") or cs_practice.get("items") or activities.get("connected_speech_hunt")):
        raise MaterialsExternalError("Music não pode conter Connected Speech no PDF.")

    draft={
        "schema":"immersionhub-materials-external-draft","schema_version":"1.3",
        "source_snapshot_id":snapshot_id,"source_canonical_sha256":canonical_sha256,
        "source_connected_speech_review_sha256":connected_speech_review_sha256,
        "generated_at_utc":_now_iso(),"source":"external_ai","content_type":content_type,
        "pdf_content":{"immersion_workbook":{
            "kit_objective":objective,
            "how_to_study":_how_to_study(content_type),
            "day_5_diagnostic":diagnostic,
            "connected_speech":cs,
            "connected_speech_practice":cs_practice,
            "structures_from_scene":structures,
            "activities":activities,
            "finalization":finalization,
        }},
        "anki":{"items":cards},
        "audio":{"strategy":"groq_tts_after_human_review","items":[]},
    }
    return draft,{"pdfs":1,"anki_cards":len(cards),"approved_connected_speech":len(approved_cs),"cues":len(cues),"structures":len(structures["items"]),"content_blocks":7}
