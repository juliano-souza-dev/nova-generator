from __future__ import annotations

import logging
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeDownloadError(RuntimeError):
    """Raised when yt-dlp cannot create a usable local MP4 source."""


class YtDlpYoutubeDownloader:
    """Download with the proven legacy format/client matrix into cache staging."""

    FORMATS = (
        "bestvideo+bestaudio/best",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "bv*+ba/b",
        "b[height<=720][ext=mp4]/b[height<=720]/b",
        "bv*[height<=720]+ba/b[height<=720]/b",
        "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
    )
    PLAYER_CLIENTS: tuple[str | None, ...] = (
        None,
        "web_embedded",
        "android_vr",
        "web_safari",
        "tv_simply",
        "all",
    )

    def __init__(
        self,
        factory: Callable[[Any], Any] | None = None,
        command_runner: Callable[..., Any] = subprocess.run,
    ) -> None:
        self._factory = factory
        self._command_runner = command_runner

    def download(self, video: YoutubeVideo, destination_directory: Path) -> Path:
        if self._factory is None:
            try:
                import yt_dlp
            except ModuleNotFoundError as exc:  # pragma: no cover
                raise YoutubeDownloadError("yt-dlp não está instalado.") from exc
            factory = yt_dlp.YoutubeDL
        else:
            factory = self._factory

        destination_directory.mkdir(parents=True, exist_ok=True)
        failures: list[str] = []
        runtime_options = self._runtime_options()
        cookie_options = self._cookie_options(destination_directory)
        for format_selector in self.FORMATS:
            for client in self.PLAYER_CLIENTS:
                self._clean(destination_directory)
                options: dict[str, Any] = {
                    "format": format_selector,
                    "outtmpl": str(destination_directory / "source.%(ext)s"),
                    "merge_output_format": "mp4",
                    "noplaylist": True,
                    "quiet": True,
                    "no_warnings": True,
                    "retries": 3,
                    "fragment_retries": 3,
                    "extractor_retries": 2,
                    "socket_timeout": 25,
                    **runtime_options,
                    **cookie_options,
                    **self._client_options(client),
                }
                label = client or "padrão"
                logging.getLogger(__name__).info(
                    "youtube_download_attempt",
                    extra={
                        "video_id": video.video_id,
                        "player_client": label,
                        "format": format_selector,
                    },
                )
                try:
                    with factory(cast(Any, options)) as downloader:
                        exit_code = downloader.download([video.canonical_url])
                    if exit_code not in (None, 0):
                        raise RuntimeError(f"yt-dlp encerrou com código {exit_code}")
                    candidate = self._candidate(destination_directory)
                    if candidate is None:
                        raise RuntimeError("saída de mídia não encontrada")
                    result = self._normalize_mp4(candidate, destination_directory)
                    logging.getLogger(__name__).info(
                        "youtube_download_succeeded",
                        extra={"video_id": video.video_id, "player_client": label},
                    )
                    return result
                except Exception as exc:
                    failures.append(f"{label} · {format_selector}: {exc}")
        self._clean(destination_directory)
        raise YoutubeDownloadError(
            "Não foi possível baixar o vídeo após todas as alternativas: "
            + "; ".join(failures[-6:])
        )

    def _normalize_mp4(self, candidate: Path, directory: Path) -> Path:
        destination = directory / "source.mp4"
        if candidate.suffix.lower() == ".mp4":
            if candidate != destination:
                candidate.replace(destination)
            return destination
        remuxed = directory / "source-remux.mp4"
        completed = self._command_runner(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(candidate),
                "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart",
                str(remuxed),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if completed.returncode != 0 or not remuxed.is_file() or remuxed.stat().st_size == 0:
            raise RuntimeError("FFmpeg não conseguiu normalizar a mídia para MP4")
        remuxed.replace(destination)
        return destination

    @staticmethod
    def _clean(directory: Path) -> None:
        for old in directory.glob("source*"):
            if old.is_file():
                old.unlink(missing_ok=True)

    @staticmethod
    def _candidate(directory: Path) -> Path | None:
        candidates = sorted(
            (
                path
                for path in directory.glob("source.*")
                if path.is_file()
                and path.stat().st_size > 0
                and path.suffix.lower() not in {".part", ".ytdl"}
            ),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
        return candidates[0] if candidates else None

    @classmethod
    def _runtime_options(cls) -> dict[str, Any]:
        runtimes: dict[str, dict[str, str]] = {}
        for name, executable, minimum in (
            ("deno", "deno", (2, 3, 0)),
            ("node", "node", (22, 0, 0)),
            ("quickjs", "qjs", (0,)),
        ):
            path = shutil.which(executable)
            if path and cls._version(path) >= minimum:
                runtimes[name] = {"path": path}
        return {"js_runtimes": runtimes} if runtimes else {}

    @staticmethod
    def _version(executable: str) -> tuple[int, ...]:
        try:
            result = subprocess.run(
                [executable, "--version"], capture_output=True, text=True, timeout=8
            )
        except (OSError, subprocess.TimeoutExpired):
            return ()
        match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", result.stdout or result.stderr)
        return tuple(int(value or 0) for value in match.groups()) if match else ()

    @staticmethod
    def _cookie_options(directory: Path) -> dict[str, Any]:
        for candidate in (directory / "cookies.txt", Path.cwd() / "cookies.txt"):
            if candidate.is_file() and candidate.stat().st_size > 0:
                return {"cookiefile": str(candidate)}
        return {}

    @staticmethod
    def _client_options(client: str | None) -> dict[str, Any]:
        return {"extractor_args": {"youtube": {"player_client": [client]}}} if client else {}
