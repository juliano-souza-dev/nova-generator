from __future__ import annotations

import json
import os
from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path

from nova_generator.application.ports.story_video_renderer import StoryVideoRenderer
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.stories import StoryPackage
from nova_generator.domain.stories.render import (
    RenderedStoryCue,
    StoryRender,
    cue_fingerprint,
    sha256_file,
)
from nova_generator.domain.voices import VoiceProfileSnapshot


class RenderStory:
    """Render only stale story cues, then atomically replace the final concatenation."""

    def __init__(self, speech: SynthesizeSpeech, renderer: StoryVideoRenderer) -> None:
        self._speech = speech
        self._renderer = renderer

    def execute(
        self,
        *,
        package: StoryPackage,
        images: Mapping[str, Path],
        voice: VoiceProfileSnapshot,
        output_directory: Path,
    ) -> StoryRender:
        output_directory.mkdir(parents=True, exist_ok=True)
        previous = _load_manifest(output_directory / "story-manifest.json")
        rendered: list[RenderedStoryCue] = []
        for cue in package.cues:
            image = images.get(cue.image)
            if image is None:
                raise ValueError(f"Imagem materializada ausente para cue {cue.order}: {cue.image}")
            image_hash = sha256_file(image)
            fingerprint = cue_fingerprint(cue, image_sha256=image_hash, voice=voice)
            old = previous.get(str(cue.order), {})
            cue_dir = output_directory / "cues"
            audio = cue_dir / f"{cue.order:03d}.wav"
            video = cue_dir / f"{cue.order:03d}.mp4"
            if _reusable(old, fingerprint, audio, video):
                rendered.append(
                    RenderedStoryCue(
                        cue, audio, video, int(old["duration_ms"]), fingerprint,
                        sha256_file(audio), sha256_file(video),
                    )
                )
                continue
            speech = self._speech.execute(text=cue.en, profile=voice)
            source_audio = Path(speech.audio_path)
            cue_dir.mkdir(parents=True, exist_ok=True)
            # The voice cache owns its WAV; the production owns a stable snapshot copy.
            audio.write_bytes(source_audio.read_bytes())
            staged_video = video.with_suffix(".tmp.mp4")
            self._renderer.render_cue(image=image, audio=audio, output=staged_video)
            if not staged_video.is_file() or staged_video.stat().st_size == 0:
                raise RuntimeError(f"Renderização não criou vídeo para cue {cue.order}.")
            os.replace(staged_video, video)
            rendered.append(
                RenderedStoryCue(
                    cue, audio, video, speech.duration_ms, fingerprint,
                    sha256_file(audio), sha256_file(video),
                )
            )
        final_video = output_directory / "story_final.mp4"
        staged_final = output_directory / ".story_final.tmp.mp4"
        self._renderer.concat(cue_videos=[cue.video_path for cue in rendered], output=staged_final)
        if not staged_final.is_file() or staged_final.stat().st_size == 0:
            raise RuntimeError("Concatenação não criou story_final.mp4.")
        os.replace(staged_final, final_video)
        manifest = output_directory / "story-manifest.json"
        _write_manifest(manifest, package, voice, rendered, final_video)
        return StoryRender(package, voice, output_directory, final_video, manifest, tuple(rendered))


def _load_manifest(path: Path) -> dict[str, dict[str, object]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        cues = payload.get("cues", [])
        return {str(cue["order"]): cue for cue in cues if isinstance(cue, dict)}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}


def _reusable(old: dict[str, object], fingerprint: str, audio: Path, video: Path) -> bool:
    return (
        old.get("input_sha256") == fingerprint
        and isinstance(old.get("duration_ms"), int)
        and old["duration_ms"] > 0
        and old.get("audio_sha256") == sha256_file_or_none(audio)
        and old.get("video_sha256") == sha256_file_or_none(video)
    )


def sha256_file_or_none(path: Path) -> str | None:
    try:
        return sha256_file(path)
    except ValueError:
        return None


def _write_manifest(
    path: Path,
    package: StoryPackage,
    voice: VoiceProfileSnapshot,
    cues: list[RenderedStoryCue],
    final_video: Path,
) -> None:
    payload = {
        "schema": "nova-generator-story-render",
        "schema_version": "1.0",
        "title": package.title,
        "language": package.language,
        "aspect_ratio": package.aspect_ratio,
        "voice_snapshot_sha256": voice.sha256,
        "final_video_sha256": sha256_file(final_video),
        "cues": [
            {
                "order": item.cue.order,
                "en_sha256": sha256(item.cue.en.encode("utf-8")).hexdigest(),
                "pt_sha256": sha256(item.cue.pt.encode("utf-8")).hexdigest(),
                "image": item.cue.image,
                "input_sha256": item.input_sha256,
                "audio_sha256": item.audio_sha256,
                "video_sha256": item.video_sha256,
                "duration_ms": item.duration_ms,
            }
            for item in cues
        ],
    }
    staging = path.with_suffix(".tmp.json")
    staging.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(staging, path)
