"""Versioned, isolated TikTok Media project contract (never the iHub editorial contract)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

MediaFormat = Literal["carousel", "lesson_video", "lyrics_video"]
MediaTheme = Literal["ihub", "midnight", "warm"]


class MediaSlide(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=80)
    kind: Literal["cover", "lesson", "example", "challenge", "lyric"] = "lesson"
    heading: str = Field(default="", max_length=120)
    en: str = Field(default="", max_length=600)
    pt: str = Field(default="", max_length=800)
    note: str = Field(default="", max_length=900)
    highlight: str = Field(default="", max_length=120)
    speaker: str = Field(default="", max_length=100)
    duration_ms: int = Field(default=4500, ge=1000, le=20000)


class MediaProject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract: Literal["nova-tiktok-media/1"] = "nova-tiktok-media/1"
    id: UUID = Field(default_factory=uuid4)
    title: str = Field(min_length=1, max_length=140)
    format: MediaFormat = "carousel"
    theme: MediaTheme = "ihub"
    source_project_id: UUID | None = None
    revision: int = Field(default=1, ge=1)
    slides: list[MediaSlide] = Field(min_length=1, max_length=30)
    audio_filename: Literal["audio.mp3", "audio.wav", "audio.ogg"] | None = None

    @model_validator(mode="after")
    def unique_slide_ids(self) -> MediaProject:
        if len({slide.id for slide in self.slides}) != len(self.slides):
            raise ValueError("Cada quadro precisa de um ID diferente")
        return self


class MediaProjectEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=140)
    format: MediaFormat
    theme: MediaTheme
    source_project_id: UUID | None = None
    slides: list[MediaSlide] = Field(min_length=1, max_length=30)


def new_media_project(title: str, format: MediaFormat) -> MediaProject:
    return MediaProject(
        title=title,
        format=format,
        slides=[
            MediaSlide(
                kind="lyric" if format == "lyrics_video" else "cover",
                heading="SUA PRÓXIMA PUBLICAÇÃO",
                en="Your English, in context.",
                pt="Inglês que faz sentido.",
                note="Edite este quadro para começar.",
            )
        ],
    )
