from __future__ import annotations

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
        except (OSError, RuntimeError, ValueError) as exc:
            raise TranscriptionError("Faster-Whisper não conseguiu transcrever a fonte.") from exc
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
        words = tuple(
            TranscriptWordCandidate(
                str(word.word),
                round(float(word.start) * 1000),
                round(float(word.end) * 1000),
                getattr(word, "probability", None),
            )
            for word in FasterWhisperTranscriber._words(segment)
            if getattr(word, "word", "") and getattr(word, "end", 0) > getattr(word, "start", 0)
        )
        return TranscriptCueCandidate(
            round(float(segment.start) * 1000),
            round(float(segment.end) * 1000),
            str(segment.text),
            words,
            language,
        )

    @staticmethod
    def _words(segment: Any) -> Iterable[Any]:
        words = getattr(segment, "words", None)
        return words if words is not None else ()
