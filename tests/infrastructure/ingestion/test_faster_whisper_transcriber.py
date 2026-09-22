from pathlib import Path
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
