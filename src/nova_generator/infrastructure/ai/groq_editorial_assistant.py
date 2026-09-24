from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from nova_generator.application.ports.editorial_assistant import (
    EditorialAssistanceResult,
    EditorialCuePrompt,
    EditorialSuggestion,
)


class EditorialAssistantUnavailable(RuntimeError):
    def __init__(self, message: str, *, code: str, retry_after_seconds: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.retry_after_seconds = retry_after_seconds


class _SuggestionPayload(BaseModel):
    cue_id: str
    order: int
    approved_en: str = Field(min_length=1)
    approved_pt: str = Field(min_length=1)
    notes: str = ""


class _ResponsePayload(BaseModel):
    scene_id: str
    input_sha256: str
    suggestions: list[_SuggestionPayload]


class GroqEditorialAssistant:
    """Groq adapter that keeps quota policy outside the editorial domain."""

    def __init__(self, *, api_key: str | None, model: str, client: Any | None = None) -> None:
        self._model = model
        self._missing_api_key = not api_key and client is None
        if client is not None:
            self._client = client
            return
        if not api_key:
            self._client = None
            return
        try:
            from groq import Groq  # pyright: ignore[reportMissingImports]
        except ImportError as error:
            raise EditorialAssistantUnavailable(
                "SDK da Groq não está instalado. Use o pacote para IA externa.",
                code="sdk_unavailable",
            ) from error
        self._client = Groq(api_key=api_key, max_retries=0)

    def suggest(
        self,
        *,
        scene_id: str,
        input_sha256: str,
        cues: tuple[EditorialCuePrompt, ...],
    ) -> EditorialAssistanceResult:
        if self._missing_api_key or self._client is None:
            raise EditorialAssistantUnavailable(
                "Groq não configurada. Use o pacote para IA externa.", code="missing_api_key"
            )
        request = {
            "scene_id": scene_id,
            "input_sha256": input_sha256,
            "cues": [cue.__dict__ for cue in cues],
        }
        try:
            raw = self._client.with_raw_response.chat.completions.create(
                model=self._model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": json.dumps(request, ensure_ascii=False, separators=(",", ":")),
                    },
                ],
            )
            response = raw.parse()
            content = response.choices[0].message.content
            if not isinstance(content, str) or not content:
                raise ValueError("empty response")
            parsed = _ResponsePayload.model_validate_json(content)
        except (ValidationError, ValueError, IndexError, KeyError, TypeError) as error:
            raise EditorialAssistantUnavailable(
                "A Groq devolveu um JSON inválido. Use o pacote para IA externa.",
                code="invalid_response",
            ) from error
        except Exception as error:
            raise _translate_error(error) from error
        headers = {str(key).lower(): str(value) for key, value in raw.headers.items()}
        return EditorialAssistanceResult(
            scene_id=parsed.scene_id,
            input_sha256=parsed.input_sha256,
            provider="groq",
            model=self._model,
            suggestions=tuple(
                EditorialSuggestion(
                    cue_id=item.cue_id,
                    order=item.order,
                    approved_en=item.approved_en,
                    approved_pt=item.approved_pt,
                    notes=item.notes,
                )
                for item in parsed.suggestions
            ),
            rate_limits=_rate_limit_headers(headers),
        )


def _translate_error(error: Exception) -> EditorialAssistantUnavailable:
    status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", {}) if response is not None else {}
    retry_after = str(headers.get("retry-after")) if headers.get("retry-after") else None
    if status == 429:
        return EditorialAssistantUnavailable(
            "Limite da Groq atingido. Aguarde o período informado ou use a IA externa.",
            code="rate_limited",
            retry_after_seconds=retry_after,
        )
    if status in {401, 403}:
        return EditorialAssistantUnavailable(
            "A chave da Groq foi recusada. Revise a configuração ou use a IA externa.",
            code="authentication_failed",
        )
    if status == 498 or status is not None and status >= 500:
        return EditorialAssistantUnavailable(
            "A Groq está sem capacidade no momento. Use a IA externa ou tente novamente.",
            code="provider_unavailable",
            retry_after_seconds=retry_after,
        )
    return EditorialAssistantUnavailable(
        "Não foi possível obter sugestões da Groq. Use o pacote para IA externa.",
        code="provider_error",
        retry_after_seconds=retry_after,
    )


def _rate_limit_headers(headers: dict[str, str]) -> dict[str, str]:
    allowed = {
        "retry-after",
        "x-ratelimit-limit-requests",
        "x-ratelimit-limit-tokens",
        "x-ratelimit-remaining-requests",
        "x-ratelimit-remaining-tokens",
        "x-ratelimit-reset-requests",
        "x-ratelimit-reset-tokens",
    }
    return {key: value for key, value in headers.items() if key in allowed}


_SYSTEM_PROMPT = """You are an English-to-Brazilian-Portuguese subtitle editor.
Return one JSON object only, with scene_id, input_sha256 and suggestions.
For every input cue, return exactly one suggestion in the same order with cue_id, order,
approved_en, approved_pt and notes. Correct the English only when needed. Preserve meaning,
names, accents, apostrophes, quotation marks, commas, periods, questions and ellipses. Produce
natural Brazilian Portuguese. Never merge, split, omit or invent cues. Copy scene_id,
input_sha256, cue_id and order exactly."""
