"""Small, process-local telemetry with an explicit safe field allowlist."""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import UTC, datetime
from threading import Lock

SAFE_FIELDS = frozenset(
    {
        "request_id",
        "job_id",
        "project_id",
        "artifact_id",
        "worker_id",
        "kind",
        "attempt",
        "status",
        "method",
        "route",
        "duration_ms",
        "count",
        "result",
    }
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "event": record.getMessage(),
        }
        payload.update(
            {
                key: value
                for key, value in record.__dict__.items()
                if key in SAFE_FIELDS and isinstance(value, (str, int, float, bool))
            }
        )
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def configure_json_logging() -> logging.Logger:
    logger = logging.getLogger("nova_generator")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class OperationalMetrics:
    """Aggregate counts and durations without storing inputs, text, tokens or URLs."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._counts: Counter[str] = Counter()
        self._durations_ms: Counter[str] = Counter()

    def record(self, name: str, *, duration_ms: int | None = None) -> None:
        with self._lock:
            self._counts[name] += 1
            if duration_ms is not None:
                self._durations_ms[name] += duration_ms
        configure_json_logging().info(
            "metric_recorded", extra={"kind": name, "duration_ms": duration_ms or 0}
        )

    def snapshot(self) -> dict[str, dict[str, int]]:
        with self._lock:
            return {"counts": dict(self._counts), "duration_ms": dict(self._durations_ms)}


metrics = OperationalMetrics()
