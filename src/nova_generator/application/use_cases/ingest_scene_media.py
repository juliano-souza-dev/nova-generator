from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from nova_generator.application.ports.source_cutter import SourceCutter
from nova_generator.application.ports.speech_transcriber import SpeechTranscriber
from nova_generator.application.ports.waveform_generator import WaveformGenerator
from nova_generator.domain.ingestion import SourceCut, TranscriptCandidate, WaveformMetadata


@dataclass(frozen=True)
class IngestSceneMediaResult:
    cut_file: Path
    waveform: WaveformMetadata
    transcript_candidate: TranscriptCandidate


class IngestSceneMedia:
    """Build review inputs without mutating approved cues or their translations."""

    def __init__(
        self,
        cutter: SourceCutter,
        waveform: WaveformGenerator,
        transcriber: SpeechTranscriber,
    ) -> None:
        self._cutter = cutter
        self._waveform = waveform
        self._transcriber = transcriber

    def execute(
        self,
        *,
        source: Path,
        output: Path,
        start_ms: int,
        end_ms: int,
        language: str | None = None,
        bucket_ms: int = 40,
    ) -> IngestSceneMediaResult:
        cut = self._cutter.cut(SourceCut(source, output, start_ms, end_ms))
        return IngestSceneMediaResult(
            cut_file=cut,
            waveform=self._waveform.generate(cut, bucket_ms=bucket_ms),
            transcript_candidate=self._transcriber.transcribe(cut, language=language),
        )
