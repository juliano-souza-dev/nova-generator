import json
from types import SimpleNamespace

import pytest

from nova_generator.application.ports.editorial_assistant import (
    EditorialCuePrompt,
    EditorialWordPrompt,
)
from nova_generator.infrastructure.ai.groq_editorial_assistant import (
    EditorialAssistantUnavailable,
    GroqEditorialAssistant,
)


class _RawResponse:
    def __init__(self, content: str, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}
        self._content = content

    def parse(self):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self._content))]
        )


class _Client:
    def __init__(self, response: _RawResponse | Exception) -> None:
        self.with_raw_response = self
        self.chat = self
        self.completions = self
        self._response = response

    def create(self, **_kwargs):
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def test_groq_adapter_validates_json_and_exposes_dynamic_rate_headers() -> None:
    payload = {
        "scene_id": "scene-1",
        "input_sha256": "a" * 64,
        "suggestions": [
            {
                "cue_id": "cue-1",
                "order": 1,
                "approved_en": "“Are you ready…?”",
                "approved_pt": "“Você está pronto…?”",
                "notes": "Pontuação preservada.",
                "semantic_units": [{"word_ids": ["word-1", "word-2"], "pt": "Você está pronto?"}],
            }
        ],
    }
    raw = _RawResponse(
        json.dumps(payload, ensure_ascii=False),
        {"x-ratelimit-remaining-requests": "29", "authorization": "secret"},
    )
    result = GroqEditorialAssistant(api_key=None, model="test-model", client=_Client(raw)).suggest(
        scene_id="scene-1",
        input_sha256="a" * 64,
        cues=(
            EditorialCuePrompt(
                "cue-1",
                1,
                "Are you ready?",
                "",
                "",
                (
                    EditorialWordPrompt("word-1", 1, "Are"),
                    EditorialWordPrompt("word-2", 2, "you"),
                ),
            ),
        ),
    )
    assert result.suggestions[0].approved_pt == "“Você está pronto…?”"
    assert result.suggestions[0].semantic_units[0].word_ids == ("word-1", "word-2")
    assert result.suggestions[0].semantic_units[0].pt == "Você está pronto?"
    assert result.rate_limits == {"x-ratelimit-remaining-requests": "29"}


def test_groq_adapter_marks_429_for_external_fallback() -> None:
    error = RuntimeError("limited")
    error.status_code = 429  # type: ignore[attr-defined]
    error.response = SimpleNamespace(headers={"retry-after": "17"})  # type: ignore[attr-defined]
    assistant = GroqEditorialAssistant(api_key=None, model="test", client=_Client(error))
    with pytest.raises(EditorialAssistantUnavailable) as raised:
        assistant.suggest(scene_id="s", input_sha256="a" * 64, cues=())
    assert raised.value.code == "rate_limited"
    assert raised.value.retry_after_seconds == "17"


def test_groq_adapter_does_not_block_worker_start_without_a_key() -> None:
    assistant = GroqEditorialAssistant(api_key=None, model="test")
    with pytest.raises(EditorialAssistantUnavailable, match="não configurada"):
        assistant.suggest(scene_id="s", input_sha256="a" * 64, cues=())
