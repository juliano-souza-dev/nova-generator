"""Extract only the YouTube source and exact scene window from iHub exports."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from nova_generator.application.use_cases.manage_projects import ProjectCommandError
from nova_generator.domain.media.youtube import InvalidYoutubeUrl, YoutubeVideo

MAX_EXPORT_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class IHubVideoCut:
    youtube_url: str
    start_ms: int
    end_ms: int


def extract_ihub_video_cut(raw: bytes) -> IHubVideoCut:
    if not raw or len(raw) > MAX_EXPORT_BYTES:
        raise ProjectCommandError("O JSON do iHub está vazio ou excede 10 MB.")
    try:
        data: Any = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProjectCommandError("O arquivo não contém um JSON válido em UTF-8.") from error
    if not isinstance(data, dict):
        raise ProjectCommandError("O JSON do iHub deve ser um objeto.")
    if data.get("schema") not in (None, "immersionhub-super-json"):
        raise ProjectCommandError("O arquivo não usa o formato de exportação do iHub.")
    export = data.get("export")
    if isinstance(export, dict) and export.get("kind") not in (None, "hub_generator_roundtrip"):
        raise ProjectCommandError("Este tipo de exportação do iHub não é compatível.")
    if data.get("schema") is None and (
        not isinstance(export, dict) or export.get("kind") != "hub_generator_roundtrip"
    ):
        raise ProjectCommandError("Selecione um JSON exportado pelo iHub.")

    sections = [data[key] for key in ("project", "kit") if isinstance(data.get(key), dict)]
    if not sections:
        raise ProjectCommandError("O JSON não contém project ou kit com dados do corte.")

    videos: list[YoutubeVideo] = []
    for section in sections:
        for key in ("youtube_url", "youtube", "youtube_video_id"):
            value = section.get(key)
            if value is None or value == "":
                continue
            if not isinstance(value, str):
                raise ProjectCommandError("O identificador do vídeo deve ser texto.")
            try:
                video = (
                    YoutubeVideo(value.strip())
                    if key == "youtube_video_id"
                    else YoutubeVideo.from_url(value.strip())
                )
            except InvalidYoutubeUrl as error:
                raise ProjectCommandError("O JSON contém um vídeo do YouTube inválido.") from error
            videos.append(video)
    if not videos:
        raise ProjectCommandError("O JSON não contém um vídeo do YouTube.")
    if any(video.video_id != videos[0].video_id for video in videos[1:]):
        raise ProjectCommandError("project e kit indicam vídeos diferentes.")

    def read_time(key: str) -> int:
        values = [section[key] for section in sections if key in section]
        if not values:
            raise ProjectCommandError(f"O JSON não contém {key}.")
        if any(type(value) is not int or value < 0 for value in values):
            raise ProjectCommandError(f"{key} deve ser um número inteiro de milissegundos.")
        if len(set(values)) != 1:
            raise ProjectCommandError(f"Os valores de {key} em project e kit são diferentes.")
        return values[0]

    start_ms = read_time("scene_start_ms")
    end_ms = read_time("scene_end_ms")
    if end_ms <= start_ms:
        raise ProjectCommandError("O final do corte precisa ser posterior ao início.")
    return IHubVideoCut(videos[0].canonical_url, start_ms, end_ms)
