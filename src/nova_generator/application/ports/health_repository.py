from typing import Protocol


class HealthRepository(Protocol):
    def is_available(self) -> bool:
        """Return whether the persistence dependency can execute a lightweight query."""
