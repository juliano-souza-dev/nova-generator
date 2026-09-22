from functools import lru_cache

from sqlalchemy.orm import Session, sessionmaker

from nova_generator.application.use_cases.check_health import CheckHealth
from nova_generator.application.use_cases.manage_jobs import CancelJob, EnqueueJob
from nova_generator.core.settings import get_settings
from nova_generator.infrastructure.database.health_repository import SqlAlchemyHealthRepository
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.database.session import (
    create_database_engine,
    create_session_factory,
)


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    settings = get_settings()
    settings.ensure_database_directory()
    return create_session_factory(create_database_engine(settings.database_url))


def get_check_health() -> CheckHealth:
    return CheckHealth(SqlAlchemyHealthRepository(get_session_factory()))


def get_enqueue_job() -> EnqueueJob:
    return EnqueueJob(SqlAlchemyJobRepository(get_session_factory()))


def get_cancel_job() -> CancelJob:
    return CancelJob(SqlAlchemyJobRepository(get_session_factory()))
