import os
import shutil
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from nova_generator.core.shared_runtime import shared_directory, shared_resource


def _global_resource_root() -> Path:
    """Return a per-user data directory outside the source checkout."""
    configured = os.environ.get("NOVA_GENERATOR_HOME")
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        return (Path(base) if base else Path.home() / "AppData" / "Local") / "NovaGenerator"
    base = os.environ.get("XDG_DATA_HOME")
    return (Path(base).expanduser() if base else Path.home() / ".local" / "share") / "NovaGenerator"


def _global_resource_path(*parts: str) -> Path:
    return _global_resource_root().joinpath(*parts)


class Settings(BaseSettings):
    """Runtime configuration loaded from environment variables and `.env`."""

    model_config = SettingsConfigDict(
        env_prefix="NOVA_GENERATOR_",
        env_file=".env",
        extra="ignore",
    )

    app_name: str = "Nova Generator"
    environment: str = "development"
    database_url: str = "sqlite:///./data/nova-generator.db"
    media_cache_root: Path = Field(
        default_factory=lambda: shared_directory("cache", "nova-generator-media")
        or Path("media_cache")
    )
    project_root: Path = Path("data/projects")
    whisper_model: str = "small"
    whisper_model_root: Path = Field(
        default_factory=lambda: shared_directory("models", "whisper")
        or _global_resource_path("models", "whisper")
    )
    chatterbox_model_root: Path = Field(
        default_factory=lambda: shared_directory("models", "chatterbox")
        or _global_resource_path("models", "chatterbox")
    )
    chatterbox_model_file: Path | None = None
    qwen_model_root: Path = Field(
        default_factory=lambda: shared_directory("models", "qwen3-tts")
        or _global_resource_path("models", "qwen3-tts")
    )
    qwen_venv_root: Path = Field(
        default_factory=lambda: shared_directory("runtimes", "qwen")
        or _global_resource_path("environments", "qwen")
    )
    huggingface_cache_root: Path = Field(
        default_factory=lambda: shared_directory("cache", "huggingface")
        or _global_resource_path("cache", "huggingface")
    )
    qwen_tts_python: str | None = None
    ffmpeg_executable: str = Field(
        default_factory=lambda: str(
            shared_resource("ffmpeg", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            or "ffmpeg"
        )
    )
    ffprobe_executable: str = Field(
        default_factory=lambda: str(
            shared_resource("ffmpeg", "ffprobe.exe" if os.name == "nt" else "ffprobe")
            or "ffprobe"
        )
    )
    ytdlp_executable: str = "yt-dlp"
    cloudflared_executable: str = "cloudflared"
    cloudflared_enabled: bool = False
    groq_api_key: str | None = None
    groq_editorial_model: str = "openai/gpt-oss-20b"
    api_prefix: str = "/api"

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        if not value.startswith("sqlite:///") or not value.removeprefix("sqlite:///"):
            raise ValueError("NOVA_GENERATOR_DATABASE_URL deve ser uma URL sqlite:/// válida")
        return value

    @field_validator(
        "media_cache_root", "project_root", "whisper_model_root", "chatterbox_model_root",
        "qwen_model_root", "qwen_venv_root", "huggingface_cache_root"
    )
    @classmethod
    def validate_path(cls, value: Path) -> Path:
        if not str(value).strip() or value.exists() and not value.is_dir():
            raise ValueError(f"Diretório inválido: {value}")
        return value

    def validate_runtime(self) -> None:
        """Fail with an actionable message for tools required by the selected deployment."""
        required = ("ffmpeg_executable", "ffprobe_executable", "ytdlp_executable")
        if self.cloudflared_enabled:
            required += ("cloudflared_executable",)
        for name in required:
            executable = getattr(self, name)
            if shutil.which(executable) is None:
                raise RuntimeError(
                    f"{name}={executable!r} não encontrado; instale o comando ou configure "
                    f"NOVA_GENERATOR_{name.upper()}."
                )
        for name in ("media_cache_root", "project_root"):
            directory = getattr(self, name)
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                raise RuntimeError(
                    f"{name}={directory}: diretório indisponível: {error}"
                ) from error

    def ensure_database_directory(self) -> None:
        """Create the local parent directory when the configured database is SQLite."""
        if not self.database_url.startswith("sqlite:///") or self.database_url.endswith(":memory:"):
            return
        database_path = self.database_url.removeprefix("sqlite:///")
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
