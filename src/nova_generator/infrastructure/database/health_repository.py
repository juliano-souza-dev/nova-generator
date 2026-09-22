from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker


class SqlAlchemyHealthRepository:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def is_available(self) -> bool:
        try:
            with self._session_factory() as session:
                session.execute(text("SELECT 1"))
            return True
        except SQLAlchemyError:
            return False
