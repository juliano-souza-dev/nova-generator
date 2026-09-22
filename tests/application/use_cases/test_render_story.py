from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.build_story_text_audio_export import (
    build_story_text_audio_export,
)
from nova_generator.application.use_cases.render_story import RenderStory
from nova_generator.application.use_cases.render_story_job import RenderStoryJob
from nova_generator.domain.jobs import Job
from nova_generator.domain.stories import Highlight, ImageAsset, StoryCue, StoryPackage
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfile


class FakeSpeech:
    def __init__(self, root: Path) -> None:
        self.calls: list[str] = []
        self.root = root

    def execute(self, *, text, profile, parameters=None) -> SynthesizedSpeech:
        self.calls.append(text)
        path = self.root / "voice" / f"{len(self.calls)}.wav"
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
        return SynthesizedSpeech(
            str(path), sha256(text.encode("utf-8")).hexdigest(), profile, {}, 1000, 24000, 1
        )


class FakeRenderer:
    def __init__(self) -> None:
        self.rendered: list[str] = []

    def render_cue(self, *, image: Path, audio: Path, output: Path) -> Path:
        self.rendered.append(image.name)
        output.write_bytes(image.read_bytes() + audio.read_bytes())
        return output

    def concat(self, *, cue_videos: list[Path], output: Path) -> Path:
        output.write_bytes(b"".join(path.read_bytes() for path in cue_videos))
        return output


def _package() -> StoryPackage:
    return StoryPackage(
        "História, com acento!", "en", "9:16",
        (
            StoryCue(1, "images/1.jpg", "Hello, “world”...", "Olá, “mundo”...", ()),
            StoryCue(2, "images/2.jpg", "Pick up the key.", "Pegue a chave.", (
                Highlight("Pick up", "phrasal_verb", "Pegar", 1),
            )),
        ),
        (ImageAsset("images/1.jpg", 1, "a" * 64), ImageAsset("images/2.jpg", 1, "b" * 64)),
    )


def _voice():
    return VoiceProfile(uuid4(), "Ana", 1, "chatterbox-nano", "a" * 64).snapshot()


def test_story_render_reuses_unchanged_cues_and_preserves_provenance(tmp_path: Path) -> None:
    images = {"images/1.jpg": tmp_path / "1.jpg", "images/2.jpg": tmp_path / "2.jpg"}
    images["images/1.jpg"].write_bytes(b"one")
    images["images/2.jpg"].write_bytes(b"two")
    speech, renderer = FakeSpeech(tmp_path), FakeRenderer()
    use_case = RenderStory(speech, renderer)

    first = use_case.execute(
        package=_package(), images=images, voice=_voice(), output_directory=tmp_path / "out"
    )
    second = use_case.execute(
        package=_package(), images=images, voice=first.voice, output_directory=tmp_path / "out"
    )

    assert speech.calls == ["Hello, “world”...", "Pick up the key."]
    assert renderer.rendered == ["1.jpg", "2.jpg"]
    assert first.final_video_path.is_file() and second.manifest_path.is_file()
    manifest = json.loads(second.manifest_path.read_text(encoding="utf-8"))
    assert manifest["voice_snapshot_sha256"] == first.voice.sha256
    assert manifest["cues"][0]["en_sha256"] == sha256("Hello, “world”...".encode()).hexdigest()


def test_story_render_invalidates_only_changed_image_cue(tmp_path: Path) -> None:
    images = {"images/1.jpg": tmp_path / "1.jpg", "images/2.jpg": tmp_path / "2.jpg"}
    images["images/1.jpg"].write_bytes(b"one")
    images["images/2.jpg"].write_bytes(b"two")
    speech, renderer = FakeSpeech(tmp_path), FakeRenderer()
    use_case = RenderStory(speech, renderer)
    voice = _voice()
    use_case.execute(
        package=_package(), images=images, voice=voice, output_directory=tmp_path / "out"
    )
    images["images/2.jpg"].write_bytes(b"two edited")
    use_case.execute(
        package=_package(), images=images, voice=voice, output_directory=tmp_path / "out"
    )

    assert speech.calls == ["Hello, “world”...", "Pick up the key.", "Pick up the key."]
    assert renderer.rendered == ["1.jpg", "2.jpg", "2.jpg"]


def test_story_export_is_manual_youtube_contract(tmp_path: Path) -> None:
    images = {"images/1.jpg": tmp_path / "1.jpg", "images/2.jpg": tmp_path / "2.jpg"}
    for image in images.values():
        image.write_bytes(image.name.encode())
    render = RenderStory(FakeSpeech(tmp_path), FakeRenderer()).execute(
        package=_package(), images=images, voice=_voice(), output_directory=tmp_path / "out"
    )
    result = build_story_text_audio_export(
        render, youtube_video_id="dQw4w9WgXcQ", description="Teste"
    )

    assert result["schema"] == "immersionhub-text-audio"
    assert result["durationMs"] == 2000
    assert result["cues"][1]["highlights"][0]["type"] == "phrasal_verb"
    with pytest.raises(ValueError, match="YouTube"):
        build_story_text_audio_export(render, youtube_video_id="invalid")


def test_story_job_uses_production_id_and_returns_render_provenance(tmp_path: Path) -> None:
    images = {"images/1.jpg": tmp_path / "1.jpg", "images/2.jpg": tmp_path / "2.jpg"}
    for image in images.values():
        image.write_bytes(image.name.encode())
    profile = _voice()
    handler = RenderStoryJob(
        lambda production_id: (_package(), images, profile, tmp_path / production_id),
        RenderStory(FakeSpeech(tmp_path), FakeRenderer()),
    )
    job = Job(uuid4(), "story.render", "running", {"production_id": "story-1"}, None, 1, 3)

    class Execution:
        def heartbeat(self) -> None: pass
        def raise_if_cancelled(self) -> None: pass

    output = handler(job, Execution())
    assert output["production_id"] == "story-1"
    assert output["cue_count"] == 2
