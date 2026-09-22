from __future__ import annotations

import json
from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nova_generator.domain.voices import VoiceProfile
from nova_generator.infrastructure.database.models import VoiceProfileRecord

SessionFactory = Callable[[], Session]


class SqlAlchemyVoiceProfileRepository:
    def __init__(self, session_factory: SessionFactory) -> None:
        self._session_factory = session_factory

    def save(self, profile: VoiceProfile) -> None:
        with self._session_factory() as session:
            existing = session.scalar(
                select(VoiceProfileRecord).where(
                    VoiceProfileRecord.profile_id == profile.id,
                    VoiceProfileRecord.version == profile.version,
                )
            )
            if existing is not None:
                raise ValueError("voice profile version already exists")
            session.add(
                VoiceProfileRecord(
                    profile_id=profile.id,
                    name=profile.name,
                    version=profile.version,
                    model_id=profile.model_id,
                    model_sha256=profile.model_sha256,
                    reference_audio_sha256=profile.reference_audio_sha256,
                    parameters_json=json.dumps(
                        profile.parameters, ensure_ascii=False, sort_keys=True
                    ),
                )
            )
            session.commit()

    def get(self, profile_id: UUID, version: int | None = None) -> VoiceProfile | None:
        with self._session_factory() as session:
            query = select(VoiceProfileRecord).where(VoiceProfileRecord.profile_id == profile_id)
            if version is not None:
                query = query.where(VoiceProfileRecord.version == version)
            record = session.scalar(query.order_by(VoiceProfileRecord.version.desc()).limit(1))
            return _profile(record) if record else None

    def list(self) -> list[VoiceProfile]:
        with self._session_factory() as session:
            records = session.scalars(
                select(VoiceProfileRecord).order_by(
                    VoiceProfileRecord.profile_id, VoiceProfileRecord.version.desc()
                )
            ).all()
            latest: dict[UUID, VoiceProfile] = {}
            for record in records:
                latest.setdefault(record.profile_id, _profile(record))
            return list(latest.values())


def _profile(record: VoiceProfileRecord) -> VoiceProfile:
    return VoiceProfile(
        record.profile_id,
        record.name,
        record.version,
        record.model_id,
        record.model_sha256,
        record.reference_audio_sha256,
        json.loads(record.parameters_json),
    )
