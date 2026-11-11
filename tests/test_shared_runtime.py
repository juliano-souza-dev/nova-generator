from __future__ import annotations

import json
from pathlib import Path

import pytest

from nova_generator.core.shared_runtime import (
    load_shared_runtime_config,
    shared_directory,
    shared_resource,
)


def write_manifest(root: Path) -> None:
    shared_root = root / "shared-runtime"
    (shared_root / "models").mkdir(parents=True)
    (shared_root / "cache").mkdir(parents=True)
    (shared_root / "runtimes").mkdir(parents=True)
    document = {
        "schemaVersion": "1.0",
        "application": {"id": "nova-generator", "name": "Nova Generator"},
        "shared": {
            "enabled": True,
            "root": str(shared_root),
            "directories": {
                "models": str(shared_root / "models"),
                "cache": str(shared_root / "cache"),
                "runtimes": str(shared_root / "runtimes"),
            },
            "files": {},
            "resources": {"ffmpeg": str(shared_root / "tools" / "ffmpeg")},
        },
    }
    (root / "shared.config.json").write_text(
        json.dumps(document), encoding="utf-8"
    )


def test_loads_manifest_from_project_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_manifest(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("NOVA_GENERATOR_SHARED_CONFIG", raising=False)
    load_shared_runtime_config.cache_clear()

    document = load_shared_runtime_config()

    assert document is not None
    assert document["application"]["id"] == "nova-generator"
    assert shared_directory("models", "whisper") == (
        tmp_path / "shared-runtime" / "models" / "whisper"
    )
    assert shared_resource("ffmpeg", "ffmpeg.exe") == (
        tmp_path / "shared-runtime" / "tools" / "ffmpeg" / "ffmpeg.exe"
    )
    load_shared_runtime_config.cache_clear()


def test_returns_none_when_project_is_not_linked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("NOVA_GENERATOR_SHARED_CONFIG", raising=False)
    load_shared_runtime_config.cache_clear()

    assert load_shared_runtime_config() is None
    assert shared_directory("models") is None
    load_shared_runtime_config.cache_clear()


def test_rejects_unsupported_manifest_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_manifest(tmp_path)
    path = tmp_path / "shared.config.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["schemaVersion"] = "9.0"
    path.write_text(json.dumps(document), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("NOVA_GENERATOR_SHARED_CONFIG", raising=False)
    load_shared_runtime_config.cache_clear()

    with pytest.raises(RuntimeError, match="não suportada"):
        load_shared_runtime_config()
    load_shared_runtime_config.cache_clear()
