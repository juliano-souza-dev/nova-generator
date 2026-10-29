"""Independent Cards studio: JSON validation, frozen job and cards-only download."""
from __future__ import annotations

import json
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Annotated
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from nova_generator.api.dependencies import get_enqueue_job, get_manage_voice_profiles
from nova_generator.application.use_cases.cards_only import normalize_cards
from nova_generator.application.use_cases.manage_voice_profiles import _payload
from nova_generator.core.settings import get_settings
from nova_generator.domain.media.youtube import YoutubeVideo

router = APIRouter(prefix="/cards-only", tags=["cards-only"])
MAX_JSON = 3_000_000
MAX_AUDIO = 50 * 1024 * 1024


async def _read_cards(file: UploadFile) -> tuple[str, list[dict]]:
    if Path(file.filename or "").suffix.lower() != ".json":
        raise HTTPException(422, "Selecione um JSON válido.")
    body = await file.read(MAX_JSON + 1)
    if not body or len(body) > MAX_JSON:
        raise HTTPException(413, "O JSON deve ter até 3 MB.")
    try:
        document = json.loads(body.decode("utf-8-sig"))
        return normalize_cards(document)
    except ValueError as exc:
        raise HTTPException(422, f"JSON de cards inválido: {exc}") from exc



def _source_cues(document: dict) -> tuple[str, list[dict]]:
    source = document.get("source") if isinstance(document.get("source"), dict) else document
    title = source.get("title") or document.get("title") or "Cards IHUB"
    candidates = [
        cue for scene in source.get("scenes", [])
        if isinstance(scene, dict)
        for cue in scene.get("cues", []) if isinstance(cue, dict)
    ]
    if not candidates and isinstance(source.get("cues"), list):
        candidates = [cue for cue in source["cues"] if isinstance(cue, dict)]
    rows = []
    for index, cue in enumerate(candidates):
        english = cue.get("approved_en") or cue.get("final_en") or cue.get("en")
        portuguese = cue.get("approved_pt") or cue.get("pt")
        if not isinstance(english, str) or not english.strip():
            continue
        if not isinstance(portuguese, str) or not portuguese.strip():
            continue
        cue_id = cue.get("id") or cue.get("cue_id")
        if not cue_id:
            cue_id = str(uuid5(NAMESPACE_URL, f"cards-source:{index}:{english}:{portuguese}"))
        try:
            cue_id = str(UUID(str(cue_id)))
        except ValueError as exc:
            raise HTTPException(422, "O JSON contém um cue_id inválido.") from exc
        rows.append({"cue_id": cue_id, "source_context_en": english,
                     "source_context_pt": portuguese})
    if not rows or len(rows) > 20:
        raise HTTPException(
            422, "A geração com IA exige 1 a 20 falas com inglês e tradução em português."
        )
    if len({row["cue_id"] for row in rows}) != len(rows):
        raise HTTPException(422, "O JSON possui falas com IDs repetidos.")
    return str(title), rows


@router.post("/generate")
async def generate_cards_only(file: Annotated[UploadFile, File(...)]) -> dict:
    """Generate ONLY the didactic card lesson from a source JSON, never workbook sections."""
    raw = await file.read(MAX_JSON + 1)
    if not raw or len(raw) > MAX_JSON:
        raise HTTPException(413, "O JSON de origem deve ter até 3 MB.")
    try:
        source = json.loads(raw.decode("utf-8-sig"))
    except ValueError as exc:
        raise HTTPException(422, "O JSON de origem é inválido.") from exc
    if not isinstance(source, dict):
        raise HTTPException(422, "O JSON de origem deve ser um objeto.")
    title, rows = _source_cues(source)
    settings = get_settings()
    if not settings.groq_api_key:
        raise HTTPException(503, "Configure o Groq para gerar cards com IA.")
    try:
        from groq import Groq

        client = Groq(api_key=settings.groq_api_key, max_retries=0, timeout=60.0)
        result = client.chat.completions.create(
            model=settings.groq_editorial_model,
            temperature=0.15,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": (
                    "You write pedagogically precise Brazilian Portuguese/English flashcards. "
                    "Return ONLY JSON object {cards:[...]} with exactly one card per cue. "
                    "Every card must carry unchanged cue_id, source_context_en and "
                    "source_context_pt. Supply front_en, back_pt, uses_literal_scene_line, "
                    "card_type, focus_text, meaning, marked_en, marked_pt, explanation_pt, "
                    "example_en, example_pt, tags. Focus_text MUST be a literal substring "
                    "of source_context_en. Marked_en and marked_pt MUST be literal "
                    "substrings of front_en/back_pt. Write a fresh, accurate English "
                    "pedagogical sentence and an equivalent Portuguese sentence, and one "
                    "natural bilingual example. Never invent facts about the scene. "
                    "If front/back equal source context set uses_literal_scene_line=true, "
                    "otherwise false. Do not produce chapters, workbook or other material."
                )},
                {"role": "user", "content": json.dumps(
                    {"title": title, "cues": rows}, ensure_ascii=False
                )},
            ],
        )
        payload = json.loads(result.choices[0].message.content or "{}")
        proposed = payload.get("cards")
        if not isinstance(proposed, list) or len(proposed) != len(rows):
            raise ValueError("A IA retornou uma quantidade diferente de cards.")
        expected = {row["cue_id"]: row for row in rows}
        completed = []
        for item in proposed:
            if not isinstance(item, dict):
                raise ValueError("A IA retornou um card inválido.")
            reference = expected.get(str(item.get("cue_id")))
            if reference is None or any(
                item.get(field) != reference[field]
                for field in ("source_context_en", "source_context_pt")
            ):
                raise ValueError("A IA alterou o contexto literal da fonte.")
            item = dict(item)
            item["card_id"] = str(uuid5(
                NAMESPACE_URL, f"cards-ai:{item['cue_id']}:{item.get('focus_text', '')}"
            ))
            completed.append(item)
        if {str(card.get("cue_id")) for card in completed} != set(expected):
            raise ValueError("A IA omitiu ou repetiu falas.")
        _, prepared = normalize_cards({"title": title, "cards": completed})
        return {"title": title, "cards": prepared, "count": len(prepared),
                "needs_review": True}
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        raise HTTPException(502, f"Revise o resultado da IA: {exc}") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "A IA para cards está indisponível.") from exc

@router.post("/validate")
async def validate_cards_only(file: Annotated[UploadFile, File(...)]) -> dict:
    title, cards = await _read_cards(file)
    return {"title": title, "cards": cards, "count": len(cards)}


@router.post("/exports", status_code=202)
async def prepare_cards_only(
    file: Annotated[UploadFile, File(...)],
    voice_id: Annotated[UUID, Form(...)],
    youtube_url: Annotated[str, Form()] = "",
    audio_file: Annotated[UploadFile | None, File()] = None,
) -> dict:
    title, cards = await _read_cards(file)
    if bool(youtube_url.strip()) == bool(audio_file is not None):
        raise HTTPException(422, "Escolha uma origem: link do YouTube OU MP3/WAV enviado.")
    voice = get_manage_voice_profiles().get(voice_id)
    if voice is None:
        raise HTTPException(404, "Voz selecionada não encontrada.")
    youtube = None
    audio_content = None
    suffix = None
    if youtube_url.strip():
        try:
            youtube = YoutubeVideo.from_url(youtube_url.strip()).canonical_url
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    else:
        assert audio_file is not None
        suffix = Path(audio_file.filename or "").suffix.lower()
        if suffix not in {".mp3", ".wav"}:
            raise HTTPException(422, "O áudio de origem deve ser MP3 ou WAV.")
        audio_content = await audio_file.read(MAX_AUDIO + 1)
        if not audio_content or len(audio_content) > MAX_AUDIO:
            raise HTTPException(413, "O áudio deve ter até 50 MiB.")
    export_id = uuid4()
    folder = get_settings().media_cache_root / "cards-only" / str(export_id)
    folder.mkdir(parents=True, exist_ok=False)
    card_bytes = json.dumps(
        {"title": title, "cards": cards}, ensure_ascii=False, sort_keys=True
    ).encode("utf-8")
    (folder / "input.json").write_bytes(card_bytes)
    audio_sha = None
    if audio_content is not None:
        assert suffix is not None
        asset = folder / f"source{suffix}"
        asset.write_bytes(audio_content)
        audio_sha = sha256(audio_content).hexdigest()
        try:
            check = subprocess.run(
                [get_settings().ffprobe_executable, "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_type",
                "-of", "default=noprint_wrappers=1", str(asset),
            ],
                capture_output=True, text=True, timeout=30, check=False,
            )
            if check.returncode or "codec_type=audio" not in check.stdout:
                raise HTTPException(422, "O MP3/WAV não contém áudio válido.")
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(503, "Não foi possível verificar o áudio de origem.") from exc
    job = get_enqueue_job().execute(
            kind="cards-only.export",
            input={
                "export_id": str(export_id), "input_sha256": sha256(card_bytes).hexdigest(),
                "audio_sha256": audio_sha, "audio_extension": suffix,
                "youtube_url": youtube, "voice_snapshot": _payload(voice.snapshot()),
            },
            idempotency_key=f"cards-only:{export_id}",
            max_attempts=2,
    )
    return {
        "export_id": str(export_id), "job_id": str(job.id),
        "status": job.status, "count": len(cards),
    }


def _finished(export_id: UUID) -> Path:
    folder = get_settings().media_cache_root / "cards-only" / str(export_id)
    if not (folder / "manifest.json").is_file():
        raise HTTPException(404, "A exportação de cards ainda não foi concluída.")
    return folder


@router.get("/exports/{export_id}/bundle")
def download_cards_only(export_id: UUID) -> FileResponse:
    path = _finished(export_id) / "cards-only.zip"
    if not path.is_file():
        raise HTTPException(404, "Pacote de cards não encontrado.")
    return FileResponse(path, media_type="application/zip", filename="cards-only.zip")


@router.get("/exports/{export_id}/cards.json")
def download_cards_json(export_id: UUID) -> FileResponse:
    path = _finished(export_id) / "cards.json"
    return FileResponse(path, media_type="application/json", filename="cards.json")


@router.get("/exports/{export_id}/anki.apkg")
def download_cards_apkg(export_id: UUID) -> FileResponse:
    path = _finished(export_id) / "anki.apkg"
    return FileResponse(path, media_type="application/octet-stream", filename="anki.apkg")


@router.get("/exports/{export_id}/audio/{card_id}")
def stream_cards_audio(export_id: UUID, card_id: UUID) -> FileResponse:
    path = _finished(export_id) / "audio" / f"anki_{card_id}.wav"
    if not path.is_file():
        raise HTTPException(404, "Áudio do card indisponível.")
    return FileResponse(path, media_type="audio/wav", content_disposition_type="inline")
