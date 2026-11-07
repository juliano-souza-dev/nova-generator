from uuid import UUID

from nova_generator.infrastructure.filesystem.tiktok_sound_effects import SoundEffectLibrary


def test_global_sound_effects_can_be_added_listed_renamed_and_deleted(tmp_path):
    library = SoundEffectLibrary(tmp_path)
    effect = library.add("  Check  ", ".wav", b"test-audio")

    assert isinstance(effect.id, UUID)
    assert effect.name == "Check"
    assert effect.size_bytes == len(b"test-audio")
    assert library.get(effect.id)[1].read_bytes() == b"test-audio"
    assert library.list() == [effect]

    renamed = library.rename(effect.id, "Check suave")
    assert renamed.name == "Check suave"
    assert library.list() == [renamed]

    library.delete(effect.id)
    assert library.list() == []
    assert library.get(effect.id) is None


def test_global_sound_effects_reject_empty_names_and_unsupported_formats(tmp_path):
    library = SoundEffectLibrary(tmp_path)
    try:
        library.add("   ", ".wav", b"audio")
        raise AssertionError("empty name should be rejected")
    except ValueError:
        pass
    try:
        library.add("Effect", ".mp4", b"video")
        raise AssertionError("unsupported format should be rejected")
    except ValueError:
        pass
