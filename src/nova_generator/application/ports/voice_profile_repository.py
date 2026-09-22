from typing import Protocol
from uuid import UUID

from nova_generator.domain.voices import VoiceProfile


class VoiceProfileRepository(Protocol):
    def save(self, profile: VoiceProfile) -> None: ...
    def get(self, profile_id: UUID, version: int | None = None) -> VoiceProfile | None: ...
    def list(self) -> list[VoiceProfile]: ...
