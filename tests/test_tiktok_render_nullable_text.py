"""Regressions for nullable text in previously saved TikTok Media drafts."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from nova_generator.domain.tiktok_media import MediaCaption, MediaProject, MediaSlide
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.worker import tiktok_media_handler


def test_voice_render_uses_slide_text_when_legacy_narration_is_null(
    monkeypatch, tmp_path: Path
) -> None:
    project = MediaProject.model_validate({
        "title": "Teste bilíngue",
        "slides": [{"narration_text": None, "en": "Watch this!", "pt": None}],
    })
    profile = VoiceProfileSnapshot(
        profile_id=uuid4(),
        name="Voz local",
        version=1,
        model_id="qwen3-tts-1.7b-base",
        model_sha256="a" * 64,
        reference_audio_sha256="b" * 64,
        parameters={"reference_text": "Teste de referência."},
    )
    render_id = uuid4()
    snapshot_dir = tmp_path / "tiktok-media" / str(project.id) / "renders" / str(render_id)
    snapshot_dir.mkdir(parents=True)
    image = b"fake-png-for-ffmpeg-mock"
    (snapshot_dir / "000.png").write_bytes(image)
    payload = {
        "project": project.model_dump(mode="json"),
        "audio_mode": "voice",
        "voice_language": "en",
        "visual_mode": "slides",
        "image_hashes": [sha256(image).hexdigest()],
        "voice_snapshot": {
            "profile_id": str(profile.profile_id),
            "name": profile.name,
            "version": profile.version,
            "model_id": profile.model_id,
            "model_sha256": profile.model_sha256,
            "reference_audio_sha256": profile.reference_audio_sha256,
            "parameters": profile.parameters,
            "snapshot_sha256": profile.sha256,
        },
    }
    content = json.dumps(payload).encode("utf-8")
    (snapshot_dir / "snapshot.json").write_bytes(content)
    job = SimpleNamespace(input={
        "project_id": str(project.id),
        "render_id": str(render_id),
        "snapshot_sha256": sha256(content).hexdigest(),
    })
    execution = SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None)
    monkeypatch.setattr(
        tiktok_media_handler, "get_settings", lambda: SimpleNamespace(media_cache_root=tmp_path)
    )

    def fake_ffmpeg(arguments: list[str], **_kwargs: object) -> None:
        Path(arguments[-1]).write_bytes(b"mock-video")

    monkeypatch.setattr(tiktok_media_handler, "_run_ffmpeg", fake_ffmpeg)
    calls: list[tuple[str, dict[str, str]]] = []

    def fake_speech(**kwargs: object) -> SimpleNamespace:
        calls.append((kwargs["text"], kwargs["parameters"]))
        return SimpleNamespace(audio_path="test.wav", duration_ms=900)

    speech = SimpleNamespace(execute=fake_speech)
    handler = tiktok_media_handler.make_media_render_handler(speech, None)
    result = handler(job, execution)

    assert calls == [("Watch this!", {"language": "English"})]
    assert result["render_id"] == str(render_id)
    assert (snapshot_dir / "manifest.json").is_file()


def test_render_text_reader_does_not_call_strip_on_null_fields() -> None:
    slide = MediaSlide.model_construct(narration_text=None, en=None, pt=None)
    assert not any((
        tiktok_media_handler._optional_text(slide.narration_text),
        tiktok_media_handler._optional_text(slide.en),
        tiktok_media_handler._optional_text(slide.pt),
    ))


def test_video_render_reports_missing_legacy_approval_instead_of_crashing() -> None:
    source_project_id, scene_id = uuid4(), uuid4()
    caption = MediaCaption(cue_id=uuid4(), start_ms=0, end_ms=1000, en="Hello!")
    project = MediaProject(
        title="Corte antigo",
        slides=[MediaSlide()],
        source_project_id=source_project_id,
        source_scene_id=scene_id,
        video_captions=[caption],
    )
    cue = SimpleNamespace(
        scene_id=scene_id, provenance={"approval": "approved"},
        approved_en="Hello!", approved_pt=None,
    )
    repository = SimpleNamespace(
        get_scene_project_id=lambda _scene: source_project_id,
        get_cue=lambda _id: cue,
    )
    with pytest.raises(ValueError, match="Revise as legendas"):
        tiktok_media_handler._check_current_caption_approval(project, repository)
