from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

ProgressCallback = Callable[[float, str, str], None]


def _emit(callback: ProgressCallback | None, percent: float, stage: str, message: str) -> None:
    if callback:
        callback(float(percent), str(stage), str(message))


def _yt_dlp_command(*args: str) -> list[str]:
    return [sys.executable, "-m", "yt_dlp", *args]


def _command_version(command: str) -> tuple[int, ...]:
    try:
        result = subprocess.run([command, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8)
    except (OSError, subprocess.TimeoutExpired):
        return ()
    if result.returncode != 0:
        return ()
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", result.stdout or result.stderr)
    return tuple(int(v or 0) for v in match.groups()) if match else ()


def _javascript_runtimes() -> dict[str, dict[str, str]]:
    runtimes: dict[str, dict[str, str]] = {}
    deno = shutil.which("deno")
    if deno and _command_version(deno) >= (2, 3, 0):
        runtimes["deno"] = {"path": deno}
    node = shutil.which("node")
    if node and _command_version(node) >= (22, 0, 0):
        runtimes["node"] = {"path": node}
    qjs = shutil.which("qjs")
    if qjs:
        runtimes["quickjs"] = {"path": qjs}
    return runtimes


def _runtime_cli_args() -> list[str]:
    runtimes = _javascript_runtimes()
    if "deno" in runtimes:
        return ["--js-runtimes", f"deno:{runtimes['deno']['path']}"]
    if "node" in runtimes:
        return ["--js-runtimes", f"node:{runtimes['node']['path']}"]
    return []


def _runtime_api_args() -> dict[str, Any]:
    runtimes = _javascript_runtimes()
    return {"js_runtimes": runtimes} if runtimes else {}


def _player_clients(preferred: str | None = None) -> list[str | None]:
    values: list[str | None] = [preferred or None, None, "web_embedded", "android_vr", "web_safari", "tv_simply", "all"]
    result: list[str | None] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def _cli_client_args(client: str | None) -> list[str]:
    return ["--extractor-args", f"youtube:player_client={client}"] if client else []


def _api_client_args(client: str | None) -> dict[str, Any]:
    return {"extractor_args": {"youtube": {"player_client": [client]}}} if client else {}


def _cookie_args(directory: Path) -> dict[str, Any]:
    for candidate in (directory / "cookies.txt", Path(__file__).resolve().parent / "cookies.txt"):
        if candidate.is_file() and candidate.stat().st_size > 0:
            return {"cookiefile": str(candidate)}
    return {}


def _ensure_ytdlp() -> None:
    try:
        import yt_dlp  # noqa: F401
    except ModuleNotFoundError as exc:
        raise RuntimeError("yt-dlp não está instalado. Execute install.bat novamente.") from exc


def inspect_video(url: str) -> dict[str, Any]:
    _ensure_ytdlp()
    failures: list[str] = []
    runtime_args = _runtime_cli_args()
    for client in _player_clients():
        result = subprocess.run(
            _yt_dlp_command("--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", *runtime_args, *_cli_client_args(client), str(url)),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            failures.append(f"{client or 'padrão'}: {(result.stderr or result.stdout or 'erro não informado').strip()}")
            continue
        try:
            info = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            failures.append(f"{client or 'padrão'}: metadados JSON inválidos ({exc})")
            continue
        if isinstance(info, dict):
            info["_player_client"] = client or ""
            return info
    detail = "\n".join(failures[-4:])
    raise RuntimeError("Não foi possível consultar o vídeo no YouTube.\n" + detail)


def inspect_embed_support(url: str) -> dict[str, Any]:
    """Valida o vídeo e confirma se o YouTube permite reprodução incorporada."""
    info = inspect_video(url)
    raw = info.get("playable_in_embed")
    title = str(info.get("title") or "").strip()
    video_id = str(info.get("id") or "").strip()

    if raw is False:
        return {"embeddable": False, "video_id": video_id, "title": title, "reason": "O proprietário deste vídeo desativou a reprodução incorporada."}
    if raw is True:
        return {"embeddable": True, "video_id": video_id, "title": title, "reason": ""}
    if isinstance(raw, str) and raw.strip().lower() in {"whitelist", "never", "false", "no"}:
        return {"embeddable": False, "video_id": video_id, "title": title, "reason": f"O vídeo possui restrição de incorporação ({raw})."}

    result = subprocess.run(
        _yt_dlp_command("--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", *_runtime_cli_args(), *_cli_client_args("web_embedded"), str(url)),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode == 0:
        try:
            embedded_info = json.loads(result.stdout)
        except json.JSONDecodeError:
            embedded_info = {}
        if not isinstance(embedded_info, dict) or embedded_info.get("playable_in_embed") is not False:
            return {"embeddable": True, "video_id": video_id, "title": title, "reason": ""}

    detail = (result.stderr or result.stdout or "").strip()
    return {
        "embeddable": False,
        "video_id": video_id,
        "title": title,
        "reason": detail.splitlines()[-1] if detail else "O cliente de reprodução incorporada do YouTube recusou o vídeo.",
    }


def _format_bytes(value: int | float | None) -> str:
    if not value:
        return ""
    number = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if number < 1024 or unit == "GB":
            return f"{number:.1f} {unit}"
        number /= 1024
    return ""


def download_video(url: str, project_directory: str | Path, *, progress: ProgressCallback | None = None, preferred_player_client: str | None = None, highest_quality: bool = True) -> Path:
    _ensure_ytdlp()
    import yt_dlp

    directory = Path(project_directory)
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / "original.mp4"
    temporary_stem = "source_video_download"

    def clean() -> None:
        for old in directory.glob(f"{temporary_stem}*"):
            try:
                old.unlink()
            except OSError:
                pass

    def hook(data: dict[str, Any]) -> None:
        if str(data.get("status") or "") != "downloading":
            return
        downloaded = float(data.get("downloaded_bytes", 0) or 0)
        total = float(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
        percent = max(0.0, min(100.0, downloaded / total * 100.0)) if total else 10.0
        message = f"{_format_bytes(downloaded)} de {_format_bytes(total)}" if total else f"{_format_bytes(downloaded)} recebidos"
        _emit(progress, percent, "Baixando vídeo", message)

    clean()
    formats = [
        "bestvideo+bestaudio/best",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "bv*+ba/b",
        "b[height<=720][ext=mp4]/b[height<=720]/b",
        "bv*[height<=720]+ba/b[height<=720]/b",
        "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
    ]
    clients = _player_clients(preferred_player_client)
    failures: list[str] = []
    total_attempts = len(formats) * len(clients)
    attempt = 0

    for selector in formats:
        for client in clients:
            attempt += 1
            clean()
            options: dict[str, Any] = {
                "format": selector,
                "outtmpl": str(directory / f"{temporary_stem}.%(ext)s"),
                "merge_output_format": "mp4",
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
                "retries": 3,
                "fragment_retries": 3,
                "extractor_retries": 2,
                "socket_timeout": 25,
                "progress_hooks": [hook],
                **_runtime_api_args(),
                **_cookie_args(directory),
                **_api_client_args(client),
            }
            _emit(progress, 1, "Baixando vídeo", f"Tentativa {attempt}/{total_attempts} · cliente {client or 'padrão'}")
            try:
                with yt_dlp.YoutubeDL(options) as downloader:
                    code = downloader.download([str(url)])
                if code not in (None, 0):
                    raise RuntimeError(f"yt-dlp encerrou com código {code}.")
                candidates = sorted(
                    [p for p in directory.glob(f"{temporary_stem}.*") if p.is_file() and p.stat().st_size > 0 and p.suffix.lower() not in {".part", ".ytdl"}],
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                if not candidates:
                    raise RuntimeError("O vídeo temporário não foi criado.")
                candidate = candidates[0]
                if candidate.suffix.lower() == ".mp4":
                    candidate.replace(destination)
                else:
                    remuxed = directory / f"{temporary_stem}_remux.mp4"
                    result = subprocess.run(
                        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(candidate), "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", str(remuxed)],
                        capture_output=True, text=True, encoding="utf-8", errors="replace",
                    )
                    if result.returncode != 0 or not remuxed.is_file():
                        raise RuntimeError("FFmpeg não conseguiu normalizar o vídeo para MP4.\n" + result.stderr.strip())
                    remuxed.replace(destination)
                clean()
                if destination.is_file() and destination.stat().st_size > 0:
                    return destination
                raise RuntimeError("original.mp4 não foi criado.")
            except Exception as exc:
                failures.append(f"{client or 'padrão'} · {selector}: {exc}")

    clean()
    raise RuntimeError("Não foi possível baixar o vídeo após múltiplas estratégias do YouTube.\n" + "\n".join(failures[-6:]))
