# Migrations

Execute migrations through Alembic, never by calling `Base.metadata.create_all()`:

```powershell
alembic upgrade head
```

The initial migration creates the durable job table. A failed upgrade is recoverable:

1. Preserve the SQLite file.
2. Inspect `alembic current` and the error log.
3. Correct the migration in a new change when it has reached a shared environment.
4. Retry `alembic upgrade head` from the preserved database.

For local disposable databases only, remove the `data/` directory and run the upgrade again.
