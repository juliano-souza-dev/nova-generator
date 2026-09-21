from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from nova_generator.core.settings import get_settings


def test_editorial_migration_upgrades_and_downgrades(tmp_path, monkeypatch) -> None:
    database = tmp_path / "migration.db"
    monkeypatch.setenv("NOVA_GENERATOR_DATABASE_URL", f"sqlite:///{database}")
    get_settings.cache_clear()
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    tables = set(inspect(create_engine(f"sqlite:///{database}")).get_table_names())
    assert {"projects", "scenes", "cues", "word_timings", "editorial_revisions"} <= tables

    command.downgrade(config, "20260921_0001")
    tables = set(inspect(create_engine(f"sqlite:///{database}")).get_table_names())
    assert "projects" not in tables
    assert "jobs" in tables
    get_settings.cache_clear()
