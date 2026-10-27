from __future__ import annotations

import logging
import math
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from nova_generator.domain.ingestion import (
    TranscriptCandidate,
    TranscriptCueCandidate,
    TranscriptWordCandidate,
)


class TranscriptionError(RuntimeError):
    pass


ModelFactory = Callable[..., Any]


class FasterWhisperTranscriber:
    """Lazy Faster-Whisper adapter suitable for a persistent worker process."""

    def __init__(
        self,
        model_name: str,
        *,
        device: str = "auto",
        compute_type: str = "auto",
        model_factory: ModelFactory | None = None,
    ) -> None:
        self._model_name, self._device, self._compute_type = model_name, device, compute_type
        self._factory = model_factory
        self._model: Any | None = None

    def transcribe(self, source: Path, *, language: str | None = None) -> TranscriptCandidate:
        if not source.is_file():
            raise TranscriptionError("A fonte para ASR não existe.")
        try:
            segments, info = self._get_model().transcribe(
                str(source), language=language, word_timestamps=True, vad_filter=True
            )
            detected_language = getattr(info, "language", language)
            cues = tuple(self._cue(segment, detected_language) for segment in segments)
        except TranscriptionError:
            raise
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            raise TranscriptionError(
                f"Faster-Whisper não conseguiu transcrever a fonte ({type(exc).__name__})."
            ) from exc
        if not cues:
            raise TranscriptionError("Faster-Whisper não retornou candidatos editoriais.")
        return TranscriptCandidate(
            "faster-whisper", self._model_name, source, detected_language, cues
        )

    def _get_model(self) -> Any:
        if self._model is None:
            factory = self._factory or self._default_factory()
            self._model = factory(
                self._model_name, device=self._device, compute_type=self._compute_type
            )
        return self._model

    @staticmethod
    def _default_factory() -> ModelFactory:
        try:
            from importlib import import_module

            whisper_model = import_module("faster_whisper").WhisperModel
        except ImportError as exc:
            raise TranscriptionError(
                "Instale o extra de ASR para usar Faster-Whisper neste worker."
            ) from exc
        return whisper_model

    @staticmethod
    def _cue(segment: Any, language: str | None) -> TranscriptCueCandidate:
        cue_start_ms = round(float(segment.start) * 1000)
        cue_end_ms = round(float(segment.end) * 1000)
        words: list[TranscriptWordCandidate] = []
        skipped = 0
        for word in FasterWhisperTranscriber._words(segment):
            surface = getattr(word, "word", "")
            if not surface:
                continue
            raw_start = getattr(word, "start", None)
            raw_end = getattr(word, "end", None)
            if raw_start is None or raw_end is None:
                skipped += 1
                continue
            try:
                start = float(raw_start)
                end = float(raw_end)
            except (TypeError, ValueError):
                skipped += 1
                continue
            if not (math.isfinite(start) and math.isfinite(end)):
                skipped += 1
                continue
            word_start_ms = round(start * 1000)
            word_end_ms = round(end * 1000)
            if (
                word_start_ms < cue_start_ms
                or word_end_ms > cue_end_ms
                or word_end_ms <= word_start_ms
            ):
                skipped += 1
                continue
            probability = getattr(word, "probability", None)
            if probability is not None:
                try:
                    probability = float(probability)
                except (TypeError, ValueError):
                    probability = None
                if probability is not None and (
                    not math.isfinite(probability) or not 0 <= probability <= 1
                ):
                    probability = None
            words.append(
                TranscriptWordCandidate(
                    str(surface), word_start_ms, word_end_ms, probability
                )
            )
        if skipped:
            # Preserve the complete cue text; never fabricate missing word timestamps.
            logging.getLogger("nova_generator").warning(
                "asr_word_timing_unavailable", extra={"count": skipped}
            )
        return TranscriptCueCandidate(
            cue_start_ms, cue_end_ms, str(segment.text), tuple(words), language
        )

    @staticmethod
    def _words(segment: Any) -> Iterable[Any]:
        words = getattr(segment, "words", None)
        return words if words is not None else ()
