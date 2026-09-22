from __future__ import annotations

from pathlib import Path
from typing import Any

from nova_generator.application.use_cases.ingest_scene_media import IngestSceneMedia
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


class IngestSceneMediaJobHandler:
    """Worker adapter; its output is review data and never editorial mutation."""

    def __init__(self, use_case: IngestSceneMedia) -> None:
        self._use_case = use_case

    def __call__(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        value = job.input
        execution.raise_if_cancelled()
        result = self._use_case.execute(
            source=Path(_string(value, "source")),
            output=Path(_string(value, "output")),
            start_ms=_integer(value, "start_ms"),
            end_ms=_integer(value, "end_ms"),
            language=value.get("language") if isinstance(value.get("language"), str) else None,
            bucket_ms=_integer(value, "bucket_ms", default=40),
        )
        execution.heartbeat()
        return {
            "cut_file": str(result.cut_file),
            "waveform": {
                "sample_rate_hz": result.waveform.sample_rate_hz,
                "bucket_ms": result.waveform.bucket_ms,
                "peaks": list(result.waveform.peaks),
            },
            "transcript_candidate": {
                "engine": result.transcript_candidate.engine,
                "model": result.transcript_candidate.model,
                "language": result.transcript_candidate.language,
                "cues": [
                    {
                        "start_ms": cue.start_ms,
                        "end_ms": cue.end_ms,
                        "text": cue.text,
                        "words": [
                            {
                                "surface": word.surface,
                                "start_ms": word.start_ms,
                                "end_ms": word.end_ms,
                                "probability": word.probability,
                            }
                            for word in cue.words
                        ],
                    }
                    for cue in result.transcript_candidate.cues
                ],
            },
        }


def _string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"job input requires {key}")
    return result


def _integer(value: dict[str, Any], key: str, *, default: int | None = None) -> int:
    result = value.get(key, default)
    if not isinstance(result, int) or isinstance(result, bool) or result < 0:
        raise ValueError(f"job input requires non-negative integer {key}")
    return result
