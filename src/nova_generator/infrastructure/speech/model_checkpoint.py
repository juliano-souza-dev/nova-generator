"""Resolve and fingerprint the actual local Chatterbox Nano checkpoint."""

from __future__ import annotations

import os
from functools import lru_cache
from hashlib import file_digest
from pathlib import Path

from nova_generator.core.settings import Settings

CHECKPOINT_NAME = "t3_nano_v1.safetensors"


def checkpoint_file(settings: Settings) -> Path:
    if settings.chatterbox_model_file is not None:
        candidate = settings.chatterbox_model_file.expanduser()
        if candidate.is_file():
            return candidate
        raise ValueError(f"Checkpoint Chatterbox Nano não encontrado: {candidate}")
    hub_root = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
    roots = [
        settings.chatterbox_model_root.expanduser(),
        hub_root / "models--ResembleAI--chatterbox-nano" / "snapshots",
    ]
    candidates = [
        path
        for root in roots
        if root.is_dir()
        for path in root.rglob(CHECKPOINT_NAME)
        if path.is_file()
    ]
    if not candidates:
        raise ValueError(
            "Checkpoint Chatterbox Nano ausente. Configure "
            "NOVA_GENERATOR_CHATTERBOX_MODEL_FILE para t3_nano_v1.safetensors."
        )
    return max(candidates, key=lambda path: path.stat().st_mtime)


def checkpoint_sha256(settings: Settings) -> str:
    path = checkpoint_file(settings)
    stat = path.stat()
    return _hash_file(str(path.resolve()), stat.st_size, stat.st_mtime_ns)


@lru_cache(maxsize=8)
def _hash_file(path: str, size: int, mtime_ns: int) -> str:
    with Path(path).open("rb") as file:
        return file_digest(file, "sha256").hexdigest()
