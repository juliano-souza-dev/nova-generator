"""Language-aware, literal speech chunks for TikTok Media slide narration."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from nova_generator.application.use_cases.speech_language import (
    synthesis_language_parameters,
)
from nova_generator.domain.tiktok_media import MediaSlide
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.speech.qwen3_tts_runner import (
    has_language_tags,
    parse_narration,
)

MAX_SPEECH_CHUNK_CHARACTERS = 280
MAX_COMPATIBILITY_CHUNK_CHARACTERS = 2000
_LEGACY_LANGUAGE_TAGS = re.compile(
    r"\[/?(?:pt|en|es|fr|de|it|pl|tr|ru|nl|cs|ar|zh-cn|ja|hu|ko|hi)\]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class TikTokSpeechChunk:
    slide_index: int
    slide_id: str
    source_field: str
    language: str
    text: str
    parameters: dict[str, Any]


def split_at_sentence_boundaries(
    text: str, max_characters: int = MAX_SPEECH_CHUNK_CHARACTERS
) -> list[str]:
    """Split long text at sentence punctuation while preserving every original character."""
    if not isinstance(text, str) or not text.strip():
        return []
    if max_characters < 1:
        raise ValueError("O limite de caracteres por chunk precisa ser positivo.")
    if len(text) <= max_characters:
        return [text]

    pieces: list[str] = []
    start = 0
    for match in re.finditer(r"(?<=[.!?…;:])\s+", text):
        pieces.append(text[start : match.end()])
        start = match.end()
    if start < len(text):
        pieces.append(text[start:])
    if not pieces:
        return [text]

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + len(piece) > max_characters:
            chunks.append(current)
            current = piece
        else:
            current += piece
    if current:
        chunks.append(current)
    return chunks


def _slide_sources(
    slide: MediaSlide, default_language: str
) -> list[tuple[str, str, str]]:
    sources: list[tuple[str, str, str]] = []
    english = slide.en if isinstance(slide.en, str) else ""
    portuguese = slide.pt if isinstance(slide.pt, str) else ""

    # The cue fields are authoritative. narration_text remains only as a
    # backwards-compatible fallback for old projects that have no EN/PT cue.
    if english.strip():
        sources.append(("en", english, "en"))
    if portuguese.strip():
        sources.append(("pt", portuguese, "pt"))
    if sources:
        return sources

    legacy = slide.narration_text if isinstance(slide.narration_text, str) else ""
    if not legacy.strip():
        return []
    if has_language_tags(legacy):
        try:
            return [
                (language, text, "legacy_narration_text")
                for language, text in parse_narration(legacy, default_language)
            ]
        except ValueError:
            # Older drafts sometimes contain an unfinished manual tag. Do not
            # let legacy markup block a render; treat its literal body as the
            # selected fallback language after removing only language tags.
            cleaned = _LEGACY_LANGUAGE_TAGS.sub("", legacy)
            return [(default_language, cleaned, "legacy_narration_text")] if cleaned.strip() else []
    return [(default_language, legacy, "legacy_narration_text")]


def build_project_speech_chunks(
    slides: Iterable[MediaSlide],
    profile: VoiceProfileSnapshot,
    default_language: str = "pt",
    *,
    max_characters: int = MAX_SPEECH_CHUNK_CHARACTERS,
) -> list[TikTokSpeechChunk]:
    """Build ordered EN then PT chunks from cue fields without inserting markup."""
    if default_language not in {"pt", "en"}:
        raise ValueError("Idioma padrão de narração inválido.")

    chunks: list[TikTokSpeechChunk] = []
    for slide_index, slide in enumerate(slides):
        for language, text, source_field in _slide_sources(slide, default_language):
            language_name = "English" if language == "en" else "Portuguese"
            parameters = synthesis_language_parameters(profile, language_name)
            for part in split_at_sentence_boundaries(text, max_characters):
                if part.strip():
                    chunks.append(
                        TikTokSpeechChunk(
                            slide_index=slide_index,
                            slide_id=slide.id,
                            source_field=source_field,
                            language=language,
                            text=part,
                            parameters=dict(parameters),
                        )
                    )
    return chunks
