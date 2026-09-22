from pathlib import Path

from nova_generator.application.use_cases.ingest_scene_media import IngestSceneMedia
from nova_generator.domain.ingestion import (
    TranscriptCandidate,
    TranscriptCueCandidate,
    TranscriptWordCandidate,
    WaveformMetadata,
)


class Cutter:
    def cut(self, request):
        request.output.parent.mkdir(parents=True, exist_ok=True)
        request.output.write_bytes(b"mp4")
        return request.output


class Waveform:
    def generate(self, source, *, bucket_ms=40):
        return WaveformMetadata(8000, bucket_ms, (0.1, 0.9))


class Transcriber:
    def transcribe(self, source, *, language=None):
        return TranscriptCandidate(
            "faster-whisper",
            "small",
            source,
            language,
            (
                TranscriptCueCandidate(
                    0, 200, "Hello!", (TranscriptWordCandidate("Hello!", 0, 200),), language
                ),
            ),
        )


def test_ingestion_returns_review_candidate_without_editorial_repository(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    result = IngestSceneMedia(Cutter(), Waveform(), Transcriber()).execute(
        source=source,
        output=tmp_path / "project" / "cut.mp4",
        start_ms=120,
        end_ms=800,
        language="en",
    )

    assert result.cut_file.name == "cut.mp4"
    assert result.waveform.peaks == (0.1, 0.9)
    assert result.transcript_candidate.cues[0].text == "Hello!"
    assert result.transcript_candidate.cues[0].words[0].surface == "Hello!"
