from __future__ import annotations

import array
import copy
import difflib
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import stat
import subprocess
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode, urlparse

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from youtube_pipeline import download_video, inspect_embed_support
from ai_provider import groq_readiness, list_groq_models, public_ai_settings, save_ai_settings, test_groq_connection
from materials_review_flow import approved_payload, build_review, normalize_review, review_summary, validate_finalize
from materials_external import _validate_cards as validate_one_pass_cards, build_package as build_materials_external_package, validate_return as validate_materials_external_return
from materials_final import generate_final_materials
from tts_service import synthesize_tts

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
WORKSPACE_DIR = BASE_DIR / "workspace"
PROJECTS_DIR = BASE_DIR / "projects"
PROJECTS_INDEX_FILE = PROJECTS_DIR / "index.json"
SOURCE_EN_DIR = WORKSPACE_DIR / "source" / "en"
STATE_FILE = WORKSPACE_DIR / "state.json"
SOURCE_EN_FILE = SOURCE_EN_DIR / "original.mp4"
PROCESS_DIR = WORKSPACE_DIR / "process"
PROCESS_SOURCE_DIR = PROCESS_DIR / "source"
PROCESS_OUTPUT_DIR = PROCESS_DIR / "output"
PROCESS_SOURCE_FILE = PROCESS_SOURCE_DIR / "original.mp4"
PROCESS_VIDEO_FILE = PROCESS_OUTPUT_DIR / "scene_video.mp4"
PROCESS_AUDIO_FILE = PROCESS_OUTPUT_DIR / "scene_audio_16k_mono.wav"
PROCESS_JSON_FILE = PROCESS_OUTPUT_DIR / "initial_scene.json"

TEMPLATE_DIR = BASE_DIR / "templates"
CANONICAL_TEMPLATE_FILE = TEMPLATE_DIR / "canonical_v1_7.json"
EXTERNAL_AI_DIR = WORKSPACE_DIR / "external_ai"
EXTERNAL_AI_CANONICAL_FILE = EXTERNAL_AI_DIR / "canonical_scene.json"
EXTERNAL_AI_INSTRUCTIONS_FILE = EXTERNAL_AI_DIR / "INSTRUCOES_EXTERNAL_AI.txt"
EXTERNAL_AI_ZIP_FILE = EXTERNAL_AI_DIR / "external_ai_scene.zip"
EXTERNAL_AI_RETURN_FILE = EXTERNAL_AI_DIR / "external_ai_return.json"
EXTERNAL_AI_ONE_PASS_FILE = EXTERNAL_AI_DIR / "one_pass_final_materials.json"
EXTERNAL_AI_EXTRACTION_FILE = EXTERNAL_AI_DIR / "extracao_cues.txt"
EXTERNAL_AI_CONTRACT_VERSION = "2.2.0-one-pass-wbw-practices"
CUE_REVIEW_DIR = WORKSPACE_DIR / "cue_review"
CUE_REVIEW_CANONICAL_FILE = CUE_REVIEW_DIR / "canonical_scene_reviewed.json"
WORD_REVIEW_DIR = WORKSPACE_DIR / "word_review"
WORD_REVIEW_CANONICAL_FILE = WORD_REVIEW_DIR / "canonical_scene_word_reviewed.json"
CUE_TIMING_DIR = WORKSPACE_DIR / "cue_timing"
CUE_TIMING_CANONICAL_FILE = CUE_TIMING_DIR / "canonical_scene_timing_reviewed.json"
CUE_TIMING_WAVEFORM_FILE = CUE_TIMING_DIR / "waveform.json"
WORD_TIMING_DIR = WORKSPACE_DIR / "word_timing"
WORD_TIMING_CANONICAL_FILE = WORD_TIMING_DIR / "canonical_scene_word_timing_reviewed.json"
DUAL_SCENE_DIR = WORKSPACE_DIR / "dual_scene"
DUAL_SCENE_PT_DIR = DUAL_SCENE_DIR / "pt"
DUAL_SCENE_PT_FILE = DUAL_SCENE_PT_DIR / "original.mp4"
DUAL_SCENE_PT_AUDIO_FILE = DUAL_SCENE_PT_DIR / "audio.wav"
DUAL_SCENE_PT_WAVEFORM_FILE = DUAL_SCENE_DIR / "pt_waveform.json"
DUAL_SCENE_FILE = DUAL_SCENE_DIR / "dual_scene.json"
SHADOWING_DIR = WORKSPACE_DIR / "shadowing"
SHADOWING_PLAN_FILE = SHADOWING_DIR / "shadowing.json"
CONNECTED_SPEECH_DIR = WORKSPACE_DIR / "connected_speech"
CONNECTED_SPEECH_CANONICAL_FILE = CONNECTED_SPEECH_DIR / "canonical_scene_current.json"
CONNECTED_SPEECH_SCOPE_FILE = CONNECTED_SPEECH_DIR / "ESCOPO_CONNECTED_SPEECH.txt"
CONNECTED_SPEECH_INSTRUCTIONS_FILE = CONNECTED_SPEECH_DIR / "INSTRUCOES_CONNECTED_SPEECH.txt"
CONNECTED_SPEECH_ZIP_FILE = CONNECTED_SPEECH_DIR / "connected_speech_external_ai.zip"
CONNECTED_SPEECH_RETURN_FILE = CONNECTED_SPEECH_DIR / "connected_speech_return.json"
CONNECTED_SPEECH_REVIEW_FILE = CONNECTED_SPEECH_DIR / "connected_speech_review.json"
MATERIALS_EXTERNAL_DIR = WORKSPACE_DIR / "materials_external"
MATERIALS_EXTERNAL_CONTRACT_VERSION = "1.3"
MATERIALS_EXTERNAL_PACKAGE_DIR = MATERIALS_EXTERNAL_DIR / "package"
MATERIALS_EXTERNAL_ZIP_FILE = MATERIALS_EXTERNAL_DIR / "external_ai_materials.zip"
MATERIALS_EXTERNAL_RETURN_FILE = MATERIALS_EXTERNAL_DIR / "materials_external_ai_return.json"
MATERIALS_EXTERNAL_DRAFT_FILE = MATERIALS_EXTERNAL_DIR / "materials_external_ai_draft.json"
MATERIALS_TTS_DIR = WORKSPACE_DIR / "materials_tts" / "tts"
MATERIALS_TTS_MANIFEST_FILE = WORKSPACE_DIR / "materials_tts" / "tts_manifest.json"
MATERIALS_TTS_AUDIO_ZIP_FILE = WORKSPACE_DIR / "materials_tts" / "materials_tts_audio.zip"
MATERIALS_TTS_VOICES = ("diana", "hannah", "troy", "austin")
MATERIALS_REVIEW_DIR = WORKSPACE_DIR / "materials_review"
MATERIALS_REVIEW_FILE = MATERIALS_REVIEW_DIR / "materials_review.json"
MATERIALS_REVIEW_APPROVED_FILE = MATERIALS_REVIEW_DIR / "materials_review_approved.json"
MATERIALS_FINAL_DIR = WORKSPACE_DIR / "materials_final"
MATERIALS_FINAL_OUTPUT_DIR = MATERIALS_FINAL_DIR / "output"
AI_TTS_TEST_FILE = WORKSPACE_DIR / "ai" / "tts_test.wav"

WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
SOURCE_EN_DIR.mkdir(parents=True, exist_ok=True)

APP_NAME = "Media and Subtitle Generator"
APP_VERSION = "Alpha 1.39"
BUILD_ID = "alpha-1.39-cue-word-sync"

app = FastAPI(title=APP_NAME, version="alpha-1.39")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/media", StaticFiles(directory=WORKSPACE_DIR), name="media")

_state_lock = threading.Lock()
_wave_lock = threading.Lock()
_process_lock = threading.Lock()
_external_ai_lock = threading.Lock()
_connected_speech_lock = threading.Lock()
_materials_final_lock = threading.Lock()


def _default_state() -> dict[str, Any]:
    return {
        "app": {"name": APP_NAME, "version": APP_VERSION, "build_id": BUILD_ID},
        "en": {"url": "", "validated": False, "embeddable": False, "title": "", "video_id": "", "reason": ""},
        "pt": {"url": "", "validated": False, "embeddable": False, "title": "", "video_id": "", "reason": ""},
        "configuration": {"content_type": "", "dual_scene": False, "transcription_mode": "external", "configured": False},
        "wave": {
            "status": "idle",
            "percent": 0,
            "message": "Aguardando configuração.",
            "duration_ms": 0,
            "waveform": [],
            "media_url": "",
            "source_url": "",
            "error": "",
        },
        "cut": {"start_ms": 0, "end_ms": 0, "saved": False},
        "process": {
            "status": "idle",
            "percent": 0,
            "message": "Aguardando recorte.",
            "logs": [],
            "artifacts": [],
            "error": "",
            "started_at": "",
            "finished_at": "",
        },
        "external_ai": {
            "status": "idle",
            "snapshot_id": "",
            "generated_at_utc": "",
            "artifacts": [],
            "error": "",
            "validated": False,
            "returned_filename": "",
            "validation_summary": {},
            "validated_at": "",
        },
        "cue_review": {
            "status": "idle",
            "source_snapshot_id": "",
            "total": 0,
            "accepted_orders": [],
            "current_order": 1,
            "completed": False,
            "updated_at": "",
        },
        "word_review": {
            "status": "idle",
            "source_snapshot_id": "",
            "total_words": 0,
            "accepted_keys": [],
            "current_cue_order": 1,
            "current_word_index": 0,
            "completed": False,
            "updated_at": "",
        },
        "cue_timing": {
            "status": "idle",
            "source_snapshot_id": "",
            "source_revision": "",
            "total": 0,
            "accepted_orders": [],
            "current_order": 1,
            "completed": False,
            "speaker_options": [],
            "updated_at": "",
        },
        "word_timing": {
            "status": "idle",
            "source_snapshot_id": "",
            "source_revision": "",
            "timing_scope_version": "per-word-v2-cue-authoritative",
            "total_units": 0,
            "accepted_keys": [],
            "current_cue_order": 1,
            "current_unit_index": 0,
            "completed": False,
            "updated_at": "",
        },
        "dual_scene": {"status": "idle", "blocks": [], "completed": False, "updated_at": ""},
        "shadowing": {
            "status": "idle",
            "source_snapshot_id": "",
            "source_revision": "",
            "pause_markers_ms": [],
            "end_ms": None,
            "segments": [],
            "completed": False,
            "updated_at": "",
        },
        "connected_speech": {
            "status": "idle",
            "source_snapshot_id": "",
            "source_revision": "",
            "generated_at_utc": "",
            "work_start_ms": 0,
            "work_end_ms": 0,
            "artifacts": [],
            "error": "",
            "returned_filename": "",
            "validated": False,
            "validation_summary": {},
            "validated_at": "",
            "review_total": 0,
            "review_decisions": {},
            "current_sequence_order": 0,
            "review_completed": False,
            "review_updated_at": "",
        },
        "materials_external": {
            "status": "idle",
            "message": "Aguardando conferência do Connected Speech.",
            "source_snapshot_id": "",
            "source_canonical_sha256": "",
            "source_connected_speech_review_sha256": "",
            "contract_version": "",
            "artifacts": [],
            "error": "",
            "returned_filename": "",
            "validated": False,
            "validation_summary": {},
            "prepared_at": "",
            "validated_at": "",
        },
        "materials_review": {
            "status": "idle",
            "message": "Aguardando retorno da IA externa.",
            "summary": {},
            "updated_at": "",
        },
        "materials_final": {
            "status": "idle",
            "percent": 0,
            "message": "Aguardando revisão dos materiais.",
            "logs": [],
            "artifacts": [],
            "error": "",
            "failed_items": [],
            "started_at": "",
            "finished_at": "",
        },
    }


def _read_state() -> dict[str, Any]:
    if not STATE_FILE.is_file():
        return _default_state()
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return _default_state()
    if not isinstance(data, dict):
        return _default_state()
    base = _default_state()
    for key in ("en", "pt", "configuration", "wave", "cut", "process", "external_ai", "cue_review", "word_review", "cue_timing", "word_timing", "dual_scene", "shadowing", "connected_speech", "materials_external", "materials_review", "materials_final"):
        if isinstance(data.get(key), dict):
            base[key].update(data[key])
    base["app"] = _default_state()["app"]
    return base


def _write_state(state: dict[str, Any]) -> None:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _update_state(mutator) -> dict[str, Any]:
    with _state_lock:
        state = _read_state()
        mutator(state)
        _write_state(state)
        return state


_project_lock = threading.RLock()


def _remove_project_tree(path: Path) -> None:
    if not path.exists():
        return
    def unlock_and_retry(function, target, _exc) -> None:
        os.chmod(target, stat.S_IWRITE)
        function(target)
    shutil.rmtree(path, onexc=unlock_and_retry)


def _safe_project_id(value: Any) -> str:
    project_id = str(value or "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{5,80}", project_id):
        raise ValueError("Projeto inválido.")
    return project_id


def _read_projects_index() -> dict[str, Any]:
    if PROJECTS_INDEX_FILE.is_file():
        try:
            data = json.loads(PROJECTS_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("projects"), list):
                return data
        except Exception:
            pass
    return {"active_project_id": "", "projects": []}


def _write_projects_index(index: dict[str, Any]) -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_INDEX_FILE.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _project_video_details(item: dict[str, Any]) -> dict[str, Any]:
    details = dict(item)
    state_file = PROJECTS_DIR / str(item.get("id") or "") / "workspace" / "state.json"
    try:
        project_state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        project_state = {}
    source = project_state.get("en") if isinstance(project_state.get("en"), dict) else {}
    wave = project_state.get("wave") if isinstance(project_state.get("wave"), dict) else {}
    video_id = str(source.get("video_id") or details.get("video_id") or "").strip()
    title = str(source.get("title") or details.get("name") or "Projeto sem título").strip()
    if str(details.get("name") or "").strip().lower() in {"", "novo projeto", "projeto sem título"}:
        details["name"] = title
    details.update({"video_title": title, "source_url": str(source.get("url") or details.get("source_url") or ""), "video_id": video_id, "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg" if video_id else "", "duration_ms": int(wave.get("duration_ms") or 0), "content_type": str((project_state.get("configuration") or {}).get("content_type") or "")})
    return details


def _music_without_shadowing(state: dict[str, Any]) -> bool:
    config = state.get("configuration") or {}
    return config.get("content_type") == "music" and config.get("shadowing_enabled") is False


def _project_progress(state: dict[str, Any]) -> tuple[str, str, str]:
    if (state.get("imported_final") or {}).get("media_pending"):
        return "in_progress", "JSON importado · preparar mídia", "/process"
    active_stages = [
        ("materials_final", {"running", "failed"}, "Geração final", "/materials-final"),
        ("materials_review", {"reviewing"}, "Revisão de materiais", "/materials-review"),
        ("shadowing", {"editing"}, "Shadowing", "/shadowing"),
        ("word_timing", {"reviewing"}, "WbW Timing", "/word-timing"),
        ("cue_timing", {"reviewing"}, "Cue Timing", "/cue-timing"),
        ("word_review", {"reviewing"}, "Word by Word", "/word-review"),
        ("cue_review", {"reviewing"}, "Revisão de cues", "/cue-review"),
    ]
    for key, statuses, label, url in active_stages:
        if key == "shadowing" and _music_without_shadowing(state):
            continue
        if str((state.get(key) or {}).get("status") or "") in statuses:
            return "in_progress", label, url
    stages = [
        ("materials_final", "completed", "Concluído", "/materials-final"),
        ("materials_review", "completed", "Revisão de materiais", "/materials-review"),
        ("shadowing", "completed", "Shadowing", "/shadowing"),
        ("word_timing", "completed", "WbW Timing", "/word-timing"),
        ("cue_timing", "completed", "Cue Timing", "/cue-timing"),
        ("word_review", "completed", "Word by Word", "/word-review"),
        ("cue_review", "completed", "Revisão de cues", "/cue-review"),
        ("external_ai", "validated", "Retorno da IA", "/external-ai"),
        ("process", "status", "Mídia processada", "/process"),
    ]
    for key, flag, label, url in stages:
        if key == "shadowing" and _music_without_shadowing(state):
            continue
        if key == "word_timing" and _music_without_shadowing(state) and (state.get(key) or {}).get("completed"):
            return "in_progress", "Materiais de Música", "/materials-external"
        section = state.get(key) or {}
        value = section.get(flag)
        if value is True or (key == "process" and value == "ready"):
            return ("completed" if key == "materials_final" else "in_progress", label, url)
    if (state.get("en") or {}).get("validated"):
        return "in_progress", "Fonte validada", "/config"
    return "draft", "Novo projeto", "/source"


def _workspace_has_project() -> bool:
    state = _read_state()
    return bool((state.get("en") or {}).get("url") or (state.get("configuration") or {}).get("configured"))


def _sync_active_project(index: dict[str, Any] | None = None) -> dict[str, Any]:
    index = index or _read_projects_index()
    if not _workspace_has_project():
        return index
    state = _read_state()
    project_id = str(index.get("active_project_id") or "")
    if not project_id:
        project_id = f"project-{uuid.uuid4().hex[:12]}"
        index["active_project_id"] = project_id
    target = PROJECTS_DIR / _safe_project_id(project_id) / "workspace"
    if target.exists():
        _remove_project_tree(target)
    shutil.copytree(WORKSPACE_DIR, target)
    status, status_label, continue_url = _project_progress(state)
    now = _now_iso()
    existing = next((item for item in index["projects"] if item.get("id") == project_id), None)
    payload = {
        "id": project_id,
        "name": str((existing or {}).get("name") or (state.get("en") or {}).get("title") or "Projeto sem título"),
        "source_url": str((state.get("en") or {}).get("url") or ""),
        "video_id": str((state.get("en") or {}).get("video_id") or ""),
        "status": status, "status_label": status_label, "continue_url": continue_url,
        "created_at": str((existing or {}).get("created_at") or now), "updated_at": now,
    }
    if existing:
        existing.update(payload)
    else:
        index["projects"].append(payload)
    _write_projects_index(index)
    return index


def _clear_active_workspace() -> None:
    if WORKSPACE_DIR.exists():
        _remove_project_tree(WORKSPACE_DIR)
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    _write_state(_default_state())


def _is_youtube_url(value: str) -> bool:
    try:
        parsed = urlparse(value.strip())
    except Exception:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    valid_hosts = {
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "youtu.be", "www.youtu.be",
    }
    return host in valid_hosts


def _reset_after_en_change(state: dict[str, Any]) -> None:
    state["configuration"] = {"content_type": "", "dual_scene": False, "transcription_mode": "external", "configured": False}
    state["pt"] = _default_state()["pt"]
    state["wave"] = _default_state()["wave"]
    state["cut"] = _default_state()["cut"]
    state["process"] = _default_state()["process"]
    state["external_ai"] = _default_state()["external_ai"]
    state["cue_review"] = _default_state()["cue_review"]
    state["word_review"] = _default_state()["word_review"]
    state["cue_timing"] = _default_state()["cue_timing"]
    state["word_timing"] = _default_state()["word_timing"]
    state["connected_speech"] = _default_state()["connected_speech"]
    state["materials_external"] = _default_state()["materials_external"]
    state["materials_review"] = _default_state()["materials_review"]
    state["materials_final"] = _default_state()["materials_final"]
    shutil.rmtree(CONNECTED_SPEECH_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_EXTERNAL_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
    shutil.rmtree(MATERIALS_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)
    shutil.rmtree(CUE_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(CUE_TIMING_DIR, ignore_errors=True)
    shutil.rmtree(WORD_TIMING_DIR, ignore_errors=True)
    shutil.rmtree(PROCESS_DIR, ignore_errors=True)
    shutil.rmtree(EXTERNAL_AI_DIR, ignore_errors=True)
    shutil.rmtree(SOURCE_EN_DIR, ignore_errors=True)
    SOURCE_EN_DIR.mkdir(parents=True, exist_ok=True)


def _probe_duration_ms(path: Path) -> int:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError("Não foi possível identificar a duração do vídeo.")
    try:
        return max(1, round(float(result.stdout.strip()) * 1000))
    except ValueError as exc:
        raise RuntimeError("O ffprobe retornou uma duração inválida.") from exc


def _probe_fps(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        return 0.0
    raw = result.stdout.strip()
    try:
        if "/" in raw:
            num, den = raw.split("/", 1)
            den_f = float(den)
            return round(float(num) / den_f, 6) if den_f else 0.0
        return round(float(raw), 6)
    except Exception:
        return 0.0


def _generate_waveform(path: Path, points: int = 2400) -> list[float]:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError("Não foi possível gerar a waveform.\n" + detail)
    samples = array.array("h")
    samples.frombytes(result.stdout)
    if not samples:
        return [0.0] * points
    window = max(1, math.ceil(len(samples) / points))
    peaks: list[float] = []
    for index in range(0, len(samples), window):
        chunk = samples[index:index + window]
        peak = max((abs(v) for v in chunk), default=0) / 32768.0
        peaks.append(round(min(1.0, peak), 4))
    if len(peaks) < points:
        peaks.extend([0.0] * (points - len(peaks)))
    return peaks[:points]


def _wave_update(**values: Any) -> None:
    def mutate(state: dict[str, Any]) -> None:
        state["wave"].update(values)
    _update_state(mutate)


def _prepare_wave_job(source_url: str) -> None:
    try:
        if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
            raise RuntimeError("FFmpeg/ffprobe não encontrados no PATH.")

        _wave_update(status="running", percent=4, message="Preparando vídeo fonte…", error="", source_url=source_url)

        def progress(percent: float, stage: str, message: str) -> None:
            mapped = 8 + int(max(0, min(100, percent)) * 0.62)
            _wave_update(status="running", percent=min(70, mapped), message=f"{stage}: {message}")

        download_video(source_url, SOURCE_EN_DIR, progress=progress, highest_quality=True)
        if not SOURCE_EN_FILE.is_file() or SOURCE_EN_FILE.stat().st_size <= 0:
            raise RuntimeError("O download terminou sem gerar o vídeo fonte.")

        _wave_update(status="running", percent=78, message="Lendo duração do vídeo…")
        duration_ms = _probe_duration_ms(SOURCE_EN_FILE)
        _wave_update(status="running", percent=84, message="Gerando waveform real…")
        waveform = _generate_waveform(SOURCE_EN_FILE)

        def finish(state: dict[str, Any]) -> None:
            state["wave"].update({
                "status": "ready",
                "percent": 100,
                "message": "Wave Editor pronto.",
                "duration_ms": duration_ms,
                "waveform": waveform,
                "media_url": "/media/source/en/original.mp4",
                "source_url": source_url,
                "error": "",
            })
            if not state["cut"].get("saved"):
                state["cut"].update({"start_ms": 0, "end_ms": min(duration_ms, 30000), "saved": False})
        _update_state(finish)
    except Exception as exc:
        _wave_update(status="failed", percent=100, message="Falha ao preparar o Wave Editor.", error=str(exc))



def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _human_bytes(value: int) -> str:
    number = float(max(0, value))
    for unit in ("B", "KB", "MB", "GB"):
        if number < 1024 or unit == "GB":
            return f"{number:.1f} {unit}"
        number /= 1024
    return f"{number:.1f} GB"


def _reset_process_files() -> None:
    shutil.rmtree(PROCESS_DIR, ignore_errors=True)
    PROCESS_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    PROCESS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _process_update(*, status: str | None = None, percent: int | None = None, message: str | None = None,
                    error: str | None = None, log: str | None = None, level: str = "info",
                    artifact: dict[str, Any] | None = None, finished: bool = False) -> dict[str, Any]:
    def mutate(state: dict[str, Any]) -> None:
        proc = state["process"]
        if status is not None:
            proc["status"] = status
        if percent is not None:
            proc["percent"] = max(0, min(100, int(percent)))
        if message is not None:
            proc["message"] = message
        if error is not None:
            proc["error"] = error
        if log:
            logs = list(proc.get("logs") or [])
            logs.append({"at": _now_iso(), "level": level, "message": str(log)})
            proc["logs"] = logs[-400:]
        if artifact:
            artifacts = [a for a in list(proc.get("artifacts") or []) if a.get("key") != artifact.get("key")]
            artifacts.append(artifact)
            proc["artifacts"] = artifacts
        if finished:
            proc["finished_at"] = _now_iso()
    return _update_state(mutate)


def _artifact_payload(key: str, name: str, kind: str, path: Path, description: str) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "kind": kind,
        "description": description,
        "size_bytes": int(path.stat().st_size if path.is_file() else 0),
        "size_label": _human_bytes(path.stat().st_size if path.is_file() else 0),
        "download_url": f"/api/process/artifact/{key}",
    }


def _run_ffmpeg_attempts(attempts: list[tuple[str, list[str]]], output: Path, *, stage: str) -> str:
    failures: list[str] = []
    for index, (label, command) in enumerate(attempts, start=1):
        try:
            output.unlink(missing_ok=True)
        except OSError:
            pass
        _process_update(log=f"{stage}: tentativa {index}/{len(attempts)} · {label}", level="info")
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode == 0 and output.is_file() and output.stat().st_size > 0:
            _process_update(log=f"{stage}: concluído com {label}.", level="success")
            return label
        detail = (result.stderr or result.stdout or "erro não informado").strip()
        last_line = detail.splitlines()[-1] if detail else "erro não informado"
        failures.append(f"{label}: {last_line}")
        _process_update(log=f"{stage}: {label} falhou · {last_line}", level="warning")
    raise RuntimeError(f"{stage} falhou após {len(attempts)} estratégias. " + " | ".join(failures[-3:]))


def _clip_video(source: Path, output: Path, start_ms: int, end_ms: int) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    start = f"{start_ms / 1000:.3f}"
    duration = f"{(end_ms - start_ms) / 1000:.3f}"
    base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", start, "-i", str(source), "-t", duration]
    attempts = [
        ("H.264 + AAC (preciso)", [*base, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(output)]),
        ("MPEG-4 + AAC", [*base, "-map", "0:v:0", "-map", "0:a?", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(output)]),
        ("stream copy", [*base, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(output)]),
    ]
    return _run_ffmpeg_attempts(attempts, output, stage="Recorte do vídeo")


def _extract_audio(scene_video: Path, source: Path, output: Path, start_ms: int, end_ms: int) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    start = f"{start_ms / 1000:.3f}"
    duration = f"{(end_ms - start_ms) / 1000:.3f}"
    attempts = [
        ("vídeo recortado → PCM 16 kHz mono", ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(scene_video), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output)]),
        ("fonte original → PCM 16 kHz mono", ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", start, "-i", str(source), "-t", duration, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output)]),
        ("fonte original + resampler", ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", start, "-i", str(source), "-t", duration, "-vn", "-af", "aresample=16000", "-ac", "1", "-c:a", "pcm_s16le", str(output)]),
    ]
    return _run_ffmpeg_attempts(attempts, output, stage="Extração/conversão do áudio")


def _transcribe_scene_locally(audio_path: Path, duration_ms: int) -> list[dict[str, Any]]:
    try:
        from faster_whisper import WhisperModel
    except ModuleNotFoundError as exc:
        raise RuntimeError("Transcrição local indisponível. Execute install.bat para instalar faster-whisper.") from exc
    model = WhisperModel("small.en", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(audio_path), language="en", beam_size=5, vad_filter=True, word_timestamps=True, condition_on_previous_text=True)
    cues: list[dict[str, Any]] = []
    for segment in segments:
        words: list[dict[str, Any]] = []
        previous_start = -1
        for raw_word in (segment.words or []):
            text = str(raw_word.word or "").strip()
            if not text:
                continue
            start_ms = max(0, min(duration_ms - 1, int(round(float(raw_word.start or 0) * 1000))))
            start_ms = max(start_ms, previous_start + 1)
            end_ms = max(start_ms + 1, min(duration_ms, int(round(float(raw_word.end or 0) * 1000))))
            probability = max(0.0, min(1.0, float(raw_word.probability or 0.0)))
            words.append({"text": text, "start_ms": start_ms, "end_ms": end_ms, "original_start_ms": start_ms, "original_end_ms": end_ms, "confidence_score": round(probability, 4), "review_status": "pending", "alignment_source": "generator_whisper", "audio_confidence": round(probability, 4), "composite_confidence": round(probability, 4), "qc_status": "needs_review", "qc_reasons": [], "qc_auto_fixed": False, "human_verified_audio": False, "pt": ""})
            previous_start = start_ms
        if not words:
            continue
        cue_start = words[0]["start_ms"]
        cue_end = max(word["end_ms"] for word in words)
        text = " ".join(word["text"] for word in words).strip()
        cues.append({"order": len(cues) + 1, "speech_start_ms": cue_start, "speech_end_ms": cue_end, "subtitle_start_ms": cue_start, "subtitle_end_ms": cue_end, "speaker": "", "original_en": text, "approved_en": text, "pt": "", "words": words})
    if not cues:
        raise RuntimeError("A transcrição local não detectou fala no trecho selecionado.")
    return cues


def _build_initial_json(state: dict[str, Any], video_strategy: str, audio_strategy: str, local_cues: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    cut = state["cut"]
    cfg = state["configuration"]
    en = state["en"]
    pt = state["pt"]
    document: dict[str, Any] = {
        "version": 1,
        "generator": {"name": APP_NAME, "version": APP_VERSION, "build_id": BUILD_ID},
        "content_type": str(cfg.get("content_type") or ""),
        "dual_scene": bool(cfg.get("dual_scene")),
        "source": {
            "en": {
                "url": str(en.get("url") or ""),
                "title": str(en.get("title") or ""),
                "video_id": str(en.get("video_id") or ""),
                "embeddable": bool(en.get("embeddable")),
            }
        },
        "cut": {
            "start_ms": int(cut.get("start_ms") or 0),
            "end_ms": int(cut.get("end_ms") or 0),
            "duration_ms": int(cut.get("end_ms") or 0) - int(cut.get("start_ms") or 0),
            "timeline": "source_video_ms",
        },
        "scene_timeline": {
            "start_ms": 0,
            "end_ms": _probe_duration_ms(PROCESS_VIDEO_FILE),
            "timeline": "scene_local_ms",
        },
        "media": {
            "downloaded_video": {"file": "original.mp4", "size_bytes": PROCESS_SOURCE_FILE.stat().st_size},
            "scene_video": {"file": PROCESS_VIDEO_FILE.name, "size_bytes": PROCESS_VIDEO_FILE.stat().st_size, "strategy": video_strategy},
            "scene_audio": {"file": PROCESS_AUDIO_FILE.name, "size_bytes": PROCESS_AUDIO_FILE.stat().st_size, "sample_rate_hz": 16000, "channels": 1, "codec": "pcm_s16le", "strategy": audio_strategy},
        },
        "operations": ["youtube_download", "video_cut", "audio_extract", "audio_convert", *(["local_transcription"] if local_cues else []), "technical_json"],
        "transcription_performed": bool(local_cues),
        "transcription_mode": str(cfg.get("transcription_mode") or "external"),
        "cues": local_cues or [],
    }
    if cfg.get("dual_scene"):
        document["source"]["pt"] = {
            "url": str(pt.get("url") or ""),
            "title": str(pt.get("title") or ""),
            "video_id": str(pt.get("video_id") or ""),
            "embeddable": bool(pt.get("embeddable")),
        }
    return document


def _process_media_job() -> None:
    try:
        if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
            raise RuntimeError("FFmpeg/ffprobe não encontrados no PATH.")
        state = _read_state()
        if not _source_ready(state):
            raise RuntimeError("A fonte EN validada não está disponível.")
        cut = state.get("cut") or {}
        if not cut.get("saved"):
            raise RuntimeError("Salve o recorte antes de processar a mídia.")
        start_ms = int(cut.get("start_ms") or 0)
        end_ms = int(cut.get("end_ms") or 0)
        if end_ms <= start_ms:
            raise RuntimeError("O recorte salvo é inválido.")

        _reset_process_files()
        def begin(s: dict[str, Any]) -> None:
            s["process"] = _default_state()["process"]
            s["process"].update({"status": "running", "percent": 1, "message": "Iniciando processamento da mídia.", "started_at": _now_iso()})
            s["process"]["input_signature"] = _process_input_signature(s)
        _update_state(begin)
        preserve_review_data = bool(state.get("imported_final") or state.get("media_refresh_preserve_reviews"))
        local_transcription = not preserve_review_data and str((state.get("configuration") or {}).get("transcription_mode") or "external") == "generator"
        _process_update(log=("Processamento iniciado com transcrição local." if local_transcription else "Processamento iniciado. A transcrição será feita pela IA externa."), level="info")
        _process_update(percent=5, message="Preparando vídeo da fonte validada…", log="Preparando a mídia para o recorte.")

        seen_attempts: set[str] = set()
        def progress(percent: float, stage: str, message: str) -> None:
            mapped = 5 + int(max(0, min(100, percent)) * 0.30)
            text = f"{stage}: {message}"
            _process_update(percent=min(35, mapped), message=text)
            if "Tentativa " in message and text not in seen_attempts:
                seen_attempts.add(text)
                _process_update(log=text, level="info")

        if (state.get("wave") or {}).get("source_kind") == "manual":
            if not SOURCE_EN_FILE.is_file():
                raise RuntimeError("O vídeo enviado não está disponível. Envie o arquivo novamente na configuração.")
            shutil.copy2(SOURCE_EN_FILE, PROCESS_SOURCE_FILE)
        else:
            download_video(str(state["en"]["url"]), PROCESS_SOURCE_DIR, progress=progress, highest_quality=True)
        if not PROCESS_SOURCE_FILE.is_file() or PROCESS_SOURCE_FILE.stat().st_size <= 0:
            raise RuntimeError("O download terminou sem produzir original.mp4.")
        _process_update(percent=36, message="Vídeo fonte pronto.", log=f"Vídeo fonte pronto · {_human_bytes(PROCESS_SOURCE_FILE.stat().st_size)}", level="success",
                        artifact=_artifact_payload("source", "original.mp4", "video", PROCESS_SOURCE_FILE, "Vídeo da fonte validada"))

        _process_update(percent=42, message="Recortando vídeo no intervalo IN/OUT…", log=f"Recorte solicitado: {start_ms} ms → {end_ms} ms.")
        video_strategy = _clip_video(PROCESS_SOURCE_FILE, PROCESS_VIDEO_FILE, start_ms, end_ms)
        _process_update(percent=64, message="Vídeo recortado e normalizado.", log=f"Vídeo de cena pronto · {_human_bytes(PROCESS_VIDEO_FILE.stat().st_size)}", level="success",
                        artifact=_artifact_payload("video", PROCESS_VIDEO_FILE.name, "video", PROCESS_VIDEO_FILE, "Vídeo dentro do corte IN/OUT"))

        _process_update(percent=70, message="Extraindo e convertendo áudio…", log="Extração do áudio iniciada. Saída: PCM 16 kHz mono.")
        audio_strategy = _extract_audio(PROCESS_VIDEO_FILE, PROCESS_SOURCE_FILE, PROCESS_AUDIO_FILE, start_ms, end_ms)
        _process_update(percent=86, message="Áudio extraído e convertido.", log=f"Áudio pronto · {_human_bytes(PROCESS_AUDIO_FILE.stat().st_size)}", level="success",
                        artifact=_artifact_payload("audio", PROCESS_AUDIO_FILE.name, "audio", PROCESS_AUDIO_FILE, "Áudio da cena · WAV PCM 16 kHz mono"))

        local_cues: list[dict[str, Any]] = []
        if local_transcription:
            _process_update(percent=88, message="Transcrevendo no Generator…", log="Faster Whisper analisando fala e timestamps por palavra.")
            local_cues = _transcribe_scene_locally(PROCESS_AUDIO_FILE, _probe_duration_ms(PROCESS_VIDEO_FILE))
            _process_update(percent=94, message="Transcrição local concluída.", log=f"Rascunho local pronto · {len(local_cues)} cue(s).", level="success")
        _process_update(percent=96, message="Gerando JSON técnico inicial…", log=("Gerando JSON com a transcrição local para validação externa." if local_cues else "Gerando JSON técnico sem cues; a IA externa fará a transcrição."))
        latest = _read_state()
        document = json.loads(EXTERNAL_AI_RETURN_FILE.read_text(encoding="utf-8")) if preserve_review_data else _build_initial_json(latest, video_strategy, audio_strategy, local_cues)
        PROCESS_JSON_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _process_update(percent=98, message="JSON técnico inicial gerado.", log=f"JSON inicial pronto · {_human_bytes(PROCESS_JSON_FILE.stat().st_size)}", level="success",
                        artifact=_artifact_payload("json", PROCESS_JSON_FILE.name, "json", PROCESS_JSON_FILE, ("JSON com transcrição local preliminar" if local_cues else "JSON técnico · transcrição pela IA externa")))
        if preserve_review_data:
            CUE_TIMING_WAVEFORM_FILE.parent.mkdir(parents=True, exist_ok=True)
            CUE_TIMING_WAVEFORM_FILE.write_text(json.dumps(_generate_waveform(PROCESS_AUDIO_FILE)), encoding="utf-8")
            if (latest.get("configuration") or {}).get("dual_scene"):
                download_video(str(latest["pt"]["url"]), DUAL_SCENE_PT_DIR, highest_quality=True)
                duration = _probe_duration_ms(DUAL_SCENE_PT_FILE)
                _extract_audio(DUAL_SCENE_PT_FILE, DUAL_SCENE_PT_FILE, DUAL_SCENE_PT_AUDIO_FILE, 0, duration)
                DUAL_SCENE_PT_WAVEFORM_FILE.write_text(json.dumps(_generate_waveform(DUAL_SCENE_PT_AUDIO_FILE)), encoding="utf-8")
            def media_ready(s: dict[str, Any]) -> None:
                if s.get("imported_final"):
                    s["imported_final"]["media_pending"] = False
                if s.get("media_refresh_preserve_reviews"):
                    s["resume_after_media"] = "/dual-scene" if (s.get("configuration") or {}).get("dual_scene") else "/cue-review"
                s.pop("media_refresh_preserve_reviews", None)
            _update_state(media_ready)
        _process_update(status="ready", percent=100, message="Mídia pronta em qualidade máxima. Cues e revisões preservadas." if preserve_review_data else "Processamento concluído.", log="Processamento concluído. Todos os artefatos estão disponíveis para download.", level="success", finished=True)
    except Exception as exc:
        _process_update(status="failed", percent=100, message="Falha no processamento da mídia.", error=str(exc), log=str(exc), level="error", finished=True)


def _process_page_ready(state: dict[str, Any]) -> bool:
    return _source_ready(state) and bool((state.get("cut") or {}).get("saved"))


def _process_input_signature(state: dict[str, Any]) -> dict[str, Any]:
    cut = state.get("cut") or {}
    cfg = state.get("configuration") or {}
    return {
        "source_url": str((state.get("en") or {}).get("url") or ""),
        "start_ms": int(cut.get("start_ms") or 0),
        "end_ms": int(cut.get("end_ms") or 0),
        "content_type": str(cfg.get("content_type") or ""),
        "dual_scene": bool(cfg.get("dual_scene")),
        "transcription_mode": str(cfg.get("transcription_mode") or "external"),
    }


def _processed_media_matches(state: dict[str, Any]) -> bool:
    proc = state.get("process") or {}
    files = (PROCESS_SOURCE_FILE, PROCESS_VIDEO_FILE, PROCESS_AUDIO_FILE, PROCESS_JSON_FILE)
    if proc.get("status") != "ready" or not all(path.is_file() and path.stat().st_size > 0 for path in files):
        return False
    expected = _process_input_signature(state)
    saved = proc.get("input_signature")
    return isinstance(saved, dict) and saved == expected


def _external_ai_page_ready(state: dict[str, Any]) -> bool:
    proc = state.get("process") or {}
    return _process_page_ready(state) and proc.get("status") == "ready" and PROCESS_AUDIO_FILE.is_file() and PROCESS_JSON_FILE.is_file()


def _external_artifact_payload(key: str, name: str, kind: str, path: Path, description: str) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "kind": kind,
        "description": description,
        "size_bytes": int(path.stat().st_size if path.is_file() else 0),
        "size_label": _human_bytes(path.stat().st_size if path.is_file() else 0),
        "download_url": f"/api/external-ai/artifact/{key}",
    }


def _external_extraction_text(document: dict[str, Any]) -> str:
    cues = document.get("cues") or []
    original = [str(cue.get("original_en") or cue.get("approved_en") or "").strip() for cue in cues]
    translation = [str(cue.get("pt") or "").strip() for cue in cues]
    word_by_word = []
    for cue in cues:
        pairs = []
        for word in cue.get("words") or []:
            en = str(word.get("text") or "").strip()
            pt = "" if word.get("pt") is None else str(word.get("pt") or "").strip()
            pairs.append(f"{en} = {pt}" if pt else en)
        word_by_word.append(" | ".join(pairs))
    blocks = [
        "ORIGINAL\n" + "\n".join(original),
        "TRADUÇÃO\n" + "\n".join(translation),
        "WORD BY WORD\n" + "\n".join(word_by_word),
    ]
    return "\n\n".join(blocks).rstrip() + "\n"


def _ensure_external_extraction_artifact() -> dict[str, Any]:
    state = _read_state()
    external = state.get("external_ai") or {}
    if not external.get("validated") or not EXTERNAL_AI_RETURN_FILE.is_file():
        return external
    document = json.loads(EXTERNAL_AI_RETURN_FILE.read_text(encoding="utf-8"))
    EXTERNAL_AI_EXTRACTION_FILE.write_text(_external_extraction_text(document), encoding="utf-8")
    artifact = _external_artifact_payload("extraction", EXTERNAL_AI_EXTRACTION_FILE.name, "text", EXTERNAL_AI_EXTRACTION_FILE, "Texto puro · original, tradução e Word by Word")
    def mutate(s: dict[str, Any]) -> None:
        artifacts = [item for item in (s["external_ai"].get("artifacts") or []) if item.get("key") != "extraction"]
        artifacts.append(artifact)
        s["external_ai"]["artifacts"] = artifacts
    return _update_state(mutate)["external_ai"]


def _load_canonical_template() -> dict[str, Any]:
    if not CANONICAL_TEMPLATE_FILE.is_file():
        raise RuntimeError(f"Template canônico ausente: {CANONICAL_TEMPLATE_FILE}")
    data = json.loads(CANONICAL_TEMPLATE_FILE.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema") != "immersionhub-canonical-ai-input" or data.get("schema_version") != "1.7":
        raise RuntimeError("O template canônico v1.7 é inválido.")
    return data


def _build_external_canonical(state: dict[str, Any], snapshot_id: str, generated_at: str) -> dict[str, Any]:
    document = _load_canonical_template()
    cut = state.get("cut") or {}
    cfg = state.get("configuration") or {}
    en = state.get("en") or {}
    start_ms = int(cut.get("start_ms") or 0)
    end_ms = int(cut.get("end_ms") or 0)
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    content_type = "music" if cfg.get("content_type") == "music" else "dialogue"
    transcription_mode = str(cfg.get("transcription_mode") or "external")
    local_cues: list[dict[str, Any]] = []
    if transcription_mode == "generator" and PROCESS_JSON_FILE.is_file():
        initial = json.loads(PROCESS_JSON_FILE.read_text(encoding="utf-8"))
        local_cues = [copy.deepcopy(cue) for cue in (initial.get("cues") or []) if isinstance(cue, dict)]
        if not local_cues:
            raise RuntimeError("A configuração exige transcrição no Generator, mas o JSON processado não contém cues locais.")
    document["snapshot_id"] = snapshot_id
    document["generated_at_utc"] = generated_at
    document["workflow_status"] = "awaiting_external_ai_one_pass"
    document["generator"] = {
        "name": APP_NAME,
        "purpose": ("Canonical music excerpt for external AI lyrics + translation + Word by Word preparation before human review" if content_type == "music" else "Canonical scene document for external AI cue + translation + Word by Word preparation before human review"),
    }
    document["project"] = {
        "content_type": content_type,
        "youtube": str(en.get("url") or ""),
        "scene_start_ms": 0,
        "scene_end_ms": duration_ms,
        "scene_duration_ms": duration_ms,
        "timeline": "scene_local_ms",
        "source_video_start_ms": start_ms,
        "source_video_end_ms": end_ms,
        "fps": _probe_fps(PROCESS_VIDEO_FILE),
    }
    if content_type == "music":
        document["project"]["youtube_video_id"] = str(en.get("video_id") or "")
        document["project"]["youtube_title"] = str(en.get("title") or "")
    note = "MUSIC: this early stage only prepares lyric cues, translations and Word by Word for later human review." if content_type == "music" else "DIALOGUE KIT: this early stage only prepares dialogue cues, translations and Word by Word for later human review."
    document["review"] = {
        "source_kind": "generator_transcription_for_external_validation" if local_cues else "external_ai_audio",
        "caption_language": "en",
        "cps_profile": "template",
        "auto_saved_human_review": False,
        "canonical_note": (
            "EARLY EXTERNAL AI PREPARATION. Return this exact canonical JSON structure. "
            + ("Validate and correct the preliminary Generator cues against scene_audio_16k_mono.wav, " if local_cues else "Build cues from scene_audio_16k_mono.wav, ")
            + "fill cue pt translations and create words using the existing fields. Human review happens afterwards. Do not create a wrapper, "
            "alternate schema, translation_units, ai_proposed or Super JSON. Multi-word PT equivalents use pt_group / pt_group_role / pt_group_original_pt."
        ),
        "content_type_note": note,
    }
    document["cues"] = local_cues
    if local_cues:
        document["ai_training"]["role"] = "Você é o validador externo da transcrição preliminar produzida pelo Generator. Ouça o WAV completo, corrija cues e words quando necessário, traduza e devolva o mesmo JSON com generator_materials."
        document["ai_training"]["current_flow"][0] = "Esta é a única chamada à IA externa; a transcrição preliminar já foi feita no Generator e deve ser validada contra o áudio."
    return document


def _build_external_instructions(document: dict[str, Any]) -> str:
    project = document["project"]
    snapshot = document["snapshot_id"]
    duration = int(project["scene_duration_ms"])
    is_music = str(project.get("content_type") or "") == "music"
    has_local_transcription = str((document.get("review") or {}).get("source_kind") or "") == "generator_transcription_for_external_validation"
    task_title = "MUSIC LYRICS + TRANSLATION + WORD BY WORD" if is_music else "EXTERNAL AI AUDIO ANALYSIS"
    mode_rules = (
        "MUSIC MODE\n"
        "- Use exactly the selected music interval; there is no maximum duration.\n"
        "- Identify the exact song/version from the YouTube metadata plus audio when possible.\n"
        "- Each cue is a sung lyric line or natural lyric fragment. Do not include generic [Music] cues.\n"
        "- Transcribe only what is actually sung inside this cut. Never complete lyrics outside the selected interval.\n"
        "- Preserve contractions, colloquial grammar, repetitions and artistic wording actually sung.\n"
        "- pt must be a natural contextual translation of the lyric line.\n"
        "- WbW PT may use semantic groups exactly through pt_group/pt_group_role.\n"
        if is_music else
        "DIALOGUE MODE\n- Build natural spoken subtitle units from the selected scene.\n"
    )
    return f"""MEDIA AND SUBTITLE GENERATOR — {task_title}
CANONICAL SCHEMA: {document['schema']}
SCHEMA VERSION: {document['schema_version']}
SNAPSHOT ID: {snapshot}

OBJECTIVE
{mode_rules}
Listen to scene_audio_16k_mono.wav in full and return canonical_scene.json itself, preserving its canonical structure. {"The Generator already supplied preliminary cues[] and word timestamps. Validate every cue and word against the audio, correcting transcription, segmentation and timings whenever necessary; then add contextual pt-BR translations." if has_local_transcription else "Fill cues[] from the audio."} Add the temporary generator_materials root field exactly as specified below. Do not create a wrapper, a second JSON schema, Markdown, comments or text outside the JSON.

AUDIO AUTHORITY
- scene_audio_16k_mono.wav is the primary authority for speech and timing.
- The supplied WAV contains only the selected scene/cut.
- Scene-local timeline: 0 ms through {duration} ms.
- project.scene_start_ms is always 0 and project.scene_end_ms is the real duration of the generated scene_video.mp4.
- project.source_video_start_ms/project.source_video_end_ms only locate this cut in the original video. NEVER add source_video_start_ms to cue/word timestamps.

{("LYRIC CUE VALIDATION AND CORRECTION" if is_music else "CUE VALIDATION AND CORRECTION") if has_local_transcription else ("LYRIC CUE EXTRACTION" if is_music else "CUE EXTRACTION")}
- {"Detect every sung lyric unit actually audible inside this selected excerpt." if is_music else "Detect every real spoken utterance in the audio."}
- {"Treat existing cues and words as a fallible Generator draft, not as authority. Preserve correct material, but freely fix missing or extra words, cue boundaries, word boundaries and segmentation using the WAV." if has_local_transcription else "Create the transcription directly from the WAV; no preliminary transcript is authoritative."}
- Create cues[] in chronological order and set order sequentially starting at 1.
- {"Prefer natural lyric lines/fragments that follow the sung phrasing. You may split/join only when the audio itself justifies it." if is_music else "Prefer natural subtitle/speech units. You may split or join speech into cues when the audio/context justifies it."}
- speech_start_ms: exact audible beginning of that cue, in integer milliseconds on the scene-local timeline.
- speech_end_ms: exact audible end of that cue.
- subtitle_start_ms/subtitle_end_ms: subtitle display interval; initially keep them coherent with the real speech interval unless a small display adjustment is genuinely necessary.
- speaker: ALWAYS use an empty string in this stage. {"Music does not use speaker assignment." if is_music else "Speaker naming/assignment happens only later in the Cue Timing Wave Editor."}
- original_en: faithful English transcription of the audio.
- approved_en: initially copy original_en exactly. Human review occurs later.
- pt: natural contextual pt-BR translation of the complete cue.

WORD BY WORD — EXACT AUDIO TIMESTAMPS
For EVERY cue, create words[] covering the spoken words in order.
- text: the actual English word/token spoken.
- start_ms/end_ms: exact audible boundaries of that word/token, in integer milliseconds.
- Never calculate word timings by evenly dividing the cue duration.
- Never estimate timing from character count or word count.
- Listen to the audio and align every word to acoustic evidence.
- Word timestamps must remain inside the parent cue speech interval.
- Coarticulation may make adjacent boundaries tight; do not create artificial gaps merely to make numbers look clean.
- original_start_ms/original_end_ms: on this first AI pass, copy the detected start_ms/end_ms.
- confidence_score, audio_confidence and composite_confidence: number from 0.0 to 1.0 representing your confidence in the detected token/timing.
- review_status: ALWAYS "pending". You are not the human reviewer.
- alignment_source: "auto".
- qc_status: "needs_review".
- qc_reasons: use [] when there is no specific warning, otherwise short machine-readable reasons.
- qc_auto_fixed: false.
- human_verified_audio: false.
- pt: contextual pt-BR equivalent for the word/unit.

MULTI-WORD PT UNITS — USE THE EXISTING FIELDS ONLY
Before translating any word, understand the complete cue and determine the contextual meaning of every token. Word by Word must explain the meaning actually communicated by the cue; it must never be a mechanical dictionary substitution.
- Decide whether each PT equivalent works independently or whether contiguous words form one semantic unit.
- Group phrasal verbs, idioms, collocations, auxiliary/negation combinations, grammatical structures and any sequence whose isolated translations would be false, truncated or unnatural.
If 2+ contiguous English words form ONE semantic translation unit in Portuguese:
- assign the same pt_group string to all words in that contiguous group;
- first word: pt_group_role="lead" and pt contains the complete Portuguese equivalent;
- remaining words: pt_group_role="member" and pt=null;
- pt_group_original_pt may store the individual PT equivalent before grouping, so the later human review can undo the group;
- DO NOT invent translation_units, groups arrays or any other field/schema.

ONE-PASS FINAL MATERIAL DATA
This is the ONLY external-AI pass in the workflow. In addition to filling cues[], add one temporary root field named generator_materials. The Generator removes this field before saving the canonical document and keeps it as a snapshot-bound sidecar for later human review.
generator_materials must have exactly:
- anki.items: complete card objects linked by cue_order. Each card must contain key, cue_order, score (0..100), type, focus, meaning, highlight_en, marked, highlight_pt, markedPT, explanation, example_en, example_pt and tags[]. marked/markedPT must occur literally in their highlights. New examples must not copy the source sentence.
- connected_speech.cues: one object per cue with cue_order and phenomena[]. Each phenomenon must contain sequenceOrder, type (linking/elision/assimilation/reduction/contraction), start_ms, end_ms, source_text, heard_as, explanation_pt and confidence. Use [] when none is confirmed. Music must use connected_speech.cues=[].
- wbw_practices: a short list containing ONLY important reusable structures, collocations, idioms, and phrasal verbs from the scene. Do not create one item per word or cue. Each item must contain cue_order, type ("structure" or "phrasal_verb"), expression_en, meaning_pt, explanation_pt, example_en, example_pt, start_ms, and end_ms.

WBW PRACTICE TIMING CONTRACT
- start_ms/end_ms use the same scene-local millisecond timeline as cues[] and words[]. Never add source_video_start_ms.
- Both values must be integers and stay inside the referenced cue's speech_start_ms..speech_end_ms interval.
- Mark the exact audible span of expression_en. Use the first included word start_ms and the last included word end_ms as acoustic anchors.
- The HUB Admin stores these values without conversion. When the learner clicks Play clip, the HUB seeks to start_ms / 1000 and stops at end_ms / 1000.
- Select only pedagogically relevant reusable language. Return [] when the scene has no strong candidate.
These items are candidates only. They are reconciled against the final reviewed canonical and require human approval before final generation.

IMMUTABLE / PROTECTED DATA
The external AI MUST return these root fields exactly as received, without editing, removing, adding nested values or recalculating anything:
- schema
- schema_version
- snapshot_id — copy the exact original value; NEVER regenerate it
- generated_at_utc — copy the exact original value; NEVER recalculate or replace it
- workflow_status
- generator
- project
- review
- shadowingConfig
- ai_training
Only cues[] and the temporary generator_materials field are mutable in this stage.
The returned root object must contain the canonical root keys plus generator_materials.
IMPORTANT: ai_training describes this same current one-pass contract and must be followed. It is protected metadata: execute its rules, but return the block unchanged. The only authorized write targets are cues[] and the temporary generator_materials root field.

MANDATORY RETURN VALIDATION
Before returning the JSON, verify:
1. schema == "{document['schema']}"
2. schema_version == "{document['schema_version']}"
3. snapshot_id == "{snapshot}"
4. all protected root fields are untouched
5. cues[] is non-empty and order is 1..N without gaps
6. every cue has valid speech/subtitle timing inside 0..{duration} ms
7. every cue has original_en, approved_en and pt
8. every cue has a non-empty words[]
9. every word has valid start_ms/end_ms inside its cue
10. every ungrouped word has pt; grouped words follow pt_group/lead/member rules
11. review_status remains "pending" and human_verified_audio remains false for every word
12. generator_materials contains Anki, Connected Speech, and curated wbw_practices tied to existing cue_order values

RETURN
Return ONLY valid JSON: the complete canonical_scene.json document with cues[] populated plus the temporary generator_materials root field. No Markdown fences and no explanation outside the JSON.
"""


def _prepare_external_ai_package() -> dict[str, Any]:
    with _external_ai_lock:
        state = _read_state()
        if not _external_ai_page_ready(state):
            raise RuntimeError("Conclua o processamento da mídia antes de preparar o pacote da IA externa.")
        ext = state.get("external_ai") or {}
        if ext.get("contract_version") == EXTERNAL_AI_CONTRACT_VERSION and ext.get("status") in {"prepared", "validated", "invalid"} and EXTERNAL_AI_CANONICAL_FILE.is_file() and EXTERNAL_AI_INSTRUCTIONS_FILE.is_file() and EXTERNAL_AI_ZIP_FILE.is_file():
            return ext

        shutil.rmtree(EXTERNAL_AI_DIR, ignore_errors=True)
        EXTERNAL_AI_DIR.mkdir(parents=True, exist_ok=True)
        snapshot_id = secrets.token_hex(8)
        generated_at = _now_iso()
        document = _build_external_canonical(state, snapshot_id, generated_at)
        EXTERNAL_AI_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        EXTERNAL_AI_INSTRUCTIONS_FILE.write_text(_build_external_instructions(document), encoding="utf-8")
        with zipfile.ZipFile(EXTERNAL_AI_ZIP_FILE, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(EXTERNAL_AI_CANONICAL_FILE, arcname="canonical_scene.json")
            archive.write(PROCESS_AUDIO_FILE, arcname="scene_audio_16k_mono.wav")
            archive.write(EXTERNAL_AI_INSTRUCTIONS_FILE, arcname="INSTRUCOES_EXTERNAL_AI.txt")

        artifacts = [
            _external_artifact_payload("canonical", "canonical_scene.json", "json", EXTERNAL_AI_CANONICAL_FILE, "JSON canônico v1.7 · análise one-pass aguardando IA"),
            _external_artifact_payload("audio", "scene_audio_16k_mono.wav", "audio", PROCESS_AUDIO_FILE, "Áudio completo da cena · WAV PCM 16 kHz mono"),
            _external_artifact_payload("instructions", "INSTRUCOES_EXTERNAL_AI.txt", "text", EXTERNAL_AI_INSTRUCTIONS_FILE, "Contrato único: cues, WbW, WbW Practices, Connected Speech e Anki"),
            _external_artifact_payload("zip", ("external_ai_music.zip" if str((document.get("project") or {}).get("content_type") or "") == "music" else "external_ai_scene.zip"), "zip", EXTERNAL_AI_ZIP_FILE, "Único pacote externo do fluxo"),
        ]
        def mutate(s: dict[str, Any]) -> None:
            s["external_ai"] = _default_state()["external_ai"]
            s["external_ai"].update({
                "status": "prepared",
                "snapshot_id": snapshot_id,
                "generated_at_utc": generated_at,
                "contract_version": EXTERNAL_AI_CONTRACT_VERSION,
                "artifacts": artifacts,
                "error": "",
            })
        return _update_state(mutate)["external_ai"]


def _collect_diffs(expected: Any, actual: Any, path: str, output: list[str], limit: int = 16) -> None:
    if len(output) >= limit:
        return
    if type(expected) is not type(actual):
        output.append(f"{path}: tipo alterado ({type(expected).__name__} → {type(actual).__name__})")
        return
    if isinstance(expected, dict):
        expected_keys = set(expected)
        actual_keys = set(actual)
        for key in sorted(expected_keys - actual_keys):
            output.append(f"{path}.{key}: campo removido")
            if len(output) >= limit: return
        for key in sorted(actual_keys - expected_keys):
            output.append(f"{path}.{key}: campo adicionado")
            if len(output) >= limit: return
        for key in expected:
            if key in actual:
                _collect_diffs(expected[key], actual[key], f"{path}.{key}", output, limit)
                if len(output) >= limit: return
        return
    if isinstance(expected, list):
        if len(expected) != len(actual):
            output.append(f"{path}: quantidade alterada ({len(expected)} → {len(actual)})")
            return
        for i, (left, right) in enumerate(zip(expected, actual)):
            _collect_diffs(left, right, f"{path}[{i}]", output, limit)
            if len(output) >= limit: return
        return
    if expected != actual:
        output.append(f"{path}: valor alterado")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


CANONICAL_SERVER_OWNED_FIELDS = ("snapshot_id", "generated_at_utc")


def _restore_canonical_server_owned_fields(document: dict[str, Any], base: dict[str, Any]) -> None:
    """Keep canonical identity metadata owned by the Generator, never by external AI."""
    for key in CANONICAL_SERVER_OWNED_FIELDS:
        document[key] = base.get(key)


def _validate_external_cues(document: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    if set(document.keys()) != set(base.keys()):
        missing = sorted(set(base) - set(document))
        extra = sorted(set(document) - set(base))
        parts = []
        if missing: parts.append("campos raiz ausentes=" + ", ".join(missing))
        if extra: parts.append("campos raiz extras=" + ", ".join(extra))
        raise ValueError("A estrutura raiz do JSON foi alterada (" + "; ".join(parts) + ").")

    protected = ["schema", "schema_version", "snapshot_id", "generated_at_utc", "workflow_status", "generator", "project", "review", "shadowingConfig", "ai_training"]
    diffs: list[str] = []
    for key in protected:
        _collect_diffs(base.get(key), document.get(key), f"$.{key}", diffs)
    if diffs:
        raise ValueError("Campos protegidos foram alterados:\n- " + "\n- ".join(diffs))

    cues = document.get("cues")
    if not isinstance(cues, list) or not cues:
        raise ValueError("$.cues deve ser uma lista não vazia criada a partir do áudio.")
    duration = int(base["project"]["scene_duration_ms"])
    total_words = 0
    total_groups = 0
    required_word_fields = [
        "text", "start_ms", "end_ms", "original_start_ms", "original_end_ms", "confidence_score", "review_status",
        "alignment_source", "audio_confidence", "composite_confidence", "qc_status", "qc_reasons", "qc_auto_fixed",
        "human_verified_audio", "pt",
    ]
    for cue_index, cue in enumerate(cues, start=1):
        path = f"$.cues[{cue_index - 1}]"
        if not isinstance(cue, dict):
            raise ValueError(f"{path} deve ser um objeto.")
        cue_fields = {"order", "speech_start_ms", "speech_end_ms", "subtitle_start_ms", "subtitle_end_ms", "speaker", "original_en", "approved_en", "pt", "words"}
        if set(cue.keys()) != cue_fields:
            missing = sorted(cue_fields - set(cue.keys()))
            extra = sorted(set(cue.keys()) - cue_fields)
            details = []
            if missing: details.append("ausentes=" + ", ".join(missing))
            if extra: details.append("extras=" + ", ".join(extra))
            raise ValueError(f"{path}: estrutura do cue inválida ({'; '.join(details)}).")
        if cue.get("order") != cue_index:
            raise ValueError(f"{path}.order deve ser {cue_index}.")
        for field in ("speech_start_ms", "speech_end_ms", "subtitle_start_ms", "subtitle_end_ms"):
            if not _is_int(cue.get(field)):
                raise ValueError(f"{path}.{field} deve ser inteiro em milissegundos.")
        ss, se = cue["speech_start_ms"], cue["speech_end_ms"]
        ts, te = cue["subtitle_start_ms"], cue["subtitle_end_ms"]
        if not (0 <= ss < se <= duration):
            raise ValueError(f"{path}: speech_start_ms/speech_end_ms fora da cena 0..{duration} ms.")
        if not (0 <= ts < te <= duration):
            raise ValueError(f"{path}: subtitle_start_ms/subtitle_end_ms fora da cena 0..{duration} ms.")
        for field in ("original_en", "approved_en", "pt"):
            if not isinstance(cue.get(field), str) or not cue[field].strip():
                raise ValueError(f"{path}.{field} é obrigatório e não pode estar vazio.")
        if not isinstance(cue.get("speaker", ""), str):
            raise ValueError(f"{path}.speaker deve ser string (pode ser vazia).")
        words = cue.get("words")
        if not isinstance(words, list) or not words:
            raise ValueError(f"{path}.words deve conter o Word by Word completo.")
        groups: dict[str, list[tuple[int, dict[str, Any]]]] = {}
        previous_start = -1
        for word_index, word in enumerate(words):
            wpath = f"{path}.words[{word_index}]"
            if not isinstance(word, dict):
                raise ValueError(f"{wpath} deve ser objeto.")
            for field in required_word_fields:
                if field not in word:
                    raise ValueError(f"{wpath}.{field} está ausente.")
            allowed_word_fields = set(required_word_fields) | {"pt_group", "pt_group_role", "pt_group_original_pt"}
            extra_word_fields = sorted(set(word.keys()) - allowed_word_fields)
            if extra_word_fields:
                raise ValueError(f"{wpath}: campos não reconhecidos: {', '.join(extra_word_fields)}.")
            if not isinstance(word.get("text"), str) or not word["text"].strip():
                raise ValueError(f"{wpath}.text não pode estar vazio.")
            for field in ("start_ms", "end_ms", "original_start_ms", "original_end_ms"):
                if not _is_int(word.get(field)):
                    raise ValueError(f"{wpath}.{field} deve ser inteiro.")
            ws, we = word["start_ms"], word["end_ms"]
            if not (ss <= ws < we <= se):
                raise ValueError(f"{wpath}: timestamp deve ficar dentro do speech interval do cue.")
            if ws < previous_start:
                raise ValueError(f"{wpath}: words devem estar em ordem temporal crescente.")
            previous_start = ws
            if word["original_start_ms"] != ws or word["original_end_ms"] != we:
                raise ValueError(f"{wpath}: no primeiro retorno original_start_ms/original_end_ms devem copiar start_ms/end_ms.")
            for field in ("confidence_score", "audio_confidence", "composite_confidence"):
                value = word.get(field)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not (0 <= float(value) <= 1):
                    raise ValueError(f"{wpath}.{field} deve ser número entre 0 e 1.")
            if word.get("review_status") != "pending":
                raise ValueError(f"{wpath}.review_status deve ser 'pending'; a IA não aprova a revisão humana.")
            if word.get("human_verified_audio") is not False:
                raise ValueError(f"{wpath}.human_verified_audio deve ser false.")
            if not isinstance(word.get("alignment_source"), str) or not word["alignment_source"].strip():
                raise ValueError(f"{wpath}.alignment_source deve ser string não vazia.")
            if not isinstance(word.get("qc_status"), str) or not word["qc_status"].strip():
                raise ValueError(f"{wpath}.qc_status deve ser string não vazia.")
            if not isinstance(word.get("qc_reasons"), list):
                raise ValueError(f"{wpath}.qc_reasons deve ser lista.")
            if not isinstance(word.get("qc_auto_fixed"), bool):
                raise ValueError(f"{wpath}.qc_auto_fixed deve ser booleano.")
            group = word.get("pt_group")
            if group:
                if not isinstance(group, str):
                    raise ValueError(f"{wpath}.pt_group deve ser string.")
                role = word.get("pt_group_role")
                if role not in {"lead", "member"}:
                    raise ValueError(f"{wpath}.pt_group_role deve ser lead ou member.")
                groups.setdefault(group, []).append((word_index, word))
            else:
                if not isinstance(word.get("pt"), str) or not word["pt"].strip():
                    raise ValueError(f"{wpath}.pt é obrigatório quando a word não pertence a pt_group.")
            total_words += 1
        for group_id, members in groups.items():
            indexes = [i for i, _ in members]
            if indexes != list(range(min(indexes), max(indexes) + 1)):
                raise ValueError(f"{path}: pt_group '{group_id}' deve conter words contíguas.")
            leads = [(i, w) for i, w in members if w.get("pt_group_role") == "lead"]
            if len(leads) != 1 or leads[0][0] != min(indexes):
                raise ValueError(f"{path}: pt_group '{group_id}' deve ter exatamente um lead na primeira word.")
            if not isinstance(leads[0][1].get("pt"), str) or not leads[0][1]["pt"].strip():
                raise ValueError(f"{path}: lead de pt_group '{group_id}' deve conter a tradução completa em pt.")
            for _, member in members:
                if member.get("pt_group_role") == "member" and member.get("pt") not in (None, ""):
                    raise ValueError(f"{path}: members de pt_group '{group_id}' devem usar pt=null.")
            total_groups += 1
    return {"cues": len(cues), "words": total_words, "pt_groups": total_groups, "schema_version": base["schema_version"], "snapshot_id": base["snapshot_id"]}


def _validate_one_pass_materials(raw: Any, cues: list[dict[str, Any]], *, is_music: bool) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {"anki", "connected_speech", "wbw_practices"}:
        raise ValueError("generator_materials deve conter exatamente anki, connected_speech e wbw_practices.")
    anki = raw.get("anki") if isinstance(raw.get("anki"), dict) else {}
    cue_map = {int(cue.get("order") or 0): cue for cue in cues if isinstance(cue, dict)}
    cards = validate_one_pass_cards(anki.get("items"), cue_map)
    connected = raw.get("connected_speech") if isinstance(raw.get("connected_speech"), dict) else {}
    cs_cues = connected.get("cues")
    if not isinstance(cs_cues, list):
        raise ValueError("generator_materials.connected_speech.cues deve ser uma lista.")
    if is_music and cs_cues:
        raise ValueError("Music não usa Connected Speech; envie connected_speech.cues=[].")
    seen_orders: set[int] = set()
    allowed_types = {"linking", "elision", "assimilation", "reduction", "contraction"}
    cleaned_cs: list[dict[str, Any]] = []
    for row in cs_cues:
        if not isinstance(row, dict):
            raise ValueError("Cada item de connected_speech.cues deve ser objeto.")
        order = int(row.get("cue_order") or 0)
        if order not in cue_map or order in seen_orders:
            raise ValueError(f"Connected Speech possui cue_order inválido ou duplicado: {order}.")
        seen_orders.add(order)
        phenomena = row.get("phenomena")
        if not isinstance(phenomena, list):
            raise ValueError(f"Connected Speech cue {order}: phenomena deve ser lista.")
        cleaned: list[dict[str, Any]] = []
        for item in phenomena:
            if not isinstance(item, dict) or str(item.get("type") or "") not in allowed_types:
                raise ValueError(f"Connected Speech cue {order}: fenômeno inválido.")
            start_ms, end_ms = int(item.get("start_ms") or 0), int(item.get("end_ms") or 0)
            cue_start, cue_end = _connected_speech_cue_bounds(cue_map[order])
            if not cue_start <= start_ms < end_ms <= cue_end:
                raise ValueError(f"Connected Speech cue {order}: timestamp fora do cue.")
            confidence = float(item.get("confidence") or 0)
            if not 0 <= confidence <= 1:
                raise ValueError(f"Connected Speech cue {order}: confidence fora de 0..1.")
            for field in ("source_text", "heard_as", "explanation_pt"):
                if not str(item.get(field) or "").strip():
                    raise ValueError(f"Connected Speech cue {order}: {field} não pode ficar vazio.")
            cleaned.append({
                "type": str(item["type"]), "start_ms": start_ms, "end_ms": end_ms,
                "source_text": str(item.get("source_text") or "").strip(),
                "heard_as": str(item.get("heard_as") or "").strip(),
                "explanation_pt": str(item.get("explanation_pt") or "").strip(),
                "confidence": confidence,
            })
        cleaned_cs.append({"cue_order": order, "phenomena": cleaned})
    wbw_raw = raw.get("wbw_practices")
    if not isinstance(wbw_raw, list):
        raise ValueError("generator_materials.wbw_practices deve ser uma lista.")
    wbw: list[dict[str, Any]] = []
    for position, item in enumerate(wbw_raw, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"wbw_practices[{position}] deve ser objeto.")
        required = {"cue_order", "type", "expression_en", "meaning_pt", "explanation_pt", "example_en", "example_pt", "start_ms", "end_ms"}
        if set(item) != required:
            raise ValueError(f"wbw_practices[{position}] possui campos ausentes ou extras.")
        cue_order = int(item.get("cue_order") or 0)
        cue = cue_map.get(cue_order)
        if not cue:
            raise ValueError(f"wbw_practices[{position}].cue_order não existe em cues[].")
        practice_type = str(item.get("type") or "").strip()
        if practice_type not in {"structure", "phrasal_verb"}:
            raise ValueError(f"wbw_practices[{position}].type deve ser structure ou phrasal_verb.")
        start_ms, end_ms = int(item.get("start_ms") or 0), int(item.get("end_ms") or 0)
        cue_start, cue_end = int(cue.get("speech_start_ms") or 0), int(cue.get("speech_end_ms") or 0)
        if not (cue_start <= start_ms < end_ms <= cue_end):
            raise ValueError(f"wbw_practices[{position}] deve ficar dentro do speech interval da cue {cue_order}.")
        for field in ("expression_en", "meaning_pt", "explanation_pt", "example_en"):
            if not str(item.get(field) or "").strip():
                raise ValueError(f"wbw_practices[{position}].{field} é obrigatório.")
        wbw.append({
            "cue_order": cue_order, "type": practice_type,
            "expression_en": str(item["expression_en"]).strip(),
            "meaning_pt": str(item["meaning_pt"]).strip(),
            "explanation_pt": str(item["explanation_pt"]).strip(),
            "example_en": str(item["example_en"]).strip(),
            "example_pt": str(item.get("example_pt") or "").strip(),
            "start_ms": start_ms, "end_ms": end_ms,
        })
    return {"anki": {"items": cards}, "connected_speech": {"cues": cleaned_cs}, "wbw_practices": wbw}


def _cue_review_page_ready(state: dict[str, Any]) -> bool:
    ext = state.get("external_ai") or {}
    return bool(ext.get("validated") and EXTERNAL_AI_RETURN_FILE.is_file())


def _load_external_return() -> dict[str, Any]:
    if not EXTERNAL_AI_RETURN_FILE.is_file():
        raise RuntimeError("Importe e valide primeiro o JSON retornado pela IA externa.")
    data = json.loads(EXTERNAL_AI_RETURN_FILE.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("cues"), list) or not data["cues"]:
        raise RuntimeError("O retorno validado da IA não contém cues.")
    return data


def _ensure_cue_review() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    state = _read_state()
    if not _cue_review_page_ready(state):
        raise RuntimeError("Valide o retorno da IA externa antes de revisar os cues.")
    source = _load_external_return()
    snapshot_id = str(source.get("snapshot_id") or "")
    review = state.get("cue_review") or {}
    existing_reviewed = None
    if CUE_REVIEW_CANONICAL_FILE.is_file():
        try:
            existing_reviewed = json.loads(CUE_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
        except Exception:
            existing_reviewed = None
    existing_total = len((existing_reviewed or {}).get("cues") or [])
    must_reset = (
        existing_reviewed is None
        or str(review.get("source_snapshot_id") or "") != snapshot_id
        or int(review.get("total") or 0) != existing_total
    )
    if must_reset:
        CUE_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        CUE_REVIEW_CANONICAL_FILE.write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        def reset(s: dict[str, Any]) -> None:
            s["cue_review"] = _default_state()["cue_review"]
            s["word_review"] = _default_state()["word_review"]
            s["cue_timing"] = _default_state()["cue_timing"]
            s["word_timing"] = _default_state()["word_timing"]
            s["cue_review"].update({
                "status": "reviewing",
                "source_snapshot_id": snapshot_id,
                "total": len(source["cues"]),
                "accepted_orders": [],
                "current_order": 1,
                "completed": False,
                "updated_at": _now_iso(),
            })
        state = _update_state(reset)
        review = state["cue_review"]
    reviewed = json.loads(CUE_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
    return source, reviewed, review


def _source_cue_for_reviewed(source_cues: list[dict[str, Any]], current_cue: dict[str, Any], fallback_index: int) -> dict[str, Any]:
    current_start = int(current_cue.get("speech_start_ms") or 0)
    current_end = int(current_cue.get("speech_end_ms") or 0)
    current_original = str(current_cue.get("original_en") or "").strip()
    if not current_original:
        return current_cue
    for cue in source_cues:
        if int(cue.get("speech_start_ms") or 0) == current_start and int(cue.get("speech_end_ms") or 0) == current_end and str(cue.get("original_en") or "").strip() == current_original:
            return cue
    if 0 <= fallback_index < len(source_cues):
        return source_cues[fallback_index]
    return current_cue


def _cue_review_payload() -> dict[str, Any]:
    source, reviewed, review = _ensure_cue_review()
    accepted = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    source_cues = source["cues"]
    reviewed_cues = reviewed["cues"]
    items = []
    for index, current_cue in enumerate(reviewed_cues):
        ai_cue = _source_cue_for_reviewed(source_cues, current_cue, index)
        order = int(current_cue["order"])
        items.append({
            "order": order,
            "label": str(current_cue.get("approved_en") or ai_cue.get("approved_en") or ai_cue.get("original_en") or ""),
            "status": "accepted" if order in accepted else "pending",
            "start_ms": int(current_cue.get("speech_start_ms") or current_cue.get("subtitle_start_ms") or 0),
            "end_ms": int(current_cue.get("speech_end_ms") or current_cue.get("subtitle_end_ms") or 0),
        })
    current_order = int(review.get("current_order") or 1)
    if current_order < 1 or current_order > len(reviewed_cues):
        current_order = 1
    current_cue = reviewed_cues[current_order - 1]
    ai_cue = _source_cue_for_reviewed(source_cues, current_cue, current_order - 1)
    return {
        "status": review.get("status") or "reviewing",
        "source_snapshot_id": review.get("source_snapshot_id") or source.get("snapshot_id") or "",
        "total": len(reviewed_cues),
        "accepted": len(accepted),
        "pending": len(reviewed_cues) - len(accepted),
        "completed": len(accepted) == len(reviewed_cues),
        "current_order": current_order,
        "media_url": "/media/process/output/scene_video.mp4",
        "playback_start_ms": int(((reviewed.get("project") or {}).get("scene_start_ms") or 0)),
        "playback_end_ms": int(((reviewed.get("project") or {}).get("scene_end_ms") or _probe_duration_ms(PROCESS_VIDEO_FILE))),
        "items": items,
        "cue": {
            "order": current_order,
            "start_ms": int(current_cue.get("speech_start_ms") or current_cue.get("subtitle_start_ms") or 0),
            "end_ms": int(current_cue.get("speech_end_ms") or current_cue.get("subtitle_end_ms") or 0),
            "ai": {
                "approved_en": str(ai_cue.get("approved_en") or ai_cue.get("original_en") or ""),
                "pt": str(ai_cue.get("pt") or ""),
            },
            "current": {
                "approved_en": str(current_cue.get("approved_en") or ""),
                "pt": str(current_cue.get("pt") or ""),
            },
            "accepted": current_order in accepted,
        },
    }


def _word_review_page_ready(state: dict[str, Any]) -> bool:
    cue_review = state.get("cue_review") or {}
    return bool(
        _cue_review_page_ready(state)
        and cue_review.get("completed")
        and CUE_REVIEW_CANONICAL_FILE.is_file()
    )


def _word_key(cue_order: int, word_index: int) -> str:
    return f"{int(cue_order)}:{int(word_index)}"


def _cue_word_tokens(text: str) -> list[str]:
    """Tokenize approved cue text using the same visual unit used by words[]."""
    return [token for token in re.findall(r"\S+", str(text or "").strip()) if token]


def _cue_word_match_key(text: str) -> str:
    """Match words while ignoring case and edge punctuation.

    Punctuation/capitalization-only edits should update words[].text without
    throwing away a timing that is still valid for the same spoken token.
    """
    value = str(text or "").strip().replace("’", "'").replace("`", "'")
    core = re.sub(r"^[^\w']+|[^\w']+$", "", value, flags=re.UNICODE)
    return (core or value).casefold()


def _cue_word_time(word: dict[str, Any], field: str, fallback: int) -> int:
    try:
        return int(word.get(field))
    except (TypeError, ValueError):
        return int(fallback)


def _cue_word_pending_from_template(
    template: dict[str, Any] | None,
    *,
    text: str,
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    """Create a pending WbW token after a human cue-text edit."""
    base = dict(template or {})
    start_ms = int(start_ms)
    end_ms = max(start_ms + 1, int(end_ms))
    base.update({
        "text": str(text),
        "start_ms": start_ms,
        "end_ms": end_ms,
        "original_start_ms": start_ms,
        "original_end_ms": end_ms,
        "confidence_score": 0.0,
        "review_status": "pending",
        "alignment_source": "cue_text_sync",
        "audio_confidence": 0.0,
        "composite_confidence": 0.0,
        "qc_status": "needs_review",
        "qc_reasons": ["cue_text_changed"],
        "qc_auto_fixed": False,
        "human_verified_audio": False,
        "pt": "",
    })
    for field in ("pt_group", "pt_group_role", "pt_group_original_pt"):
        base.pop(field, None)
    return base


def _cue_word_span_for_edit(
    cue: dict[str, Any],
    old_words: list[dict[str, Any]],
    i1: int,
    i2: int,
) -> tuple[int, int]:
    """Find a safe temporary timing span for inserted/replaced tokens.

    These timings are only a seed for the later WbW Timing review. Existing
    unchanged words keep their exact timings.
    """
    cue_start = int(cue.get("speech_start_ms") or 0)
    cue_end = int(cue.get("speech_end_ms") or max(cue_start + 1, 1))
    if i1 < i2 and old_words:
        start = _cue_word_time(old_words[i1], "start_ms", cue_start)
        end = _cue_word_time(old_words[i2 - 1], "end_ms", cue_end)
        if end > start:
            return start, end

    prev_word = old_words[i1 - 1] if i1 > 0 and i1 - 1 < len(old_words) else None
    next_word = old_words[i1] if i1 < len(old_words) else None
    prev_end = _cue_word_time(prev_word, "end_ms", cue_start) if prev_word else cue_start
    next_start = _cue_word_time(next_word, "start_ms", cue_end) if next_word else cue_end
    if next_start > prev_end:
        return prev_end, next_start

    # No real gap: overlap a neighboring token temporarily rather than moving
    # a timing that is already aligned. WbW Timing will be the authority later.
    if next_word:
        start = _cue_word_time(next_word, "start_ms", cue_start)
        end = _cue_word_time(next_word, "end_ms", start + 1)
        if end > start:
            return start, end
    if prev_word:
        start = _cue_word_time(prev_word, "start_ms", cue_start)
        end = _cue_word_time(prev_word, "end_ms", start + 1)
        if end > start:
            return start, end
    return cue_start, max(cue_start + 1, cue_end)


def _cue_word_allocate_ranges(start_ms: int, end_ms: int, count: int) -> list[tuple[int, int]]:
    if count <= 0:
        return []
    start_ms = int(start_ms)
    end_ms = max(start_ms + 1, int(end_ms))
    width = end_ms - start_ms
    if width < count:
        # A zero/tiny gap is acceptable as a temporary seed. Keep starts equal
        # so the following preserved word never becomes temporally "earlier".
        return [(start_ms, end_ms) for _ in range(count)]
    ranges: list[tuple[int, int]] = []
    for index in range(count):
        start = round(start_ms + (width * index / count))
        end = round(start_ms + (width * (index + 1) / count))
        if end <= start:
            end = start + 1
        ranges.append((int(start), int(end)))
    return ranges


def _sync_cue_words_to_approved_text(cue: dict[str, Any], approved_en: str) -> dict[str, Any]:
    """Reconcile words[] after the human changes a cue's English text.

    Unchanged lexical tokens keep their timing/translation metadata. Replaced
    or inserted tokens become pending and receive only a temporary timing seed.
    PT semantic groups touched by the edit are dissolved so stale grouping is
    never silently carried into the new phrase.
    """
    old_words = [dict(word) for word in (cue.get("words") or []) if isinstance(word, dict)]
    new_tokens = _cue_word_tokens(approved_en)
    if not new_tokens:
        raise ValueError("A cue revisada precisa conter ao menos uma word.")

    if not old_words:
        span_start = int(cue.get("speech_start_ms") or 0)
        span_end = int(cue.get("speech_end_ms") or span_start + 1)
        ranges = _cue_word_allocate_ranges(span_start, span_end, len(new_tokens))
        cue["words"] = [
            _cue_word_pending_from_template(None, text=token, start_ms=start, end_ms=end)
            for token, (start, end) in zip(new_tokens, ranges)
        ]
        _expand_cue_bounds_to_words(cue)
        return {"changed": True, "preserved": 0, "updated": len(new_tokens), "inserted": len(new_tokens), "removed": 0, "total": len(new_tokens)}

    old_keys = [_cue_word_match_key(word.get("text") or "") for word in old_words]
    new_keys = [_cue_word_match_key(token) for token in new_tokens]
    matcher = difflib.SequenceMatcher(a=old_keys, b=new_keys, autojunk=False)

    entries: list[dict[str, Any]] = []
    affected_group_ids: set[str] = set()
    changed_old_indices: set[int] = set()
    preserved = 0
    updated = 0
    inserted = 0
    removed = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for old_index, new_index in zip(range(i1, i2), range(j1, j2)):
                word = dict(old_words[old_index])
                word["text"] = new_tokens[new_index]
                entries.append({"word": word, "source_index": old_index, "changed": False})
                preserved += 1
            continue

        changed_old_indices.update(range(i1, i2))
        removed += max(0, (i2 - i1) - (j2 - j1))
        inserted += max(0, (j2 - j1) - (i2 - i1))

        # Insertion inside an existing PT group breaks contiguity even when no
        # old token itself was replaced.
        if tag == "insert" and i1 > 0 and i1 < len(old_words):
            left_group = str(old_words[i1 - 1].get("pt_group") or "").strip()
            right_group = str(old_words[i1].get("pt_group") or "").strip()
            if left_group and left_group == right_group:
                affected_group_ids.add(left_group)

        new_segment = new_tokens[j1:j2]
        if not new_segment:
            continue
        span_start, span_end = _cue_word_span_for_edit(cue, old_words, i1, i2)
        ranges = _cue_word_allocate_ranges(span_start, span_end, len(new_segment))
        for offset, (token, (start, end)) in enumerate(zip(new_segment, ranges)):
            source_index = i1 + offset if i1 + offset < i2 else None
            template = old_words[source_index] if source_index is not None else (
                old_words[i1] if i1 < len(old_words) else old_words[-1]
            )
            word = _cue_word_pending_from_template(template, text=token, start_ms=start, end_ms=end)
            entries.append({"word": word, "source_index": source_index, "changed": True})
            updated += 1

    for old_index in changed_old_indices:
        group_id = str(old_words[old_index].get("pt_group") or "").strip()
        if group_id:
            affected_group_ids.add(group_id)

    # Dissolve every semantic PT group touched by the edit. Preserve the old
    # individual PT backup when available so the reviewer does not lose data.
    for entry in entries:
        source_index = entry.get("source_index")
        if source_index is None:
            continue
        old_word = old_words[int(source_index)]
        group_id = str(old_word.get("pt_group") or "").strip()
        if not group_id or group_id not in affected_group_ids:
            continue
        word = entry["word"]
        fallback_pt = str(old_word.get("pt_group_original_pt") or old_word.get("pt") or "").strip()
        for field in ("pt_group", "pt_group_role", "pt_group_original_pt"):
            word.pop(field, None)
        if not entry.get("changed"):
            word["pt"] = fallback_pt
            word["review_status"] = "pending"
            word["human_verified_audio"] = False
            word["qc_status"] = "needs_review"
            reasons = list(word.get("qc_reasons") or [])
            if "cue_text_group_changed" not in reasons:
                reasons.append("cue_text_group_changed")
            word["qc_reasons"] = reasons
            word["qc_auto_fixed"] = False

    cue["words"] = [entry["word"] for entry in entries]
    _expand_cue_bounds_to_words(cue)
    return {
        "changed": True,
        "preserved": preserved,
        "updated": updated,
        "inserted": inserted,
        "removed": removed,
        "total": len(cue["words"]),
    }


def _word_positions(document: dict[str, Any]) -> list[tuple[int, int]]:
    positions: list[tuple[int, int]] = []
    for cue in document.get("cues") or []:
        order = int(cue.get("order") or 0)
        for index, _word in enumerate(cue.get("words") or []):
            positions.append((order, index))
    return positions


def _find_group_lead_index(cue: dict[str, Any], group_id: str) -> int:
    words = cue.get("words") or []
    for index, word in enumerate(words):
        if word.get("pt_group") == group_id and word.get("pt_group_role") == "lead":
            return index
    raise RuntimeError(f"pt_group '{group_id}' não possui lead na cue {cue.get('order')}.")


def _resolved_word_pt(cue: dict[str, Any], word_index: int) -> tuple[str, dict[str, Any] | None]:
    words = cue.get("words") or []
    word = words[word_index]
    group_id = str(word.get("pt_group") or "").strip()
    if not group_id:
        return str(word.get("pt") or ""), None
    lead_index = _find_group_lead_index(cue, group_id)
    lead = words[lead_index]
    member_indices = [i for i, item in enumerate(words) if str(item.get("pt_group") or "") == group_id]
    return str(lead.get("pt") or ""), {
        "id": group_id,
        "role": str(word.get("pt_group_role") or ""),
        "lead_index": lead_index,
        "member_indices": member_indices,
        "members_text": " ".join(str(words[i].get("text") or "") for i in member_indices).strip(),
    }


def _word_semantic_members(cue: dict[str, Any], word_index: int) -> list[int]:
    words = cue.get("words") or []
    if word_index < 0 or word_index >= len(words):
        raise ValueError("Word não encontrada.")
    group_id = str(words[word_index].get("pt_group") or "").strip()
    if not group_id:
        return [word_index]
    members = [i for i, item in enumerate(words) if str(item.get("pt_group") or "").strip() == group_id]
    members.sort()
    return members


def _word_review_units_for_cue(cue: dict[str, Any], accepted: set[str] | None = None) -> list[dict[str, Any]]:
    words = cue.get("words") or []
    order = int(cue.get("order") or 0)
    accepted = accepted or set()
    units: list[dict[str, Any]] = []
    consumed: set[int] = set()
    for index, word in enumerate(words):
        if index in consumed:
            continue
        members = _word_semantic_members(cue, index)
        consumed.update(members)
        group_id = str(word.get("pt_group") or "").strip()
        if group_id:
            lead_index = _find_group_lead_index(cue, group_id)
            pt = str(words[lead_index].get("pt") or "")
        else:
            lead_index = index
            pt = str(word.get("pt") or "")
        units.append({
            "unit_index": len(units),
            "lead_index": lead_index,
            "member_indices": members,
            "group_id": group_id,
            "is_group": len(members) > 1,
            "en": " ".join(str(words[i].get("text") or "").strip() for i in members).strip(),
            "pt": pt,
            "status": "accepted" if all(_word_key(order, i) in accepted for i in members) else "pending",
        })
    return units


def _reset_word_review_dependents() -> None:
    shutil.rmtree(CUE_TIMING_DIR, ignore_errors=True)
    shutil.rmtree(WORD_TIMING_DIR, ignore_errors=True)


def _invalidate_word_review_members(review: dict[str, Any], cue_order: int, member_indices: list[int]) -> tuple[set[str], bool]:
    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}
    for index in member_indices:
        accepted.discard(_word_key(cue_order, index))
    return accepted, False


def _ensure_word_review() -> tuple[dict[str, Any], dict[str, Any]]:
    state = _read_state()
    if not _word_review_page_ready(state):
        raise RuntimeError("Conclua a revisão de todas as cues antes de revisar o Word by Word.")
    source = json.loads(CUE_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
    if not isinstance(source, dict) or not isinstance(source.get("cues"), list) or not source["cues"]:
        raise RuntimeError("O JSON revisado de cues não contém cues válidas.")
    positions = _word_positions(source)
    if not positions:
        raise RuntimeError("O JSON revisado não contém words para revisão.")
    snapshot_id = str(source.get("snapshot_id") or "")
    review = state.get("word_review") or {}
    must_reset = (
        not WORD_REVIEW_CANONICAL_FILE.is_file()
        or str(review.get("source_snapshot_id") or "") != snapshot_id
        or int(review.get("total_words") or 0) != len(positions)
    )
    if must_reset:
        WORD_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        WORD_REVIEW_CANONICAL_FILE.write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        first_cue, first_index = positions[0]
        def reset(s: dict[str, Any]) -> None:
            s["word_review"] = _default_state()["word_review"]
            s["cue_timing"] = _default_state()["cue_timing"]
            s["word_timing"] = _default_state()["word_timing"]
            s["word_review"].update({
                "status": "reviewing",
                "source_snapshot_id": snapshot_id,
                "total_words": len(positions),
                "accepted_keys": [],
                "current_cue_order": first_cue,
                "current_word_index": first_index,
                "completed": False,
                "updated_at": _now_iso(),
            })
        state = _update_state(reset)
        review = state["word_review"]
    reviewed = json.loads(WORD_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
    return reviewed, review


def _word_review_payload() -> dict[str, Any]:
    reviewed, review = _ensure_word_review()
    cues = reviewed["cues"]
    positions = _word_positions(reviewed)
    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}

    cue_items: list[dict[str, Any]] = []
    for cue in cues:
        order = int(cue["order"])
        words = cue.get("words") or []
        accepted_count = sum(1 for index in range(len(words)) if _word_key(order, index) in accepted)
        cue_items.append({
            "order": order,
            "label": str(cue.get("approved_en") or cue.get("original_en") or ""),
            "speech_start_ms": int(cue.get("speech_start_ms") or 0),
            "speech_end_ms": int(cue.get("speech_end_ms") or 0),
            "subtitle_start_ms": int(cue.get("subtitle_start_ms") or cue.get("speech_start_ms") or 0),
            "subtitle_end_ms": int(cue.get("subtitle_end_ms") or cue.get("speech_end_ms") or 0),
            "accepted": accepted_count,
            "total": len(words),
            "status": "accepted" if words and accepted_count == len(words) else "pending",
        })

    current_cue_order = int(review.get("current_cue_order") or positions[0][0])
    current_word_index = int(review.get("current_word_index") or 0)
    valid_positions = set(positions)
    if (current_cue_order, current_word_index) not in valid_positions:
        pending = [pos for pos in positions if _word_key(*pos) not in accepted]
        current_cue_order, current_word_index = pending[0] if pending else positions[0]

    cue = cues[current_cue_order - 1]
    words = cue.get("words") or []
    word = words[current_word_index]
    display_pt, group = _resolved_word_pt(cue, current_word_index)
    word_items = []
    for index, item in enumerate(words):
        word_items.append({
            "index": index,
            "number": index + 1,
            "text": str(item.get("text") or ""),
            "group_id": str(item.get("pt_group") or "").strip(),
            "status": "accepted" if _word_key(current_cue_order, index) in accepted else "pending",
        })
    unit_items = _word_review_units_for_cue(cue, accepted)
    current_members = _word_semantic_members(cue, current_word_index)

    return {
        "status": review.get("status") or "reviewing",
        "source_snapshot_id": review.get("source_snapshot_id") or reviewed.get("snapshot_id") or "",
        "total_words": len(positions),
        "accepted_words": len(accepted),
        "pending_words": len(positions) - len(accepted),
        "completed": len(accepted) == len(positions),
        "current_cue_order": current_cue_order,
        "current_word_index": current_word_index,
        "cues": cue_items,
        "word_items": word_items,
        "unit_items": unit_items,
        "word": {
            "cue_order": current_cue_order,
            "cue_text": str(cue.get("approved_en") or cue.get("original_en") or ""),
            "cue_pt": str(cue.get("pt") or ""),
            "word_index": current_word_index,
            "word_number": current_word_index + 1,
            "words_in_cue": len(words),
            "text": str(word.get("text") or ""),
            "pt": display_pt,
            "start_ms": int(word.get("start_ms") or 0),
            "end_ms": int(word.get("end_ms") or 0),
            "group": group,
            "semantic_member_indices": current_members,
            "can_group_previous": min(current_members) > 0,
            "can_group_next": max(current_members) < len(words) - 1,
            "accepted": _word_key(current_cue_order, current_word_index) in accepted,
        },
    }


def _cue_timing_page_ready(state: dict[str, Any]) -> bool:
    review = state.get("word_review") or {}
    return bool(
        _word_review_page_ready(state)
        and review.get("completed")
        and WORD_REVIEW_CANONICAL_FILE.is_file()
        and PROCESS_VIDEO_FILE.is_file()
        and PROCESS_AUDIO_FILE.is_file()
    )


def _normalize_speaker_options(values: list[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        name = str(raw or "").strip()
        if not name:
            continue
        name = name[:80].rstrip()
        key = name.casefold()
        if not name or key in seen:
            continue
        seen.add(key)
        result.append(name)
        if len(result) >= 50:
            break
    return result


def _ensure_cue_timing() -> tuple[dict[str, Any], dict[str, Any], int]:
    state = _read_state()
    if not _cue_timing_page_ready(state):
        raise RuntimeError("Conclua a revisão Word by Word antes de ajustar IN/OUT e speakers.")
    source = json.loads(WORD_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
    cues = source.get("cues") or []
    if not isinstance(cues, list) or not cues:
        raise RuntimeError("O JSON revisado Word by Word não contém cues válidas.")
    source_snapshot_id = str(source.get("snapshot_id") or "")
    source_revision = hashlib.sha256(WORD_REVIEW_CANONICAL_FILE.read_bytes()).hexdigest()
    review = state.get("cue_timing") or {}
    must_reset = (
        not CUE_TIMING_CANONICAL_FILE.is_file()
        or str(review.get("source_snapshot_id") or "") != source_snapshot_id
        or str(review.get("source_revision") or "") != source_revision
        or int(review.get("total") or 0) != len(cues)
    )
    if must_reset:
        CUE_TIMING_DIR.mkdir(parents=True, exist_ok=True)
        timing_document = json.loads(json.dumps(source))
        for cue in timing_document.get("cues") or []:
            if isinstance(cue, dict):
                # Speaker is intentionally born in this stage; prior stages do not own it.
                cue["speaker"] = ""
        CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(timing_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        waveform = _generate_waveform(PROCESS_AUDIO_FILE, points=2400)
        CUE_TIMING_WAVEFORM_FILE.write_text(json.dumps(waveform, ensure_ascii=False) + "\n", encoding="utf-8")
        def reset(s: dict[str, Any]) -> None:
            s["cue_timing"] = _default_state()["cue_timing"]
            s["word_timing"] = _default_state()["word_timing"]
            s["cue_timing"].update({
                "status": "reviewing",
                "source_snapshot_id": source_snapshot_id,
                "source_revision": source_revision,
                "total": len(cues),
                "accepted_orders": [],
                "current_order": 1,
                "completed": False,
                "speaker_options": [],
                "updated_at": _now_iso(),
            })
        state = _update_state(reset)
        review = state["cue_timing"]
    document = json.loads(CUE_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    return document, review, duration_ms


def _cue_timing_payload(*, include_waveform: bool = True) -> dict[str, Any]:
    document, review, duration_ms = _ensure_cue_timing()
    cues = document.get("cues") or []
    accepted = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    current_order = int(review.get("current_order") or 1)
    if current_order < 1 or current_order > len(cues):
        current_order = 1
    current = cues[current_order - 1]
    payload = {
        "content_type": str(((_read_state().get("configuration") or {}).get("content_type") or "kit")),
        "status": review.get("status") or "reviewing",
        "total": len(cues),
        "accepted": len(accepted),
        "pending": len(cues) - len(accepted),
        "completed": len(accepted) == len(cues),
        "current_order": current_order,
        "duration_ms": duration_ms,
        "media_url": "/media/process/output/scene_video.mp4",
        "speaker_options": _normalize_speaker_options(list(review.get("speaker_options") or [])),
        "items": [
            {
                "order": int(cue.get("order") or index),
                "label": str(cue.get("approved_en") or cue.get("original_en") or ""),
                "pt": str(cue.get("pt") or ""),
                "speaker": str(cue.get("speaker") or ""),
                "start_ms": int(cue.get("speech_start_ms") or 0),
                "end_ms": int(cue.get("speech_end_ms") or 0),
                "status": "accepted" if int(cue.get("order") or index) in accepted else "pending",
            }
            for index, cue in enumerate(cues, start=1)
        ],
        "cue": {
            "order": current_order,
            "approved_en": str(current.get("approved_en") or current.get("original_en") or ""),
            "pt": str(current.get("pt") or ""),
            "speaker": str(current.get("speaker") or ""),
            "start_ms": int(current.get("speech_start_ms") or 0),
            "end_ms": int(current.get("speech_end_ms") or 0),
            "accepted": current_order in accepted,
        },
    }
    if include_waveform:
        try:
            payload["waveform"] = json.loads(CUE_TIMING_WAVEFORM_FILE.read_text(encoding="utf-8"))
        except Exception:
            payload["waveform"] = _generate_waveform(PROCESS_AUDIO_FILE, points=2400)
    return payload


def _word_timing_page_ready(state: dict[str, Any]) -> bool:
    review = state.get("cue_timing") or {}
    return bool(
        _cue_timing_page_ready(state)
        and review.get("completed")
        and CUE_TIMING_CANONICAL_FILE.is_file()
        and PROCESS_VIDEO_FILE.is_file()
        and PROCESS_AUDIO_FILE.is_file()
    )


def _word_timing_units_for_cue(cue: dict[str, Any]) -> list[dict[str, Any]]:
    """Return one timing unit per source word.

    ``pt_group`` describes a semantic translation relationship only.  It must
    not merge multiple English words into one editable timing range.
    """
    words = cue.get("words") or []
    units: list[dict[str, Any]] = []
    for index, word in enumerate(words):
        group_id = str(word.get("pt_group") or "").strip()
        units.append({
            "unit_index": index,
            "member_indices": [index],
            "group_id": group_id,
            "is_group": False,
            "en": str(word.get("text") or "").strip(),
            "pt": str(word.get("pt") or "").strip(),
            "start_ms": int(word.get("start_ms") or 0),
            "end_ms": int(word.get("end_ms") or 0),
        })
    return units


def _word_timing_positions(document: dict[str, Any]) -> list[tuple[int, int]]:
    positions: list[tuple[int, int]] = []
    for cue in document.get("cues") or []:
        order = int(cue.get("order") or 0)
        for unit in _word_timing_units_for_cue(cue):
            positions.append((order, int(unit["unit_index"])))
    return positions


def _word_timing_key(cue_order: int, unit_index: int) -> str:
    return f"{int(cue_order)}:{int(unit_index)}"


def _expand_cue_bounds_to_words(cue: dict[str, Any]) -> bool:
    """Expand speech timing so every WbW word remains inside its cue.

    WbW is allowed to define the real audible edge of a cue. We never clamp or
    rescale a reviewed word to fit an older cue boundary; the cue follows the
    first/last word instead. subtitle_* follows only when it was linked to the
    previous speech boundary.
    """
    words = [word for word in (cue.get("words") or []) if isinstance(word, dict)]
    timed: list[tuple[int, int]] = []
    for word in words:
        try:
            start = int(word.get("start_ms"))
            end = int(word.get("end_ms"))
        except (TypeError, ValueError):
            continue
        if start >= 0 and end > start:
            timed.append((start, end))
    if not timed:
        return False

    word_start = min(start for start, _end in timed)
    word_end = max(end for _start, end in timed)
    try:
        old_start = int(cue.get("speech_start_ms"))
    except (TypeError, ValueError):
        old_start = word_start
    try:
        old_end = int(cue.get("speech_end_ms"))
    except (TypeError, ValueError):
        old_end = word_end

    new_start = min(old_start, word_start)
    new_end = max(old_end, word_end)
    if new_end <= new_start:
        return False

    changed = new_start != old_start or new_end != old_end
    if not changed:
        return False

    old_subtitle_start = cue.get("subtitle_start_ms")
    old_subtitle_end = cue.get("subtitle_end_ms")
    cue["speech_start_ms"] = new_start
    cue["speech_end_ms"] = new_end
    if old_subtitle_start is not None:
        try:
            if int(old_subtitle_start) == old_start:
                cue["subtitle_start_ms"] = new_start
        except (TypeError, ValueError):
            pass
    if old_subtitle_end is not None:
        try:
            if int(old_subtitle_end) == old_end:
                cue["subtitle_end_ms"] = new_end
        except (TypeError, ValueError):
            pass
    return True


def _normalize_word_timing_cue_bounds(document: dict[str, Any]) -> bool:
    changed = False
    for cue in document.get("cues") or []:
        if isinstance(cue, dict) and _expand_cue_bounds_to_words(cue):
            changed = True
    return changed


def _seed_word_timings_inside_cues(document: dict[str, Any]) -> None:
    """Initialize WbW without squeezing word timings into cue bounds.

    If imported/aligned words extend beyond the current cue, expand the cue.
    Word timings and original_* audit fields remain untouched.
    """
    _normalize_word_timing_cue_bounds(document)


def _ensure_word_timing() -> tuple[dict[str, Any], dict[str, Any], int]:
    state = _read_state()
    if not _word_timing_page_ready(state):
        raise RuntimeError("Conclua o Cue Timing antes de ajustar o timing Word by Word.")
    source = json.loads(CUE_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    cues = source.get("cues") or []
    if not isinstance(cues, list) or not cues:
        raise RuntimeError("O JSON do Cue Timing não contém cues válidas.")
    positions = _word_timing_positions(source)
    if not positions:
        raise RuntimeError("O JSON do Cue Timing não contém unidades Word by Word.")
    source_snapshot_id = str(source.get("snapshot_id") or "")
    source_revision = hashlib.sha256(CUE_TIMING_CANONICAL_FILE.read_bytes()).hexdigest()
    review = state.get("word_timing") or {}
    # Never discard human WbW timing merely because an upstream file changed.
    # Structural cue edits already have dedicated merge/invalidation handlers;
    # opening this page must be read-only with respect to completed work.
    existing_positions: list[tuple[int, int]] = []
    if WORD_TIMING_CANONICAL_FILE.is_file():
        try:
            existing_document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
            existing_positions = _word_timing_positions(existing_document)
        except (OSError, ValueError, TypeError):
            existing_positions = []
    must_reset = not WORD_TIMING_CANONICAL_FILE.is_file() or not existing_positions
    if must_reset:
        WORD_TIMING_DIR.mkdir(parents=True, exist_ok=True)
        timing_document = json.loads(json.dumps(source))
        _seed_word_timings_inside_cues(timing_document)
        WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(timing_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        positions = _word_timing_positions(timing_document)
        first_cue, first_unit = positions[0]
        def reset(s: dict[str, Any]) -> None:
            s["word_timing"] = _default_state()["word_timing"]
            s["word_timing"].update({
                "status": "reviewing",
                "source_snapshot_id": source_snapshot_id,
                "source_revision": source_revision,
                "timing_scope_version": "per-word-v2-cue-authoritative",
                "total_units": len(positions),
                "accepted_keys": [],
                "current_cue_order": first_cue,
                "current_unit_index": first_unit,
                "completed": False,
                "updated_at": _now_iso(),
            })
        state = _update_state(reset)
        review = state["word_timing"]
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    return document, review, duration_ms


def _word_timing_payload(*, include_waveform: bool = True) -> dict[str, Any]:
    document, review, duration_ms = _ensure_word_timing()
    cues = document.get("cues") or []
    positions = _word_timing_positions(document)
    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}
    current_cue = int(review.get("current_cue_order") or positions[0][0])
    current_unit = int(review.get("current_unit_index") or 0)
    if (current_cue, current_unit) not in set(positions):
        pending = [pos for pos in positions if _word_timing_key(*pos) not in accepted]
        current_cue, current_unit = pending[0] if pending else positions[0]

    timeline: list[dict[str, Any]] = []
    cue_items: list[dict[str, Any]] = []
    for cue in cues:
        order = int(cue.get("order") or 0)
        units = _word_timing_units_for_cue(cue)
        accepted_count = sum(1 for unit in units if _word_timing_key(order, int(unit["unit_index"])) in accepted)
        cue_items.append({
            "order": order,
            "label": str(cue.get("approved_en") or cue.get("original_en") or ""),
            "speech_start_ms": int(cue.get("speech_start_ms") or 0),
            "speech_end_ms": int(cue.get("speech_end_ms") or 0),
            "subtitle_start_ms": int(cue.get("subtitle_start_ms") or cue.get("speech_start_ms") or 0),
            "subtitle_end_ms": int(cue.get("subtitle_end_ms") or cue.get("speech_end_ms") or 0),
            "accepted": accepted_count,
            "total": len(units),
            "status": "accepted" if units and accepted_count == len(units) else "pending",
        })
        for unit in units:
            key = _word_timing_key(order, int(unit["unit_index"]))
            timeline.append({
                **unit,
                "cue_order": order,
                "key": key,
                "status": "accepted" if key in accepted else "pending",
            })

    cue = cues[current_cue - 1]
    units = _word_timing_units_for_cue(cue)
    selected = units[current_unit]
    unit_items = []
    for unit in units:
        key = _word_timing_key(current_cue, int(unit["unit_index"]))
        unit_items.append({**unit, "key": key, "status": "accepted" if key in accepted else "pending"})

    payload = {
        "status": review.get("status") or "reviewing",
        "source_snapshot_id": review.get("source_snapshot_id") or document.get("snapshot_id") or "",
        "total_units": len(positions),
        "accepted_units": len(accepted),
        "pending_units": len(positions) - len(accepted),
        "completed": len(accepted) == len(positions),
        "content_type": str(((_read_state().get("configuration") or {}).get("content_type") or "kit")),
        "current_cue_order": current_cue,
        "current_unit_index": current_unit,
        "duration_ms": duration_ms,
        "media_url": "/media/process/output/scene_video.mp4",
        "cues": cue_items,
        "unit_items": unit_items,
        "timeline": timeline,
        "cue": {
            "order": current_cue,
            "approved_en": str(cue.get("approved_en") or cue.get("original_en") or ""),
            "pt": str(cue.get("pt") or ""),
            "speaker": str(cue.get("speaker") or ""),
            "start_ms": int(cue.get("speech_start_ms") or 0),
            "end_ms": int(cue.get("speech_end_ms") or 0),
        },
        "unit": {
            **selected,
            "cue_order": current_cue,
            "key": _word_timing_key(current_cue, current_unit),
            "accepted": _word_timing_key(current_cue, current_unit) in accepted,
        },
        "next_stage": {
            "kind": "materials_external" if _music_without_shadowing(_read_state()) else ("dual_scene" if bool((_read_state().get("configuration") or {}).get("dual_scene")) else "shadowing"),
            "url": "/materials-external" if _music_without_shadowing(_read_state()) else ("/dual-scene" if bool((_read_state().get("configuration") or {}).get("dual_scene")) else "/shadowing"),
        },
    }
    if include_waveform:
        try:
            payload["waveform"] = json.loads(CUE_TIMING_WAVEFORM_FILE.read_text(encoding="utf-8"))
        except Exception:
            payload["waveform"] = _generate_waveform(PROCESS_AUDIO_FILE, points=2400)
    return payload


def _apply_word_unit_range(cue: dict[str, Any], unit_index: int, start_ms: int, end_ms: int) -> None:
    units = _word_timing_units_for_cue(cue)
    if unit_index < 0 or unit_index >= len(units):
        raise ValueError("Unidade WbW não encontrada.")
    unit = units[unit_index]
    members = [int(i) for i in unit["member_indices"]]
    words = cue.get("words") or []
    if len(members) == 1:
        word = words[members[0]]
        word["start_ms"] = start_ms
        word["end_ms"] = end_ms
        return

    if end_ms - start_ms < len(members):
        raise ValueError(f"O intervalo do grupo precisa ter pelo menos {len(members)} ms.")
    old_start = int(unit["start_ms"])
    old_end = int(unit["end_ms"])
    old_span = max(1, old_end - old_start)
    new_span = end_ms - start_ms
    for member_index in members:
        word = words[member_index]
        ws = int(word.get("start_ms") or old_start)
        we = int(word.get("end_ms") or ws + 1)
        mapped_start = start_ms + round((ws - old_start) * new_span / old_span)
        mapped_end = start_ms + round((we - old_start) * new_span / old_span)
        mapped_start = max(start_ms, min(end_ms - 1, mapped_start))
        mapped_end = max(mapped_start + 1, min(end_ms, mapped_end))
        word["start_ms"] = mapped_start
        word["end_ms"] = mapped_end
    words[members[0]]["start_ms"] = start_ms
    words[members[-1]]["end_ms"] = end_ms


def _dual_scene_ready(state: dict[str, Any]) -> bool:
    return bool(
        (state.get("configuration") or {}).get("dual_scene")
        and (state.get("word_timing") or {}).get("completed")
        and WORD_TIMING_CANONICAL_FILE.is_file()
        and PROCESS_VIDEO_FILE.is_file()
    )


def _dual_scene_cues(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [{
        "order": int(cue.get("order") or index),
        "en": str(cue.get("approved_en") or cue.get("original_en") or ""),
        "pt": str(cue.get("pt") or ""),
        "start_ms": int(cue.get("speech_start_ms") or 0),
        "end_ms": int(cue.get("speech_end_ms") or 0),
        "words": copy.deepcopy([word for word in (cue.get("words") or []) if isinstance(word, dict)]),
    } for index, cue in enumerate(document.get("cues") or [], start=1)]


def _normalize_dual_scene_blocks(raw_blocks: Any, document: dict[str, Any], en_duration_ms: int, pt_duration_ms: int) -> list[dict[str, Any]]:
    if not isinstance(raw_blocks, list) or not raw_blocks:
        raise ValueError("Crie pelo menos um bloco Dual Scene.")
    cues = _dual_scene_cues(document)
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_blocks, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"Bloco {index} inválido.")
        en_start = int(raw.get("en_start_ms") or 0)
        en_end = int(raw.get("en_end_ms") or 0)
        pt_start = int(raw.get("pt_start_ms") or 0)
        pt_end = int(raw.get("pt_end_ms") or 0)
        if en_start < 0 or en_end <= en_start or en_end > en_duration_ms:
            raise ValueError(f"IN/OUT EN inválido no bloco {index}.")
        if pt_start < 0 or pt_end <= pt_start or (pt_duration_ms > 0 and pt_end > pt_duration_ms):
            raise ValueError(f"IN/OUT PT inválido no bloco {index}.")
        cue_orders = [cue["order"] for cue in cues if cue["end_ms"] > en_start and cue["start_ms"] < en_end]
        if not cue_orders:
            raise ValueError(f"O bloco {index} EN precisa intersectar pelo menos uma cue.")
        normalized.append({
            "video": index,
            "cueOrder": cue_orders[0],
            "cueStartOrder": cue_orders[0],
            "cueEndOrder": cue_orders[-1],
            "cueOrders": cue_orders,
            "en": {"source": "scene", "youtube": str((_read_state().get("en") or {}).get("url") or ""), "start_ms": en_start, "end_ms": en_end},
            "pt": {"source": "dual_scene_pt", "youtube": str((_read_state().get("pt") or {}).get("url") or ""), "start_ms": pt_start, "end_ms": pt_end},
            "transition": {"visual_fade_ms": 120, "audio_fade_ms": 80},
        })
    return normalized


def _dual_scene_payload() -> dict[str, Any]:
    state = _read_state()
    if not _dual_scene_ready(state):
        raise RuntimeError("Conclua o WbW Time de um projeto Dual Scene.")
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    project = document.get("project") if isinstance(document.get("project"), dict) else {}
    en_youtube_offset = int(project.get("media_source_start_ms", project.get("source_video_start_ms") or project.get("scene_start_ms") or 0))
    en_duration = _probe_duration_ms(PROCESS_VIDEO_FILE)
    pt_duration = _probe_duration_ms(DUAL_SCENE_PT_FILE) if DUAL_SCENE_PT_FILE.is_file() else 0
    review = state.get("dual_scene") or {}
    blocks = copy.deepcopy(review.get("blocks") or [])
    cues = _dual_scene_cues(document)
    if not blocks and cues:
        start = cues[0]["start_ms"]
        end = cues[0]["end_ms"]
        blocks = [{"id": "block-1", "en_start_ms": start, "en_end_ms": end, "pt_start_ms": 0, "pt_end_ms": min(pt_duration or max(1, end-start), max(1, end-start))}]
    try:
        en_waveform = json.loads(CUE_TIMING_WAVEFORM_FILE.read_text(encoding="utf-8"))
    except Exception:
        en_waveform = _generate_waveform(PROCESS_AUDIO_FILE, points=2400)
    try:
        pt_waveform = json.loads(DUAL_SCENE_PT_WAVEFORM_FILE.read_text(encoding="utf-8"))
    except Exception:
        pt_waveform = []
    return {
        "status": review.get("status") or "editing", "completed": bool(review.get("completed")),
        "blocks": blocks, "cues": cues,
        "en": {"media_url": "/media/process/output/scene_video.mp4", "youtube_url": str((state.get("en") or {}).get("url") or ""), "youtube_offset_ms": en_youtube_offset, "duration_ms": en_duration, "waveform": en_waveform},
        "pt": {"media_url": "/media/dual_scene/pt/original.mp4" if DUAL_SCENE_PT_FILE.is_file() else "", "youtube_url": str((state.get("pt") or {}).get("url") or ""), "duration_ms": pt_duration, "waveform": pt_waveform, "prepared": DUAL_SCENE_PT_FILE.is_file()},
    }



def _shadowing_page_ready(state: dict[str, Any]) -> bool:
    cfg = state.get("configuration") or {}
    review = state.get("word_timing") or {}
    return bool(
        _word_timing_page_ready(state)
        and review.get("completed")
        and WORD_TIMING_CANONICAL_FILE.is_file()
        and PROCESS_VIDEO_FILE.is_file()
        and PROCESS_AUDIO_FILE.is_file()
        and not bool(cfg.get("dual_scene"))
    )


def _shadowing_student_pause_ms(block_duration_ms: int, config: dict[str, Any]) -> int:
    pause = config.get("studentPause") if isinstance(config.get("studentPause"), dict) else {}
    margin_ms = max(0, round(float(pause.get("marginSeconds", 0.8) or 0.8) * 1000))
    min_ms = max(1, round(float(pause.get("minSeconds", 1.5) or 1.5) * 1000))
    max_ms = max(min_ms, round(float(pause.get("maxSeconds", 6.0) or 6.0) * 1000))
    return max(min_ms, min(max_ms, max(1, int(block_duration_ms)) + margin_ms))


def _normalize_shadowing_markers(markers: Any, duration_ms: int, end_ms: int | None = None) -> list[int]:
    if not isinstance(markers, list):
        raise ValueError("Os marcadores PAUSA precisam ser enviados como uma lista.")
    terminal = int(end_ms) if end_ms is not None else int(duration_ms)
    if terminal <= 0 or terminal > int(duration_ms):
        raise ValueError("END precisa ficar dentro da mídia.")
    values: list[int] = []
    seen: set[int] = set()
    for raw in markers:
        try:
            value = int(round(float(raw)))
        except (TypeError, ValueError):
            raise ValueError("Marcador PAUSA inválido.")
        if value <= 0 or value >= terminal:
            raise ValueError("Cada PAUSA precisa ficar depois do início do bloco e antes do END/fim da mídia.")
        if value in seen:
            continue
        seen.add(value)
        values.append(value)
    values.sort()
    return values


def _shadowing_cue_orders(cues: list[dict[str, Any]], start_ms: int, end_ms: int) -> list[int]:
    orders: list[int] = []
    for cue in cues:
        cue_start = int(cue.get("speech_start_ms") or 0)
        cue_end = int(cue.get("speech_end_ms") or cue_start)
        if cue_end > start_ms and cue_start < end_ms:
            order = int(cue.get("order") or 0)
            if order > 0:
                orders.append(order)
    return orders


def _normalize_shadowing_segments(raw: Any, duration_ms: int) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("Crie pelo menos um trecho de Shadowing.")
    segments: list[dict[str, Any]] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Trecho {index}: estrutura inválida.")
        try:
            start_ms = int(round(float(item.get("start_ms"))))
            end_ms = int(round(float(item.get("end_ms"))))
        except (TypeError, ValueError):
            raise ValueError(f"Trecho {index}: START e END precisam ser números.")
        if not 0 <= start_ms < end_ms <= duration_ms:
            raise ValueError(f"Trecho {index}: use 0 <= START < END <= {duration_ms} ms.")
        pauses = _normalize_shadowing_markers(item.get("pause_markers_ms") or [], duration_ms, end_ms)
        pauses = [value for value in pauses if start_ms < value < end_ms]
        if len(pauses) != len(set(int(v) for v in (item.get("pause_markers_ms") or []))):
            raise ValueError(f"Trecho {index}: cada PAUSA precisa ficar entre o START e o END do próprio trecho.")
        segments.append({"id": str(item.get("id") or f"segment-{index}"), "start_ms": start_ms, "end_ms": end_ms, "pause_markers_ms": pauses})
    segments.sort(key=lambda row: (row["start_ms"], row["end_ms"]))
    for previous, current in zip(segments, segments[1:]):
        if current["start_ms"] < previous["end_ms"]:
            raise ValueError("Trechos de Shadowing não podem se sobrepor.")
    return segments


def _build_shadowing_plan(document: dict[str, Any], markers: Any, end_ms: int | None, duration_ms: int, segments: Any = None) -> dict[str, Any]:
    if duration_ms <= 0:
        raise ValueError("A duração da cena é inválida para Shadowing.")
    if isinstance(segments, list) and segments:
        normalized_segments = _normalize_shadowing_segments(segments, duration_ms)
    else:
        terminal_end = int(duration_ms) if end_ms is None else int(end_ms)
        pauses = _normalize_shadowing_markers(markers, duration_ms, terminal_end)
        normalized_segments = [{"id": "segment-1", "start_ms": 0, "end_ms": terminal_end, "pause_markers_ms": pauses}]

    editor_segments = normalized_segments
    normalized_segments = [
        {**row, "end_ms": row["pause_markers_ms"][-1]}
        for row in editor_segments if row["pause_markers_ms"]
    ]
    config = document.get("shadowingConfig") if isinstance(document.get("shadowingConfig"), dict) else {}
    cues = document.get("cues") if isinstance(document.get("cues"), list) else []
    project = document.get("project") or {}
    scene_source_start = int(project.get("source_video_start_ms", project.get("scene_start_ms", 0)) or 0)
    blocks: list[dict[str, Any]] = []
    for segment_index, segment in enumerate(editor_segments, start=1):
        boundaries = [(value, "pause") for value in segment["pause_markers_ms"]]
        block_start = segment["start_ms"]
        for block_end, boundary_type in boundaries:
            speech_ms = block_end - block_start
            blocks.append({
                "order": len(blocks) + 1, "segment_order": segment_index, "segment_id": segment["id"],
                "start_ms": block_start, "pause_at_ms": block_end, "end_ms": block_end,
                "speech_duration_ms": speech_ms, "repeat_ms": speech_ms,
                "pause_duration_ms": _shadowing_student_pause_ms(speech_ms, config),
                "continue_at_ms": None, "terminal": False, "boundary_type": boundary_type,
                "cue_orders": _shadowing_cue_orders(cues, block_start, block_end),
                "source_start_ms": scene_source_start + block_start, "source_pause_ms": scene_source_start + block_end,
                "source_end_ms": scene_source_start + block_end, "source_continue_ms": None,
            })
            block_start = block_end
    for index, block in enumerate(blocks):
        next_start = blocks[index + 1]["start_ms"] if index + 1 < len(blocks) else None
        block["continue_at_ms"] = next_start
        block["source_continue_ms"] = None if next_start is None else scene_source_start + next_start
        block["terminal"] = next_start is None
        if block["terminal"]:
            block["boundary_type"] = "final_end"

    all_pauses = [value for segment in normalized_segments for value in segment["pause_markers_ms"]]
    terminal_end = normalized_segments[-1]["end_ms"] if normalized_segments else 0

    return {
        "version": 3,
        "enabled": True,
        "mode": "discontinuous_segments",
        "timeline": "scene_relative_ms",
        "scene_duration_ms": int(duration_ms),
        "source_window": {"start_ms": scene_source_start + (normalized_segments[0]["start_ms"] if normalized_segments else 0), "end_ms": scene_source_start + terminal_end},
        "source_windows": [{"start_ms": scene_source_start + row["start_ms"], "end_ms": scene_source_start + row["end_ms"]} for row in normalized_segments],
        "end": {"mode": "segments", "at_ms": terminal_end},
        "segments": normalized_segments,
        "editor_segments": editor_segments,
        "segment_count": len(normalized_segments),
        "selected_duration_ms": sum(row["end_ms"] - row["start_ms"] for row in normalized_segments),
        "pause_markers_ms": all_pauses,
        "pause_marker_count": len(all_pauses),
        "block_count": len(blocks),
        "studentPause": config.get("studentPause") if isinstance(config.get("studentPause"), dict) else {},
        "blocks": blocks,
    }


def _ensure_shadowing() -> tuple[dict[str, Any], dict[str, Any], int]:
    state = _read_state()
    if not _shadowing_page_ready(state):
        cfg = state.get("configuration") or {}
        if bool(cfg.get("dual_scene")):
            raise RuntimeError("Este projeto usa Dual Scene. O ramo Dual Scene será a próxima implementação.")
        raise RuntimeError("Conclua o WbW Time antes de configurar o Shadowing.")
    source = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    source_snapshot_id = str(source.get("snapshot_id") or "")
    source_revision = hashlib.sha256(WORD_TIMING_CANONICAL_FILE.read_bytes()).hexdigest()
    review = state.get("shadowing") or {}
    revision_changed = (
        str(review.get("source_snapshot_id") or "") != source_snapshot_id
        or str(review.get("source_revision") or "") != source_revision
    )
    has_saved_shadowing = bool(review.get("segments")) or SHADOWING_PLAN_FILE.is_file()
    # Opening Shadowing must never erase human segments. Upstream structural
    # edit endpoints handle their own scoped invalidation/merge.
    must_reset = revision_changed and not has_saved_shadowing
    if must_reset:
        SHADOWING_DIR.mkdir(parents=True, exist_ok=True)
        if SHADOWING_PLAN_FILE.is_file():
            SHADOWING_PLAN_FILE.unlink()
        def reset(s: dict[str, Any]) -> None:
            s["shadowing"] = _default_state()["shadowing"]
            s["shadowing"].update({
                "status": "editing",
                "source_snapshot_id": source_snapshot_id,
                "source_revision": source_revision,
                "pause_markers_ms": [],
                "end_ms": None,
                "completed": False,
                "updated_at": _now_iso(),
            })
        state = _update_state(reset)
        review = state["shadowing"]
    elif revision_changed and has_saved_shadowing:
        def refresh_source(s: dict[str, Any]) -> None:
            s["shadowing"]["source_snapshot_id"] = source_snapshot_id
            s["shadowing"]["source_revision"] = source_revision
            s["shadowing"]["updated_at"] = _now_iso()
        state = _update_state(refresh_source)
        review = state["shadowing"]
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    return source, review, duration_ms


def _shadowing_payload(*, include_waveform: bool = True) -> dict[str, Any]:
    document, review, duration_ms = _ensure_shadowing()
    raw_end = review.get("end_ms")
    end_ms = int(raw_end) if isinstance(raw_end, (int, float)) and int(raw_end) > 0 else None
    plan = _build_shadowing_plan(document, review.get("pause_markers_ms") or [], end_ms, duration_ms, review.get("segments"))
    cue_map = []
    for cue in document.get("cues") or []:
        cue_map.append({
            "order": int(cue.get("order") or 0),
            "en": str(cue.get("approved_en") or cue.get("original_en") or ""),
            "pt": str(cue.get("pt") or ""),
            "speaker": str(cue.get("speaker") or ""),
            "start_ms": int(cue.get("speech_start_ms") or 0),
            "end_ms": int(cue.get("speech_end_ms") or 0),
        })
    content_type = str(((document.get("project") or {}).get("content_type") or "dialogue"))
    payload = {
        "status": review.get("status") or "editing",
        "completed": bool(review.get("completed")),
        "content_type": content_type,
        "next_stage": {"kind": "materials_external", "url": "/materials-external"},
        "duration_ms": duration_ms,
        "media_url": "/media/process/output/scene_video.mp4",
        "pause_markers_ms": plan["pause_markers_ms"],
        "segments": plan["editor_segments"],
        "selected_duration_ms": plan["selected_duration_ms"],
        "end_ms": end_ms,
        "end_mode": plan["end"]["mode"],
        "blocks": plan["blocks"],
        "block_count": plan["block_count"],
        "config": document.get("shadowingConfig") if isinstance(document.get("shadowingConfig"), dict) else {},
        "cues": cue_map,
    }
    if include_waveform:
        try:
            payload["waveform"] = json.loads(CUE_TIMING_WAVEFORM_FILE.read_text(encoding="utf-8"))
        except Exception:
            payload["waveform"] = _generate_waveform(PROCESS_AUDIO_FILE, points=2400)
    return payload


def _connected_speech_page_ready(state: dict[str, Any]) -> bool:
    if bool((state.get("configuration") or {}).get("dual_scene")):
        return False
    try:
        _document, review, _duration_ms = _ensure_shadowing()
    except Exception:
        return False
    return bool(review.get("completed")) and SHADOWING_PLAN_FILE.is_file() and WORD_TIMING_CANONICAL_FILE.is_file() and PROCESS_AUDIO_FILE.is_file()


def _connected_speech_artifact_payload(key: str, name: str, kind: str, path: Path, description: str) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "kind": kind,
        "description": description,
        "size_bytes": int(path.stat().st_size if path.is_file() else 0),
        "size_label": _human_bytes(path.stat().st_size if path.is_file() else 0),
        "download_url": f"/api/connected-speech/artifact/{key}",
    }


def _connected_speech_scope_text(document: dict[str, Any], plan: dict[str, Any], canonical_sha256: str, audio_sha256: str) -> str:
    project = document.get("project") or {}
    local_start = 0
    local_end = int((plan.get("end") or {}).get("at_ms") or project.get("scene_duration_ms") or 0)
    source_scene_start = int(project.get("source_video_start_ms", project.get("scene_start_ms", 0)) or 0)
    source_start = source_scene_start + local_start
    source_end = source_scene_start + local_end
    block_lines = []
    for block in plan.get("blocks") or []:
        block_lines.append(
            f"- bloco {int(block.get('order') or 0):02d}: local {int(block.get('start_ms') or 0)}..{int(block.get('end_ms') or 0)} ms | "
            f"source {int(block.get('source_start_ms') or 0)}..{int(block.get('source_end_ms') or 0)} ms | "
            f"cue_orders={','.join(str(v) for v in (block.get('cue_orders') or [])) or '-'}"
        )
    return f"""MEDIA AND SUBTITLE GENERATOR — CONNECTED SPEECH — ESCOPO DE AUDIO

TIMELINE QUE A IA DEVE ANALISAR
- arquivo: scene_audio_16k_mono.wav
- audio_local_start_ms: {local_start}
- audio_local_end_ms: {local_end}
- source_video_start_ms: {source_start}
- source_video_end_ms: {source_end}
- source_scene_start_ms: {source_scene_start}
- source_scene_end_ms: {int(project.get('source_video_end_ms', source_scene_start + int(project.get('scene_duration_ms') or 0)) or 0)}

REGRA DE TIMING
O WAV e o JSON canonico usam timeline LOCAL da cena para cues/words. Portanto, para a analise de Connected Speech, use somente {local_start}..{local_end} ms do WAV. Nao some source_video_start_ms aos timestamps devolvidos. Os valores source_video_* existem apenas para localizar este recorte no video original.

INTEGRIDADE DA ENTRADA
- snapshot_id: {document.get('snapshot_id') or ''}
- canonical_sha256: {canonical_sha256}
- audio_sha256: {audio_sha256}

BLOCOS DE SHADOWING JA APROVADOS
{chr(10).join(block_lines) if block_lines else '- nenhum bloco encontrado'}

Nao altere os blocos de Shadowing. Eles sao apenas contexto para entender como a cena sera praticada no HUB.
"""


def _connected_speech_instructions_text(document: dict[str, Any], plan: dict[str, Any], canonical_sha256: str) -> str:
    project = document.get("project") or {}
    work_end = int((plan.get("end") or {}).get("at_ms") or project.get("scene_duration_ms") or 0)
    snapshot = str(document.get("snapshot_id") or "")
    return f"""MEDIA AND SUBTITLE GENERATOR — IA EXTERNA — CONNECTED SPEECH

ENTRADAS
1. canonical_scene_current.json
2. scene_audio_16k_mono.wav
3. ESCOPO_CONNECTED_SPEECH.txt

OBJETIVO
Analise a fala REAL do audio e identifique fenomenos de Connected Speech dentro do intervalo local 0..{work_end} ms. O JSON canonico ja contem cues, texto aprovado, traducao PT, speakers e Word by Word com timestamps revisados. Use-o como mapa da cena e como fonte de ids/timings; use o audio como autoridade para confirmar o que realmente e pronunciado.

NAO MODIFIQUE O JSON CANONICO
- Nao remova, renomeie ou acrescente campos em canonical_scene_current.json.
- Nao recalcule cues, words, traducoes, speaker ou Shadowing.
- Nao devolva um Super JSON e nao envolva o canônico em outro objeto.
- snapshot_id esperado: {snapshot}
- sha256 esperado do canônico: {canonical_sha256}

O QUE ANALISAR
Para cada cue cuja fala intersecte 0..{work_end} ms:
- linking: ligacao sonora entre palavras;
- elision: som omitido na fala natural;
- assimilation: som alterado pela influencia do som vizinho;
- reduction: forma reduzida/fraca observada no audio;
- contraction: contracao efetivamente realizada na fala.

REGRAS
- Confirme pelo audio; nao marque fenomeno apenas porque ele seria teoricamente possivel no texto.
- Use somente cue_order existente no JSON canônico.
- start_ms/end_ms do fenomeno sao LOCAIS ao WAV e devem ficar dentro do cue correspondente.
- Quando o fenomeno envolver mais de uma palavra, use os timestamps WbW como referencia e cubra apenas o trecho necessario.
- sequenceOrder deve ser unico, inteiro, iniciar em 1 e crescer sem lacunas em toda a cena.
- explanation_pt deve ser curta, clara e voltada a um estudante de ingles.
- confidence deve ser numero entre 0.0 e 1.0.
- Se um cue nao tiver fenomeno confirmado, ainda assim devolva esse cue com phenomena: [].
- Nao invente pronuncia fonetica que nao possa confirmar no audio.

ARQUIVO QUE DEVE SER DEVOLVIDO
Nome: connected_speech_return.json
Retorne SOMENTE JSON valido, sem Markdown e sem texto fora do JSON, exatamente com esta estrutura:

{{
  "schema": "immersionhub-connected-speech-analysis",
  "schema_version": "1.0",
  "source_snapshot_id": "{snapshot}",
  "source_canonical_sha256": "{canonical_sha256}",
  "audio_scope": {{
    "start_ms": 0,
    "end_ms": {work_end}
  }},
  "cues": [
    {{
      "cue_order": 1,
      "phenomena": [
        {{
          "sequenceOrder": 1,
          "type": "linking",
          "start_ms": 1200,
          "end_ms": 1540,
          "source_text": "turn it",
          "heard_as": "descricao curta de como soa",
          "explanation_pt": "explicacao curta em portugues",
          "confidence": 0.94
        }}
      ]
    }}
  ]
}}

VALIDACAO ANTES DE DEVOLVER
1. source_snapshot_id == "{snapshot}"
2. source_canonical_sha256 == "{canonical_sha256}"
3. audio_scope.start_ms == 0
4. audio_scope.end_ms == {work_end}
5. todos os cue_order existem no canônico e cada cue do escopo aparece uma unica vez
6. types permitidos: linking, elision, assimilation, reduction, contraction
7. sequenceOrder global unico/crescente, apenas para phenomena existentes
8. cada start_ms/end_ms fica dentro do cue e dentro de 0..{work_end} ms
9. nenhuma alteracao ao canonical_scene_current.json

RETORNO
Devolva apenas connected_speech_return.json.
"""


def _prepare_connected_speech_package() -> dict[str, Any]:
    with _connected_speech_lock:
        state = _read_state()
        if not _connected_speech_page_ready(state):
            raise RuntimeError("Conclua e aprove o Shadowing antes de preparar Connected Speech.")
        document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
        plan = json.loads(SHADOWING_PLAN_FILE.read_text(encoding="utf-8"))
        canonical_bytes = WORD_TIMING_CANONICAL_FILE.read_bytes()
        canonical_sha256 = hashlib.sha256(canonical_bytes).hexdigest()
        audio_sha256 = hashlib.sha256(PROCESS_AUDIO_FILE.read_bytes()).hexdigest()
        source_revision = hashlib.sha256(canonical_bytes + SHADOWING_PLAN_FILE.read_bytes()).hexdigest()
        previous = state.get("connected_speech") or {}
        required = (CONNECTED_SPEECH_CANONICAL_FILE, CONNECTED_SPEECH_SCOPE_FILE, CONNECTED_SPEECH_INSTRUCTIONS_FILE, CONNECTED_SPEECH_ZIP_FILE)
        if previous.get("status") in {"prepared", "validated", "reviewing", "completed"} and previous.get("source_revision") == source_revision and all(path.is_file() for path in required):
            return previous

        shutil.rmtree(CONNECTED_SPEECH_DIR, ignore_errors=True)
        CONNECTED_SPEECH_DIR.mkdir(parents=True, exist_ok=True)
        CONNECTED_SPEECH_CANONICAL_FILE.write_bytes(canonical_bytes)
        CONNECTED_SPEECH_SCOPE_FILE.write_text(_connected_speech_scope_text(document, plan, canonical_sha256, audio_sha256), encoding="utf-8")
        CONNECTED_SPEECH_INSTRUCTIONS_FILE.write_text(_connected_speech_instructions_text(document, plan, canonical_sha256), encoding="utf-8")
        with zipfile.ZipFile(CONNECTED_SPEECH_ZIP_FILE, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(CONNECTED_SPEECH_SCOPE_FILE, arcname=CONNECTED_SPEECH_SCOPE_FILE.name)
            archive.write(CONNECTED_SPEECH_CANONICAL_FILE, arcname=CONNECTED_SPEECH_CANONICAL_FILE.name)
            archive.write(PROCESS_AUDIO_FILE, arcname="scene_audio_16k_mono.wav")
            archive.write(CONNECTED_SPEECH_INSTRUCTIONS_FILE, arcname=CONNECTED_SPEECH_INSTRUCTIONS_FILE.name)

        project = document.get("project") or {}
        work_end = int((plan.get("end") or {}).get("at_ms") or project.get("scene_duration_ms") or 0)
        artifacts = [
            _connected_speech_artifact_payload("scope", CONNECTED_SPEECH_SCOPE_FILE.name, "text", CONNECTED_SPEECH_SCOPE_FILE, "IN/OUT exatos da timeline que a IA deve analisar"),
            _connected_speech_artifact_payload("canonical", CONNECTED_SPEECH_CANONICAL_FILE.name, "json", CONNECTED_SPEECH_CANONICAL_FILE, "JSON canônico atual, preenchido e revisado até este ponto"),
            _connected_speech_artifact_payload("audio", "scene_audio_16k_mono.wav", "audio", PROCESS_AUDIO_FILE, "Mesmo áudio WAV da cena; não é reprocessado nem recortado novamente"),
            _connected_speech_artifact_payload("instructions", CONNECTED_SPEECH_INSTRUCTIONS_FILE.name, "text", CONNECTED_SPEECH_INSTRUCTIONS_FILE, "Tarefa da IA + contrato exato de connected_speech_return.json"),
            _connected_speech_artifact_payload("zip", CONNECTED_SPEECH_ZIP_FILE.name, "zip", CONNECTED_SPEECH_ZIP_FILE, "Pacote completo para enviar à IA externa"),
        ]
        generated_at = _now_iso()
        payload = {
            "status": "prepared",
            "source_snapshot_id": str(document.get("snapshot_id") or ""),
            "source_revision": source_revision,
            "generated_at_utc": generated_at,
            "work_start_ms": 0,
            "work_end_ms": work_end,
            "artifacts": artifacts,
            "error": "",
        }
        def save(s: dict[str, Any]) -> None:
            s["connected_speech"] = payload
        _update_state(save)
        return payload


CONNECTED_SPEECH_TYPES = {"linking", "elision", "assimilation", "reduction", "contraction"}


def _connected_speech_cue_bounds(cue: dict[str, Any]) -> tuple[int, int]:
    start = cue.get("speech_start_ms")
    end = cue.get("speech_end_ms")
    if start is None:
        start = cue.get("subtitle_start_ms")
    if end is None:
        end = cue.get("subtitle_end_ms")
    return int(start or 0), int(end or 0)


def _connected_speech_validation_context() -> tuple[dict[str, Any], int, str, dict[int, dict[str, Any]], list[int]]:
    if not WORD_TIMING_CANONICAL_FILE.is_file() or not SHADOWING_PLAN_FILE.is_file():
        raise RuntimeError("O canônico revisado e o Shadowing precisam existir antes de validar Connected Speech.")
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    plan = json.loads(SHADOWING_PLAN_FILE.read_text(encoding="utf-8"))
    project = document.get("project") or {}
    work_end = int((plan.get("end") or {}).get("at_ms") or project.get("scene_duration_ms") or 0)
    if work_end <= 0:
        raise RuntimeError("O intervalo de Connected Speech não possui OUT válido.")
    canonical_sha256 = hashlib.sha256(WORD_TIMING_CANONICAL_FILE.read_bytes()).hexdigest()
    cue_map: dict[int, dict[str, Any]] = {}
    expected_orders: list[int] = []
    cues = document.get("cues") or []
    if not isinstance(cues, list):
        raise RuntimeError("O canônico atual não possui cues válidos.")
    for index, cue in enumerate(cues, start=1):
        if not isinstance(cue, dict):
            continue
        order = int(cue.get("order") or index)
        cue_map[order] = cue
        start_ms, end_ms = _connected_speech_cue_bounds(cue)
        selected_segments = plan.get("segments") if isinstance(plan.get("segments"), list) else []
        in_scope = any(end_ms > int(segment.get("start_ms") or 0) and start_ms < int(segment.get("end_ms") or 0) for segment in selected_segments) if selected_segments else (end_ms > 0 and start_ms < work_end)
        if in_scope:
            expected_orders.append(order)
    return document, work_end, canonical_sha256, cue_map, expected_orders


def _validate_connected_speech_return(returned: dict[str, Any]) -> dict[str, Any]:
    document, work_end, canonical_sha256, cue_map, expected_orders = _connected_speech_validation_context()
    root_fields = {"schema", "schema_version", "source_snapshot_id", "source_canonical_sha256", "audio_scope", "cues"}
    if set(returned.keys()) != root_fields:
        missing = sorted(root_fields - set(returned.keys()))
        extra = sorted(set(returned.keys()) - root_fields)
        parts = []
        if missing:
            parts.append("ausentes=" + ", ".join(missing))
        if extra:
            parts.append("extras=" + ", ".join(extra))
        raise ValueError("Estrutura raiz inválida: " + "; ".join(parts))
    if returned.get("schema") != "immersionhub-connected-speech-analysis":
        raise ValueError("schema inválido para Connected Speech.")
    if returned.get("schema_version") != "1.0":
        raise ValueError("schema_version deve ser 1.0.")
    snapshot = str(document.get("snapshot_id") or "")
    if str(returned.get("source_snapshot_id") or "") != snapshot:
        raise ValueError("source_snapshot_id não corresponde ao canônico enviado.")
    if str(returned.get("source_canonical_sha256") or "") != canonical_sha256:
        raise ValueError("source_canonical_sha256 não corresponde ao canônico enviado.")

    scope = returned.get("audio_scope")
    if not isinstance(scope, dict) or set(scope.keys()) != {"start_ms", "end_ms"}:
        raise ValueError("audio_scope deve conter somente start_ms e end_ms.")
    if isinstance(scope.get("start_ms"), bool) or not isinstance(scope.get("start_ms"), int) or scope.get("start_ms") != 0:
        raise ValueError("audio_scope.start_ms deve ser o inteiro 0.")
    if isinstance(scope.get("end_ms"), bool) or not isinstance(scope.get("end_ms"), int) or scope.get("end_ms") != work_end:
        raise ValueError(f"audio_scope.end_ms deve ser o inteiro {work_end}.")

    cues = returned.get("cues")
    if not isinstance(cues, list):
        raise ValueError("cues deve ser uma lista.")
    cue_fields = {"cue_order", "phenomena"}
    phenomenon_fields = {"sequenceOrder", "type", "start_ms", "end_ms", "source_text", "heard_as", "explanation_pt", "confidence"}
    returned_orders: list[int] = []
    sequence_orders: list[int] = []
    type_counts = {kind: 0 for kind in sorted(CONNECTED_SPEECH_TYPES)}
    phenomenon_count = 0

    for cue_item in cues:
        if not isinstance(cue_item, dict) or set(cue_item.keys()) != cue_fields:
            raise ValueError("Cada item de cues deve conter somente cue_order e phenomena.")
        cue_order = cue_item.get("cue_order")
        if isinstance(cue_order, bool) or not isinstance(cue_order, int):
            raise ValueError("cue_order deve ser inteiro.")
        if cue_order not in cue_map:
            raise ValueError(f"cue_order {cue_order} não existe no canônico.")
        if cue_order in returned_orders:
            raise ValueError(f"cue_order {cue_order} foi devolvido mais de uma vez.")
        returned_orders.append(cue_order)
        phenomena = cue_item.get("phenomena")
        if not isinstance(phenomena, list):
            raise ValueError(f"phenomena do cue {cue_order} deve ser uma lista.")
        cue_start, cue_end = _connected_speech_cue_bounds(cue_map[cue_order])
        for phenomenon in phenomena:
            if not isinstance(phenomenon, dict) or set(phenomenon.keys()) != phenomenon_fields:
                raise ValueError(f"Fenômeno do cue {cue_order} não segue a estrutura esperada.")
            sequence = phenomenon.get("sequenceOrder")
            if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
                raise ValueError("sequenceOrder deve ser inteiro positivo.")
            sequence_orders.append(sequence)
            kind = phenomenon.get("type")
            if kind not in CONNECTED_SPEECH_TYPES:
                raise ValueError(f"type inválido no sequenceOrder {sequence}: {kind}")
            start_ms = phenomenon.get("start_ms")
            end_ms = phenomenon.get("end_ms")
            if isinstance(start_ms, bool) or not isinstance(start_ms, int) or isinstance(end_ms, bool) or not isinstance(end_ms, int):
                raise ValueError(f"start_ms/end_ms do sequenceOrder {sequence} devem ser inteiros.")
            if start_ms < 0 or end_ms <= start_ms or end_ms > work_end:
                raise ValueError(f"Intervalo inválido no sequenceOrder {sequence}.")
            if start_ms < cue_start or end_ms > cue_end:
                raise ValueError(f"sequenceOrder {sequence} está fora do intervalo do cue {cue_order} ({cue_start}..{cue_end} ms).")
            for text_field in ("source_text", "heard_as", "explanation_pt"):
                if not isinstance(phenomenon.get(text_field), str) or not phenomenon.get(text_field).strip():
                    raise ValueError(f"{text_field} do sequenceOrder {sequence} deve ser texto não vazio.")
            confidence = phenomenon.get("confidence")
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0.0 <= float(confidence) <= 1.0:
                raise ValueError(f"confidence do sequenceOrder {sequence} deve estar entre 0.0 e 1.0.")
            type_counts[str(kind)] += 1
            phenomenon_count += 1

    if len(returned_orders) != len(expected_orders) or set(returned_orders) != set(expected_orders):
        missing = sorted(set(expected_orders) - set(returned_orders))
        extra = sorted(set(returned_orders) - set(expected_orders))
        details = []
        if missing:
            details.append("cues ausentes=" + ",".join(map(str, missing)))
        if extra:
            details.append("cues fora do escopo=" + ",".join(map(str, extra)))
        raise ValueError("O retorno precisa conter cada cue do escopo exatamente uma vez" + (": " + "; ".join(details) if details else "."))
    if sequence_orders != list(range(1, len(sequence_orders) + 1)):
        raise ValueError("sequenceOrder deve ser global, único, crescente, iniciar em 1 e não ter lacunas.")

    return {
        "snapshot_id": snapshot,
        "canonical_sha256": canonical_sha256,
        "work_start_ms": 0,
        "work_end_ms": work_end,
        "cues": len(cues),
        "phenomena": phenomenon_count,
        "types": type_counts,
    }


def _connected_speech_flat_items(returned: dict[str, Any], document: dict[str, Any]) -> list[dict[str, Any]]:
    cue_map = {int(cue.get("order") or index): cue for index, cue in enumerate(document.get("cues") or [], start=1) if isinstance(cue, dict)}
    items: list[dict[str, Any]] = []
    for cue_item in returned.get("cues") or []:
        cue_order = int(cue_item.get("cue_order") or 0)
        cue = cue_map.get(cue_order) or {}
        for phenomenon in cue_item.get("phenomena") or []:
            item = dict(phenomenon)
            item["cue_order"] = cue_order
            item["cue_en"] = str(cue.get("approved_en") or cue.get("original_en") or "")
            item["cue_pt"] = str(cue.get("pt") or "")
            item["speaker"] = str(cue.get("speaker") or "")
            items.append(item)
    items.sort(key=lambda item: int(item.get("sequenceOrder") or 0))
    return items


def _write_connected_speech_review_result(returned: dict[str, Any], decisions: dict[str, str]) -> dict[str, Any]:
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    items = _connected_speech_flat_items(returned, document)
    reviewed_items = []
    approved = 0
    rejected = 0
    for item in items:
        sequence = int(item.get("sequenceOrder") or 0)
        decision = str(decisions.get(str(sequence)) or "pending")
        if decision == "approved":
            approved += 1
        elif decision == "rejected":
            rejected += 1
        reviewed_items.append({**item, "decision": decision})
    completed = bool(len(reviewed_items) == 0 or approved + rejected == len(reviewed_items))
    payload = {
        "schema": "immersionhub-connected-speech-review",
        "schema_version": "1.0",
        "source_snapshot_id": str(returned.get("source_snapshot_id") or ""),
        "source_canonical_sha256": str(returned.get("source_canonical_sha256") or ""),
        "completed": completed,
        "updated_at_utc": _now_iso(),
        "summary": {"total": len(reviewed_items), "approved": approved, "rejected": rejected, "pending": len(reviewed_items) - approved - rejected},
        "items": reviewed_items,
    }
    CONNECTED_SPEECH_REVIEW_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def _connected_speech_review_payload(sequence_order: int | None = None) -> dict[str, Any]:
    state = _read_state()
    connected = state.get("connected_speech") or {}
    if not connected.get("validated") or not CONNECTED_SPEECH_RETURN_FILE.is_file():
        raise RuntimeError("Importe e valide connected_speech_return.json antes da conferência manual.")
    returned = json.loads(CONNECTED_SPEECH_RETURN_FILE.read_text(encoding="utf-8"))
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    items = _connected_speech_flat_items(returned, document)
    decisions = {str(k): str(v) for k, v in (connected.get("review_decisions") or {}).items()}
    pending = [int(item.get("sequenceOrder") or 0) for item in items if str(decisions.get(str(item.get("sequenceOrder"))) or "") not in {"approved", "rejected"}]
    available = [int(item.get("sequenceOrder") or 0) for item in items]
    current = int(sequence_order or connected.get("current_sequence_order") or (pending[0] if pending else (available[0] if available else 0)))
    if current not in available and available:
        current = pending[0] if pending else available[0]
    reviewed = _write_connected_speech_review_result(returned, decisions)
    selected = next((item for item in items if int(item.get("sequenceOrder") or 0) == current), None)
    list_items = [
        {
            "sequenceOrder": int(item.get("sequenceOrder") or 0),
            "cue_order": int(item.get("cue_order") or 0),
            "type": str(item.get("type") or ""),
            "source_text": str(item.get("source_text") or ""),
            "decision": str(decisions.get(str(item.get("sequenceOrder"))) or "pending"),
        }
        for item in items
    ]
    return {
        "total": len(items),
        "approved": int(reviewed["summary"]["approved"]),
        "rejected": int(reviewed["summary"]["rejected"]),
        "pending": int(reviewed["summary"]["pending"]),
        "completed": bool(reviewed["completed"]),
        "current_sequence_order": current,
        "current": ({**selected, "decision": str(decisions.get(str(current)) or "pending")} if selected else None),
        "items": list_items,
        "download_url": "/api/connected-speech/review/result" if CONNECTED_SPEECH_REVIEW_FILE.is_file() else "",
    }


def _seed_connected_speech_from_one_pass() -> bool:
    if not EXTERNAL_AI_ONE_PASS_FILE.is_file() or not WORD_TIMING_CANONICAL_FILE.is_file() or not SHADOWING_PLAN_FILE.is_file():
        return False
    document, work_end, canonical_sha, cue_map, expected_orders = _connected_speech_validation_context()
    saved = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
    candidates = {int(row.get("cue_order") or 0): row for row in ((saved.get("connected_speech") or {}).get("cues") or []) if isinstance(row, dict)}
    sequence = 0
    cues: list[dict[str, Any]] = []
    for order in expected_orders:
        cue = cue_map[order]
        cue_start, cue_end = _connected_speech_cue_bounds(cue)
        phenomena: list[dict[str, Any]] = []
        for item in (candidates.get(order) or {}).get("phenomena") or []:
            start_ms, end_ms = int(item.get("start_ms") or 0), int(item.get("end_ms") or 0)
            source_text = str(item.get("source_text") or "").strip()
            current_text = str(cue.get("approved_en") or cue.get("original_en") or "")
            if not source_text or source_text.casefold() not in current_text.casefold():
                continue
            if not cue_start <= start_ms < end_ms <= min(cue_end, work_end):
                continue
            sequence += 1
            phenomena.append({**item, "sequenceOrder": sequence})
        cues.append({"cue_order": order, "phenomena": phenomena})
    returned = {
        "schema": "immersionhub-connected-speech-analysis", "schema_version": "1.0",
        "source_snapshot_id": str(document.get("snapshot_id") or ""),
        "source_canonical_sha256": canonical_sha,
        "audio_scope": {"start_ms": 0, "end_ms": work_end}, "cues": cues,
    }
    summary = _validate_connected_speech_return(returned)
    CONNECTED_SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    CONNECTED_SPEECH_RETURN_FILE.write_text(json.dumps(returned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _write_connected_speech_review_result(returned, {})
    total = int(summary.get("phenomena") or 0)
    def save(state: dict[str, Any]) -> None:
        state["connected_speech"].update({
            "status": "validated", "validated": True, "error": "", "returned_filename": "one_pass_final_materials.json",
            "validation_summary": summary, "validated_at": _now_iso(), "review_total": total,
            "review_decisions": {}, "current_sequence_order": 1 if total else 0,
            "review_completed": total == 0, "review_updated_at": "",
        })
    _update_state(save)
    if total == 0:
        _activate_one_pass_anki()
    return True


def _activate_one_pass_anki() -> bool:
    if not EXTERNAL_AI_ONE_PASS_FILE.is_file() or not WORD_TIMING_CANONICAL_FILE.is_file():
        return False
    canonical, cs_review, canonical_sha, cs_sha = _materials_external_inputs()
    saved = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
    cue_map = {int(cue.get("order") or 0): cue for cue in (canonical.get("cues") or []) if isinstance(cue, dict)}
    candidate_cards = validate_one_pass_cards(((saved.get("anki") or {}).get("items")), cue_map)
    cards: list[dict[str, Any]] = []
    discarded = 0
    for card in candidate_cards:
        cue = cue_map.get(int(card.get("cue_order") or 0)) or {}
        final_text = re.sub(r"\W+", " ", str(cue.get("approved_en") or cue.get("original_en") or "").casefold()).strip()
        source_text = re.sub(r"\W+", " ", str(card.get("highlight_en") or "").casefold()).strip()
        if final_text and source_text and difflib.SequenceMatcher(None, final_text, source_text).ratio() >= 0.75:
            cards.append(card)
        else:
            discarded += 1
    draft = {
        "schema": "immersionhub-materials-one-pass-draft", "schema_version": "1.0",
        "source_snapshot_id": str(canonical.get("snapshot_id") or ""),
        "source_canonical_sha256": canonical_sha, "source_connected_speech_review_sha256": cs_sha,
        "generated_at_utc": _now_iso(), "source": "external_ai_one_pass",
        "content_type": str(((canonical.get("project") or {}).get("content_type") or "dialogue")),
        "pdf_content": {}, "anki": {"items": cards}, "audio": {"strategy": "groq_tts_after_human_review", "items": []},
    }
    MATERIALS_EXTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    MATERIALS_EXTERNAL_DRAFT_FILE.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def save(state: dict[str, Any]) -> None:
        state["materials_external"].update({
            "status": "validated", "validated": True, "message": "Dados da única análise externa reaproveitados.",
            "source_snapshot_id": draft["source_snapshot_id"], "source_canonical_sha256": canonical_sha,
            "source_connected_speech_review_sha256": cs_sha, "returned_filename": EXTERNAL_AI_ONE_PASS_FILE.name,
            "validation_summary": {"anki_cards": len(cards), "discarded_after_reconciliation": discarded, "pdfs": 0}, "validated_at": _now_iso(),
        })
    _update_state(save)
    return True


def _materials_external_inputs() -> tuple[dict[str, Any], dict[str, Any], str, str]:
    state = _read_state()
    if not WORD_TIMING_CANONICAL_FILE.is_file():
        raise RuntimeError("JSON canônico final não encontrado.")
    canonical = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    content_type = str(((canonical.get("project") or {}).get("content_type") or "dialogue"))
    if bool((state.get("configuration") or {}).get("dual_scene")):
        dual = state.get("dual_scene") or {}
        if not bool(dual.get("completed")) or not DUAL_SCENE_FILE.is_file() or not canonical.get("dualScene"):
            raise RuntimeError("Conclua o Dual Scene antes dos materiais.")
        cs_review = {
            "schema": "immersionhub-connected-speech-review", "schema_version": "1.0",
            "source_snapshot_id": str(canonical.get("snapshot_id") or ""), "completed": True,
            "disabled_for_content_type": "dual_scene", "items": [],
        }
    else:
        # Scene and Music proceed from finalized Shadowing directly to materials.
        shadowing = state.get("shadowing") or {}
        if _music_without_shadowing(state):
            if not (state.get("word_timing") or {}).get("completed"):
                raise RuntimeError("Conclua o Word by Word antes dos materiais.")
        elif not bool(shadowing.get("completed")) or not SHADOWING_PLAN_FILE.is_file():
            raise RuntimeError("Conclua o Shadowing antes dos materiais.")
        # Connected Speech is retired. Keep a deterministic
        # empty review only to preserve the shared materials identity contract.
        cs_review = {
            "schema": "immersionhub-connected-speech-review",
            "schema_version": "1.0",
            "source_snapshot_id": str(canonical.get("snapshot_id") or ""),
            "completed": True,
            "disabled_for_content_type": content_type,
            "items": [],
        }
    canonical_sha = hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    cs_sha = hashlib.sha256(
        json.dumps(cs_review, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return canonical, cs_review, canonical_sha, cs_sha


def _materials_external_page_ready() -> bool:
    try:
        _materials_external_inputs()
        return True
    except Exception:
        return False


def _materials_external_artifacts() -> list[dict[str, Any]]:
    entries = (
        ("zip", MATERIALS_EXTERNAL_ZIP_FILE, "zip", "Pacote completo para a IA externa"),
        ("canonical", MATERIALS_EXTERNAL_PACKAGE_DIR / "canonical_scene_current.json", "json", "Canônico final read-only"),
        ("connected_speech", MATERIALS_EXTERNAL_PACKAGE_DIR / "connected_speech_review.json", "json", "Fonte técnica de Connected Speech · vazia no ramo Music"),
        ("instructions", MATERIALS_EXTERNAL_PACKAGE_DIR / "external_ai_materials_instructions.json", "json", "Contrato 1.3 · PDF único · 7 blocos exatos + Anki separado"),
    )
    artifacts: list[dict[str, Any]] = []
    for key, path, kind, description in entries:
        if path.is_file():
            artifacts.append({
                "key": key,
                "name": path.name,
                "kind": kind,
                "description": description,
                "size_bytes": int(path.stat().st_size),
                "size_label": _human_bytes(path.stat().st_size),
                "download_url": f"/api/materials-external/artifact/{key}",
            })
    return artifacts


def _prepare_materials_external_package() -> dict[str, Any]:
    canonical, cs_review, canonical_sha, cs_sha = _materials_external_inputs()
    previous = (_read_state().get("materials_external") or {})
    source_changed = bool(
        (previous.get("source_canonical_sha256") and previous.get("source_canonical_sha256") != canonical_sha)
        or (previous.get("source_connected_speech_review_sha256") and previous.get("source_connected_speech_review_sha256") != cs_sha)
        or (previous.get("source_snapshot_id") and previous.get("source_snapshot_id") != str(canonical.get("snapshot_id") or ""))
        or str(previous.get("contract_version") or "") != MATERIALS_EXTERNAL_CONTRACT_VERSION
    )
    if source_changed:
        MATERIALS_EXTERNAL_RETURN_FILE.unlink(missing_ok=True)
        MATERIALS_EXTERNAL_DRAFT_FILE.unlink(missing_ok=True)
        shutil.rmtree(MATERIALS_REVIEW_DIR, ignore_errors=True)
        shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)
        shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
        def invalidate(state: dict[str, Any]) -> None:
            state["materials_external"] = _default_state()["materials_external"]
            state["materials_review"] = _default_state()["materials_review"]
            state["materials_final"] = _default_state()["materials_final"]
        _update_state(invalidate)
    MATERIALS_EXTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    result = build_materials_external_package(
        canonical,
        cs_review,
        canonical_sha256=canonical_sha,
        connected_speech_review_sha256=cs_sha,
        package_dir=MATERIALS_EXTERNAL_PACKAGE_DIR,
        archive_file=MATERIALS_EXTERNAL_ZIP_FILE,
    )
    snapshot_id = str(canonical.get("snapshot_id") or "")
    artifacts = _materials_external_artifacts()
    def save(state: dict[str, Any]) -> None:
        state["materials_external"].update({
            "status": "validated" if state["materials_external"].get("validated") and MATERIALS_EXTERNAL_DRAFT_FILE.is_file() else "prepared",
            "message": "Retorno validado. Revisão liberada." if state["materials_external"].get("validated") and MATERIALS_EXTERNAL_DRAFT_FILE.is_file() else "Pacote pronto para a IA externa.",
            "source_snapshot_id": snapshot_id,
            "source_canonical_sha256": canonical_sha,
            "source_connected_speech_review_sha256": cs_sha,
            "contract_version": MATERIALS_EXTERNAL_CONTRACT_VERSION,
            "artifacts": artifacts,
            "error": "",
            "prepared_at": _now_iso(),
        })
    current = _update_state(save)["materials_external"]
    return {
        "materials": current,
        "artifacts": artifacts,
        "expected_return": str(result.get("expected_return") or "materials_external_ai_return.json"),
        "cue_count": int(result.get("cue_count") or 0),
        "approved_connected_speech": int(result.get("approved_connected_speech") or 0),
    }


def _reset_materials_generation() -> None:
    """Invalidate only material-generation outputs, preserving canonical study data."""
    shutil.rmtree(MATERIALS_EXTERNAL_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
    shutil.rmtree(MATERIALS_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)

    def reset(state: dict[str, Any]) -> None:
        state["materials_external"] = _default_state()["materials_external"]
        state["materials_review"] = _default_state()["materials_review"]
        state["materials_final"] = _default_state()["materials_final"]

    _update_state(reset)


def _materials_review_ready() -> bool:
    state = _read_state()
    external = state.get("materials_external") or {}
    return bool(MATERIALS_EXTERNAL_DRAFT_FILE.is_file() and external.get("validated"))


def _read_materials_review() -> dict[str, Any]:
    if not MATERIALS_EXTERNAL_DRAFT_FILE.is_file():
        raise RuntimeError("O retorno de materiais da IA externa ainda não foi validado.")
    draft = json.loads(MATERIALS_EXTERNAL_DRAFT_FILE.read_text(encoding="utf-8"))
    raw: Any = None
    if MATERIALS_REVIEW_FILE.is_file():
        try:
            raw = json.loads(MATERIALS_REVIEW_FILE.read_text(encoding="utf-8"))
        except Exception:
            raw = None
    review = normalize_review(draft, raw) if raw is not None else build_review(draft)
    MATERIALS_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    MATERIALS_REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return review


def _materials_final_ready() -> bool:
    if not MATERIALS_REVIEW_FILE.is_file() or not MATERIALS_REVIEW_APPROVED_FILE.is_file():
        return False
    try:
        review = json.loads(MATERIALS_REVIEW_FILE.read_text(encoding="utf-8"))
        return review.get("status") == "approved" and not validate_finalize(review)
    except Exception:
        return False


def _materials_final_progress(percent: int, message: str) -> None:
    percent = max(0, min(100, int(percent)))
    text = str(message or "").strip()
    def update(state: dict[str, Any]) -> None:
        job = state["materials_final"]
        job["status"] = "running" if percent < 100 else job.get("status", "running")
        job["percent"] = percent
        job["message"] = text
        logs = list(job.get("logs") or [])
        if text and (not logs or logs[-1] != text):
            logs.append(text)
        job["logs"] = logs[-200:]
        job["error"] = ""
    _update_state(update)


def _materials_tts_for_approved(canonical: dict[str, Any], approved: dict[str, Any]) -> dict[str, Any]:
    cards = ((approved.get("anki") or {}).get("items") or []) if isinstance(approved.get("anki"), dict) else []
    cue_map = {
        int(cue.get("order") or 0): cue
        for cue in canonical.get("cues") or []
        if isinstance(cue, dict) and int(cue.get("order") or 0) > 0
    }
    cue_orders: list[int] = []
    for card in cards:
        if not isinstance(card, dict):
            continue
        order = int(card.get("cue_order") or 0)
        if order in cue_map and order not in cue_orders:
            cue_orders.append(order)
    if not cue_orders:
        shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
        return {"items": [], "zip": None, "manifest": None}

    settings = public_ai_settings()
    if not str(settings.get("tts_model") or "").strip():
        raise RuntimeError("Configure o modelo TTS da Groq antes da geração final.")
    approved_hash = hashlib.sha256(json.dumps(approved, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    identity = {
        "source_snapshot_id": str(canonical.get("snapshot_id") or ""),
        "approved_materials_sha256": approved_hash,
        "tts_model": str(settings.get("tts_model") or ""),
        "tts_voices": list(MATERIALS_TTS_VOICES),
    }
    previous: dict[str, Any] = {}
    if MATERIALS_TTS_MANIFEST_FILE.is_file():
        try:
            loaded = json.loads(MATERIALS_TTS_MANIFEST_FILE.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                previous = loaded
        except Exception:
            previous = {}
    # Reuse each cue by text/model/voice, not approval dates or unrelated cards.
    MATERIALS_TTS_DIR.mkdir(parents=True, exist_ok=True)
    existing = {
        (str(item.get("voice") or "").lower(), int(item.get("cue_order") or 0)): item
        for item in previous.get("items") or []
        if isinstance(item, dict) and int(item.get("cue_order") or 0) > 0
    }
    items: list[dict[str, Any]] = []
    total = len(cue_orders) * len(MATERIALS_TTS_VOICES)
    index = 0
    for voice in MATERIALS_TTS_VOICES:
        voice_dir = MATERIALS_TTS_DIR / voice
        voice_dir.mkdir(parents=True, exist_ok=True)
        for order in cue_orders:
            index += 1
            cue = cue_map[order]
            text = str(cue.get("approved_en") or cue.get("original_en") or "").strip()
            if not text:
                raise RuntimeError(f"Cue {order} sem texto inglês para TTS.")
            filename = f"{voice}/cue_{order:04d}.wav"
            destination = MATERIALS_TTS_DIR / filename
            cached = existing.get((voice, order)) or {}
            percent = 5 + int(index / max(1, total) * 30)
            reusable = (
                destination.is_file() and destination.stat().st_size > 0
                and str(cached.get("text") or "") == text
                and str(cached.get("model") or "") == identity["tts_model"]
                and str(cached.get("voice") or "").lower() == voice
            )
            if reusable:
                info = cached
                _materials_final_progress(percent, f"TTS {voice.title()} {index}/{total} · cue {order} recuperado do disco.")
            else:
                if not bool(settings.get("has_api_key")):
                    raise RuntimeError("Configure a API key da Groq para gerar os áudios novos ou modificados.")
                _materials_final_progress(percent, f"TTS {voice.title()} {index}/{total} · cue {order}…")
                generated = synthesize_tts(text, destination, voice=voice)
                info = {
                    "cue_order": order,
                    "text": text,
                    "filename": filename,
                    "chunks": int(generated.get("chunks") or 1),
                    "model": str(generated.get("model") or settings.get("tts_model") or ""),
                    "voice": voice,
                }
            items.append({**info, "cue_order": order, "text": text, "filename": filename, "voice": voice})

    manifest = {
        "schema": "immersionhub-materials-tts-manifest",
        "schema_version": "2.0",
        "identity": identity,
        "items": items,
        "generated_at_utc": _now_iso(),
    }
    MATERIALS_TTS_MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    MATERIALS_TTS_MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with zipfile.ZipFile(MATERIALS_TTS_AUDIO_ZIP_FILE, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in items:
            path = MATERIALS_TTS_DIR / str(item["filename"])
            if path.is_file():
                archive.write(path, arcname=str(item["filename"]).replace("\\", "/"))
        archive.write(MATERIALS_TTS_MANIFEST_FILE, arcname=MATERIALS_TTS_MANIFEST_FILE.name)
    return {"items": items, "zip": MATERIALS_TTS_AUDIO_ZIP_FILE, "manifest": MATERIALS_TTS_MANIFEST_FILE}


def _current_materials_tts_result() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    if MATERIALS_TTS_MANIFEST_FILE.is_file():
        try:
            payload = json.loads(MATERIALS_TTS_MANIFEST_FILE.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                items = [item for item in (payload.get("items") or []) if isinstance(item, dict)]
        except Exception:
            items = []
    return {
        "items": items,
        "zip": MATERIALS_TTS_AUDIO_ZIP_FILE if MATERIALS_TTS_AUDIO_ZIP_FILE.is_file() else None,
        "manifest": MATERIALS_TTS_MANIFEST_FILE if MATERIALS_TTS_MANIFEST_FILE.is_file() else None,
    }


_WORDBOUNDS_ERROR_RE = re.compile(
    r'Word timing fora do cue\s+(?P<cue>\d+)\s+·\s+posição\s+(?P<position>\d+)\s+"(?P<text>[^"]*)":\s*'
    r'cue\s+(?P<cue_start>\d+)[–-](?P<cue_end>\d+)\s+ms;\s*'
    r'word\s+(?P<word_start>\d+)[–-](?P<word_end>\d+)\s+ms\.',
    re.IGNORECASE,
)
_WBW_PRACTICE_ERROR_RE = re.compile(
    r"wbw_practices\[(?P<position>\d+)\].*fora do intervalo da cue",
    re.IGNORECASE,
)


def _word_timing_revision_sha256() -> str:
    if not WORD_TIMING_CANONICAL_FILE.is_file():
        return ""
    return hashlib.sha256(WORD_TIMING_CANONICAL_FILE.read_bytes()).hexdigest()


def _word_timing_unit_for_raw_position(cue_order: int, word_position: int) -> int | None:
    """Map the raw 1-based words[] position from the HUB validator to the WbW editor unit."""
    if not WORD_TIMING_CANONICAL_FILE.is_file():
        return None
    try:
        document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    raw_index = int(word_position) - 1
    for cue in document.get("cues") or []:
        if not isinstance(cue, dict) or int(cue.get("order") or 0) != int(cue_order):
            continue
        for unit in _word_timing_units_for_cue(cue):
            if raw_index in [int(value) for value in (unit.get("member_indices") or [])]:
                return int(unit.get("unit_index") or 0)
    return None


def _decorate_materials_final_failure(failure: dict[str, Any], *, attach_dependency: bool) -> dict[str, Any]:
    item = dict(failure or {})
    if str(item.get("id") or "") != "hub_json":
        return item
    existing = item.get("recovery") if isinstance(item.get("recovery"), dict) else None
    if existing:
        return item
    error_text = str(item.get("error") or "")
    practice_match = _WBW_PRACTICE_ERROR_RE.search(error_text)
    if practice_match:
        position = int(practice_match.group("position"))
        practice: dict[str, Any] = {}
        try:
            payload = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
            candidate = (payload.get("wbw_practices") or [])[position - 1]
            if isinstance(candidate, dict):
                practice = candidate
        except (OSError, ValueError, IndexError, TypeError):
            practice = {}
        cue_order = int(practice.get("cue_order") or 0)
        item["recovery"] = {
            "type": "wbw_practice",
            "practice_index": position,
            "cue_order": cue_order,
            "expression_en": str(practice.get("expression_en") or "").strip(),
            "practice_start_ms": int(practice.get("start_ms") or 0),
            "practice_end_ms": int(practice.get("end_ms") or 0),
            "fix_url": "/cue-timing?" + urlencode({
                "cue": cue_order, "return_to": "/materials-final", "repair": "wbw_practice",
            }),
        }
        return item
    match = _WORDBOUNDS_ERROR_RE.search(error_text)
    if not match:
        return item
    cue_order = int(match.group("cue"))
    word_position = int(match.group("position"))
    unit_index = _word_timing_unit_for_raw_position(cue_order, word_position)
    query = {
        "cue": cue_order,
        "return_to": "/materials-final",
        "repair": "hub_json",
    }
    if unit_index is not None:
        query["unit"] = unit_index
    recovery: dict[str, Any] = {
        "type": "word_timing",
        "cue_order": cue_order,
        "word_position": word_position,
        "unit_index": unit_index,
        "word_text": match.group("text"),
        "cue_start_ms": int(match.group("cue_start")),
        "cue_end_ms": int(match.group("cue_end")),
        "word_start_ms": int(match.group("word_start")),
        "word_end_ms": int(match.group("word_end")),
        "fix_url": "/word-timing?" + urlencode(query),
    }
    if attach_dependency:
        recovery["dependency_sha256"] = _word_timing_revision_sha256()
    item["recovery"] = recovery
    return item


def _public_materials_final_state(job: dict[str, Any]) -> dict[str, Any]:
    """Decorate legacy failures for UI navigation without fabricating a historical dependency hash."""
    public = json.loads(json.dumps(job or {}))
    public["artifacts"] = [
        item for item in (public.get("artifacts") or [])
        if str(item.get("kind") or "").lower() != "pdf" and not str(item.get("name") or "").lower().endswith(".pdf")
    ]
    public["failed_items"] = [
        _decorate_materials_final_failure(item, attach_dependency=False)
        for item in (public.get("failed_items") or [])
        if isinstance(item, dict)
    ]
    return public


def _materials_final_identity() -> str:
    from materials_cache import content_digest
    inputs = {}
    for path in (WORD_TIMING_CANONICAL_FILE, MATERIALS_REVIEW_APPROVED_FILE, SHADOWING_PLAN_FILE, EXTERNAL_AI_ONE_PASS_FILE):
        inputs[path.name] = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    if inputs.get(EXTERNAL_AI_ONE_PASS_FILE.name):
        inputs[EXTERNAL_AI_ONE_PASS_FILE.name] = inputs[EXTERNAL_AI_ONE_PASS_FILE.name].get("wbw_practices") or []
    settings = public_ai_settings()
    inputs["tts"] = {"tts_model": settings.get("tts_model"), "tts_voices": list(MATERIALS_TTS_VOICES)}
    inputs["title"] = (_read_state().get("en") or {}).get("title")
    inputs["media"] = [(p.name, p.stat().st_size, p.stat().st_mtime_ns) if p.is_file() else (p.name, None) for p in (PROCESS_VIDEO_FILE, DUAL_SCENE_PT_FILE)]
    inputs["shadowing_enabled"] = not _music_without_shadowing(_read_state())
    inputs["tiktok_media"] = _tiktok_options()
    background = _tiktok_background_file()
    inputs["tiktok_background"] = hashlib.sha256(background.read_bytes()).hexdigest() if background.is_file() else None
    inputs["implementation"] = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(__file__), Path(__file__).with_name("materials_final.py"), Path(__file__).with_name("music_video.py"), Path(__file__).with_name("tiktok_media.py"))]
    return content_digest(inputs)


def _cached_materials_final() -> dict[str, Any] | None:
    try:
        cached = json.loads((MATERIALS_FINAL_DIR / "reuse.json").read_text(encoding="utf-8"))
        if cached["identity"] != _materials_final_identity():
            return None
        job = cached["job"]
        if job.get("status") != "ready" or not job.get("artifacts"):
            return None
        for item in job["artifacts"]:
            root = MATERIALS_TTS_DIR.parent if item.get("group") == "tts" else MATERIALS_FINAL_OUTPUT_DIR
            path = root / Path(item["name"]).name
            if not path.is_file() or path.stat().st_size != item["size_bytes"]:
                return None
        return {**job, "message": "Nada mudou. Materiais existentes reutilizados, sem Groq ou nova renderização."}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _materials_final_job(
    retry_only: set[str] | None = None,
    preserved_failures: list[dict[str, Any]] | None = None,
) -> None:
    with _materials_final_lock:
        try:
            if not _materials_final_ready():
                raise RuntimeError("Finalize a revisão do Anki antes da geração final.")
            canonical = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
            if EXTERNAL_AI_ONE_PASS_FILE.is_file():
                one_pass = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
                canonical["wbw_practices"] = copy.deepcopy(one_pass.get("wbw_practices") or [])
            if not _read_state().get("imported_final") and _normalize_word_timing_cue_bounds(canonical):
                WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(canonical, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            approved = json.loads(MATERIALS_REVIEW_APPROVED_FILE.read_text(encoding="utf-8"))
            canonical["generator_media_window"] = copy.deepcopy(_read_state().get("cut") or {})
            generation_identity = _materials_final_identity()
            source_title = str((_read_state().get("en") or {}).get("title") or "Immersion Kit").strip() or "Immersion Kit"
            retry_only = {str(value) for value in (retry_only or set())} or None

            stage_failures: list[dict[str, Any]] = [dict(item) for item in (preserved_failures or [])]
            cards = ((approved.get("anki") or {}).get("items") or []) if isinstance(approved.get("anki"), dict) else []
            should_run_tts = bool(cards) and (retry_only is None or "tts" in retry_only)
            if cards and should_run_tts:
                try:
                    _materials_final_progress(3, "Materiais revisados. Groq será usada somente para gerar os áudios dos cards aprovados…")
                    tts = _materials_tts_for_approved(canonical, approved)
                except Exception as exc:
                    stage_failures.append({"id": "tts", "label": "Groq TTS", "error": str(exc)})
                    tts = _current_materials_tts_result()
                    _materials_final_progress(35, f"ERRO em Groq TTS: {exc} — continuando com os materiais que não dependem desse áudio…")
            elif cards:
                tts = _current_materials_tts_result()
                _materials_final_progress(35, "TTS já concluído anteriormente; reutilizando os WAVs existentes.")
            else:
                tts = {"items": [], "zip": None, "manifest": None}
                _materials_final_progress(35, "Nenhum card Anki aprovado; TTS não é necessário.")

            def render_progress(percent: int, message: str) -> None:
                mapped = 38 + int(max(0, min(100, percent)) * 0.62)
                _materials_final_progress(mapped, message)

            is_music = str(((canonical.get("project") or {}).get("content_type") or "")) == "music"
            if _music_without_shadowing(_read_state()):
                shadowing_plan = {"enabled": False, "blocks": [], "reason": "disabled_by_user"}
                canonical["shadowingConfig"] = {**(canonical.get("shadowingConfig") or {}), "enabled": False}
            elif canonical.get("dualScene"):
                shadowing_plan = {}
            elif not SHADOWING_PLAN_FILE.is_file():
                stage_failures.append({"id": "hub_json", "label": "hub_final.json", "error": "shadowing.json aprovado não encontrado."})
                shadowing_plan = {}
            else:
                shadowing_plan = json.loads(SHADOWING_PLAN_FILE.read_text(encoding="utf-8"))

            render_retry = None if retry_only is None else {value for value in retry_only if value != "tts"}
            # If TTS was retried, refresh the audio APKG too; it is a dependent
            # renderer, not a second Groq generation.
            if retry_only is not None and "tts" in retry_only:
                render_retry.add("anki.with_tts")

            result = generate_final_materials(
                canonical,
                approved,
                shadowing_plan=shadowing_plan,
                tts_dir=MATERIALS_TTS_DIR,
                tts_voice_dirs={voice: MATERIALS_TTS_DIR / voice for voice in MATERIALS_TTS_VOICES},
                output_dir=MATERIALS_FINAL_OUTPUT_DIR,
                source_title=source_title,
                dual_scene_en_video=PROCESS_VIDEO_FILE,
                dual_scene_pt_video=DUAL_SCENE_PT_FILE,
                music_source_video=PROCESS_VIDEO_FILE,
                tiktok_options=_tiktok_options(),
                tiktok_background=_tiktok_background_file() if _tiktok_options()["background_mode"] == "image" else None,
                shadowing_source_video=PROCESS_VIDEO_FILE,
                progress=render_progress,
                retry_only=render_retry,
            )
            failures = stage_failures + [item for item in (result.get("failures") or []) if isinstance(item, dict)]

            # The complete package also receives the TTS technical artifacts.
            bundle_path = Path(str(result.get("bundle") or ""))
            if bundle_path.is_file():
                try:
                    with zipfile.ZipFile(bundle_path, "a", compression=zipfile.ZIP_DEFLATED) as archive:
                        for extra in (tts.get("zip"), tts.get("manifest")):
                            if isinstance(extra, Path) and extra.is_file():
                                archive.write(extra, arcname=f"tts/{extra.name}")
                except Exception as exc:
                    failures.append({"id": "bundle", "label": "materials_final.zip", "error": str(exc)})

            artifacts: list[dict[str, Any]] = []
            for item in result.get("artifacts") or []:
                path = Path(str(item.get("path") or ""))
                if not path.is_file():
                    continue
                artifacts.append({
                    "name": path.name,
                    "kind": str(item.get("kind") or path.suffix.lstrip(".")),
                    "group": str(item.get("group") or "other"),
                    "size_bytes": int(path.stat().st_size),
                    "size_label": _human_bytes(path.stat().st_size),
                    "download_url": f"/api/materials-final/artifact/{path.name}",
                })
            for path, kind in ((tts.get("zip"), "zip"), (tts.get("manifest"), "json")):
                if isinstance(path, Path) and path.is_file():
                    artifacts.append({
                        "name": path.name,
                        "kind": kind,
                        "group": "tts",
                        "size_bytes": int(path.stat().st_size),
                        "size_label": _human_bytes(path.stat().st_size),
                        "download_url": f"/api/materials-final/tts-artifact/{path.name}",
                    })

            # De-duplicate retry artifacts by (group, name).
            dedup: dict[tuple[str, str], dict[str, Any]] = {}
            for artifact in artifacts:
                dedup[(str(artifact.get("group") or ""), str(artifact.get("name") or ""))] = artifact
            artifacts = list(dedup.values())

            # De-duplicate failures by task id, keeping the last/most specific one.
            # Recoverable HUB/WbW failures also keep the exact WbW revision that
            # caused the error so a blind retry can be blocked until the source changes.
            decorated_failures = [
                _decorate_materials_final_failure(failure, attach_dependency=True)
                for failure in failures
                if isinstance(failure, dict)
            ]
            failure_map: dict[str, dict[str, Any]] = {}
            for failure in decorated_failures:
                task_id = str(failure.get("id") or "unknown")
                normalized: dict[str, Any] = {
                    "id": task_id,
                    "label": str(failure.get("label") or task_id),
                    "error": str(failure.get("error") or "Erro não informado."),
                }
                if isinstance(failure.get("recovery"), dict):
                    normalized["recovery"] = dict(failure["recovery"])
                failure_map[task_id] = normalized
            failures = list(failure_map.values())

            def done(state: dict[str, Any]) -> None:
                job = state["materials_final"]
                if failures:
                    status = "partial" if artifacts else "failed"
                    message = f"Geração concluída com {len(failures)} item(ns) com erro. Os arquivos prontos já podem ser baixados."
                    error = "\n".join(f"{item['label']}: {item['error']}" for item in failures)
                else:
                    status = "ready"
                    message = f"Materiais finais prontos: {int(result.get('anki_cards') or 0)} card(s), {len(tts.get('items') or [])} áudio(s) Groq TTS e hub_final.json."
                    error = ""
                job.update({
                    "status": status,
                    "percent": 100,
                    "message": message,
                    "artifacts": artifacts,
                    "failed_items": failures,
                    "error": error,
                    "finished_at": _now_iso(),
                })
                logs = list(job.get("logs") or [])
                logs.append(message)
                if failures:
                    logs.extend(f"PENDENTE · {item['label']}: {item['error']}" for item in failures)
                job["logs"] = logs[-200:]
            finished = _update_state(done)
            if not failures and generation_identity == _materials_final_identity():
                (MATERIALS_FINAL_DIR / "reuse.json").write_text(json.dumps({"identity": generation_identity, "job": finished["materials_final"]}, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            # Catastrophic setup/input failure: there was no safe per-artifact
            # boundary at which the pipeline could continue.
            def failed(state: dict[str, Any]) -> None:
                job = state["materials_final"]
                job.update({
                    "status": "failed",
                    "percent": 100,
                    "message": "Falha antes da geração dos artefatos finais.",
                    "error": str(exc),
                    "failed_items": [{"id": "pipeline", "label": "Pipeline final", "error": str(exc)}],
                    "finished_at": _now_iso(),
                })
                logs = list(job.get("logs") or [])
                logs.append(f"ERRO: {exc}")
                job["logs"] = logs[-200:]
            _update_state(failed)


class ValidateYouTubeRequest(BaseModel):
    video_url: str
    role: Literal["en", "pt"] = "en"


class ConfigureRequest(BaseModel):
    media_source: Literal["youtube", "manual"] = "youtube"
    content_type: Literal["kit", "music"]
    dual_scene: bool = False
    transcription_mode: Literal["generator", "external"] = "external"


class CutRequest(BaseModel):
    start_ms: int
    end_ms: int


class CueReviewSaveRequest(BaseModel):
    order: int
    approved_en: str
    pt: str
    start_ms: int | None = None
    end_ms: int | None = None


class CueReviewInvalidateRequest(BaseModel):
    order: int


class CueReviewCreateRequest(BaseModel):
    after_order: int
    start_ms: int
    end_ms: int


class CueReviewWindowRequest(BaseModel):
    start_ms: int | None = None
    end_ms: int | None = None


class CueReviewMergeRequest(BaseModel):
    order: int
    direction: Literal["previous", "next"]


class CueReviewSplitRequest(BaseModel):
    order: int
    split_ms: int
    split_word_index: int | None = None


def _fine_split_word_index(words: list[dict[str, Any]], split_ms: int, requested: int | None = None) -> int:
    if len(words) < 2:
        raise ValueError("A cue precisa ter pelo menos duas palavras para ser separada.")
    if requested is not None:
        index = int(requested)
        if 1 <= index < len(words):
            return index
        raise ValueError("Escolha uma palavra interna para iniciar a nova cue.")
    # Pick the textual boundary nearest to the exact temporal marker. Each
    # candidate is the midpoint between the previous word's OUT and the next
    # word's IN, so a marker in either a silence or an overlap is deterministic.
    candidates = []
    for index in range(1, len(words)):
        previous_end = int(words[index - 1].get("end_ms") or words[index - 1].get("start_ms") or 0)
        next_start = int(words[index].get("start_ms") or previous_end)
        candidates.append((abs(((previous_end + next_start) // 2) - int(split_ms)), index))
    return min(candidates)[1]


class ProjectCreateRequest(BaseModel):
    name: str = ""


class CueTimingSaveRequest(BaseModel):
    order: int
    start_ms: int
    end_ms: int
    speaker: str = ""


class SpeakerNameRequest(BaseModel):
    name: str


class SpeakerRenameRequest(BaseModel):
    current_name: str
    new_name: str


class WordReviewSaveRequest(BaseModel):
    cue_order: int
    word_index: int
    text: str
    pt: str


class WordReviewGroupRequest(BaseModel):
    cue_order: int
    word_index: int
    direction: Literal["previous", "next"]


class WordReviewUngroupRequest(BaseModel):
    cue_order: int
    word_index: int


class WordTimingSaveRequest(BaseModel):
    cue_order: int
    unit_index: int
    start_ms: int
    end_ms: int


class WordTimingSaveCueRequest(BaseModel):
    cue_order: int
    current_unit_index: int
    current_start_ms: int
    current_end_ms: int


class WordTimingRealignRequest(BaseModel):
    cue_order: int
    anchor_unit_index: int
    anchor_start_ms: int
    anchor_end_ms: int


class DualSceneBlocksRequest(BaseModel):
    blocks: list[dict[str, Any]] = []


class ShadowingDraftRequest(BaseModel):
    pause_markers_ms: list[int] = []
    end_ms: int | None = None
    segments: list[dict[str, Any]] = []


class ConnectedSpeechReviewDecisionRequest(BaseModel):
    sequence_order: int
    decision: Literal["approved", "rejected"]


class AISettingsRequest(BaseModel):
    model: str | None = None
    tts_model: str
    tts_voice: str
    api_key: str | None = None


class AISetupInspectRequest(BaseModel):
    api_key: str


class AITTSTestRequest(BaseModel):
    text: str


def _source_ready(state: dict[str, Any]) -> bool:
    en = state.get("en") or {}
    return bool(en.get("validated") and en.get("embeddable") and en.get("url"))


def _wave_page_ready(state: dict[str, Any]) -> bool:
    if not _source_ready(state):
        return False
    cfg = state.get("configuration") or {}
    content_type = str(cfg.get("content_type") or "")
    if not (cfg.get("configured") and content_type in {"kit", "music"}):
        return False
    if content_type == "kit" and cfg.get("dual_scene"):
        pt = state.get("pt") or {}
        if not (pt.get("validated") and pt.get("embeddable") and pt.get("url")):
            return False
    return True


@app.get("/", include_in_schema=False)
def projects_page():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/source", include_in_schema=False)
def source_alias():
    return FileResponse(STATIC_DIR / "source.html")


@app.get("/config", include_in_schema=False)
def config_page():
    state = _read_state()
    if not _source_ready(state):
        return RedirectResponse(url="/source", status_code=307)
    return FileResponse(STATIC_DIR / "config.html")


@app.get("/wave", include_in_schema=False)
def wave_page():
    state = _read_state()
    if not _source_ready(state):
        return RedirectResponse(url="/source", status_code=307)
    if not _wave_page_ready(state):
        return RedirectResponse(url="/config", status_code=307)
    return FileResponse(STATIC_DIR / "wave.html")


@app.get("/process", include_in_schema=False)
def process_page():
    state = _read_state()
    if not _source_ready(state):
        return RedirectResponse(url="/source", status_code=307)
    if not _wave_page_ready(state):
        return RedirectResponse(url="/config", status_code=307)
    if not _process_page_ready(state):
        return RedirectResponse(url="/wave", status_code=307)
    return FileResponse(STATIC_DIR / "process.html")


@app.get("/external-ai", include_in_schema=False)
def external_ai_page():
    state = _read_state()
    if not _source_ready(state):
        return RedirectResponse(url="/source", status_code=307)
    if not _wave_page_ready(state):
        return RedirectResponse(url="/config", status_code=307)
    if not _process_page_ready(state):
        return RedirectResponse(url="/wave", status_code=307)
    if (state.get("process") or {}).get("status") != "ready":
        return RedirectResponse(url="/process", status_code=307)
    return FileResponse(STATIC_DIR / "external_ai.html")


@app.get("/cue-review", include_in_schema=False)
def cue_review_page():
    state = _read_state()
    if not _cue_review_page_ready(state):
        return RedirectResponse(url="/external-ai", status_code=307)
    return FileResponse(STATIC_DIR / "cue_review.html")


@app.get("/word-review", include_in_schema=False)
def word_review_page():
    state = _read_state()
    if not _word_review_page_ready(state):
        return RedirectResponse(url="/cue-review", status_code=307)
    return FileResponse(STATIC_DIR / "word_review.html")


@app.get("/cue-timing", include_in_schema=False)
def cue_timing_page():
    state = _read_state()
    if not _cue_timing_page_ready(state):
        return RedirectResponse(url="/word-review", status_code=307)
    return FileResponse(STATIC_DIR / "cue_timing.html")


@app.get("/word-timing", include_in_schema=False)
def word_timing_page():
    state = _read_state()
    if not _word_timing_page_ready(state):
        return RedirectResponse(url="/cue-timing", status_code=307)
    return FileResponse(STATIC_DIR / "word_timing.html")


@app.get("/dual-scene", include_in_schema=False)
def dual_scene_page():
    state = _read_state()
    if not _dual_scene_ready(state):
        return RedirectResponse(url="/word-timing", status_code=307)
    return FileResponse(STATIC_DIR / "dual_scene.html")


@app.get("/shadowing", include_in_schema=False)
def shadowing_page():
    state = _read_state()
    if _music_without_shadowing(state):
        return RedirectResponse(url="/materials-external", status_code=307)
    if bool((state.get("configuration") or {}).get("dual_scene")):
        return RedirectResponse(url="/word-timing", status_code=307)
    if not _shadowing_page_ready(state):
        return RedirectResponse(url="/word-timing", status_code=307)
    return FileResponse(STATIC_DIR / "shadowing.html")


@app.get("/connected-speech", include_in_schema=False)
def connected_speech_page():
    return RedirectResponse(url="/materials-external", status_code=307)

@app.get("/connected-speech-import", include_in_schema=False)
def connected_speech_import_page():
    return RedirectResponse(url="/materials-external", status_code=307)

@app.get("/connected-speech-review", include_in_schema=False)
def connected_speech_review_page():
    return RedirectResponse(url="/materials-external", status_code=307)

@app.get("/materials-external", include_in_schema=False)
def materials_external_page():
    if _materials_review_ready():
        return RedirectResponse(url="/materials-review", status_code=307)
    if EXTERNAL_AI_ONE_PASS_FILE.is_file() and _materials_external_page_ready():
        _activate_one_pass_anki()
        return RedirectResponse(url="/materials-review", status_code=307)
    return RedirectResponse(url="/external-ai", status_code=307)

@app.get("/materials-review", include_in_schema=False)
def materials_review_page():
    if not _materials_review_ready():
        return RedirectResponse(url="/materials-external", status_code=307)
    return FileResponse(STATIC_DIR / "materials_review.html")


@app.get("/materials-final", include_in_schema=False)
def materials_final_page():
    if not _materials_final_ready():
        return RedirectResponse(url="/materials-review", status_code=307)
    return FileResponse(STATIC_DIR / "materials_final.html")


@app.get("/api/state")
def get_state():
    return _read_state()


@app.get("/api/projects")
def projects_list(page: int = 1):
    with _project_lock:
        index = _sync_active_project()
        items = [_project_video_details(item) for item in sorted(index.get("projects") or [], key=lambda item: str(item.get("updated_at") or ""), reverse=True)]
        page = max(1, int(page))
        per_page = 20
        total = len(items)
        pages = max(1, math.ceil(total / per_page))
        page = min(page, pages)
        start = (page - 1) * per_page
        return {"ok": True, "items": items[start:start + per_page], "page": page, "pages": pages, "per_page": per_page, "total": total, "active_project_id": index.get("active_project_id") or ""}


@app.post("/api/projects")
def projects_create(request: ProjectCreateRequest):
    with _project_lock:
        index = _sync_active_project()
        project_id = f"project-{uuid.uuid4().hex[:12]}"
        now = _now_iso()
        index["projects"].append({"id": project_id, "name": request.name.strip() or "Novo projeto", "source_url": "", "video_id": "", "status": "draft", "status_label": "Novo projeto", "continue_url": "/source", "created_at": now, "updated_at": now})
        index["active_project_id"] = project_id
        _clear_active_workspace()
        project_workspace = PROJECTS_DIR / project_id / "workspace"
        project_workspace.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(WORKSPACE_DIR, project_workspace)
        _write_projects_index(index)
        return {"ok": True, "project_id": project_id, "continue_url": "/source"}


@app.post("/api/projects/import-final")
async def projects_import_final(request: Request):
    from final_project_import import decode_final_project, install_final_project
    import sys
    import tempfile
    from types import SimpleNamespace
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="O JSON deve ter no máximo 20 MB.")
    try:
        payload = json.loads(body.decode("utf-8-sig"))
        canonical, cards = decode_final_project(payload, _is_youtube_url, request.headers.get("x-media-origin-ms"))
    except (ValueError, RuntimeError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    with _project_lock:
        current = _read_state()
        if any(isinstance(v, dict) and v.get("status") in {"running", "queued"} for v in current.values()):
            raise HTTPException(status_code=409, detail="Aguarde o processamento do projeto atual antes de importar.")
        # Build and validate all restored state before touching the active project.
        with tempfile.TemporaryDirectory(prefix="generator_import_") as temp:
            root = Path(temp) / "workspace"
            root.mkdir()
            facade = SimpleNamespace(**vars(sys.modules[__name__]))
            for name, value in vars(sys.modules[__name__]).items():
                if isinstance(value, Path) and value.is_relative_to(WORKSPACE_DIR):
                    setattr(facade, name, root / value.relative_to(WORKSPACE_DIR))
            facade._read_state = _default_state
            facade._write_state = lambda value: facade.STATE_FILE.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                install_final_project(facade, payload, canonical, cards)
            except (ValueError, TypeError, KeyError) as exc:
                raise HTTPException(status_code=422, detail=f"JSON final incompatível: {exc}") from exc
            created = projects_create(ProjectCreateRequest(name=payload["kit"]["title"]))
            shutil.copytree(root, WORKSPACE_DIR, dirs_exist_ok=True)
            _sync_active_project()
    return {"ok": True, "project_id": created["project_id"], "continue_url": "/process"}


@app.post("/api/projects/{project_id}/continue")
def projects_continue(project_id: str):
    with _project_lock:
        project_id = _safe_project_id(project_id)
        index = _sync_active_project()
        item = next((row for row in index.get("projects") or [] if row.get("id") == project_id), None)
        source = PROJECTS_DIR / project_id / "workspace"
        if not item or not source.is_dir():
            raise HTTPException(status_code=404, detail="Projeto não encontrado.")
        _clear_active_workspace()
        _remove_project_tree(WORKSPACE_DIR)
        shutil.copytree(source, WORKSPACE_DIR)
        index["active_project_id"] = project_id
        item["updated_at"] = _now_iso()
        _write_projects_index(index)
        state = _read_state()
        _status, _label, continue_url = _project_progress(state)
    return {"ok": True, "project_id": project_id, "continue_url": continue_url}


@app.delete("/api/projects/{project_id}")
def projects_delete(project_id: str):
    with _project_lock:
        project_id = _safe_project_id(project_id)
        index = _sync_active_project()
        before = len(index.get("projects") or [])
        index["projects"] = [item for item in index.get("projects") or [] if item.get("id") != project_id]
        if len(index["projects"]) == before:
            raise HTTPException(status_code=404, detail="Projeto não encontrado.")
        target = (PROJECTS_DIR / project_id).resolve()
        projects_root = PROJECTS_DIR.resolve()
        if target.parent != projects_root:
            raise HTTPException(status_code=400, detail="Destino de projeto inválido.")
        if target.exists():
            _remove_project_tree(target)
        if index.get("active_project_id") == project_id:
            index["active_project_id"] = ""
            _clear_active_workspace()
        _write_projects_index(index)
        return {"ok": True, "deleted_project_id": project_id}


@app.get("/api/ai/settings")
def ai_settings():
    return {"ok": True, "settings": public_ai_settings()}


@app.put("/api/ai/settings")
def ai_settings_save(request: AISettingsRequest):
    try:
        save_ai_settings(
            model=request.model,
            tts_model=request.tts_model,
            tts_voice=request.tts_voice,
            api_key=request.api_key,
        )
        connection = test_groq_connection(record_validation=True)
        settings = groq_readiness()
        if not settings.get("ready"):
            raise RuntimeError(settings.get("readiness_reason") or "A Groq não ficou pronta após salvar a configuração.")
        return {"ok": True, "settings": settings, "connection": connection}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/ai/connection")
def ai_connection():
    try:
        result = test_groq_connection(record_validation=True)
        return {**result, "settings": groq_readiness()}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/ai/models")
def ai_models():
    try:
        return {"ok": True, "models": list_groq_models(), "settings": public_ai_settings()}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/ai/setup/inspect")
def ai_setup_inspect(request: AISetupInspectRequest):
    key = request.api_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="Informe a API key da Groq.")
    try:
        return {
            "ok": True,
            "models": list_groq_models(api_key=key),
            "tts_voices": public_ai_settings().get("tts_voices") or [],
            "recommended_model": "openai/gpt-oss-120b",
            "recommended_tts_model": "canopylabs/orpheus-v1-english",
        }
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/ai/tts-test")
def ai_tts_test(request: AITTSTestRequest):
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Informe uma frase para testar a voz.")
    try:
        AI_TTS_TEST_FILE.parent.mkdir(parents=True, exist_ok=True)
        info = synthesize_tts(text, AI_TTS_TEST_FILE)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    response = FileResponse(AI_TTS_TEST_FILE, media_type="audio/wav", filename="groq-tts-test.wav")
    response.headers["X-TTS-Chunks"] = str(info.get("chunks") or 1)
    return response


@app.post("/api/youtube/validate")
def validate_youtube(request: ValidateYouTubeRequest):
    url = request.video_url.strip()
    if not _is_youtube_url(url):
        def invalid_url(state: dict[str, Any]) -> None:
            if request.role == "en" and str(state["en"].get("url") or "") != url:
                _reset_after_en_change(state)
            state[request.role] = {"url": url, "validated": False, "embeddable": False, "title": "", "video_id": "", "reason": "Informe uma URL válida do YouTube."}
        _update_state(invalid_url)
        raise HTTPException(status_code=422, detail="Informe uma URL válida do YouTube.")

    try:
        result = inspect_embed_support(url)
    except Exception as exc:
        reason = str(exc)
        def failed_inspection(state: dict[str, Any]) -> None:
            if request.role == "en" and str(state["en"].get("url") or "") != url:
                _reset_after_en_change(state)
            state[request.role] = {"url": url, "validated": False, "embeddable": False, "title": "", "video_id": "", "reason": reason}
        _update_state(failed_inspection)
        raise HTTPException(status_code=422, detail=reason) from exc

    embeddable = bool(result.get("embeddable"))
    payload = {
        "url": url,
        "validated": True,
        "embeddable": embeddable,
        "title": str(result.get("title") or "").strip(),
        "video_id": str(result.get("video_id") or "").strip(),
        "reason": str(result.get("reason") or "").strip(),
    }

    def mutate(state: dict[str, Any]) -> None:
        previous = str(state[request.role].get("url") or "")
        if request.role == "en" and previous and previous != url:
            _reset_after_en_change(state)
        state[request.role] = payload
    state = _update_state(mutate)

    return {
        "ok": True,
        "role": request.role,
        "can_proceed": embeddable,
        "source": state[request.role],
    }


@app.post("/api/source/upload")
async def upload_source_video(request: Request):
    # Stream to disk: large videos must not be buffered in memory.
    with _wave_lock:
        state = _read_state()
        if state["wave"].get("status") in {"running", "queued", "uploading"} or state["process"].get("status") in {"running", "queued"}:
            raise HTTPException(status_code=409, detail="Aguarde a preparação atual terminar antes de enviar outro vídeo.")
        if not _source_ready(state):
            raise HTTPException(status_code=409, detail="Valide primeiro a fonte EN.")
        previous_wave = copy.deepcopy(state["wave"])
        _wave_update(status="uploading")
    temporary = SOURCE_EN_DIR / f"upload-{uuid.uuid4().hex}.bin"
    normalized = temporary.with_suffix(".mp4")
    try:
        with temporary.open("wb") as output:
            async for chunk in request.stream():
                output.write(chunk)
        if not temporary.stat().st_size:
            raise ValueError("Selecione um arquivo de vídeo não vazio.")
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(temporary),
             "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", str(normalized)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            raise ValueError("Envie um vídeo com áudio compatível com MP4. " + result.stderr[-800:])
        duration = _probe_duration_ms(normalized)
        waveform = _generate_waveform(normalized)
        # Validate everything before replacing the current source and its dependents.
        ready_file = WORKSPACE_DIR / f"validated-{uuid.uuid4().hex}.mp4"
        normalized.replace(ready_file)
        try:
            def finish(s):
                pt = copy.deepcopy(s["pt"])
                _reset_after_en_change(s)
                s["pt"] = pt
                ready_file.replace(SOURCE_EN_FILE)
                s["wave"].update(status="ready", percent=100, message="Vídeo enviado. Wave Editor pronto.",
                    source_kind="manual", source_url=s["en"]["url"], duration_ms=duration,
                    waveform=waveform, media_url="/media/source/en/original.mp4", error="")
                s["cut"].update(start_ms=0, end_ms=min(duration, 30000), saved=False)
            _update_state(finish)
        finally:
            ready_file.unlink(missing_ok=True)
        return {"ok": True}
    except Exception as exc:
        _wave_update(**previous_wave)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        temporary.unlink(missing_ok=True)
        normalized.unlink(missing_ok=True)


@app.post("/api/configure")
def configure(request: ConfigureRequest, background_tasks: BackgroundTasks):
    state = _read_state()
    if state["wave"].get("status") == "uploading":
        raise HTTPException(status_code=409, detail="Aguarde o envio do vídeo terminar.")
    en = state["en"]
    if not (en.get("validated") and en.get("embeddable") and en.get("url")):
        raise HTTPException(status_code=409, detail="Valide primeiro um vídeo EN que permita incorporação.")

    if request.content_type == "music":
        request.dual_scene = False

    if request.content_type == "kit" and request.dual_scene:
        pt = state["pt"]
        if not (pt.get("validated") and pt.get("embeddable") and pt.get("url")):
            raise HTTPException(status_code=409, detail="DualScene exige um vídeo PT válido e incorporável antes de continuar.")

    if request.media_source == "manual" and not (
        state["wave"].get("source_kind") == "manual" and SOURCE_EN_FILE.is_file()
    ):
        raise HTTPException(status_code=409, detail="Envie um vídeo antes de continuar.")
    if request.media_source == "youtube" and state["wave"].get("source_kind") == "manual":
        pt = copy.deepcopy(state["pt"])
        _reset_after_en_change(state)
        state["pt"] = pt
        _update_state(lambda s: s.update(state))

    previous_configuration = state.get("configuration") or {}
    preserve_reviews = (
        bool(previous_configuration.get("configured"))
        and previous_configuration.get("content_type") == request.content_type
        and previous_configuration.get("transcription_mode", "external") == request.transcription_mode
        and bool((state.get("word_timing") or {}).get("completed"))
        and WORD_TIMING_CANONICAL_FILE.is_file()
    )
    switching_to_dual = preserve_reviews and not bool(previous_configuration.get("dual_scene")) and bool(request.dual_scene)
    configuration_unchanged = (
        bool(previous_configuration.get("configured"))
        and str(previous_configuration.get("content_type") or "") == request.content_type
        and bool(previous_configuration.get("dual_scene")) == (bool(request.dual_scene) if request.content_type == "kit" else False)
        and str(previous_configuration.get("transcription_mode") or "external") == request.transcription_mode
    )

    def configured_state(s: dict[str, Any]) -> None:
        previous = s.get("configuration") or {}
        unchanged = (
            bool(previous.get("configured"))
            and str(previous.get("content_type") or "") == request.content_type
            and bool(previous.get("dual_scene")) == (bool(request.dual_scene) if request.content_type == "kit" else False)
            and str(previous.get("transcription_mode") or "external") == request.transcription_mode
        )
        s["configuration"] = {
            "content_type": request.content_type,
            "dual_scene": bool(request.dual_scene) if request.content_type == "kit" else False,
            "transcription_mode": request.transcription_mode,
            "shadowing_enabled": previous.get("shadowing_enabled", True),
            "configured": True,
        }
        if unchanged:
            return
        if preserve_reviews:
            if switching_to_dual:
                s["process"] = _default_state()["process"]
                s["media_refresh_preserve_reviews"] = True
            return
        s.pop("resume_after_media", None)
        s["process"] = _default_state()["process"]
        s["external_ai"] = _default_state()["external_ai"]
        s["cue_review"] = _default_state()["cue_review"]
        s["cue_timing"] = _default_state()["cue_timing"]
        s["word_timing"] = _default_state()["word_timing"]
        s["dual_scene"] = _default_state()["dual_scene"]
    state = _update_state(configured_state)
    if preserve_reviews:
        return {"ok": True, "preserved": True, "next_url": "/process" if switching_to_dual else ("/dual-scene" if request.dual_scene else "/shadowing"), "wave_started": False}
    if not configuration_unchanged:
        shutil.rmtree(CUE_REVIEW_DIR, ignore_errors=True)
        shutil.rmtree(WORD_REVIEW_DIR, ignore_errors=True)
        shutil.rmtree(CUE_TIMING_DIR, ignore_errors=True)

    current_wave = state["wave"]
    source_url = str(state["en"]["url"])
    if current_wave.get("status") == "ready" and current_wave.get("source_url") == source_url and SOURCE_EN_FILE.is_file():
        return {"ok": True, "music_pending": False, "wave_started": False, "wave": current_wave}

    with _wave_lock:
        latest = _read_state()["wave"]
        if latest.get("status") not in {"running", "queued"}:
            _wave_update(status="queued", percent=1, message="Preparação do Wave Editor na fila…", error="", source_url=source_url)
            background_tasks.add_task(_prepare_wave_job, source_url)
    return {"ok": True, "music_pending": False, "wave_started": True}


@app.get("/api/wave/status")
def wave_status():
    return _read_state()["wave"]


@app.post("/api/cut/save")
def save_cut(request: CutRequest):
    state = _read_state()
    wave = state["wave"]
    if wave.get("status") != "ready":
        raise HTTPException(status_code=409, detail="O Wave Editor ainda não está pronto.")
    duration = int(wave.get("duration_ms") or 0)
    start = int(request.start_ms)
    end = int(request.end_ms)
    if start < 0 or end <= start or end > duration:
        raise HTTPException(status_code=422, detail="O intervalo IN/OUT é inválido para este vídeo.")
    cfg = state.get("configuration") or {}
    if cfg.get("content_type") == "music":
        selected_duration = end - start
        if selected_duration < 30000:
            raise HTTPException(status_code=422, detail="Music exige um recorte mínimo de 30 segundos.")

    previous_cut = state.get("cut") or {}
    same_cut = bool(previous_cut.get("saved")) and int(previous_cut.get("start_ms") or 0) == start and int(previous_cut.get("end_ms") or 0) == end
    can_reuse = same_cut and _processed_media_matches(state)

    def mutate(s: dict[str, Any]) -> None:
        s["cut"] = {"start_ms": start, "end_ms": end, "saved": True}
        if can_reuse:
            return
        s["process"] = _default_state()["process"]
        s["external_ai"] = _default_state()["external_ai"]
        s["cue_review"] = _default_state()["cue_review"]
        s["word_review"] = _default_state()["word_review"]
        s["cue_timing"] = _default_state()["cue_timing"]
        s["word_timing"] = _default_state()["word_timing"]
    _update_state(mutate)
    if not can_reuse:
        shutil.rmtree(EXTERNAL_AI_DIR, ignore_errors=True)
        shutil.rmtree(CUE_REVIEW_DIR, ignore_errors=True)
        shutil.rmtree(WORD_REVIEW_DIR, ignore_errors=True)
        shutil.rmtree(CUE_TIMING_DIR, ignore_errors=True)
    return {
        "ok": True,
        "cut": {"start_ms": start, "end_ms": end, "saved": True},
        "media_reused": can_reuse,
        "message": "Corte salvo. Mídia e JSON existentes reaproveitados." if can_reuse else "Corte salvo.",
    }


@app.post("/api/process/start")
def start_process(background_tasks: BackgroundTasks, force: bool = False):
    state = _read_state()
    if not _process_page_ready(state):
        raise HTTPException(status_code=409, detail="Salve um recorte válido antes de processar a mídia.")
    with _process_lock:
        if not force and _processed_media_matches(state):
            return {"ok": True, "started": False, "reused": True, "process": state["process"]}
        latest = _read_state()["process"]
        if latest.get("status") in {"queued", "running"}:
            return {"ok": True, "started": False, "process": latest}
        def queue(s: dict[str, Any]) -> None:
            s["process"] = _default_state()["process"]
            if s.get("imported_final") or s.get("media_refresh_preserve_reviews"):
                s["process"].update({"status": "queued", "percent": 0, "message": "Baixando mídias do JSON importado, sem alterar cues.", "started_at": _now_iso()})
                s["process"]["input_signature"] = _process_input_signature(s)
                return
            s["external_ai"] = _default_state()["external_ai"]
            s["cue_review"] = _default_state()["cue_review"]
            s["word_review"] = _default_state()["word_review"]
            s["cue_timing"] = _default_state()["cue_timing"]
            s["word_timing"] = _default_state()["word_timing"]
            s["process"].update({"status": "queued", "percent": 0, "message": "Processamento na fila.", "started_at": _now_iso()})
            s["process"]["input_signature"] = _process_input_signature(s)
        queued = _update_state(queue)
        background_tasks.add_task(_process_media_job)
    return {"ok": True, "started": True, "process": queued["process"]}


@app.get("/api/process/status")
def process_status():
    state = _read_state()
    return {**state["process"], "next_url": str(state.get("resume_after_media") or (("/dual-scene" if (state.get("configuration") or {}).get("dual_scene") else "/cue-review") if (state.get("imported_final") or state.get("media_refresh_preserve_reviews")) else "/external-ai"))}


@app.get("/api/process/artifact/{artifact_key}")
def process_artifact(artifact_key: str):
    available = {str(item.get("key") or "") for item in (_read_state().get("process", {}).get("artifacts") or [])}
    if artifact_key not in available:
        raise HTTPException(status_code=404, detail="Artefato ainda não está disponível para este processamento.")
    files = {
        "source": (PROCESS_SOURCE_FILE, "video/mp4", "original.mp4"),
        "video": (PROCESS_VIDEO_FILE, "video/mp4", PROCESS_VIDEO_FILE.name),
        "audio": (PROCESS_AUDIO_FILE, "audio/wav", PROCESS_AUDIO_FILE.name),
        "json": (PROCESS_JSON_FILE, "application/json", PROCESS_JSON_FILE.name),
    }
    item = files.get(artifact_key)
    if not item:
        raise HTTPException(status_code=404, detail="Artefato desconhecido.")
    path, media_type, filename = item
    if not path.is_file() or path.stat().st_size <= 0:
        raise HTTPException(status_code=404, detail="Artefato ainda não está disponível.")
    return FileResponse(path, media_type=media_type, filename=filename)


@app.post("/api/external-ai/prepare")
def prepare_external_ai():
    try:
        external = _prepare_external_ai_package()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, "external_ai": external}


@app.get("/api/external-ai/status")
def external_ai_status():
    return _ensure_external_extraction_artifact()


@app.get("/api/external-ai/artifact/{artifact_key}")
def external_ai_artifact(artifact_key: str):
    state = _read_state()
    available = {str(item.get("key") or "") for item in (state.get("external_ai", {}).get("artifacts") or [])}
    if artifact_key not in available:
        raise HTTPException(status_code=404, detail="Artefato da IA externa ainda não está disponível.")
    files = {
        "canonical": (EXTERNAL_AI_CANONICAL_FILE, "application/json", "canonical_scene.json"),
        "audio": (PROCESS_AUDIO_FILE, "audio/wav", "scene_audio_16k_mono.wav"),
        "instructions": (EXTERNAL_AI_INSTRUCTIONS_FILE, "text/plain; charset=utf-8", "INSTRUCOES_EXTERNAL_AI.txt"),
        "zip": (EXTERNAL_AI_ZIP_FILE, "application/zip", ("external_ai_music.zip" if str(((state.get("configuration") or {}).get("content_type") or "")) == "music" else "external_ai_scene.zip")),
        "extraction": (EXTERNAL_AI_EXTRACTION_FILE, "text/plain; charset=utf-8", EXTERNAL_AI_EXTRACTION_FILE.name),
    }
    item = files.get(artifact_key)
    if not item:
        raise HTTPException(status_code=404, detail="Artefato desconhecido.")
    path, media_type, filename = item
    if not path.is_file() or path.stat().st_size <= 0:
        raise HTTPException(status_code=404, detail="Artefato ainda não está disponível.")
    return FileResponse(path, media_type=media_type, filename=filename)


@app.post("/api/external-ai/import")
async def import_external_ai(request: Request, filename: str = "external_ai_return.json"):
    state = _read_state()
    if not _external_ai_page_ready(state):
        raise HTTPException(status_code=409, detail="Conclua o processamento da mídia antes de importar o retorno da IA.")
    if not EXTERNAL_AI_CANONICAL_FILE.is_file():
        try:
            _prepare_external_ai_package()
        except Exception as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:
        # Read the raw upload and parse it on the server. This preserves JSON
        # numeric representations that JavaScript would otherwise normalize
        # before validation (for example, protected 3.0 becoming 3).
        raw_body = await request.body()
        raw_text = raw_body.decode("utf-8-sig")
        returned = json.loads(raw_text)
    except Exception as exc:
        def invalid_parse(s: dict[str, Any]) -> None:
            s["external_ai"].update({"status": "invalid", "validated": False, "error": "O arquivo não contém JSON válido.", "returned_filename": filename})
        _update_state(invalid_parse)
        raise HTTPException(status_code=422, detail="O arquivo não contém JSON válido.") from exc
    try:
        if not isinstance(returned, dict):
            raise ValueError("A raiz do retorno deve ser um objeto JSON.")
        one_pass_raw = returned.pop("generator_materials", None)
        base = json.loads(EXTERNAL_AI_CANONICAL_FILE.read_text(encoding="utf-8"))
        # snapshot_id/generated_at_utc are Generator-owned canonical identity fields.
        # Never accept regenerated, normalized, removed or otherwise modified values
        # from the external AI; restore the exact canonical values before validation.
        _restore_canonical_server_owned_fields(returned, base)
        summary = _validate_external_cues(returned, base)
        one_pass = _validate_one_pass_materials(
            one_pass_raw,
            returned.get("cues") or [],
            is_music=str(((returned.get("project") or {}).get("content_type") or "")) == "music",
        )
        summary["anki_cards"] = len((one_pass.get("anki") or {}).get("items") or [])
        summary["connected_speech_candidates"] = sum(len(row.get("phenomena") or []) for row in (one_pass.get("connected_speech") or {}).get("cues") or [])
        summary["wbw_practices"] = len(one_pass.get("wbw_practices") or [])
    except Exception as exc:
        message = str(exc)
        def invalid(s: dict[str, Any]) -> None:
            s["external_ai"].update({"status": "invalid", "validated": False, "error": message, "returned_filename": filename, "validation_summary": {}})
        _update_state(invalid)
        raise HTTPException(status_code=422, detail=message) from exc

    EXTERNAL_AI_RETURN_FILE.write_text(json.dumps(returned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    EXTERNAL_AI_ONE_PASS_FILE.write_text(json.dumps(one_pass, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    EXTERNAL_AI_EXTRACTION_FILE.write_text(_external_extraction_text(returned), encoding="utf-8")
    shutil.rmtree(CUE_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(WORD_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(CUE_TIMING_DIR, ignore_errors=True)
    def valid(s: dict[str, Any]) -> None:
        s["cue_review"] = _default_state()["cue_review"]
        s["word_review"] = _default_state()["word_review"]
        s["cue_timing"] = _default_state()["cue_timing"]
        s["word_timing"] = _default_state()["word_timing"]
        s["external_ai"].update({
            "status": "validated",
            "validated": True,
            "error": "",
            "returned_filename": filename,
            "validation_summary": summary,
            "validated_at": _now_iso(),
        })
        artifacts = [item for item in (s["external_ai"].get("artifacts") or []) if item.get("key") != "extraction"]
        artifacts.append(_external_artifact_payload("extraction", EXTERNAL_AI_EXTRACTION_FILE.name, "text", EXTERNAL_AI_EXTRACTION_FILE, "Texto puro · original, tradução e Word by Word"))
        s["external_ai"]["artifacts"] = artifacts
    external = _update_state(valid)["external_ai"]
    return {"ok": True, "message": "JSON da IA externa validado.", "summary": summary, "external_ai": external}

@app.get("/api/cue-review/state")
def cue_review_state():
    state = _read_state()
    if not _cue_review_page_ready(state):
        raise HTTPException(status_code=409, detail="Valide o retorno da IA externa antes de revisar os cues.")
    try:
        return {"ok": True, "review": _cue_review_payload()}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/cue-review/cue/{order}")
def cue_review_cue(order: int):
    try:
        source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    total = len(reviewed["cues"])
    if order < 1 or order > total:
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    current_cue = reviewed["cues"][order - 1]
    ai_cue = _source_cue_for_reviewed(source["cues"], current_cue, order - 1)
    accepted = order in {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    def remember(s: dict[str, Any]) -> None:
        s["cue_review"]["current_order"] = order
        s["cue_review"]["updated_at"] = _now_iso()
    _update_state(remember)
    return {
        "ok": True,
        "cue": {
            "order": order,
            "start_ms": int(current_cue.get("speech_start_ms") or current_cue.get("subtitle_start_ms") or 0),
            "end_ms": int(current_cue.get("speech_end_ms") or current_cue.get("subtitle_end_ms") or 0),
            "ai": {
                "approved_en": str(ai_cue.get("approved_en") or ai_cue.get("original_en") or ""),
                "pt": str(ai_cue.get("pt") or ""),
            },
            "current": {
                "approved_en": str(current_cue.get("approved_en") or ""),
                "pt": str(current_cue.get("pt") or ""),
            },
            "accepted": accepted,
            "words": [
                {"index": index, "text": str(word.get("text") or ""), "start_ms": int(word.get("start_ms") or 0), "end_ms": int(word.get("end_ms") or 0)}
                for index, word in enumerate(current_cue.get("words") or []) if isinstance(word, dict)
            ],
        },
    }


@app.get("/api/cue-review/waveform")
def cue_review_waveform():
    state = _read_state()
    if not _cue_review_page_ready(state):
        raise HTTPException(status_code=409, detail="Valide o retorno da IA externa antes de revisar os cues.")
    try:
        if CUE_TIMING_WAVEFORM_FILE.is_file():
            waveform = json.loads(CUE_TIMING_WAVEFORM_FILE.read_text(encoding="utf-8"))
        else:
            CUE_TIMING_DIR.mkdir(parents=True, exist_ok=True)
            waveform = _generate_waveform(PROCESS_AUDIO_FILE, points=4800)
            CUE_TIMING_WAVEFORM_FILE.write_text(json.dumps(waveform, ensure_ascii=False) + "\n", encoding="utf-8")
        return {"ok": True, "waveform": waveform, "duration_ms": _probe_duration_ms(PROCESS_VIDEO_FILE)}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=f"Não foi possível carregar a waveform: {exc}") from exc


@app.post("/api/cue-review/invalidate")
def cue_review_invalidate(request: CueReviewInvalidateRequest):
    try:
        _source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    order = int(request.order)
    total = len(reviewed.get("cues") or [])
    if order < 1 or order > total:
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    accepted = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    accepted.discard(order)
    def invalidate(s: dict[str, Any]) -> None:
        s["cue_review"].update({
            "status": "reviewing",
            "accepted_orders": sorted(accepted),
            "current_order": order,
            "completed": False,
            "updated_at": _now_iso(),
        })
    _update_state(invalidate)
    return {"ok": True, "invalidated_order": order, "review": _cue_review_payload()}


def _retime_review_cue(cue: dict[str, Any], start_ms: int, end_ms: int) -> None:
    old_start = int(cue.get("speech_start_ms") or 0)
    old_end = int(cue.get("speech_end_ms") or max(old_start + 1, 1))
    old_span = max(1, old_end - old_start)
    new_span = end_ms - start_ms
    previous_start = start_ms - 1
    for word in [item for item in (cue.get("words") or []) if isinstance(item, dict)]:
        ws = int(word.get("start_ms") or old_start)
        we = int(word.get("end_ms") or ws + 1)
        mapped_start = start_ms + round((ws - old_start) * new_span / old_span)
        mapped_end = start_ms + round((we - old_start) * new_span / old_span)
        mapped_start = max(previous_start + 1, min(end_ms - 1, mapped_start))
        mapped_end = max(mapped_start + 1, min(end_ms, mapped_end))
        word["start_ms"] = mapped_start
        word["end_ms"] = mapped_end
        word["original_start_ms"] = mapped_start
        word["original_end_ms"] = mapped_end
        previous_start = mapped_start
    cue["speech_start_ms"] = start_ms
    cue["speech_end_ms"] = end_ms
    cue["subtitle_start_ms"] = start_ms
    cue["subtitle_end_ms"] = end_ms


def _sync_review_video_window(document: dict[str, Any]) -> None:
    cues = [cue for cue in (document.get("cues") or []) if isinstance(cue, dict)]
    if not cues:
        return
    project = document.setdefault("project", {})
    previous_local_start = int(project.get("scene_start_ms") or 0)
    previous_source_start = int(project.get("source_video_start_ms") or 0)
    source_origin = previous_source_start - previous_local_start
    local_start = min(int(cue.get("speech_start_ms") or 0) for cue in cues)
    local_end = max(int(cue.get("speech_end_ms") or 0) for cue in cues)
    project["scene_start_ms"] = local_start
    project["scene_end_ms"] = local_end
    project["scene_duration_ms"] = max(1, local_end - local_start)
    project["source_video_start_ms"] = source_origin + local_start
    project["source_video_end_ms"] = source_origin + local_end


def _shift_one_pass_orders(sidecar: dict[str, Any], insertion_order: int) -> None:
    for card in ((sidecar.get("anki") or {}).get("items") or []):
        order = int(card.get("cue_order") or 0)
        if order >= insertion_order:
            card["cue_order"] = order + 1
    for row in ((sidecar.get("connected_speech") or {}).get("cues") or []):
        order = int(row.get("cue_order") or 0)
        if order >= insertion_order:
            row["cue_order"] = order + 1
    for item in (sidecar.get("wbw_practices") or []):
        order = int(item.get("cue_order") or 0)
        if order >= insertion_order:
            item["cue_order"] = order + 1


def _reset_after_cue_structure_change(cues: list[dict[str, Any]], accepted: list[int], current_order: int) -> None:
    def update(s: dict[str, Any]) -> None:
        total = len(cues)
        completed = len(accepted) == total
        s["cue_review"].update({"status": "completed" if completed else "reviewing", "total": total, "accepted_orders": accepted, "current_order": max(1, min(current_order, total)), "completed": completed, "updated_at": _now_iso()})
    _update_state(update)


def _sync_word_review_after_cue_change(reviewed: dict[str, Any], new_to_old: dict[int, int], invalid_old_orders: set[int], current_new_order: int) -> None:
    if not WORD_REVIEW_CANONICAL_FILE.is_file():
        return
    try:
        previous = json.loads(WORD_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
        previous_cues = {int(cue.get("order") or 0): cue for cue in (previous.get("cues") or []) if isinstance(cue, dict)}
        state = _read_state()
        old_review = state.get("word_review") or {}
        old_accepted = {str(value) for value in (old_review.get("accepted_keys") or []) if isinstance(value, str)}
        synced = copy.deepcopy(reviewed)
        synced_cues: list[dict[str, Any]] = []
        old_to_new = {old: new for new, old in new_to_old.items() if old not in invalid_old_orders}
        for new_cue in reviewed.get("cues") or []:
            new_order = int(new_cue.get("order") or 0)
            old_order = new_to_old.get(new_order)
            if old_order and old_order not in invalid_old_orders and old_order in previous_cues:
                preserved = copy.deepcopy(previous_cues[old_order])
                preserved["order"] = new_order
                synced_cues.append(preserved)
            else:
                synced_cues.append(copy.deepcopy(new_cue))
        synced["cues"] = synced_cues
        valid_counts = {int(cue.get("order") or 0): len(cue.get("words") or []) for cue in synced_cues}
        accepted: set[str] = set()
        for key in old_accepted:
            try:
                old_order, word_index = (int(part) for part in key.split(":", 1))
            except Exception:
                continue
            new_order = old_to_new.get(old_order)
            if new_order and 0 <= word_index < valid_counts.get(new_order, 0):
                accepted.add(_word_key(new_order, word_index))
        total_words = sum(valid_counts.values())
        completed = len(accepted) == total_words and total_words > 0
        WORD_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        WORD_REVIEW_CANONICAL_FILE.write_text(json.dumps(synced, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        def update_word_state(s: dict[str, Any]) -> None:
            s["word_review"].update({
                "status": "completed" if completed else "reviewing",
                "source_snapshot_id": str(synced.get("snapshot_id") or ""),
                "total_words": total_words,
                "accepted_keys": sorted(accepted),
                "current_cue_order": max(1, min(current_new_order, len(synced_cues))),
                "current_word_index": 0,
                "completed": completed,
                "updated_at": _now_iso(),
            })
        _update_state(update_word_state)
        _sync_timing_reviews_after_upstream_change(synced, new_to_old, invalid_old_orders, current_new_order)
    except Exception:
        # Never destroy an existing human review if a granular synchronization
        # cannot be completed. The next request can surface the inconsistency.
        return


def _sync_timing_reviews_after_upstream_change(source: dict[str, Any], new_to_old: dict[int, int], invalid_old_orders: set[int], current_new_order: int) -> None:
    if not CUE_TIMING_CANONICAL_FILE.is_file():
        return
    previous_cue_timing = json.loads(CUE_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    old_cues = {int(cue.get("order") or 0): cue for cue in (previous_cue_timing.get("cues") or []) if isinstance(cue, dict)}
    state = _read_state()
    old_accepted = {int(value) for value in ((state.get("cue_timing") or {}).get("accepted_orders") or []) if isinstance(value, int)}
    cue_timing = copy.deepcopy(source)
    timing_cues: list[dict[str, Any]] = []
    accepted_orders: list[int] = []
    for source_cue in source.get("cues") or []:
        new_order = int(source_cue.get("order") or 0)
        old_order = new_to_old.get(new_order)
        if old_order and old_order not in invalid_old_orders and old_order in old_cues:
            preserved = copy.deepcopy(old_cues[old_order])
            preserved["order"] = new_order
            timing_cues.append(preserved)
            if old_order in old_accepted:
                accepted_orders.append(new_order)
        else:
            fresh = copy.deepcopy(source_cue)
            if old_order in old_cues:
                fresh["speaker"] = str(old_cues[old_order].get("speaker") or "")
            timing_cues.append(fresh)
    cue_timing["cues"] = timing_cues
    CUE_TIMING_DIR.mkdir(parents=True, exist_ok=True)
    CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(cue_timing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    upstream_revision = hashlib.sha256(WORD_REVIEW_CANONICAL_FILE.read_bytes()).hexdigest()

    def update_cue_timing(s: dict[str, Any]) -> None:
        total = len(timing_cues)
        completed = len(accepted_orders) == total and total > 0
        s["cue_timing"].update({"source_snapshot_id": str(source.get("snapshot_id") or ""), "source_revision": upstream_revision, "total": total, "accepted_orders": sorted(accepted_orders), "current_order": max(1, min(current_new_order, total)), "completed": completed, "status": "completed" if completed else "reviewing", "updated_at": _now_iso()})
    _update_state(update_cue_timing)

    if not WORD_TIMING_CANONICAL_FILE.is_file():
        return
    previous_word_timing = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    old_word_cues = {int(cue.get("order") or 0): cue for cue in (previous_word_timing.get("cues") or []) if isinstance(cue, dict)}
    state = _read_state()
    old_word_accepted = {str(value) for value in ((state.get("word_timing") or {}).get("accepted_keys") or []) if isinstance(value, str)}
    word_timing = copy.deepcopy(cue_timing)
    word_timing_cues: list[dict[str, Any]] = []
    accepted_keys: set[str] = set()
    for fresh_cue in cue_timing.get("cues") or []:
        new_order = int(fresh_cue.get("order") or 0)
        old_order = new_to_old.get(new_order)
        if old_order and old_order not in invalid_old_orders and old_order in old_word_cues:
            preserved = copy.deepcopy(old_word_cues[old_order])
            preserved["order"] = new_order
            word_timing_cues.append(preserved)
            for key in old_word_accepted:
                if key.startswith(f"{old_order}:"):
                    accepted_keys.add(f"{new_order}:{key.split(':', 1)[1]}")
        else:
            word_timing_cues.append(copy.deepcopy(fresh_cue))
    word_timing["cues"] = word_timing_cues
    _seed_word_timings_inside_cues(word_timing)
    WORD_TIMING_DIR.mkdir(parents=True, exist_ok=True)
    WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(word_timing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    positions = _word_timing_positions(word_timing)
    valid = {_word_timing_key(*position) for position in positions}
    accepted_keys &= valid
    cue_revision = hashlib.sha256(CUE_TIMING_CANONICAL_FILE.read_bytes()).hexdigest()

    def update_word_timing(s: dict[str, Any]) -> None:
        completed = len(accepted_keys) == len(positions) and bool(positions)
        s["word_timing"].update({"source_snapshot_id": str(source.get("snapshot_id") or ""), "source_revision": cue_revision, "total_units": len(positions), "accepted_keys": sorted(accepted_keys), "current_cue_order": max(1, min(current_new_order, len(word_timing_cues))), "current_unit_index": 0, "completed": completed, "status": "completed" if completed else "reviewing", "updated_at": _now_iso()})
        if SHADOWING_PLAN_FILE.is_file():
            s["shadowing"]["source_revision"] = hashlib.sha256(WORD_TIMING_CANONICAL_FILE.read_bytes()).hexdigest()
            s["shadowing"]["updated_at"] = _now_iso()
    _update_state(update_word_timing)


def _write_review_documents(reviewed: dict[str, Any], sidecar: dict[str, Any] | None = None) -> None:
    _sync_review_video_window(reviewed)
    CUE_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if sidecar is not None:
        EXTERNAL_AI_ONE_PASS_FILE.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _join_cue_text(left: dict[str, Any], right: dict[str, Any], field: str) -> str:
    return " ".join(part.strip() for part in (str(left.get(field) or ""), str(right.get(field) or "")) if part.strip())


@app.post("/api/cue-review/merge")
def cue_review_merge(request: CueReviewMergeRequest):
    try:
        _source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    order = int(request.order)
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    left_order = order - 1 if request.direction == "previous" else order
    right_order = left_order + 1
    if left_order < 1 or right_order > len(cues):
        raise HTTPException(status_code=422, detail="Não existe cue nesse lado para juntar.")

    left, right = cues[left_order - 1], cues[right_order - 1]
    left["speech_start_ms"] = min(int(left.get("speech_start_ms") or 0), int(right.get("speech_start_ms") or 0))
    left["speech_end_ms"] = max(int(left.get("speech_end_ms") or 0), int(right.get("speech_end_ms") or 0))
    left["subtitle_start_ms"] = min(int(left.get("subtitle_start_ms") or left["speech_start_ms"]), int(right.get("subtitle_start_ms") or right["speech_start_ms"]))
    left["subtitle_end_ms"] = max(int(left.get("subtitle_end_ms") or left["speech_end_ms"]), int(right.get("subtitle_end_ms") or right["speech_end_ms"]))
    for field in ("original_en", "approved_en", "pt"):
        left[field] = _join_cue_text(left, right, field)
    if not str(left.get("speaker") or "").strip():
        left["speaker"] = right.get("speaker") or ""
    left["words"] = sorted([copy.deepcopy(word) for word in (left.get("words") or []) + (right.get("words") or []) if isinstance(word, dict)], key=lambda word: (int(word.get("start_ms") or 0), int(word.get("end_ms") or 0)))
    cues.pop(right_order - 1)
    for new_order, cue in enumerate(cues, start=1):
        cue["order"] = new_order

    sidecar = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8")) if EXTERNAL_AI_ONE_PASS_FILE.is_file() else None
    if sidecar is not None:
        def mapped(value: int) -> int:
            if value == right_order:
                return left_order
            return value - 1 if value > right_order else value
        for card in ((sidecar.get("anki") or {}).get("items") or []):
            card["cue_order"] = mapped(int(card.get("cue_order") or 0))
        combined: dict[int, list[dict[str, Any]]] = {}
        for row in ((sidecar.get("connected_speech") or {}).get("cues") or []):
            combined.setdefault(mapped(int(row.get("cue_order") or 0)), []).extend(row.get("phenomena") or [])
        sidecar.setdefault("connected_speech", {})["cues"] = [{"cue_order": key, "phenomena": value} for key, value in sorted(combined.items()) if key > 0]
        for item in (sidecar.get("wbw_practices") or []):
            item["cue_order"] = mapped(int(item.get("cue_order") or 0))

    accepted_before = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    accepted = sorted((value - 1 if value > right_order else value) for value in accepted_before if value not in (left_order, right_order))
    _write_review_documents(reviewed, sidecar)
    _sync_word_review_after_cue_change(reviewed, {new: (new if new < right_order else new + 1) for new in range(1, len(cues) + 1)}, {left_order, right_order}, left_order)
    _reset_after_cue_structure_change(cues, accepted, left_order)
    return {"ok": True, "merged_order": left_order, "review": _cue_review_payload()}


@app.post("/api/cue-review/split")
def cue_review_split(request: CueReviewSplitRequest):
    try:
        _source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    order, split_ms = int(request.order), int(request.split_ms)
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    cue = cues[order - 1]
    start_ms, end_ms = int(cue.get("speech_start_ms") or 0), int(cue.get("speech_end_ms") or 0)
    if not start_ms < split_ms < end_ms:
        raise HTTPException(status_code=422, detail="O playhead precisa estar dentro da cue selecionada.")
    original_pt = str(cue.get("pt") or "")
    words = sorted([copy.deepcopy(word) for word in (cue.get("words") or []) if isinstance(word, dict)], key=lambda word: (int(word.get("start_ms") or 0), int(word.get("end_ms") or 0)))
    boundary = max(start_ms + 1, min(end_ms - 1, split_ms))
    if len(words) >= 2:
        split_index = _fine_split_word_index(words, boundary)
        left_words, right_words = words[:split_index], words[split_index:]
    else:
        # A temporal split must also work before WbW exists. Text is divided
        # provisionally by the marker ratio and remains editable by the user.
        left_words, right_words = [], []
    left_groups = {str(word.get("pt_group")) for word in left_words if word.get("pt_group")}
    right_groups = {str(word.get("pt_group")) for word in right_words if word.get("pt_group")}
    for word in words:
        if str(word.get("pt_group") or "") in left_groups & right_groups:
            recovered_pt = str(word.get("pt") or word.get("pt_group_original_pt") or "")
            for field in ("pt_group", "pt_group_role", "pt_group_original_pt"):
                word.pop(field, None)
            word["pt"] = recovered_pt
    left, right = cue, copy.deepcopy(cue)
    left["speech_end_ms"] = left["subtitle_end_ms"] = boundary
    right["speech_start_ms"] = right["subtitle_start_ms"] = boundary
    left["words"], right["words"] = left_words, right_words
    if len(words) >= 2:
        for target, target_words in ((left, left_words), (right, right_words)):
            target["original_en"] = target["approved_en"] = " ".join(str(word.get("text") or "").strip() for word in target_words if str(word.get("text") or "").strip())
            translated = " ".join(str(word.get("pt") or word.get("pt_group_original_pt") or "").strip() for word in target_words if str(word.get("pt") or word.get("pt_group_original_pt") or "").strip())
            target["pt"] = translated or original_pt
    else:
        ratio = (boundary - start_ms) / max(1, end_ms - start_ms)
        for field in ("original_en", "approved_en", "pt"):
            tokens = str(cue.get(field) or "").split()
            pivot = max(1, min(len(tokens) - 1, round(len(tokens) * ratio))) if len(tokens) > 1 else len(tokens)
            left[field] = " ".join(tokens[:pivot])
            right[field] = " ".join(tokens[pivot:])
    cues.insert(order, right)
    for new_order, item in enumerate(cues, start=1):
        item["order"] = new_order

    sidecar = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8")) if EXTERNAL_AI_ONE_PASS_FILE.is_file() else None
    if sidecar is not None:
        for card in ((sidecar.get("anki") or {}).get("items") or []):
            old = int(card.get("cue_order") or 0)
            card["cue_order"] = old + 1 if old > order else old
        cs_out = []
        for row in ((sidecar.get("connected_speech") or {}).get("cues") or []):
            old = int(row.get("cue_order") or 0)
            if old != order:
                row["cue_order"] = old + 1 if old > order else old
                cs_out.append(row)
                continue
            phenomena = row.get("phenomena") or []
            cs_out.append({"cue_order": order, "phenomena": [item for item in phenomena if int(item.get("start_ms") or 0) < boundary]})
            cs_out.append({"cue_order": order + 1, "phenomena": [item for item in phenomena if int(item.get("start_ms") or 0) >= boundary]})
        sidecar.setdefault("connected_speech", {})["cues"] = cs_out
        for item in (sidecar.get("wbw_practices") or []):
            old = int(item.get("cue_order") or 0)
            item["cue_order"] = order + 1 if old == order and int(item.get("start_ms") or 0) >= boundary else (old + 1 if old > order else old)

    accepted_before = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    accepted = sorted(value + 1 if value > order else value for value in accepted_before if value != order)
    _write_review_documents(reviewed, sidecar)
    _sync_word_review_after_cue_change(reviewed, {new: (new if new < order else new - 1) for new in range(1, len(cues) + 1) if new not in (order, order + 1)}, {order}, order)
    _reset_after_cue_structure_change(cues, accepted, order)
    return {"ok": True, "split_order": order, "new_order": order + 1, "review": _cue_review_payload()}


@app.post("/api/cue-review/create")
def cue_review_create(request: CueReviewCreateRequest):
    try:
        _source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    after_order = max(0, min(len(cues), int(request.after_order)))
    start_ms, end_ms = int(request.start_ms), int(request.end_ms)
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    if not (0 <= start_ms < end_ms <= duration_ms):
        raise HTTPException(status_code=422, detail=f"A nova cue deve ficar dentro do vídeo (0..{duration_ms} ms).")
    insertion_order = after_order + 1
    cues.insert(after_order, {"order": insertion_order, "speech_start_ms": start_ms, "speech_end_ms": end_ms, "subtitle_start_ms": start_ms, "subtitle_end_ms": end_ms, "speaker": "", "original_en": "", "approved_en": "", "pt": "", "words": []})
    for order, cue in enumerate(cues, start=1):
        cue["order"] = order
    _sync_review_video_window(reviewed)
    CUE_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if EXTERNAL_AI_ONE_PASS_FILE.is_file():
        sidecar = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
        _shift_one_pass_orders(sidecar, insertion_order)
        EXTERNAL_AI_ONE_PASS_FILE.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _sync_word_review_after_cue_change(reviewed, {new: (new if new < insertion_order else new - 1) for new in range(1, len(cues) + 1) if new != insertion_order}, set(), insertion_order)
    accepted = sorted(value + 1 if value >= insertion_order else value for value in {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)})
    for directory in (WORD_REVIEW_DIR, CUE_TIMING_DIR, WORD_TIMING_DIR, SHADOWING_DIR, CONNECTED_SPEECH_DIR, MATERIALS_EXTERNAL_DIR, MATERIALS_REVIEW_DIR, MATERIALS_FINAL_DIR):
        shutil.rmtree(directory, ignore_errors=True)
    def create_state(s: dict[str, Any]) -> None:
        s["cue_review"].update({"status": "reviewing", "total": len(cues), "accepted_orders": accepted, "current_order": insertion_order, "completed": False, "updated_at": _now_iso()})
        for key in ("word_review", "cue_timing", "word_timing", "shadowing", "connected_speech", "materials_external", "materials_review", "materials_final"):
            s[key] = _default_state()[key]
    _update_state(create_state)
    return {"ok": True, "created_order": insertion_order, "review": _cue_review_payload()}


@app.post("/api/cue-review/video-window")
def cue_review_video_window(request: CueReviewWindowRequest):
    try:
        _source, reviewed, _review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    project = reviewed.setdefault("project", {})
    old_local_start = int(project.get("scene_start_ms") or 0)
    old_local_end = int(project.get("scene_end_ms") or _probe_duration_ms(PROCESS_VIDEO_FILE))
    local_start = old_local_start if request.start_ms is None else int(request.start_ms)
    local_end = old_local_end if request.end_ms is None else int(request.end_ms)
    media_duration = _probe_duration_ms(PROCESS_VIDEO_FILE)
    if not (0 <= local_start < local_end <= media_duration):
        raise HTTPException(status_code=422, detail=f"A janela deve ficar dentro do vídeo (0..{media_duration} ms).")
    source_origin = int(project.get("source_video_start_ms") or 0) - old_local_start
    project["scene_start_ms"] = local_start
    project["scene_end_ms"] = local_end
    project["scene_duration_ms"] = local_end - local_start
    project["source_video_start_ms"] = source_origin + local_start
    project["source_video_end_ms"] = source_origin + local_end
    CUE_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "message": "Janela do YouTube atualizada no JSON; cues e words não foram alteradas.", "review": _cue_review_payload()}


@app.post("/api/cue-review/delete")
def cue_review_delete(request: CueReviewInvalidateRequest):
    try:
        _source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    order = int(request.order)
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    if len(cues) <= 1:
        raise HTTPException(status_code=422, detail="Não é possível excluir a única cue restante.")

    deleted = cues.pop(order - 1)
    for new_order, cue in enumerate(cues, start=1):
        cue["order"] = new_order

    sidecar: dict[str, Any] = {}
    if EXTERNAL_AI_ONE_PASS_FILE.is_file():
        sidecar = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
        cards = ((sidecar.get("anki") or {}).get("items") or [])
        adjusted_cards = []
        for card in cards:
            cue_order = int(card.get("cue_order") or 0)
            if cue_order == order:
                continue
            card["cue_order"] = cue_order - 1 if cue_order > order else cue_order
            adjusted_cards.append(card)
        sidecar.setdefault("anki", {})["items"] = adjusted_cards
        cs_rows = ((sidecar.get("connected_speech") or {}).get("cues") or [])
        adjusted_cs = []
        for row in cs_rows:
            cue_order = int(row.get("cue_order") or 0)
            if cue_order == order:
                continue
            row["cue_order"] = cue_order - 1 if cue_order > order else cue_order
            adjusted_cs.append(row)
        sidecar.setdefault("connected_speech", {})["cues"] = adjusted_cs
        practices = []
        for item in (sidecar.get("wbw_practices") or []):
            cue_order = int(item.get("cue_order") or 0)
            if cue_order == order:
                continue
            item["cue_order"] = cue_order - 1 if cue_order > order else cue_order
            practices.append(item)
        sidecar["wbw_practices"] = practices

    trim_ms = int(cues[0].get("speech_start_ms") or 0) if order == 1 else 0
    _sync_review_video_window(reviewed)
    CUE_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if sidecar:
        EXTERNAL_AI_ONE_PASS_FILE.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _sync_word_review_after_cue_change(reviewed, {new: (new if new < order else new + 1) for new in range(1, len(cues) + 1)}, set(), min(order, len(cues)))

    accepted_before = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    accepted = sorted(value - 1 if value > order else value for value in accepted_before if value != order)
    total = len(cues)
    current_order = min(order, total)
    completed = len(accepted) == total
    def delete_state(s: dict[str, Any]) -> None:
        s["cue_review"].update({
            "status": "completed" if completed else "reviewing",
            "total": total,
            "accepted_orders": accepted,
            "current_order": current_order,
            "completed": completed,
            "updated_at": _now_iso(),
        })
    _update_state(delete_state)
    return {
        "ok": True,
        "message": (f"Cue excluída. A reprodução agora começa em {trim_ms} ms; nenhum timing foi alterado." if trim_ms > 0 else "Cue excluída. Os timings das cues restantes foram preservados."),
        "deleted_order": order,
        "deleted_text": str(deleted.get("approved_en") or deleted.get("original_en") or ""),
        "trimmed_start_ms": trim_ms,
        "review": _cue_review_payload(),
    }


@app.post("/api/cue-review/save")
def cue_review_save(request: CueReviewSaveRequest):
    try:
        source, reviewed, review = _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    total = len(reviewed["cues"])
    order = int(request.order)
    if order < 1 or order > total:
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    approved_en = request.approved_en.strip()
    pt = request.pt.strip()
    if not approved_en:
        raise HTTPException(status_code=422, detail="A caixa EN não pode ficar vazia.")
    if not pt:
        raise HTTPException(status_code=422, detail="A tradução PT não pode ficar vazia.")

    reviewed_cue = reviewed["cues"][order - 1]
    old_start = int(reviewed_cue.get("speech_start_ms") or 0)
    old_end = int(reviewed_cue.get("speech_end_ms") or max(old_start + 1, 1))
    start_ms = old_start if request.start_ms is None else int(request.start_ms)
    end_ms = old_end if request.end_ms is None else int(request.end_ms)
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    if not (0 <= start_ms < end_ms <= duration_ms):
        raise HTTPException(status_code=422, detail=f"IN/OUT deve ficar dentro do vídeo (0..{duration_ms} ms).")
    timing_changed = start_ms != old_start or end_ms != old_end
    if timing_changed:
        _retime_review_cue(reviewed_cue, start_ms, end_ms)
        _sync_review_video_window(reviewed)
    english_changed = str(reviewed_cue.get("approved_en") or "") != approved_en
    pt_changed = str(reviewed_cue.get("pt") or "") != pt
    text_changed = english_changed or pt_changed
    word_sync = None
    if english_changed:
        try:
            word_sync = _sync_cue_words_to_approved_text(reviewed_cue, approved_en)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Não foi possível sincronizar o WbW com a cue revisada: {exc}") from exc
    reviewed_cue["approved_en"] = approved_en
    reviewed_cue["pt"] = pt
    CUE_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    CUE_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if text_changed or timing_changed:
        _sync_word_review_after_cue_change(reviewed, {value: value for value in range(1, total + 1)}, {order}, order)

    accepted = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    accepted.add(order)
    pending_orders = [i for i in range(1, total + 1) if i not in accepted]
    if pending_orders:
        after = [i for i in pending_orders if i > order]
        next_order = after[0] if after else pending_orders[0]
    else:
        next_order = order
    completed = not pending_orders
    def save_state(s: dict[str, Any]) -> None:
        s["cue_review"].update({
            "status": "completed" if completed else "reviewing",
            "source_snapshot_id": str(source.get("snapshot_id") or ""),
            "total": total,
            "accepted_orders": sorted(accepted),
            "current_order": next_order,
            "completed": completed,
            "updated_at": _now_iso(),
        })
    state = _update_state(save_state)
    return {
        "ok": True,
        "message": "Cue validada.",
        "saved_order": order,
        "next_order": next_order,
        "completed": completed,
        "accepted": len(accepted),
        "pending": total - len(accepted),
        "word_sync": word_sync,
        "review": state["cue_review"],
    }


@app.get("/api/cue-review/canonical")
def cue_review_canonical():
    try:
        _ensure_cue_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not CUE_REVIEW_CANONICAL_FILE.is_file():
        raise HTTPException(status_code=404, detail="JSON revisado ainda não foi criado.")
    return FileResponse(CUE_REVIEW_CANONICAL_FILE, media_type="application/json", filename="canonical_scene_reviewed.json")
@app.get("/api/word-review/state")
def word_review_state():
    state = _read_state()
    if not _word_review_page_ready(state):
        raise HTTPException(status_code=409, detail="Conclua a revisão de todas as cues antes de revisar o Word by Word.")
    try:
        return {"ok": True, "review": _word_review_payload()}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/word-review/cue/{order}")
def word_review_cue(order: int):
    try:
        reviewed, review = _ensure_word_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    words = cues[order - 1].get("words") or []
    if not words:
        raise HTTPException(status_code=404, detail="Esta cue não contém words.")
    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}
    pending = [i for i in range(len(words)) if _word_key(order, i) not in accepted]
    index = pending[0] if pending else 0
    def remember(s: dict[str, Any]) -> None:
        s["word_review"]["current_cue_order"] = order
        s["word_review"]["current_word_index"] = index
        s["word_review"]["updated_at"] = _now_iso()
    _update_state(remember)
    return {"ok": True, "review": _word_review_payload()}


@app.get("/api/word-review/word/{cue_order}/{word_index}")
def word_review_word(cue_order: int, word_index: int):
    try:
        reviewed, _review = _ensure_word_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    words = cues[cue_order - 1].get("words") or []
    if word_index < 0 or word_index >= len(words):
        raise HTTPException(status_code=404, detail="Word não encontrada.")
    def remember(s: dict[str, Any]) -> None:
        s["word_review"]["current_cue_order"] = cue_order
        s["word_review"]["current_word_index"] = word_index
        s["word_review"]["updated_at"] = _now_iso()
    _update_state(remember)
    return {"ok": True, "review": _word_review_payload()}


@app.post("/api/word-review/save")
def word_review_save(request: WordReviewSaveRequest):
    try:
        reviewed, review = _ensure_word_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    cue_order = int(request.cue_order)
    word_index = int(request.word_index)
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    cue = cues[cue_order - 1]
    words = cue.get("words") or []
    if word_index < 0 or word_index >= len(words):
        raise HTTPException(status_code=404, detail="Word não encontrada.")
    text = request.text.strip()
    pt = request.pt.strip()
    if not text:
        raise HTTPException(status_code=422, detail="A word em inglês não pode ficar vazia.")
    if not pt:
        raise HTTPException(status_code=422, detail="A tradução PT não pode ficar vazia.")

    word = words[word_index]
    word["text"] = text
    word["review_status"] = "approved"
    group_id = str(word.get("pt_group") or "").strip()
    group_member_indices: list[int] = []
    group_translation_changed = False
    if group_id:
        lead_index = _find_group_lead_index(cue, group_id)
        previous_group_pt = str(words[lead_index].get("pt") or "")
        group_translation_changed = previous_group_pt != pt
        group_member_indices = [i for i, member in enumerate(words) if str(member.get("pt_group") or "") == group_id]
        words[lead_index]["pt"] = pt
        for i in group_member_indices:
            if i != lead_index:
                words[i]["pt"] = None
    else:
        word["pt"] = pt

    WORD_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    WORD_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(CUE_TIMING_DIR, ignore_errors=True)
    shutil.rmtree(WORD_TIMING_DIR, ignore_errors=True)

    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}
    current_key = _word_key(cue_order, word_index)
    if group_translation_changed:
        # A tradução pertence à unidade inteira. Se ela mudar, words do mesmo
        # grupo já aprovadas precisam ser revistas novamente para que 100% da
        # validação continue verdadeira.
        for index in group_member_indices:
            accepted.discard(_word_key(cue_order, index))
    accepted.add(current_key)
    positions = _word_positions(reviewed)
    pending_positions = [pos for pos in positions if _word_key(*pos) not in accepted]
    if pending_positions:
        current_pos_index = positions.index((cue_order, word_index))
        after = [pos for pos in positions[current_pos_index + 1:] if _word_key(*pos) not in accepted]
        next_cue, next_index = after[0] if after else pending_positions[0]
    else:
        next_cue, next_index = cue_order, word_index
    completed = not pending_positions

    def save_state(s: dict[str, Any]) -> None:
        s["cue_timing"] = _default_state()["cue_timing"]
        s["word_timing"] = _default_state()["word_timing"]
        s["word_review"].update({
            "status": "completed" if completed else "reviewing",
            "source_snapshot_id": str(reviewed.get("snapshot_id") or ""),
            "total_words": len(positions),
            "accepted_keys": sorted(accepted, key=lambda value: tuple(int(part) for part in value.split(":"))),
            "current_cue_order": next_cue,
            "current_word_index": next_index,
            "completed": completed,
            "updated_at": _now_iso(),
        })
    state = _update_state(save_state)
    return {
        "ok": True,
        "message": "Word validada.",
        "saved": {"cue_order": cue_order, "word_index": word_index},
        "next": {"cue_order": next_cue, "word_index": next_index},
        "completed": completed,
        "accepted_words": len(accepted),
        "pending_words": len(positions) - len(accepted),
        "review": state["word_review"],
    }


@app.post("/api/word-review/group")
def word_review_group(request: WordReviewGroupRequest):
    try:
        reviewed, review = _ensure_word_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    cue_order = int(request.cue_order)
    word_index = int(request.word_index)
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    cue = cues[cue_order - 1]
    words = cue.get("words") or []
    if word_index < 0 or word_index >= len(words):
        raise HTTPException(status_code=404, detail="Word não encontrada.")

    current_members = _word_semantic_members(cue, word_index)
    neighbor_index = min(current_members) - 1 if request.direction == "previous" else max(current_members) + 1
    if neighbor_index < 0 or neighbor_index >= len(words):
        raise HTTPException(status_code=422, detail="Não existe unidade adjacente para agrupar.")
    neighbor_members = _word_semantic_members(cue, neighbor_index)
    members = sorted(set(current_members + neighbor_members))
    if members != list(range(min(members), max(members) + 1)):
        raise HTTPException(status_code=422, detail="Somente unidades WbW contíguas podem ser agrupadas.")

    unit_starts = sorted({min(current_members), min(neighbor_members)})
    translations: list[str] = []
    for start in unit_starts:
        value, _group = _resolved_word_pt(cue, start)
        if value.strip():
            translations.append(value.strip())
    grouped_pt = " ".join(translations).strip()
    group_id = f"human_c{cue_order}_{members[0]+1}_{members[-1]+1}_{uuid.uuid4().hex[:8]}"
    lead_index = members[0]
    original_pt_by_index: dict[int, str] = {}
    for index in members:
        word = words[index]
        stored_original = str(word.get("pt_group_original_pt") or "").strip()
        if stored_original:
            original_pt_by_index[index] = stored_original
        elif not str(word.get("pt_group") or "").strip():
            original_pt_by_index[index] = str(word.get("pt") or "").strip()
        else:
            original_pt_by_index[index] = ""
    for index in members:
        word = words[index]
        if original_pt_by_index[index]:
            word["pt_group_original_pt"] = original_pt_by_index[index]
        word["pt_group"] = group_id
        word["pt_group_role"] = "lead" if index == lead_index else "member"
        word["pt"] = grouped_pt if index == lead_index else None

    WORD_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _reset_word_review_dependents()
    accepted, _ = _invalidate_word_review_members(review, cue_order, members)
    def save_state(s: dict[str, Any]) -> None:
        s["cue_timing"] = _default_state()["cue_timing"]
        s["word_timing"] = _default_state()["word_timing"]
        s["word_review"].update({
            "status": "reviewing",
            "accepted_keys": sorted(accepted, key=lambda value: tuple(int(part) for part in value.split(":"))),
            "current_cue_order": cue_order,
            "current_word_index": lead_index,
            "completed": False,
            "updated_at": _now_iso(),
        })
    _update_state(save_state)
    return {"ok": True, "message": "Unidades agrupadas.", "review": _word_review_payload()}


@app.post("/api/word-review/ungroup")
def word_review_ungroup(request: WordReviewUngroupRequest):
    try:
        reviewed, review = _ensure_word_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = reviewed.get("cues") or []
    cue_order = int(request.cue_order)
    word_index = int(request.word_index)
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    cue = cues[cue_order - 1]
    words = cue.get("words") or []
    if word_index < 0 or word_index >= len(words):
        raise HTTPException(status_code=404, detail="Word não encontrada.")
    members = _word_semantic_members(cue, word_index)
    if len(members) < 2:
        raise HTTPException(status_code=422, detail="A word atual não pertence a um grupo WbW.")
    group_id = str(words[members[0]].get("pt_group") or "").strip()
    lead_index = _find_group_lead_index(cue, group_id)
    grouped_pt = str(words[lead_index].get("pt") or "").strip()
    for index in members:
        word = words[index]
        individual_pt = str(word.get("pt_group_original_pt") or "").strip()
        if not individual_pt and index == lead_index:
            individual_pt = grouped_pt
        word["pt"] = individual_pt
        word.pop("pt_group", None)
        word.pop("pt_group_role", None)
        word.pop("pt_group_original_pt", None)

    WORD_REVIEW_CANONICAL_FILE.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _reset_word_review_dependents()
    accepted, _ = _invalidate_word_review_members(review, cue_order, members)
    def save_state(s: dict[str, Any]) -> None:
        s["cue_timing"] = _default_state()["cue_timing"]
        s["word_timing"] = _default_state()["word_timing"]
        s["word_review"].update({
            "status": "reviewing",
            "accepted_keys": sorted(accepted, key=lambda value: tuple(int(part) for part in value.split(":"))),
            "current_cue_order": cue_order,
            "current_word_index": members[0],
            "completed": False,
            "updated_at": _now_iso(),
        })
    _update_state(save_state)
    return {"ok": True, "message": "Grupo desfeito. Revise as traduções individuais.", "review": _word_review_payload()}


@app.get("/api/word-review/canonical")
def word_review_canonical():
    try:
        _ensure_word_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not WORD_REVIEW_CANONICAL_FILE.is_file():
        raise HTTPException(status_code=404, detail="JSON Word by Word revisado ainda não foi criado.")
    return FileResponse(WORD_REVIEW_CANONICAL_FILE, media_type="application/json", filename="canonical_scene_words_reviewed.json")

@app.get("/api/cue-timing/state")
def cue_timing_state():
    try:
        return {"ok": True, "review": _cue_timing_payload(include_waveform=True)}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/cue-timing/cue/{order}")
def cue_timing_cue(order: int):
    try:
        document, _review, _duration = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    def remember(s: dict[str, Any]) -> None:
        s["cue_timing"]["current_order"] = order
        s["cue_timing"]["updated_at"] = _now_iso()
    _update_state(remember)
    return {"ok": True, "review": _cue_timing_payload(include_waveform=False)}


@app.post("/api/cue-timing/delete")
def cue_timing_delete(request: CueReviewInvalidateRequest):
    try:
        document, review, _duration_ms = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    order = int(request.order)
    cues = document.get("cues") or []
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    if len(cues) <= 1:
        raise HTTPException(status_code=422, detail="Não é possível excluir a única cue restante.")

    deleted = cues.pop(order - 1)
    deleted_word_count = len(deleted.get("words") or [])
    for new_order, cue in enumerate(cues, start=1):
        cue["order"] = new_order
    CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for path in (WORD_REVIEW_CANONICAL_FILE, CUE_REVIEW_CANONICAL_FILE):
        if not path.is_file():
            continue
        upstream = json.loads(path.read_text(encoding="utf-8"))
        upstream_cues = upstream.get("cues") or []
        if 1 <= order <= len(upstream_cues):
            upstream_cues.pop(order - 1)
            for new_order, cue in enumerate(upstream_cues, start=1):
                cue["order"] = new_order
            path.write_text(json.dumps(upstream, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if EXTERNAL_AI_ONE_PASS_FILE.is_file():
        sidecar = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
        for container, key in (((sidecar.get("anki") or {}), "items"), ((sidecar.get("connected_speech") or {}), "cues")):
            adjusted = []
            for item in container.get(key) or []:
                cue_order = int(item.get("cue_order") or 0)
                if cue_order == order:
                    continue
                item["cue_order"] = cue_order - 1 if cue_order > order else cue_order
                adjusted.append(item)
            container[key] = adjusted
        EXTERNAL_AI_ONE_PASS_FILE.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    cue_accepted_before = {int(v) for v in ((_read_state().get("cue_review") or {}).get("accepted_orders") or []) if isinstance(v, int)}
    cue_accepted = sorted(value - 1 if value > order else value for value in cue_accepted_before if value != order)
    word_accepted = []
    for value in ((_read_state().get("word_review") or {}).get("accepted_keys") or []):
        try:
            cue_order, word_index = (int(part) for part in str(value).split(":", 1))
        except Exception:
            continue
        if cue_order == order:
            continue
        word_accepted.append(_word_key(cue_order - 1 if cue_order > order else cue_order, word_index))
    timing_accepted_before = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    timing_accepted = sorted(value - 1 if value > order else value for value in timing_accepted_before if value != order)
    total = len(cues)
    current_order = min(order, total)
    word_document = json.loads(WORD_REVIEW_CANONICAL_FILE.read_text(encoding="utf-8"))
    total_words = len(_word_positions(word_document))
    source_revision = hashlib.sha256(WORD_REVIEW_CANONICAL_FILE.read_bytes()).hexdigest()
    for directory in (WORD_TIMING_DIR, SHADOWING_DIR, CONNECTED_SPEECH_DIR, MATERIALS_EXTERNAL_DIR, MATERIALS_REVIEW_DIR, MATERIALS_FINAL_DIR):
        shutil.rmtree(directory, ignore_errors=True)

    def delete_state(s: dict[str, Any]) -> None:
        s["cue_review"].update({"total": total, "accepted_orders": cue_accepted, "current_order": min(int((s["cue_review"].get("current_order") or 1)), total), "completed": len(cue_accepted) == total, "status": "completed" if len(cue_accepted) == total else "reviewing", "updated_at": _now_iso()})
        s["word_review"].update({"total_words": total_words, "accepted_keys": sorted(set(word_accepted)), "current_cue_order": current_order, "current_word_index": 0, "completed": len(set(word_accepted)) == total_words, "status": "completed" if len(set(word_accepted)) == total_words else "reviewing", "updated_at": _now_iso()})
        s["cue_timing"].update({"source_revision": source_revision, "total": total, "accepted_orders": timing_accepted, "current_order": current_order, "completed": len(timing_accepted) == total, "status": "completed" if len(timing_accepted) == total else "reviewing", "updated_at": _now_iso()})
        for key in ("word_timing", "shadowing", "connected_speech", "materials_external", "materials_review", "materials_final"):
            s[key] = _default_state()[key]
    _update_state(delete_state)
    return {
        "ok": True,
        "message": "Cue e Word by Word associados removidos. Timings das demais cues preservados.",
        "deleted_order": order,
        "deleted_words": deleted_word_count,
        "review": _cue_timing_payload(include_waveform=False),
    }


@app.post("/api/cue-timing/realign")
def cue_timing_realign():
    try:
        document, review, duration_ms = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    accepted = sorted({int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int) and 1 <= int(v) <= len(cues)})
    if not accepted:
        raise HTTPException(status_code=422, detail="Salve pelo menos uma cue para usá-la como âncora do realinhamento.")
    anchor_order = accepted[-1]
    if anchor_order >= len(cues):
        raise HTTPException(status_code=422, detail="Não existem cues posteriores à última cue salva.")

    aligned = json.loads(json.dumps(document))
    aligned_cues = aligned.get("cues") or []
    cursor = int(aligned_cues[anchor_order - 1].get("speech_end_ms") or 0) + 100
    shifts: dict[int, int] = {}
    for index in range(anchor_order, len(aligned_cues)):
        cue = aligned_cues[index]
        old_start = int(cue.get("speech_start_ms") or 0)
        old_end = int(cue.get("speech_end_ms") or 0)
        shift = cursor - old_start
        shifts[index + 1] = shift
        for field in ("speech_start_ms", "speech_end_ms", "subtitle_start_ms", "subtitle_end_ms"):
            cue[field] = int(cue.get(field) or 0) + shift
        for word in cue.get("words") or []:
            for field in ("start_ms", "end_ms", "original_start_ms", "original_end_ms"):
                if field in word:
                    word[field] = int(word.get(field) or 0) + shift
        cursor = int(cue.get("speech_end_ms") or 0) + 100
    final_edge = max(max(int(cue.get("speech_end_ms") or 0), int(cue.get("subtitle_end_ms") or 0)) for cue in aligned_cues)
    if final_edge > duration_ms:
        raise HTTPException(status_code=422, detail=f"O realinhamento ultrapassaria o fim do vídeo em {final_edge - duration_ms} ms. Nenhuma cue foi alterada.")

    CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(aligned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if EXTERNAL_AI_ONE_PASS_FILE.is_file():
        sidecar = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
        for row in ((sidecar.get("connected_speech") or {}).get("cues") or []):
            shift = shifts.get(int(row.get("cue_order") or 0), 0)
            if shift:
                for phenomenon in row.get("phenomena") or []:
                    phenomenon["start_ms"] = int(phenomenon.get("start_ms") or 0) + shift
                    phenomenon["end_ms"] = int(phenomenon.get("end_ms") or 0) + shift
        EXTERNAL_AI_ONE_PASS_FILE.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for directory in (WORD_TIMING_DIR, SHADOWING_DIR, CONNECTED_SPEECH_DIR, MATERIALS_EXTERNAL_DIR, MATERIALS_REVIEW_DIR, MATERIALS_FINAL_DIR):
        shutil.rmtree(directory, ignore_errors=True)
    first_moved = anchor_order + 1
    def realign_state(s: dict[str, Any]) -> None:
        s["cue_timing"].update({"current_order": first_moved, "completed": False, "status": "reviewing", "updated_at": _now_iso()})
        for key in ("word_timing", "shadowing", "connected_speech", "materials_external", "materials_review", "materials_final"):
            s[key] = _default_state()[key]
    _update_state(realign_state)
    return {"ok": True, "message": f"{len(shifts)} cues realinhadas com intervalo de 100 milissegundos.", "anchor_order": anchor_order, "moved": len(shifts), "review": _cue_timing_payload(include_waveform=False)}


@app.post("/api/cue-timing/save")
def cue_timing_save(request: CueTimingSaveRequest):
    try:
        document, review, duration_ms = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    order = int(request.order)
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    start_ms = int(request.start_ms)
    end_ms = int(request.end_ms)
    if start_ms < 0 or end_ms <= start_ms or end_ms > duration_ms:
        raise HTTPException(status_code=422, detail="IN/OUT inválido para a duração da cena.")
    options = _normalize_speaker_options(list(review.get("speaker_options") or []))
    allowed = {name.casefold(): name for name in options}
    speaker = str(request.speaker or "").strip()
    if speaker:
        canonical = allowed.get(speaker.casefold())
        if canonical is None:
            raise HTTPException(status_code=422, detail=f"Speaker não cadastrado: {speaker}.")
        speaker = canonical

    cue = cues[order - 1]
    old_speech_start = int(cue.get("speech_start_ms") or 0)
    old_speech_end = int(cue.get("speech_end_ms") or 0)
    old_subtitle_start = int(cue.get("subtitle_start_ms") or 0)
    old_subtitle_end = int(cue.get("subtitle_end_ms") or 0)
    cue["speech_start_ms"] = start_ms
    cue["speech_end_ms"] = end_ms
    cue["speaker"] = speaker
    # Keep display timing linked only when it was already linked to speech timing.
    if old_subtitle_start == old_speech_start:
        cue["subtitle_start_ms"] = start_ms
    if old_subtitle_end == old_speech_end:
        cue["subtitle_end_ms"] = end_ms
    CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    accepted = {int(v) for v in (review.get("accepted_orders") or []) if isinstance(v, int)}
    accepted.add(order)
    pending = [value for value in range(1, len(cues) + 1) if value not in accepted]
    if pending:
        after = [value for value in pending if value > order]
        next_order = after[0] if after else pending[0]
    else:
        next_order = order
    completed = not pending
    def save_state(s: dict[str, Any]) -> None:
        s["word_timing"] = _default_state()["word_timing"]
        s["cue_timing"].update({
            "status": "completed" if completed else "reviewing",
            "accepted_orders": sorted(accepted),
            "current_order": next_order,
            "completed": completed,
            "updated_at": _now_iso(),
        })
    _update_state(save_state)
    return {
        "ok": True,
        "saved_order": order,
        "next_order": next_order,
        "completed": completed,
        "review": _cue_timing_payload(include_waveform=False),
    }


@app.post("/api/cue-timing/speakers/add")
def cue_timing_speaker_add(request: SpeakerNameRequest):
    try:
        _document, review, _duration = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    name = str(request.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Informe o nome do speaker.")
    if len(name) > 80:
        raise HTTPException(status_code=422, detail="O nome do speaker deve ter no máximo 80 caracteres.")
    options = _normalize_speaker_options(list(review.get("speaker_options") or []))
    if any(item.casefold() == name.casefold() for item in options):
        raise HTTPException(status_code=422, detail="Speaker já cadastrado.")
    options.append(name)
    def save_state(s: dict[str, Any]) -> None:
        s["cue_timing"]["speaker_options"] = _normalize_speaker_options(options)
        s["cue_timing"]["updated_at"] = _now_iso()
    _update_state(save_state)
    return {"ok": True, "review": _cue_timing_payload(include_waveform=False)}


@app.post("/api/cue-timing/speakers/rename")
def cue_timing_speaker_rename(request: SpeakerRenameRequest):
    try:
        document, review, _duration = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    current_name = str(request.current_name or "").strip()
    new_name = str(request.new_name or "").strip()
    if not current_name or not new_name:
        raise HTTPException(status_code=422, detail="Nome atual e novo nome são obrigatórios.")
    if len(new_name) > 80:
        raise HTTPException(status_code=422, detail="O nome do speaker deve ter no máximo 80 caracteres.")
    options = _normalize_speaker_options(list(review.get("speaker_options") or []))
    old_key, new_key = current_name.casefold(), new_name.casefold()
    if not any(item.casefold() == old_key for item in options):
        raise HTTPException(status_code=404, detail="Speaker não encontrado.")
    if any(item.casefold() == new_key and item.casefold() != old_key for item in options):
        raise HTTPException(status_code=422, detail="Já existe um speaker com esse nome.")
    options = [new_name if item.casefold() == old_key else item for item in options]
    for cue in document.get("cues") or []:
        if str(cue.get("speaker") or "").strip().casefold() == old_key:
            cue["speaker"] = new_name
    CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def save_state(s: dict[str, Any]) -> None:
        s["word_timing"] = _default_state()["word_timing"]
        s["cue_timing"]["speaker_options"] = _normalize_speaker_options(options)
        s["cue_timing"]["updated_at"] = _now_iso()
    _update_state(save_state)
    return {"ok": True, "review": _cue_timing_payload(include_waveform=False)}


@app.post("/api/cue-timing/speakers/delete")
def cue_timing_speaker_delete(request: SpeakerNameRequest):
    try:
        document, review, _duration = _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    name = str(request.name or "").strip()
    key = name.casefold()
    options = _normalize_speaker_options(list(review.get("speaker_options") or []))
    if not key or not any(item.casefold() == key for item in options):
        raise HTTPException(status_code=404, detail="Speaker não encontrado.")
    options = [item for item in options if item.casefold() != key]
    for cue in document.get("cues") or []:
        if str(cue.get("speaker") or "").strip().casefold() == key:
            cue["speaker"] = ""
    CUE_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def save_state(s: dict[str, Any]) -> None:
        s["word_timing"] = _default_state()["word_timing"]
        s["cue_timing"]["speaker_options"] = _normalize_speaker_options(options)
        s["cue_timing"]["updated_at"] = _now_iso()
    _update_state(save_state)
    return {"ok": True, "review": _cue_timing_payload(include_waveform=False)}



@app.get("/api/word-timing/state")
def word_timing_state():
    try:
        return {"ok": True, "review": _word_timing_payload(include_waveform=True)}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/word-timing/cue/{order}")
def word_timing_cue(order: int):
    try:
        document, review, _duration = _ensure_word_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    if order < 1 or order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    units = _word_timing_units_for_cue(cues[order - 1])
    if not units:
        raise HTTPException(status_code=404, detail="Esta cue não contém unidades WbW.")
    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}
    pending = [int(unit["unit_index"]) for unit in units if _word_timing_key(order, int(unit["unit_index"])) not in accepted]
    unit_index = pending[0] if pending else 0
    def remember(s: dict[str, Any]) -> None:
        s["word_timing"]["current_cue_order"] = order
        s["word_timing"]["current_unit_index"] = unit_index
        s["word_timing"]["updated_at"] = _now_iso()
    _update_state(remember)
    return {"ok": True, "review": _word_timing_payload(include_waveform=False)}


@app.get("/api/word-timing/unit/{cue_order}/{unit_index}")
def word_timing_unit(cue_order: int, unit_index: int):
    try:
        document, _review, _duration = _ensure_word_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    units = _word_timing_units_for_cue(cues[cue_order - 1])
    if unit_index < 0 or unit_index >= len(units):
        raise HTTPException(status_code=404, detail="Unidade WbW não encontrada.")
    def remember(s: dict[str, Any]) -> None:
        s["word_timing"]["current_cue_order"] = cue_order
        s["word_timing"]["current_unit_index"] = unit_index
        s["word_timing"]["updated_at"] = _now_iso()
    _update_state(remember)
    return {"ok": True, "review": _word_timing_payload(include_waveform=False)}


@app.post("/api/word-timing/realign")
def word_timing_realign(request: WordTimingRealignRequest):
    try:
        document, review, duration_ms = _ensure_word_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    target_cue_order = int(request.cue_order)
    if target_cue_order < 1 or target_cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue atual não encontrada.")
    positions = [(target_cue_order, int(unit["unit_index"])) for unit in _word_timing_units_for_cue(cues[target_cue_order - 1])]
    anchor_index = int(request.anchor_unit_index)
    if anchor_index < 0 or anchor_index >= len(positions):
        raise HTTPException(status_code=404, detail="Word âncora não encontrada nesta cue.")
    if anchor_index >= len(positions) - 1:
        raise HTTPException(status_code=422, detail="Não existem words posteriores à word selecionada nesta cue.")

    aligned = json.loads(json.dumps(document))
    anchor_cue_order, anchor_unit_index = positions[anchor_index]
    anchor_cue = (aligned.get("cues") or [])[anchor_cue_order - 1]
    anchor_start_ms = int(request.anchor_start_ms)
    anchor_end_ms = int(request.anchor_end_ms)
    if anchor_start_ms < 0 or anchor_end_ms <= anchor_start_ms or anchor_end_ms > duration_ms:
        raise HTTPException(status_code=422, detail=f"IN/OUT da word âncora deve ficar dentro da mídia (0..{duration_ms} ms).")
    try:
        _apply_word_unit_range(anchor_cue, anchor_unit_index, anchor_start_ms, anchor_end_ms)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    anchor_unit = _word_timing_units_for_cue(anchor_cue)[anchor_unit_index]
    cursor = int(anchor_unit.get("end_ms") or 0) + 100
    moved_positions = positions[anchor_index + 1:]
    for cue_order, unit_index in moved_positions:
        cue = (aligned.get("cues") or [])[cue_order - 1]
        unit = _word_timing_units_for_cue(cue)[unit_index]
        unit_duration = max(1, int(unit.get("end_ms") or 0) - int(unit.get("start_ms") or 0))
        new_end = cursor + unit_duration
        if new_end > duration_ms:
            raise HTTPException(status_code=422, detail=f"O realinhamento ultrapassaria o fim do vídeo em {new_end - duration_ms} ms. Nenhuma unidade foi alterada.")
        _apply_word_unit_range(cue, unit_index, cursor, new_end)
        cursor = new_end + 100
    WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(aligned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for directory in (SHADOWING_DIR, CONNECTED_SPEECH_DIR, MATERIALS_EXTERNAL_DIR, MATERIALS_REVIEW_DIR, MATERIALS_FINAL_DIR):
        shutil.rmtree(directory, ignore_errors=True)
    first_cue, first_unit = moved_positions[0]
    def realign_state(s: dict[str, Any]) -> None:
        s["word_timing"].update({"current_cue_order": first_cue, "current_unit_index": first_unit, "completed": False, "status": "reviewing", "updated_at": _now_iso()})
        for key in ("shadowing", "connected_speech", "materials_external", "materials_review", "materials_final"):
            s[key] = _default_state()[key]
    _update_state(realign_state)
    return {
        "ok": True,
        "message": f"{len(moved_positions)} words da Cue {target_cue_order} realinhadas com intervalo de 100 milissegundos.",
        "anchor": {"cue_order": anchor_cue_order, "unit_index": anchor_unit_index},
        "moved": len(moved_positions),
        "review": _word_timing_payload(include_waveform=False),
    }


@app.post("/api/word-timing/save")
def word_timing_save(request: WordTimingSaveRequest):
    try:
        document, review, _duration = _ensure_word_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    cue_order = int(request.cue_order)
    unit_index = int(request.unit_index)
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    cue = cues[cue_order - 1]
    units = _word_timing_units_for_cue(cue)
    if unit_index < 0 or unit_index >= len(units):
        raise HTTPException(status_code=404, detail="Unidade WbW não encontrada.")
    start_ms = int(request.start_ms)
    end_ms = int(request.end_ms)
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    if start_ms < 0 or end_ms <= start_ms or end_ms > duration_ms:
        raise HTTPException(status_code=422, detail=f"IN/OUT da unidade deve ficar dentro da mídia (0..{duration_ms} ms).")
    try:
        _apply_word_unit_range(cue, unit_index, start_ms, end_ms)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    WORD_TIMING_DIR.mkdir(parents=True, exist_ok=True)
    WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    positions = _word_timing_positions(document)
    accepted = {str(v) for v in (review.get("accepted_keys") or []) if isinstance(v, str)}
    current_key = _word_timing_key(cue_order, unit_index)
    accepted.add(current_key)
    pending = [pos for pos in positions if _word_timing_key(*pos) not in accepted]
    if pending:
        current_pos = positions.index((cue_order, unit_index))
        after = [pos for pos in positions[current_pos + 1:] if _word_timing_key(*pos) not in accepted]
        next_cue, next_unit = after[0] if after else pending[0]
    else:
        next_cue, next_unit = cue_order, unit_index
    completed = not pending
    def save_state(s: dict[str, Any]) -> None:
        s["word_timing"].update({
            "status": "completed" if completed else "reviewing",
            "accepted_keys": sorted(accepted, key=lambda value: tuple(int(part) for part in value.split(":"))),
            "current_cue_order": next_cue,
            "current_unit_index": next_unit,
            "completed": completed,
            "updated_at": _now_iso(),
        })
    _update_state(save_state)
    return {
        "ok": True,
        "saved": {"cue_order": cue_order, "unit_index": unit_index},
        "next": {"cue_order": next_cue, "unit_index": next_unit},
        "completed": completed,
        "review": _word_timing_payload(include_waveform=False),
    }


@app.post("/api/word-timing/save-cue")
def word_timing_save_cue(request: WordTimingSaveCueRequest):
    try:
        document, review, _duration = _ensure_word_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cues = document.get("cues") or []
    cue_order = int(request.cue_order)
    current_unit_index = int(request.current_unit_index)
    if cue_order < 1 or cue_order > len(cues):
        raise HTTPException(status_code=404, detail="Cue não encontrada.")
    cue = cues[cue_order - 1]
    units = _word_timing_units_for_cue(cue)
    if not units:
        raise HTTPException(status_code=422, detail="A cue não possui unidades WbW.")
    if current_unit_index < 0 or current_unit_index >= len(units):
        raise HTTPException(status_code=404, detail="Unidade WbW atual não encontrada.")
    duration_ms = _probe_duration_ms(PROCESS_VIDEO_FILE)
    start_ms = int(request.current_start_ms)
    end_ms = int(request.current_end_ms)
    if start_ms < 0 or end_ms <= start_ms or end_ms > duration_ms:
        raise HTTPException(status_code=422, detail=f"IN/OUT da unidade deve ficar dentro da mídia (0..{duration_ms} ms).")
    try:
        _apply_word_unit_range(cue, current_unit_index, start_ms, end_ms)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    WORD_TIMING_DIR.mkdir(parents=True, exist_ok=True)
    WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    positions = _word_timing_positions(document)
    accepted = {str(value) for value in (review.get("accepted_keys") or []) if isinstance(value, str)}
    accepted.update(_word_timing_key(cue_order, int(unit["unit_index"])) for unit in units)
    pending = [position for position in positions if _word_timing_key(*position) not in accepted]
    if pending:
        after = [position for position in pending if position[0] > cue_order]
        next_cue, next_unit = after[0] if after else pending[0]
    else:
        next_cue, next_unit = cue_order, current_unit_index
    completed = not pending

    def save_state(state: dict[str, Any]) -> None:
        state["word_timing"].update({
            "status": "completed" if completed else "reviewing",
            "accepted_keys": sorted(accepted, key=lambda value: tuple(int(part) for part in value.split(":"))),
            "current_cue_order": next_cue,
            "current_unit_index": next_unit,
            "completed": completed,
            "updated_at": _now_iso(),
        })

    _update_state(save_state)
    return {
        "ok": True,
        "saved_cue_order": cue_order,
        "saved_units": len(units),
        "next": {"cue_order": next_cue, "unit_index": next_unit},
        "completed": completed,
        "review": _word_timing_payload(include_waveform=False),
    }


@app.get("/api/word-timing/canonical")
def word_timing_canonical():
    try:
        _ensure_word_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not WORD_TIMING_CANONICAL_FILE.is_file():
        raise HTTPException(status_code=404, detail="JSON WbW Timing ainda não foi criado.")
    return FileResponse(WORD_TIMING_CANONICAL_FILE, media_type="application/json", filename="canonical_scene_word_timing_reviewed.json")


@app.get("/api/dual-scene/state")
def dual_scene_state_api():
    try:
        return {"ok": True, "review": _dual_scene_payload()}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/dual-scene/prepare-pt")
def dual_scene_prepare_pt_api():
    state = _read_state()
    if not _dual_scene_ready(state):
        raise HTTPException(status_code=409, detail="O projeto Dual Scene ainda não está pronto.")
    pt_url = str((state.get("pt") or {}).get("url") or "").strip()
    if not pt_url:
        raise HTTPException(status_code=409, detail="A fonte PT não está configurada.")
    try:
        shutil.rmtree(DUAL_SCENE_PT_DIR, ignore_errors=True)
        DUAL_SCENE_PT_DIR.mkdir(parents=True, exist_ok=True)
        download_video(pt_url, DUAL_SCENE_PT_DIR, highest_quality=True)
        if not DUAL_SCENE_PT_FILE.is_file():
            raise RuntimeError("O download PT não produziu um vídeo válido.")
        duration = _probe_duration_ms(DUAL_SCENE_PT_FILE)
        _extract_audio(DUAL_SCENE_PT_FILE, DUAL_SCENE_PT_FILE, DUAL_SCENE_PT_AUDIO_FILE, 0, duration)
        waveform = _generate_waveform(DUAL_SCENE_PT_AUDIO_FILE, points=2400)
        DUAL_SCENE_PT_WAVEFORM_FILE.write_text(json.dumps(waveform, ensure_ascii=False) + "\n", encoding="utf-8")
        def prepared(s: dict[str, Any]) -> None:
            s["dual_scene"].update({"status": "editing", "completed": False, "updated_at": _now_iso()})
        _update_state(prepared)
        return {"ok": True, "review": _dual_scene_payload()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/dual-scene/state")
def dual_scene_save_api(request: DualSceneBlocksRequest):
    state = _read_state()
    if not _dual_scene_ready(state):
        raise HTTPException(status_code=409, detail="O projeto Dual Scene ainda não está pronto.")
    if not DUAL_SCENE_PT_FILE.is_file():
        raise HTTPException(status_code=409, detail="Prepare o vídeo PT antes de salvar os blocos.")
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    try:
        canonical = _normalize_dual_scene_blocks(request.blocks, document, _probe_duration_ms(PROCESS_VIDEO_FILE), _probe_duration_ms(DUAL_SCENE_PT_FILE))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    blocks = [{"id": f"block-{index}", "en_start_ms": item["en"]["start_ms"], "en_end_ms": item["en"]["end_ms"], "pt_start_ms": item["pt"]["start_ms"], "pt_end_ms": item["pt"]["end_ms"]} for index, item in enumerate(canonical, start=1)]
    DUAL_SCENE_DIR.mkdir(parents=True, exist_ok=True)
    DUAL_SCENE_FILE.write_text(json.dumps({"version": 1, "completed": False, "dualScene": canonical}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def saved(s: dict[str, Any]) -> None:
        s["dual_scene"].update({"status": "editing", "blocks": blocks, "completed": False, "updated_at": _now_iso()})
    _update_state(saved)
    return {"ok": True, "review": _dual_scene_payload()}


@app.post("/api/dual-scene/finalize")
def dual_scene_finalize_api(request: DualSceneBlocksRequest):
    dual_scene_save_api(request)
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    saved = json.loads(DUAL_SCENE_FILE.read_text(encoding="utf-8"))
    document["dualScene"] = saved["dualScene"]
    WORD_TIMING_CANONICAL_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    saved["completed"] = True
    DUAL_SCENE_FILE.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def finalized(s: dict[str, Any]) -> None:
        s["dual_scene"].update({"status": "completed", "completed": True, "updated_at": _now_iso()})
    _update_state(finalized)
    return {"ok": True, "next_url": "/materials-external", "review": _dual_scene_payload()}


class MusicShadowingRequest(BaseModel):
    enabled: bool


@app.post("/api/music/shadowing")
def music_shadowing_option(request: MusicShadowingRequest):
    state = _read_state()
    if (state.get("configuration") or {}).get("content_type") != "music":
        raise HTTPException(status_code=409, detail="Esta opção é exclusiva de Música.")
    if (state.get("materials_final") or {}).get("status") == "running":
        raise HTTPException(status_code=409, detail="Aguarde a geração terminar.")
    def save(s):
        s["configuration"]["shadowing_enabled"] = request.enabled
    _update_state(save)
    _sync_active_project()
    return {"ok": True, "enabled": request.enabled, "next_url": "/shadowing" if request.enabled else "/materials-external"}


@app.get("/api/shadowing/state")
def shadowing_state():
    try:
        return {"ok": True, "review": _shadowing_payload(include_waveform=True)}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/shadowing/draft")
def shadowing_draft(request: ShadowingDraftRequest):
    try:
        document, review, duration_ms = _ensure_shadowing()
        end_ms = int(request.end_ms) if request.end_ms is not None else None
        plan = _build_shadowing_plan(document, request.pause_markers_ms, end_ms, duration_ms, request.segments)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if SHADOWING_PLAN_FILE.is_file():
        SHADOWING_PLAN_FILE.unlink()
    def save_state(s: dict[str, Any]) -> None:
        s["shadowing"].update({
            "status": "editing",
            "pause_markers_ms": plan["pause_markers_ms"],
            "end_ms": end_ms,
            "segments": plan["editor_segments"],
            "completed": False,
            "updated_at": _now_iso(),
        })
    _update_state(save_state)
    return {"ok": True, "review": _shadowing_payload(include_waveform=False)}


@app.post("/api/shadowing/preview")
def shadowing_preview(request: ShadowingDraftRequest):
    """Build a preview from editor values without persisting the draft."""
    try:
        document, review, duration_ms = _ensure_shadowing()
        plan = _build_shadowing_plan(document, request.pause_markers_ms, request.end_ms, duration_ms, request.segments)
        if not plan["blocks"]:
            raise ValueError("Marque pelo menos uma pausa dentro do trecho para testar.")
        return {"ok": True, "plan": plan}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/shadowing/finalize")
def shadowing_finalize(request: ShadowingDraftRequest):
    try:
        document, review, duration_ms = _ensure_shadowing()
        end_ms = int(request.end_ms) if request.end_ms is not None else None
        plan = _build_shadowing_plan(document, request.pause_markers_ms, end_ms, duration_ms, request.segments)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    SHADOWING_DIR.mkdir(parents=True, exist_ok=True)
    if not plan["blocks"]:
        raise HTTPException(status_code=422, detail="Marque pelo menos uma pausa antes de finalizar o Shadowing.")
    SHADOWING_PLAN_FILE.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def save_state(s: dict[str, Any]) -> None:
        s["shadowing"].update({
            "status": "completed",
            "pause_markers_ms": plan["pause_markers_ms"],
            "end_ms": end_ms,
            "segments": plan["editor_segments"],
            "completed": True,
            "updated_at": _now_iso(),
        })
    _update_state(save_state)
    content_type = str(((document.get("project") or {}).get("content_type") or "dialogue"))
    _activate_one_pass_anki()
    return {"ok": True, "completed": True, "block_count": plan["block_count"], "review": _shadowing_payload(include_waveform=False)}


@app.get("/api/shadowing/plan")
def shadowing_plan():
    try:
        _ensure_shadowing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not SHADOWING_PLAN_FILE.is_file():
        raise HTTPException(status_code=404, detail="Shadowing ainda não foi finalizado.")
    return FileResponse(SHADOWING_PLAN_FILE, media_type="application/json", filename="shadowing.json")


@app.post("/api/connected-speech/prepare")
def connected_speech_prepare():
    try:
        return {"ok": True, "connected_speech": _prepare_connected_speech_package()}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/connected-speech/state")
def connected_speech_state():
    state = _read_state()
    if not _connected_speech_page_ready(state):
        raise HTTPException(status_code=409, detail="Conclua e aprove o Shadowing antes de abrir Connected Speech.")
    return {"ok": True, "connected_speech": state.get("connected_speech") or _default_state()["connected_speech"]}


@app.get("/api/connected-speech/artifact/{artifact_key}")
def connected_speech_artifact(artifact_key: str):
    try:
        prepared = _prepare_connected_speech_package()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    available = {str(item.get("key") or "") for item in (prepared.get("artifacts") or [])}
    if artifact_key not in available:
        raise HTTPException(status_code=404, detail="Artefato de Connected Speech não encontrado.")
    files = {
        "scope": (CONNECTED_SPEECH_SCOPE_FILE, "text/plain; charset=utf-8", CONNECTED_SPEECH_SCOPE_FILE.name),
        "canonical": (CONNECTED_SPEECH_CANONICAL_FILE, "application/json", CONNECTED_SPEECH_CANONICAL_FILE.name),
        "audio": (PROCESS_AUDIO_FILE, "audio/wav", "scene_audio_16k_mono.wav"),
        "instructions": (CONNECTED_SPEECH_INSTRUCTIONS_FILE, "text/plain; charset=utf-8", CONNECTED_SPEECH_INSTRUCTIONS_FILE.name),
        "zip": (CONNECTED_SPEECH_ZIP_FILE, "application/zip", CONNECTED_SPEECH_ZIP_FILE.name),
    }
    path, media_type, filename = files[artifact_key]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo de Connected Speech ainda não foi gerado.")
    return FileResponse(path, media_type=media_type, filename=filename)


@app.post("/api/connected-speech/import")
async def connected_speech_import(request: Request, filename: str = "connected_speech_return.json"):
    state = _read_state()
    if not _connected_speech_page_ready(state):
        raise HTTPException(status_code=409, detail="Conclua e aprove o Shadowing antes de importar Connected Speech.")
    try:
        _prepare_connected_speech_package()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:
        raw_body = await request.body()
        raw_text = raw_body.decode("utf-8-sig")
        returned = json.loads(raw_text)
        if not isinstance(returned, dict):
            raise ValueError("A raiz do retorno deve ser um objeto JSON.")
    except Exception as exc:
        def invalid_parse(s: dict[str, Any]) -> None:
            s["connected_speech"].update({
                "status": "invalid", "validated": False, "error": "O arquivo não contém JSON válido.",
                "returned_filename": filename, "validation_summary": {}, "review_total": 0,
                "review_decisions": {}, "current_sequence_order": 0, "review_completed": False,
            })
        _update_state(invalid_parse)
        raise HTTPException(status_code=422, detail="O arquivo não contém JSON válido.") from exc
    try:
        summary = _validate_connected_speech_return(returned)
    except Exception as exc:
        message = str(exc)
        def invalid(s: dict[str, Any]) -> None:
            s["connected_speech"].update({
                "status": "invalid", "validated": False, "error": message,
                "returned_filename": filename, "validation_summary": {}, "review_total": 0,
                "review_decisions": {}, "current_sequence_order": 0, "review_completed": False,
            })
        _update_state(invalid)
        raise HTTPException(status_code=422, detail=message) from exc

    CONNECTED_SPEECH_RETURN_FILE.write_text(json.dumps(returned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if CONNECTED_SPEECH_REVIEW_FILE.exists():
        CONNECTED_SPEECH_REVIEW_FILE.unlink()
    total = int(summary.get("phenomena") or 0)
    def valid(s: dict[str, Any]) -> None:
        s["connected_speech"].update({
            "status": "validated",
            "validated": True,
            "error": "",
            "returned_filename": filename,
            "validation_summary": summary,
            "validated_at": _now_iso(),
            "review_total": total,
            "review_decisions": {},
            "current_sequence_order": 1 if total else 0,
            "review_completed": total == 0,
            "review_updated_at": "",
        })
        s["materials_external"] = _default_state()["materials_external"]
        s["materials_review"] = _default_state()["materials_review"]
        s["materials_final"] = _default_state()["materials_final"]
    connected = _update_state(valid)["connected_speech"]
    shutil.rmtree(MATERIALS_EXTERNAL_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
    shutil.rmtree(MATERIALS_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)
    _write_connected_speech_review_result(returned, {})
    return {"ok": True, "message": "Connected Speech validado.", "summary": summary, "connected_speech": connected, "next_url": "/connected-speech-review"}


@app.get("/api/connected-speech/review")
def connected_speech_review(sequence_order: int | None = None):
    try:
        return {"ok": True, "review": _connected_speech_review_payload(sequence_order)}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/connected-speech/review/decision")
def connected_speech_review_decision(request: ConnectedSpeechReviewDecisionRequest):
    state = _read_state()
    connected = state.get("connected_speech") or {}
    if not connected.get("validated") or not CONNECTED_SPEECH_RETURN_FILE.is_file():
        raise HTTPException(status_code=409, detail="Valide o retorno de Connected Speech antes da conferência manual.")
    returned = json.loads(CONNECTED_SPEECH_RETURN_FILE.read_text(encoding="utf-8"))
    document = json.loads(WORD_TIMING_CANONICAL_FILE.read_text(encoding="utf-8"))
    items = _connected_speech_flat_items(returned, document)
    available = [int(item.get("sequenceOrder") or 0) for item in items]
    sequence = int(request.sequence_order)
    if sequence not in available:
        raise HTTPException(status_code=404, detail="Item de Connected Speech não encontrado.")
    decisions = {str(k): str(v) for k, v in (connected.get("review_decisions") or {}).items()}
    decisions[str(sequence)] = request.decision
    pending = [value for value in available if str(decisions.get(str(value)) or "") not in {"approved", "rejected"}]
    if pending:
        later = [value for value in pending if value > sequence]
        next_sequence = later[0] if later else pending[0]
    else:
        next_sequence = sequence
    completed = len(pending) == 0
    def save(s: dict[str, Any]) -> None:
        s["connected_speech"].update({
            "status": "completed" if completed else "reviewing",
            "review_decisions": decisions,
            "current_sequence_order": next_sequence,
            "review_completed": completed,
            "review_updated_at": _now_iso(),
            "error": "",
        })
        s["materials_external"] = _default_state()["materials_external"]
        s["materials_review"] = _default_state()["materials_review"]
        s["materials_final"] = _default_state()["materials_final"]
    _update_state(save)
    shutil.rmtree(MATERIALS_EXTERNAL_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
    shutil.rmtree(MATERIALS_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)
    _write_connected_speech_review_result(returned, decisions)
    if completed:
        _activate_one_pass_anki()
    return {"ok": True, "saved": {"sequence_order": sequence, "decision": request.decision}, "review": _connected_speech_review_payload(next_sequence)}


@app.get("/api/connected-speech/review/result")
def connected_speech_review_result():
    state = _read_state()
    connected = state.get("connected_speech") or {}
    if not connected.get("validated") or not CONNECTED_SPEECH_RETURN_FILE.is_file():
        raise HTTPException(status_code=409, detail="Connected Speech ainda não foi validado.")
    if not CONNECTED_SPEECH_REVIEW_FILE.is_file():
        returned = json.loads(CONNECTED_SPEECH_RETURN_FILE.read_text(encoding="utf-8"))
        _write_connected_speech_review_result(returned, connected.get("review_decisions") or {})
    return FileResponse(CONNECTED_SPEECH_REVIEW_FILE, media_type="application/json", filename="connected_speech_review.json")


@app.get("/api/materials-external/state")
def materials_external_state():
    if not _materials_external_page_ready():
        content_type = str(((_read_state().get("configuration") or {}).get("content_type") or "kit"))
        detail = "Conclua o Shadowing ou Dual Scene antes dos materiais."
        raise HTTPException(status_code=409, detail=detail)
    try:
        prepared = _prepare_materials_external_package()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    state = _read_state()
    return {
        "ok": True,
        "materials": state.get("materials_external") or _default_state()["materials_external"],
        "artifacts": prepared.get("artifacts") or [],
        "expected_return": prepared.get("expected_return") or "materials_external_ai_return.json",
        "cue_count": prepared.get("cue_count") or 0,
        "approved_connected_speech": prepared.get("approved_connected_speech") or 0,
    }


@app.post("/api/materials-external/prepare")
def materials_external_prepare():
    if not _materials_external_page_ready():
        content_type = str(((_read_state().get("configuration") or {}).get("content_type") or "kit"))
        detail = "Conclua o Shadowing ou Dual Scene antes dos materiais."
        raise HTTPException(status_code=409, detail=detail)
    try:
        prepared = _prepare_materials_external_package()
        return {"ok": True, **prepared}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/materials-external/rebuild")
def materials_external_rebuild():
    if not _materials_external_page_ready():
        content_type = str(((_read_state().get("configuration") or {}).get("content_type") or "kit"))
        detail = "Conclua o Shadowing ou Dual Scene antes dos materiais."
        raise HTTPException(status_code=409, detail=detail)

    try:
        # Deliberately resets only the material branch. Canonical scene, snapshot,
        # cues, WbW/timings, Shadowing and approved Connected Speech stay intact.
        _reset_materials_generation()
        prepared = _prepare_materials_external_package()
        return {
            "ok": True,
            "message": "Materiais anteriores invalidados. Novo pacote do contrato atual preparado.",
            "download_url": "/api/materials-external/artifact/zip",
            **prepared,
        }
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/materials-external/import")
async def materials_external_import(request: Request, filename: str = "materials_external_ai_return.json"):
    if not _materials_external_page_ready():
        content_type = str(((_read_state().get("configuration") or {}).get("content_type") or "kit"))
        detail = "Conclua o Shadowing ou Dual Scene antes dos materiais."
        raise HTTPException(status_code=409, detail=detail)
    try:
        canonical, cs_review, canonical_sha, cs_sha = _materials_external_inputs()
        _prepare_materials_external_package()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:
        raw_body = await request.body()
        returned = json.loads(raw_body.decode("utf-8-sig"))
        if not isinstance(returned, dict):
            raise ValueError("A raiz do retorno precisa ser objeto JSON.")
    except Exception as exc:
        def invalid_parse(state: dict[str, Any]) -> None:
            state["materials_external"].update({
                "status": "invalid",
                "validated": False,
                "error": "O arquivo não contém JSON válido.",
                "returned_filename": filename,
                "validation_summary": {},
            })
        _update_state(invalid_parse)
        raise HTTPException(status_code=422, detail="O arquivo não contém JSON válido.") from exc
    try:
        draft, summary = validate_materials_external_return(
            returned,
            canonical,
            cs_review,
            canonical_sha256=canonical_sha,
            connected_speech_review_sha256=cs_sha,
        )
    except Exception as exc:
        message = str(exc)
        def invalid(state: dict[str, Any]) -> None:
            state["materials_external"].update({
                "status": "invalid",
                "validated": False,
                "error": message,
                "returned_filename": filename,
                "validation_summary": {},
            })
        _update_state(invalid)
        raise HTTPException(status_code=422, detail=message) from exc

    MATERIALS_EXTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    MATERIALS_EXTERNAL_RETURN_FILE.write_text(json.dumps(returned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    MATERIALS_EXTERNAL_DRAFT_FILE.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(MATERIALS_REVIEW_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)
    shutil.rmtree(MATERIALS_TTS_DIR.parent, ignore_errors=True)
    snapshot_id = str(canonical.get("snapshot_id") or "")
    def valid(state: dict[str, Any]) -> None:
        state["materials_external"].update({
            "status": "validated",
            "message": f"Retorno validado: {int(summary.get('anki_cards') or 0)} card(s) e {int(summary.get('pdfs') or 0)} PDF único.",
            "source_snapshot_id": snapshot_id,
            "source_canonical_sha256": canonical_sha,
            "source_connected_speech_review_sha256": cs_sha,
            "contract_version": MATERIALS_EXTERNAL_CONTRACT_VERSION,
            "artifacts": _materials_external_artifacts(),
            "error": "",
            "returned_filename": filename,
            "validated": True,
            "validation_summary": summary,
            "validated_at": _now_iso(),
        })
        state["materials_review"] = _default_state()["materials_review"]
        state["materials_final"] = _default_state()["materials_final"]
    external = _update_state(valid)["materials_external"]
    return {
        "ok": True,
        "message": "Materiais da IA externa validados.",
        "summary": summary,
        "materials": external,
        "next_url": "/materials-review",
    }


@app.get("/api/materials-external/artifact/{artifact_key}")
def materials_external_artifact(artifact_key: str):
    mapping = {
        "zip": (MATERIALS_EXTERNAL_ZIP_FILE, "application/zip"),
        "canonical": (MATERIALS_EXTERNAL_PACKAGE_DIR / "canonical_scene_current.json", "application/json"),
        "connected_speech": (MATERIALS_EXTERNAL_PACKAGE_DIR / "connected_speech_review.json", "application/json"),
        "instructions": (MATERIALS_EXTERNAL_PACKAGE_DIR / "external_ai_materials_instructions.json", "application/json"),
    }
    if artifact_key not in mapping:
        raise HTTPException(status_code=404, detail="Artefato de materiais não encontrado.")
    path, media_type = mapping[artifact_key]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Artefato ainda não foi gerado.")
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.get("/api/materials-review/state")
def materials_review_state():
    if not _materials_review_ready():
        raise HTTPException(status_code=409, detail="Importe e valide o retorno da IA externa antes da revisão de materiais.")
    try:
        review = _read_materials_review()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    summary = review_summary(review)
    def sync(state: dict[str, Any]) -> None:
        state["materials_review"].update({
            "status": str(review.get("status") or "editing"),
            "message": "Revisão concluída." if review.get("status") == "approved" else "Revise o Anki antes da geração final.",
            "summary": summary,
            "updated_at": str(review.get("updated_at_utc") or _now_iso()),
        })
    _update_state(sync)
    return {"ok": True, "review": review, "summary": summary, "errors": validate_finalize(review)}


@app.put("/api/materials-review/state")
def save_materials_review(payload: dict[str, Any]):
    if not _materials_review_ready():
        raise HTTPException(status_code=409, detail="Importe e valide o retorno da IA externa antes da revisão de materiais.")
    try:
        draft = json.loads(MATERIALS_EXTERNAL_DRAFT_FILE.read_text(encoding="utf-8"))
        review = normalize_review(draft, payload)
        review["status"] = "editing"
        MATERIALS_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        MATERIALS_REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if MATERIALS_REVIEW_APPROVED_FILE.exists(): MATERIALS_REVIEW_APPROVED_FILE.unlink()
        # Keep artifacts until the final content comparison decides reuse.
        summary = review_summary(review)
        def save(state: dict[str, Any]) -> None:
            state["materials_review"].update({"status": "editing", "message": "Revisão salva.", "summary": summary, "updated_at": _now_iso()})
            state["materials_final"] = _default_state()["materials_final"]
        _update_state(save)
        return {"ok": True, "review": review, "summary": summary, "errors": validate_finalize(review)}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/materials-review/finalize")
def finalize_materials_review():
    if not _materials_review_ready():
        raise HTTPException(status_code=409, detail="Importe e valide o retorno da IA externa antes da revisão de materiais.")
    try:
        review = _read_materials_review()
        errors = validate_finalize(review)
        if errors:
            raise ValueError(" ".join(errors))
        review["status"] = "approved"
        review["updated_at_utc"] = _now_iso()
        approved = approved_payload(review)
        approved.update({
            "schema": "immersionhub-materials-reviewed-source",
            "schema_version": "1.0",
            "source_snapshot_id": review.get("source_snapshot_id"),
            "source_canonical_sha256": review.get("source_canonical_sha256"),
            "source_connected_speech_review_sha256": review.get("source_connected_speech_review_sha256"),
            "approved_at_utc": _now_iso(),
        })
        MATERIALS_REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        MATERIALS_REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        MATERIALS_REVIEW_APPROVED_FILE.write_text(json.dumps(approved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # Identical approvals must not discard the generated files.
        summary = review_summary(review)
        def done(state: dict[str, Any]) -> None:
            state["materials_review"].update({"status": "approved", "message": "Anki revisado. Pronto para geração final.", "summary": summary, "updated_at": _now_iso()})
            state["materials_final"] = _default_state()["materials_final"]
        _update_state(done)
        return {"ok": True, "review": review, "summary": summary, "next_url": "/materials-final"}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _tiktok_background_file() -> Path:
    return WORKSPACE_DIR / "tiktok_media" / "background.jpg"


def _tiktok_options() -> dict[str, str]:
    saved = _read_state().get("tiktok_media") or {}
    return {"background_mode": saved.get("background_mode", "default"), "aspect": saved.get("aspect", "vertical")}


def _require_music_options() -> None:
    if (_read_state().get("configuration") or {}).get("content_type") != "music":
        raise HTTPException(status_code=409, detail="TikTok Media está disponível somente para Música.")
    if (_read_state().get("materials_final") or {}).get("status") == "running":
        raise HTTPException(status_code=409, detail="Aguarde a geração terminar antes de alterar o fundo.")


@app.get("/api/tiktok-media/options")
def tiktok_media_options():
    return {"ok": True, **_tiktok_options(), "has_image": _tiktok_background_file().is_file()}


class TikTokOptionsRequest(BaseModel):
    background_mode: Literal["default", "image"] = "default"
    aspect: Literal["vertical", "source"] = "vertical"


@app.post("/api/tiktok-media/options")
def tiktok_media_save_options(request: TikTokOptionsRequest):
    if not _materials_final_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Aguarde a operação atual terminar.")
    try:
        _require_music_options()
        if request.background_mode == "image" and not _tiktok_background_file().is_file():
            raise HTTPException(status_code=422, detail="Envie uma imagem antes de selecionar esse fundo.")
        values = request.model_dump()
        def save(state):
            if state.get("tiktok_media") != values:
                state["tiktok_media"] = values
                state["materials_final"] = _default_state()["materials_final"]
        _update_state(save)
        return tiktok_media_options()
    finally:
        _materials_final_lock.release()


@app.get("/api/tiktok-media/background")
def tiktok_media_background():
    path = _tiktok_background_file()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Nenhuma imagem enviada.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/api/tiktok-media/background")
async def tiktok_media_upload_background(request: Request):
    from PIL import Image, ImageOps
    if not _materials_final_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Aguarde a operação atual terminar.")
    temporary = None
    try:
        _require_music_options()
        target = _tiktok_background_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"upload-{uuid.uuid4().hex}.tmp")
        size = 0
        with temporary.open("wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail="A imagem deve ter no máximo 20 MB.")
                output.write(chunk)
        try:
            with Image.open(temporary) as uploaded:
                if uploaded.format not in {"JPEG", "PNG", "WEBP"} or uploaded.width * uploaded.height > 40_000_000:
                    raise ValueError("Use JPG, PNG ou WebP de até 40 megapixels.")
                uploaded.load()
                normalized = ImageOps.exif_transpose(uploaded).convert("RGBA")
                flattened = Image.new("RGBA", normalized.size, "white")
                flattened.alpha_composite(normalized)
                normalized = flattened.convert("RGB")
                normalized.thumbnail((3840,3840), Image.Resampling.LANCZOS)
                normalized.save(temporary, format="JPEG", quality=95)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="Imagem inválida. Use JPG, PNG ou WebP.") from exc
        temporary.replace(target)
        def save(state):
            state["tiktok_media"] = {"aspect": (state.get("tiktok_media") or {}).get("aspect", "vertical"), "background_mode": "image"}
            state["materials_final"] = _default_state()["materials_final"]
        _update_state(save)
        return tiktok_media_options()
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        _materials_final_lock.release()


@app.get("/api/materials-final/state")
def materials_final_state():
    if not _materials_final_ready():
        raise HTTPException(status_code=409, detail="Finalize a revisão do Anki antes da geração final.")
    state = _read_state()
    job = state.get("materials_final") or _default_state()["materials_final"]
    return {"ok": True, "materials": _public_materials_final_state(job)}


@app.post("/api/materials-final/start")
def materials_final_start():
    if _materials_final_lock.locked():
        raise HTTPException(status_code=409, detail="Aguarde a operação atual terminar.")
    if not _materials_final_ready():
        raise HTTPException(status_code=409, detail="Finalize a revisão do Anki antes da geração final.")
    current = (_read_state().get("materials_final") or {})
    if current.get("status") == "running":
        return {"ok": True, "started": False, "materials": current}
    cached = _cached_materials_final()
    if cached:
        def reuse(state: dict[str, Any]) -> None:
            state["materials_final"] = cached
        _update_state(reuse)
        return {"ok": True, "started": False, "reused": True, "materials": cached}
    shutil.rmtree(MATERIALS_FINAL_DIR, ignore_errors=True)
    def reset(state: dict[str, Any]) -> None:
        state["materials_final"] = _default_state()["materials_final"]
        state["materials_final"].update({
            "status": "running", "percent": 1, "message": "Revisão confirmada. Iniciando TTS + geração final…",
            "logs": ["Conteúdo pedagógico já veio da IA externa e foi revisado. A Groq será usada somente para os áudios TTS dos cards aprovados."],
            "started_at": _now_iso(),
        })
    _update_state(reset)
    worker = threading.Thread(target=_materials_final_job, daemon=True, name="materials-final-generator")
    worker.start()
    return {"ok": True, "started": True, "materials": _read_state()["materials_final"]}


@app.post("/api/materials-final/retry-failed")
def materials_final_retry_failed():
    if not _materials_final_ready():
        raise HTTPException(status_code=409, detail="Finalize a revisão do Anki antes da geração final.")
    current = (_read_state().get("materials_final") or {})
    if current.get("status") == "running":
        return {"ok": True, "started": False, "materials": _public_materials_final_state(current)}

    failed_items = [
        _decorate_materials_final_failure(item, attach_dependency=False)
        for item in (current.get("failed_items") or [])
        if isinstance(item, dict)
    ]
    retry_ids = {str(item.get("id") or "").strip() for item in failed_items if str(item.get("id") or "").strip()}
    retry_ids.discard("pipeline")
    if not retry_ids:
        raise HTTPException(status_code=409, detail="Não há artefatos individuais com erro para tentar novamente.")

    current_wbw_sha = _word_timing_revision_sha256()
    preserved_failures: list[dict[str, Any]] = []
    blocked_labels: list[str] = []
    for item in failed_items:
        task_id = str(item.get("id") or "")
        recovery = item.get("recovery") if isinstance(item.get("recovery"), dict) else {}
        dependency_sha = str(recovery.get("dependency_sha256") or "")
        if (
            task_id == "hub_json"
            and str(recovery.get("type") or "") == "word_timing"
            and dependency_sha
            and current_wbw_sha
            and dependency_sha == current_wbw_sha
        ):
            retry_ids.discard(task_id)
            preserved_failures.append(item)
            blocked_labels.append(str(item.get("label") or task_id))

    if not retry_ids:
        message = "O erro depende de uma correção no WbW Timing. Nenhum arquivo foi regenerado."
        def blocked(state: dict[str, Any]) -> None:
            job = state["materials_final"]
            job["message"] = message
            job["failed_items"] = failed_items
            logs = list(job.get("logs") or [])
            if not logs or logs[-1] != message:
                logs.append(message)
            job["logs"] = logs[-200:]
        updated = _update_state(blocked)["materials_final"]
        return {
            "ok": True,
            "started": False,
            "blocked": True,
            "blocked_items": blocked_labels,
            "materials": _public_materials_final_state(updated),
        }

    def reset_retry(state: dict[str, Any]) -> None:
        job = state["materials_final"]
        job.update({
            "status": "running",
            "percent": 1,
            "message": f"Refazendo somente {len(retry_ids)} item(ns) que deram erro…",
            "error": "\n".join(
                f"{item.get('label')}: {item.get('error')}" for item in preserved_failures
            ),
            "failed_items": preserved_failures,
            "started_at": _now_iso(),
            "finished_at": "",
        })
        logs = list(job.get("logs") or [])
        if blocked_labels:
            logs.append("Aguardando correção externa antes do retry: " + ", ".join(blocked_labels))
        logs.append("Retry seletivo iniciado: " + ", ".join(sorted(retry_ids)))
        job["logs"] = logs[-200:]
    _update_state(reset_retry)
    worker = threading.Thread(
        target=_materials_final_job,
        args=(retry_ids, preserved_failures),
        daemon=True,
        name="materials-final-retry",
    )
    worker.start()
    return {"ok": True, "started": True, "materials": _public_materials_final_state(_read_state()["materials_final"])}


@app.post("/api/materials-final/wbw-practice/ignore")
def materials_final_ignore_wbw_practice(payload: dict[str, Any]):
    """Remove one optional WbW practice and retry the failed final artifacts."""
    try:
        position = int(payload.get("practice_index") or 0)
    except (TypeError, ValueError):
        position = 0
    if position <= 0:
        raise HTTPException(status_code=422, detail="Prática WbW inválida.")
    if not EXTERNAL_AI_ONE_PASS_FILE.is_file():
        raise HTTPException(status_code=404, detail="Arquivo de práticas WbW não encontrado.")
    try:
        document = json.loads(EXTERNAL_AI_ONE_PASS_FILE.read_text(encoding="utf-8"))
        practices = document.get("wbw_practices")
        if not isinstance(practices, list) or position > len(practices):
            raise HTTPException(status_code=404, detail="A prática indicada não existe mais.")
        removed = practices.pop(position - 1)
        EXTERNAL_AI_ONE_PASS_FILE.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        _sync_active_project()
    except HTTPException:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=500, detail=f"Não foi possível remover a prática: {exc}") from exc
    result = materials_final_retry_failed()
    result["ignored_practice"] = {
        "practice_index": position,
        "expression_en": str((removed or {}).get("expression_en") or "") if isinstance(removed, dict) else "",
    }
    return result


@app.get("/api/materials-final/artifact/{filename}")
def materials_final_artifact(filename: str):
    safe = Path(filename).name
    if safe != filename or safe.lower().endswith(".pdf"):
        raise HTTPException(status_code=404, detail="Arquivo final não encontrado.")
    path = MATERIALS_FINAL_OUTPUT_DIR / safe
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo final não encontrado.")
    media = "application/zip" if path.suffix.lower() == ".zip" else "application/pdf" if path.suffix.lower() == ".pdf" else "application/json" if path.suffix.lower() == ".json" else "video/mp4" if path.suffix.lower() == ".mp4" else "application/octet-stream"
    return FileResponse(path, media_type=media, filename=path.name)


@app.get("/api/materials-final/tts-artifact/{filename}")
def materials_final_tts_artifact(filename: str):
    safe = Path(filename).name
    if safe != filename:
        raise HTTPException(status_code=404, detail="Artefato TTS não encontrado.")
    mapping = {
        MATERIALS_TTS_AUDIO_ZIP_FILE.name: (MATERIALS_TTS_AUDIO_ZIP_FILE, "application/zip"),
        MATERIALS_TTS_MANIFEST_FILE.name: (MATERIALS_TTS_MANIFEST_FILE, "application/json"),
    }
    if safe not in mapping:
        raise HTTPException(status_code=404, detail="Artefato TTS não encontrado.")
    path, media = mapping[safe]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Artefato TTS não encontrado.")
    return FileResponse(path, media_type=media, filename=path.name)


@app.get("/api/cue-timing/canonical")
def cue_timing_canonical():
    try:
        _ensure_cue_timing()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return FileResponse(CUE_TIMING_CANONICAL_FILE, media_type="application/json", filename="canonical_scene_timing_reviewed.json")


# Integrated video editor (independent drafts and exports).
from editor_integration import install_editor
install_editor(app)
