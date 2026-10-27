"""Standalone TikTok Media contract and optimistic persistence regression tests."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from nova_generator.domain.tiktok_media import MediaProject, MediaProjectEdit, MediaSlide
from nova_generator.infrastructure.filesystem.tiktok_media_store import (
    MediaConflict,
    MediaProjectStore,
)


def test_contract_preserves_unicode_and_literal_translations():
    project = MediaProject(
        title="Aula — música 🎵",
        slides=[
            MediaSlide(
                kind="lesson",
                en="While you're at it, could you get her a card?",
                pt="Já que você vai fazer isso, pode comprar um cartão pra ela?",
                highlight="While you're at it",
            )
        ],
    )
    restored = MediaProject.model_validate_json(project.model_dump_json())
    assert restored.slides[0].pt == project.slides[0].pt
    assert restored.slides[0].en == project.slides[0].en
    assert restored.contract == "nova-tiktok-media/1"


def test_rejects_duplicate_slide_ids_and_out_of_bounds_durations():
    with pytest.raises(ValidationError):
        MediaProject(
            title="Duas telas",
            slides=[MediaSlide(id="same"), MediaSlide(id="same")],
        )
    with pytest.raises(ValidationError):
        MediaSlide(duration_ms=500)


def test_revision_lock_and_project_isolation(tmp_path):
    store = MediaProjectStore(tmp_path)
    a = store.create("Aula", "carousel")
    b = store.create("Lyric", "lyrics_video")
    edit = MediaProjectEdit(
        revision=a.revision,
        title="Aula atualizada",
        format=a.format,
        theme=a.theme,
        source_project_id=uuid4(),
        slides=[MediaSlide(en="Hey!", pt="Ei!")],
    )
    saved = store.update(a.id, edit)
    assert saved.revision == 2
    assert saved.slides[0].pt == "Ei!"
    assert store.get(b.id) == b
    assert {p.id for p in store.list()} == {saved.id, b.id}
    with pytest.raises(MediaConflict):
        store.update(a.id, edit)
