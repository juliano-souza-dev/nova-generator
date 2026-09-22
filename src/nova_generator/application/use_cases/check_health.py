from dataclasses import dataclass

from nova_generator.application.ports.health_repository import HealthRepository


@dataclass(frozen=True)
class HealthStatus:
    status: str
    database: str


class CheckHealth:
    def __init__(self, repository: HealthRepository) -> None:
        self._repository = repository

    def execute(self) -> HealthStatus:
        available = self._repository.is_available()
        return HealthStatus(
            status="ok" if available else "degraded",
            database="ok" if available else "unavailable",
        )
