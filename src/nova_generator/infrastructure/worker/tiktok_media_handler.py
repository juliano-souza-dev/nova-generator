"""TikTok Media FFmpeg job: immutable screenshots, existing speech cache and MP4 output."""

from __future__ import annotations

import json
import os
import subprocess
from hashlib import file_digest, sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.core.settings import get_settings
from nova_generator.domain.jobs import Job
from nova_generator.domain.tiktok_media import MediaProject
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.exports.tiktok_captions import render_ass
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


def _run_ffmpeg(arguments: list[str], *, cwd: Path | None = None) -> None:
    result = subprocess.run(
        [get_settings().ffmpeg_executable, "-hide_banner", "-loglevel", "error", *arguments],
        capture_output=True,
        text=True,
        check=False,
        timeout=600,
        cwd=cwd,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-2000:] or "Não foi possível renderizar o vídeo.")


def _voice_snapshot(raw: dict[str, Any]) -> VoiceProfileSnapshot:
    snapshot = VoiceProfileSnapshot(
        profile_id=UUID(raw["profile_id"]),
        name=raw["name"],
        version=raw["version"],
        model_id=raw["model_id"],
        model_sha256=raw["model_sha256"],
        reference_audio_sha256=raw.get("reference_audio_sha256"),
        parameters=raw["parameters"],
    )
    if snapshot.sha256 != raw["snapshot_sha256"]:
        raise ValueError("A voz selecionada mudou durante a exportação.")
    return snapshot


def _check_current_caption_approval(
    project: MediaProject, repository: SqlAlchemyEditorialProjectRepository
) -> None:
    """A queued render must not publish a cue that has since returned to draft."""
    if project.source_project_id is None or project.source_scene_id is None:
        raise ValueError("O vídeo não tem uma cena editorial de origem válida.")
    if repository.get_scene_project_id(project.source_scene_id) != project.source_project_id:
        raise ValueError("A cena editorial deixou de pertencer ao projeto de origem.")
    if not project.video_captions:
        raise ValueError("O vídeo não tem legendas editoriais.")
    for caption in project.video_captions:
        cue = repository.get_cue(caption.cue_id)
        if (
            cue is None
            or cue.scene_id != project.source_scene_id
            or cue.provenance.get("approval") == "draft"
            or not cue.approved_en.strip()
            or not cue.approved_pt.strip()
        ):
            raise ValueError(
                "Uma fala foi removida, alterou de cena ou voltou a rascunho. "
                "Revise as legendas e solicite uma nova exportação."
            )


def _render_video_source(
    project: MediaProject,
    payload: dict[str, Any],
    snapshot_dir: Path,
    uploaded_audio: Path,
    execution: JobExecution,
) -> tuple[list[int], str]:
    source = snapshot_dir / "source.mp4"
    if not source.is_file():
        raise ValueError("O corte congelado da origem não está disponível.")
    with source.open("rb") as source_stream:
        digest = file_digest(source_stream, "sha256").hexdigest()
    if digest != payload.get("source_video_sha256"):
        raise ValueError("O corte de origem mudou desde a solicitação da exportação.")
    duration = payload.get("source_duration_ms")
    if not isinstance(duration, int) or duration <= 0:
        raise ValueError("Duração congelada do corte inválida.")
    for caption in project.video_captions:
        if caption.end_ms > duration:
            raise ValueError("Legenda fora da duração congelada do vídeo.")
    if not project.video_captions:
        raise ValueError("Este vídeo não contém legendas revisadas.")
    if payload["audio_mode"] == "voice":
        raise ValueError("Narração não está disponível para vídeo com áudio original.")

    # Working-directory-relative ASS path works identically on Windows and Unix
    # and avoids fragile escaping of drive letters/colons inside FFmpeg filters.
    (snapshot_dir / "captions.ass").write_text(
        render_ass(project.video_captions, project.caption_style), encoding="utf-8"
    )
    execution.raise_if_cancelled()
    filter_graph = (
        "scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,setsar=1,ass=captions.ass,format=yuv420p"
    )
    args = ["-y", "-i", str(source)]
    mode = payload["audio_mode"]
    if mode == "uploaded":
        args += ["-stream_loop", "-1", "-i", str(uploaded_audio)]
    args += ["-map", "0:v:0"]
    if mode == "original":
        args += ["-map", "0:a:0?"]
    elif mode == "uploaded":
        args += ["-map", "1:a:0"]
    args += ["-vf", filter_graph, "-r", "30", "-c:v", "libx264", "-preset", "veryfast"]
    args += ["-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if mode in {"original", "uploaded"}:
        args += ["-c:a", "aac", "-ar", "44100"]
    else:
        args += ["-an"]
    args += ["-t", f"{duration / 1000:.3f}", str(snapshot_dir / "final.mp4")]
    _run_ffmpeg(args, cwd=snapshot_dir)
    execution.heartbeat()
    return [duration], digest


def make_media_render_handler(
    speech: SynthesizeSpeech, repository: SqlAlchemyEditorialProjectRepository
):
    def handle(job: Job, execution: JobExecution) -> dict[str, Any]:
        project_id = UUID(str(job.input["project_id"]))
        render_id = UUID(str(job.input["render_id"]))
        directory = get_settings().media_cache_root / "tiktok-media" / str(project_id)
        snapshot_dir = directory / "renders" / str(render_id)
        snapshot_path = snapshot_dir / "snapshot.json"
        if not snapshot_path.is_file():
            raise ValueError("Os arquivos da exportação não estão disponíveis.")
        snapshot_bytes = snapshot_path.read_bytes()
        if sha256(snapshot_bytes).hexdigest() != job.input["snapshot_sha256"]:
            raise ValueError("O storyboard foi alterado durante a exportação.")
        payload = json.loads(snapshot_bytes)
        project = MediaProject.model_validate(payload["project"])
        mode = payload["audio_mode"]
        voice = _voice_snapshot(payload["voice_snapshot"]) if mode == "voice" else None
        uploaded_audio = directory / "assets" / str(project.audio_filename or "")
        if mode == "uploaded" and (not project.audio_filename or not uploaded_audio.is_file()):
            raise ValueError("Áudio enviado não está mais disponível.")
        if mode == "uploaded":
            if sha256(uploaded_audio.read_bytes()).hexdigest() != payload["audio_sha256"]:
                raise ValueError("Áudio alterado depois de iniciar a renderização.")
        final = snapshot_dir / "final.mp4"
        source_digest = None
        if payload.get("visual_mode", "slides") == "video_source":
            _check_current_caption_approval(project, repository)
            durations, source_digest = _render_video_source(
                project, payload, snapshot_dir, uploaded_audio, execution
            )
        else:
            segments = []
            durations = []
            for index, slide in enumerate(project.slides):
                execution.raise_if_cancelled()
                image = snapshot_dir / f"{index:03d}.png"
                digest = sha256(image.read_bytes()).hexdigest()
                if digest != payload["image_hashes"][index]:
                    raise ValueError("Quadro da exportação alterado.")
                segment = snapshot_dir / f"{index:03d}.mp4"
                duration = slide.duration_ms
                args = ["-y", "-loop", "1", "-framerate", "30", "-i", str(image)]
                if voice:
                    spoken = slide.en.strip() or slide.pt.strip()
                    if spoken:
                        rendered = speech.execute(text=spoken, profile=voice)
                        duration = max(duration, rendered.duration_ms + 400)
                        args += ["-i", rendered.audio_path]
                    else:
                        args += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"]
                secs = f"{duration / 1000:.3f}"
                args += [
                    "-t",
                    secs,
                    "-vf",
                    "scale=1080:1920,format=yuv420p",
                    "-r",
                    "30",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-pix_fmt",
                    "yuv420p",
                ]
                if voice:
                    args += ["-af", f"apad,atrim=0:{secs}", "-c:a", "aac", "-ar", "44100"]
                else:
                    args += ["-an"]
                args += ["-movflags", "+faststart", str(segment)]
                _run_ffmpeg(args)
                segments.append(segment)
                durations.append(duration)
                execution.heartbeat()
            concat = snapshot_dir / "segments.txt"
            concat.write_text(
                "".join(f"file '{part.resolve().as_posix()}'\n" for part in segments),
                encoding="utf-8",
            )
            joined = snapshot_dir / "joined.mp4"
            _run_ffmpeg(
                ["-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(joined)]
            )
            if mode == "uploaded":
                total = sum(durations) / 1000
                _run_ffmpeg(
                    [
                        "-y",
                        "-i",
                        str(joined),
                        "-stream_loop",
                        "-1",
                        "-i",
                        str(uploaded_audio),
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-t",
                        f"{total:.3f}",
                        "-c:v",
                        "copy",
                        "-c:a",
                        "aac",
                        "-ar",
                        "44100",
                        "-movflags",
                        "+faststart",
                        str(final),
                    ]
                )
            else:
                os.replace(joined, final)
        if not final.is_file() or final.stat().st_size == 0:
            raise RuntimeError("A exportação gerou um arquivo vazio.")
        if source_digest is not None:
            # Manifest is the publication gate for download endpoints. Check
            # again after a long FFmpeg render, before making it accessible.
            _check_current_caption_approval(project, repository)
        with final.open("rb") as output_stream:
            video_sha256 = file_digest(output_stream, "sha256").hexdigest()
        manifest = {
            "contract": "nova-tiktok-media-render/1",
            "project_id": str(project_id),
            "revision": project.revision,
            "render_id": str(render_id),
            "audio_mode": mode,
            "visual_mode": payload.get("visual_mode", "slides"),
            "source_video_sha256": source_digest,
            "source_scene_id": str(project.source_scene_id) if source_digest else None,
            "caption_count": (
                sum(1 for item in project.video_captions if item.enabled) if source_digest else 0
            ),
            "voice_sha256": voice.sha256 if voice else None,
            "duration_ms": sum(durations),
            "slide_durations_ms": durations,
            "video_sha256": video_sha256,
            "source_snapshot_sha256": job.input["snapshot_sha256"],
        }
        temporary = snapshot_dir / "manifest.tmp"
        temporary.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        os.replace(temporary, snapshot_dir / "manifest.json")
        return {
            "render_id": str(render_id),
            "project_id": str(project_id),
            "duration_ms": sum(durations),
            "video_url": f"/api/tiktok-media/projects/{project_id}/renders/{render_id}/video",
        }

    return handle
