from typing import Protocol


class HealthRepository(Protocol):
    def is_available(self) -> bool: ...
