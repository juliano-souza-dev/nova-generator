from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


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
    api_prefix: str = "/api"

    def ensure_database_directory(self) -> None:
        """Create the local parent directory when the configured database is SQLite."""
        if not self.database_url.startswith("sqlite:///") or self.database_url.endswith(":memory:"):
            return
        database_path = self.database_url.removeprefix("sqlite:///")
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()

