from nova_generator.application.use_cases.check_health import CheckHealth


class UnavailableRepository:
    def is_available(self) -> bool:
        return False


def test_check_health_is_independent_from_database_or_server() -> None:
    status = CheckHealth(UnavailableRepository()).execute()

    assert status.status == "degraded"
    assert status.database == "unavailable"
