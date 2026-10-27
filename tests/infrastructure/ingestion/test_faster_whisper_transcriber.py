from pathlib import Path

import pytest
from types import SimpleNamespace

from nova_generator.infrastructure.ingestion.faster_whisper_transcriber import (
    FasterWhisperTranscriber,
)


class Model:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, source: str, **kwargs):
        self.calls += 1
        return (
            iter(
                [
                    SimpleNamespace(
                        start=1.0,
                        end=2.5,
                        text=" Don't normalize — punctuation! ",
                        words=[
                            SimpleNamespace(word=" Don't", start=1.0, end=1.4, probability=0.9),
                            SimpleNamespace(word=" normalize", start=1.5, end=2.0, probability=0.8),
                        ],
                    )
                ]
            ),
            SimpleNamespace(language="en"),
        )


def test_creates_literal_candidate_and_reuses_worker_model(tmp_path: Path) -> None:
    source = tmp_path / "cut.mp4"
    source.write_bytes(b"media")
    model = Model()
    transcriber = FasterWhisperTranscriber("small", model_factory=lambda *args, **kwargs: model)

    first = transcriber.transcribe(source)
    second = transcriber.transcribe(source)

    assert first.cues[0].text == " Don't normalize — punctuation! "
    assert first.cues[0].words[0].surface == " Don't"
    assert second.language == "en"
    assert model.calls == 2


def test_missing_asr_word_timestamps_do_not_abort_or_change_cue_text(tmp_path: Path) -> None:
    source = tmp_path / "cut.mp4"
    source.write_bytes(b"media")

    class SparseTimingModel:
        def transcribe(self, source: str, **kwargs):
            return (
                iter([
                    SimpleNamespace(
                        start=0.0,
                        end=2.5,
                        text=" Hello world!",
                        words=[
                            SimpleNamespace(word=" Hello", start=None, end=0.6, probability=0.9),
                            SimpleNamespace(word=" world!", start=0.6, end=2.0, probability=0.8),
                            SimpleNamespace(word=" extra", start=2.6, end=2.8, probability=0.9),
                        ],
                    )
                ]),
                SimpleNamespace(language="en"),
            )

    result = FasterWhisperTranscriber(
        "small", model_factory=lambda *args, **kwargs: SparseTimingModel()
    ).transcribe(source)
    assert result.cues[0].text == " Hello world!"
    assert [word.surface for word in result.cues[0].words] == [" world!"]


def test_unexpected_asr_typeerror_is_classified_as_transcription_failure(tmp_path: Path) -> None:
    source = tmp_path / "cut.mp4"
    source.write_bytes(b"media")

    class BrokenModel:
        def transcribe(self, source: str, **kwargs):
            raise TypeError("Private subtitle text must not be surfaced")

    from nova_generator.infrastructure.ingestion.faster_whisper_transcriber import (
        TranscriptionError,
    )

    with pytest.raises(TranscriptionError, match=r"Faster-Whisper.*TypeError"):
        FasterWhisperTranscriber(
            "small", model_factory=lambda *args, **kwargs: BrokenModel()
        ).transcribe(source)
