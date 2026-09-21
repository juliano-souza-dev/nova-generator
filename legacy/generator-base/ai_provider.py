from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from groq import Groq
except ImportError:  # pragma: no cover - handled with a friendly runtime message
    Groq = None  # type: ignore[assignment]

BASE_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = BASE_DIR / "settings" / "ai_settings.json"


def migrate_legacy_ai_settings() -> None:
    """Keep credentials outside project snapshots and public media."""
    active = BASE_DIR / "workspace" / "ai_settings.json"
    legacy = [active, *sorted((BASE_DIR / "projects").glob("*/workspace/ai_settings.json"), key=lambda path: path.stat().st_mtime, reverse=True)]
    if not SETTINGS_FILE.exists():
        for source in legacy:
            if not source.is_file():
                continue
            try:
                data = json.loads(source.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or not str(data.get("api_key") or "").strip():
                continue
            SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary = SETTINGS_FILE.with_suffix(".tmp")
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(SETTINGS_FILE)
            break
    if not SETTINGS_FILE.is_file():
        return
    saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    if not isinstance(saved, dict) or not str(saved.get("api_key") or "").strip():
        return
    for source in legacy:
        if source.is_file():
            source.unlink()


migrate_legacy_ai_settings()
DEFAULT_MODEL = "openai/gpt-oss-120b"
DEFAULT_TTS_MODEL = "canopylabs/orpheus-v1-english"
DEFAULT_TTS_VOICE = "hannah"
TTS_VOICES = ("autumn", "diana", "hannah", "austin", "daniel", "troy")
ANALYSIS_UNSUITABLE_MARKERS = ("prompt-guard", "safeguard", "orpheus", "whisper")
DEFAULT_JSON_MAX_COMPLETION_TOKENS = 512


def is_analysis_model_suitable(model_id: str) -> bool:
    model_id = str(model_id or "").strip().lower()
    return bool(model_id) and not any(marker in model_id for marker in ANALYSIS_UNSUITABLE_MARKERS)


def normalize_analysis_model(model_id: str | None) -> str:
    model_id = str(model_id or "").strip()
    return model_id if is_analysis_model_suitable(model_id) else DEFAULT_MODEL


def is_tts_model_suitable(model_id: str) -> bool:
    model_id = str(model_id or "").strip().lower()
    return bool(model_id) and "orpheus" in model_id


def _read_file() -> dict[str, Any]:
    if not SETTINGS_FILE.is_file():
        return {}
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_ai_settings() -> dict[str, str]:
    stored = _read_file()
    return {
        "provider": "groq",
        "model": normalize_analysis_model(stored.get("model") or DEFAULT_MODEL),
        "tts_model": str(stored.get("tts_model") or DEFAULT_TTS_MODEL).strip() or DEFAULT_TTS_MODEL,
        "tts_voice": str(stored.get("tts_voice") or DEFAULT_TTS_VOICE).strip().lower() or DEFAULT_TTS_VOICE,
        "api_key": str(stored.get("api_key") or os.getenv("GROQ_API_KEY") or "").strip(),
    }


def _key_fingerprint(api_key: str) -> str:
    key = str(api_key or "").strip()
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] if key else ""


def _validation_matches(settings: dict[str, str], validation: Any) -> bool:
    if not isinstance(validation, dict):
        return False
    return (
        str(validation.get("api_key_fingerprint") or "") == _key_fingerprint(settings.get("api_key") or "")
        and str(validation.get("tts_model") or "") == str(settings.get("tts_model") or "")
        and str(validation.get("tts_voice") or "") == str(settings.get("tts_voice") or "")
    )


def public_ai_settings() -> dict[str, Any]:
    settings = load_ai_settings()
    stored = _read_file()
    has_api_key = bool(settings["api_key"])
    configured = bool(
        has_api_key
        and is_tts_model_suitable(settings["tts_model"])
        and settings["tts_voice"] in TTS_VOICES
    )
    validation = stored.get("validation") if isinstance(stored.get("validation"), dict) else {}
    validation_matches = _validation_matches(settings, validation)
    connected = bool(configured and validation_matches and validation.get("ok") is True)
    ready = bool(configured and connected)

    if not has_api_key:
        readiness_code = "missing_api_key"
        readiness_reason = "Nenhuma API key Groq configurada."
    elif not configured:
        readiness_code = "incomplete_configuration"
        readiness_reason = "A configuração Groq está incompleta ou inválida."
    elif validation_matches and validation.get("ok") is False:
        readiness_code = "connection_failed"
        readiness_reason = str(validation.get("error") or "A conexão com a Groq falhou.")
    elif not connected:
        readiness_code = "validation_required"
        readiness_reason = "A configuração Groq foi salva, mas ainda precisa ser validada."
    else:
        readiness_code = "ready"
        readiness_reason = "Groq configurada e validada."

    return {
        "provider": settings["provider"],
        "model": settings["model"],
        "tts_model": settings["tts_model"],
        "tts_voice": settings["tts_voice"],
        "tts_voices": list(TTS_VOICES),
        "has_api_key": has_api_key,
        "configured": configured,
        "connected": connected,
        "ready": ready,
        "readiness_code": readiness_code,
        "readiness_reason": readiness_reason,
        "last_validated_at": str(validation.get("validated_at") or "") if validation_matches else "",
        "model_configured": bool(stored.get("model")),
        "tts_model_configured": bool(stored.get("tts_model")),
        "tts_voice_configured": bool(stored.get("tts_voice")),
        "api_key_source": "saved" if stored.get("api_key") else ("environment" if os.getenv("GROQ_API_KEY") else "none"),
    }


def _record_validation(*, ok: bool, error: str = "") -> None:
    settings = load_ai_settings()
    stored = _read_file()
    stored.update({
        "provider": "groq",
        "model": settings["model"],
        "tts_model": settings["tts_model"],
        "tts_voice": settings["tts_voice"],
    })
    stored["validation"] = {
        "ok": bool(ok),
        "validated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "api_key_fingerprint": _key_fingerprint(settings["api_key"]),
        "model": settings["model"],
        "tts_model": settings["tts_model"],
        "tts_voice": settings["tts_voice"],
        "error": str(error or "").strip(),
    }
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def groq_readiness(*, validate_if_needed: bool = False) -> dict[str, Any]:
    status = public_ai_settings()
    if not validate_if_needed or status.get("ready") or not status.get("configured"):
        return status
    try:
        test_groq_connection(record_validation=True)
    except Exception:
        pass
    return public_ai_settings()


def save_ai_settings(
    *,
    model: str | None = None,
    tts_model: str | None = None,
    tts_voice: str | None = None,
    api_key: str | None = None,
    clear_api_key: bool = False,
) -> dict[str, Any]:
    current = _read_file()
    model = normalize_analysis_model(model or current.get("model") or DEFAULT_MODEL)
    tts_model = str(tts_model or DEFAULT_TTS_MODEL).strip() or DEFAULT_TTS_MODEL
    if not is_tts_model_suitable(tts_model):
        raise ValueError("Informe um modelo TTS Groq/Orpheus válido.")
    tts_voice = str(tts_voice or DEFAULT_TTS_VOICE).strip().lower() or DEFAULT_TTS_VOICE
    if tts_voice not in TTS_VOICES:
        raise ValueError(f"Voz TTS inválida: {tts_voice}.")

    previous_effective = load_ai_settings()
    data: dict[str, Any] = {
        "provider": "groq",
        "model": model,
        "tts_model": tts_model,
        "tts_voice": tts_voice,
    }
    if clear_api_key:
        pass
    elif api_key is not None and str(api_key).strip():
        data["api_key"] = str(api_key).strip()
    elif current.get("api_key"):
        data["api_key"] = str(current["api_key"]).strip()

    effective_key = str(data.get("api_key") or os.getenv("GROQ_API_KEY") or "").strip()
    if not effective_key:
        raise ValueError("Informe a API key da Groq antes de salvar a configuração.")

    same_configuration = (
        previous_effective.get("api_key") == effective_key
        and previous_effective.get("tts_model") == tts_model
        and previous_effective.get("tts_voice") == tts_voice
    )
    if same_configuration and isinstance(current.get("validation"), dict):
        data["validation"] = current["validation"]

    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    persisted = load_ai_settings()
    if not persisted.get("api_key"):
        raise RuntimeError("A configuração foi gravada, mas a API key não pôde ser relida do armazenamento.")
    if (
        persisted.get("model") != model
        or persisted.get("tts_model") != tts_model
        or persisted.get("tts_voice") != tts_voice
    ):
        raise RuntimeError("A configuração Groq foi gravada, mas não pôde ser relida integralmente.")
    return public_ai_settings()


def groq_client(*, api_key: str | None = None):
    if Groq is None:
        raise RuntimeError("Dependência 'groq' não instalada. Execute: pip install -r requirements.txt")
    key = str(api_key or load_ai_settings()["api_key"]).strip()
    if not key:
        raise RuntimeError("Configure a GROQ API key em Configurações.")
    return Groq(api_key=key)


def _groq_error_message(exc: Exception) -> str:
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    message = ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "").strip()
        if not message:
            message = str(body.get("message") or "").strip()
    if not message:
        message = str(exc).strip()
    if status:
        return f"Groq respondeu HTTP {status}: {message}"
    return f"Falha ao acessar a Groq: {message}"



def test_groq_connection(*, record_validation: bool = False) -> dict[str, Any]:
    """Validate the configured Groq key + TTS model without spending speech tokens."""
    settings = load_ai_settings()
    selected_tts_model = settings["tts_model"]
    started = time.perf_counter()
    try:
        response = groq_client().models.list()
        elapsed_ms = max(0, int(round((time.perf_counter() - started) * 1000)))
        items = getattr(response, "data", None) or []
        available = {str(getattr(item, "id", "") or "").strip() for item in items}
        if selected_tts_model not in available:
            raise RuntimeError(f"Groq conectou, mas o modelo TTS configurado não está disponível: {selected_tts_model}")
    except Exception as exc:
        message = str(exc).strip() if isinstance(exc, RuntimeError) else _groq_error_message(exc)
        if record_validation:
            _record_validation(ok=False, error=message)
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError(message) from exc

    if record_validation:
        _record_validation(ok=True)
    return {
        "ok": True,
        "provider": "groq",
        "tts_model": selected_tts_model,
        "voice": settings["tts_voice"],
        "latency_ms": elapsed_ms,
    }

def list_groq_models(*, api_key: str | None = None) -> list[dict[str, Any]]:
    try:
        response = groq_client(api_key=api_key).models.list()
    except Exception as exc:  # SDK normalizes HTTP/network failures for us.
        raise RuntimeError(_groq_error_message(exc)) from exc

    items = getattr(response, "data", None) or []
    models: list[dict[str, Any]] = []
    for item in items:
        model_id = str(getattr(item, "id", "") or "").strip()
        if not model_id:
            continue
        active = getattr(item, "active", True)
        context_window = getattr(item, "context_window", 0) or 0
        models.append({
            "id": model_id,
            "active": bool(active),
            "owned_by": str(getattr(item, "owned_by", "") or ""),
            "context_window": int(context_window),
            "analysis_suitable": is_analysis_model_suitable(model_id),
        })
    models.sort(key=lambda item: (not item["active"], item["id"].lower()))
    return models


def _retry_after_seconds(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _model_completion_limit_from_error(text: str) -> int | None:
    patterns = (
        r"max_completion_tokens[^\d]{0,80}(?:less than or equal to|maximum(?: value)?(?: is)?)\s*[`'\"]?(\d+)",
        r"maximum value for [`'\"]?max_completion_tokens[`'\"]?[^\d]{0,40}(\d+)",
    )
    for pattern in patterns:
        match = re.search(pattern, str(text or ""), re.IGNORECASE)
        if match:
            try:
                return max(1, int(match.group(1)))
            except (TypeError, ValueError):
                pass
    return None


def groq_json_completion(
    *,
    system: str,
    user: str,
    model: str | None = None,
    max_completion_tokens: int = DEFAULT_JSON_MAX_COMPLETION_TOKENS,
) -> dict[str, Any]:
    settings = load_ai_settings()
    selected_model = normalize_analysis_model(model or settings["model"])
    if not selected_model:
        raise RuntimeError("Configure um modelo da Groq.")

    requested_tokens = max(64, int(max_completion_tokens or DEFAULT_JSON_MAX_COMPLETION_TOKENS))
    kwargs: dict[str, Any] = {
        "model": selected_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.15,
        "max_completion_tokens": requested_tokens,
        "response_format": {"type": "json_object"},
    }
    if selected_model.startswith("openai/gpt-oss-"):
        kwargs["reasoning_effort"] = "low"

    client = groq_client()
    attempts = 0
    removed_json_mode = False
    while True:
        attempts += 1
        try:
            completion = client.chat.completions.create(**kwargs)
            break
        except Exception as exc:
            text = _groq_error_message(exc)
            status = getattr(exc, "status_code", None)

            # Some Groq-hosted models expose a smaller completion ceiling.
            # Adapt once instead of forcing the user to know model-specific limits.
            model_limit = _model_completion_limit_from_error(text)
            if status == 400 and model_limit and int(kwargs["max_completion_tokens"]) > model_limit:
                kwargs["max_completion_tokens"] = model_limit
                if attempts < 4:
                    continue

            # Keep compatibility with chat models that do not expose JSON mode.
            if status == 400 and not removed_json_mode and ("response_format" in text or "json" in text.lower()):
                kwargs.pop("response_format", None)
                removed_json_mode = True
                if attempts < 4:
                    continue

            # Rate-limit retry. Groq returns retry-after when a TPM/RPM window is hit.
            if status == 429 and attempts < 4:
                retry_after = _retry_after_seconds(exc)
                delay = retry_after if retry_after is not None else float(2 ** (attempts - 1))
                if delay <= 65:
                    time.sleep(max(0.5, delay))
                    continue
            raise RuntimeError(text) from exc

    choices = getattr(completion, "choices", None) or []
    if not choices:
        raise RuntimeError("A Groq não retornou uma resposta do modelo.")
    message = getattr(choices[0], "message", None)
    content = str(getattr(message, "content", "") or "").strip()
    if not content:
        raise RuntimeError("O modelo retornou uma resposta vazia.")

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        candidate = content[start:end + 1] if start >= 0 and end > start else ""
        try:
            result = json.loads(candidate) if candidate else None
        except json.JSONDecodeError as exc:
            raise RuntimeError("O modelo não retornou um objeto JSON válido.") from exc

    if not isinstance(result, dict):
        raise RuntimeError("O modelo retornou um formato JSON inválido.")
    result["_model"] = selected_model
    return result
