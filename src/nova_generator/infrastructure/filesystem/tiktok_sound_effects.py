"""Persistent global sound-effects library for TikTok Media."""
from __future__ import annotations

import json
import re
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import BaseModel, Field

_NAME = re.compile(r"[^\w .()-]+", re.UNICODE)
_ALLOWED = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg"}


class SoundEffect(BaseModel):
    id: UUID
    name: str = Field(min_length=1, max_length=80)
    filename: str
    media_type: str
    size_bytes: int


class SoundEffectLibrary:
    def __init__(self, cache_root: Path):
        self.root = cache_root / "tiktok-media" / "sound-effects"
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest = self.root / "library.json"

    def _items(self) -> list[dict]:
        try:
            value = json.loads(self.manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return value if isinstance(value, list) else []

    def list(self) -> list[SoundEffect]:
        valid = []
        for raw in self._items():
            try:
                item = SoundEffect.model_validate(raw)
                path = self.root / item.filename
                if path.is_file() and path.stat().st_size == item.size_bytes:
                    valid.append(item)
            except (ValueError, OSError):
                continue
        return sorted(valid, key=lambda item: item.name.casefold())

    def _save(self, items: list[SoundEffect]) -> None:
        temporary = self.manifest.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                [item.model_dump(mode="json") for item in items],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        temporary.replace(self.manifest)

    def add(self, name: str, suffix: str, content: bytes) -> SoundEffect:
        clean = " ".join(_NAME.sub("", name).split()).strip(" .-")
        if not clean:
            raise ValueError("Informe um nome válido para o efeito.")
        if len(clean) > 80:
            raise ValueError("O nome deve ter até 80 caracteres.")
        if suffix not in _ALLOWED:
            raise ValueError("Envie áudio MP3, WAV ou OGG.")
        identifier = uuid4()
        filename = f"{identifier.hex}{suffix}"
        (self.root / filename).write_bytes(content)
        item = SoundEffect(
            id=identifier,
            name=clean,
            filename=filename,
            media_type=_ALLOWED[suffix],
            size_bytes=len(content),
        )
        self._save([*self.list(), item])
        return item

    def rename(self, identifier: UUID, name: str) -> SoundEffect:
        clean = " ".join(_NAME.sub("", name).split()).strip(" .-")
        if not clean or len(clean) > 80:
            raise ValueError("O nome deve ter entre 1 e 80 caracteres.")
        items = self.list()
        found = next((item for item in items if item.id == identifier), None)
        if found is None:
            raise FileNotFoundError("Efeito sonoro não encontrado.")
        updated = found.model_copy(update={"name": clean})
        self._save([updated if item.id == identifier else item for item in items])
        return updated

    def delete(self, identifier: UUID) -> None:
        items = self.list()
        found = next((item for item in items if item.id == identifier), None)
        if found is None:
            raise FileNotFoundError("Efeito sonoro não encontrado.")
        sound_value = f"library:{identifier.hex}"
        for project_dir in self.root.parent.iterdir():
            project_file = project_dir / "project.json"
            if not project_dir.is_dir() or project_dir == self.root or not project_file.is_file():
                continue
            try:
                project = json.loads(project_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            graphics = project.get("motion_graphics", []) if isinstance(project, dict) else []
            if any(
                isinstance(graphic, dict) and graphic.get("sound") == sound_value
                for graphic in graphics
            ):
                raise ValueError(
                    "Este efeito está associado a um projeto. Troque o som no Motion Graphics antes de excluí-lo."
                )
        (self.root / found.filename).unlink(missing_ok=True)
        self._save([item for item in items if item.id != identifier])

    def get(self, identifier: UUID) -> tuple[SoundEffect, Path] | None:
        item = next((item for item in self.list() if item.id == identifier), None)
        return (item, self.root / item.filename) if item else None
