"""TikTok Media FFmpeg job: immutable screenshots, existing speech cache and MP4 output."""

from __future__ import annotations

import json
import os
import subprocess
from hashlib import file_digest, sha256
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.application.use_cases.tiktok_shadowing import resolve_tiktok_shadowing
from nova_generator.core.settings import get_settings
from nova_generator.domain.jobs import Job
from nova_generator.domain.tiktok_media import MediaCaption, MediaProject
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.exports.tiktok_captions import render_ass
from nova_generator.infrastructure.speech.qwen3_tts_models import QWEN_MODELS
from nova_generator.infrastructure.worker.persistent_worker import JobExecution
from nova_generator.infrastructure.worker.project_media_handler import _keep_lease
from nova_generator.infrastructure.worker.tiktok_speech import (
    MAX_COMPATIBILITY_CHUNK_CHARACTERS,
    MAX_SPEECH_CHUNK_CHARACTERS,
    TikTokSpeechChunk,
    build_project_speech_chunks,
)


def _optional_text(value: object) -> str:
    """Read legacy nullable text without losing literal nonempty narration."""
    return value.strip() if isinstance(value, str) else ""


def _pause_after_ms(text: str, language: str, next_language: str | None) -> int:
    """Choose a natural pause from punctuation and add a small language-switch beat."""
    if next_language is None:
        return 0
    ending = text.rstrip()
    while ending and ending[-1] in "\"'”’)]}":
        ending = ending[:-1].rstrip()
    punctuation = ending[-1:] if ending else ""
    if punctuation in {".", "!", "?", "…"}:
        pause = 320
    elif punctuation in {";", ":"}:
        pause = 240
    elif punctuation == ",":
        pause = 170
    else:
        pause = 130
    if next_language != language:
        pause += 100
    return pause


def _assemble_voice_chunks(
    items: list[tuple[TikTokSpeechChunk, Any]],
    output: Path,
    *,
    slide_start_ms: int,
    following_language: str | None = None,
) -> tuple[int, list[dict[str, Any]], str]:
    """Join cached WAV chunks, insert linguistic pauses and normalize the final level."""
    if not items:
        raise ValueError("Não há chunks de voz para montar.")
    sample_rate = int(getattr(items[0][1], "sample_rate", 24000))
    if sample_rate <= 0:
        raise ValueError("Frequência de áudio dos chunks inválida.")

    filters: list[str] = []
    concat_inputs: list[str] = []
    records: list[dict[str, Any]] = []
    cursor_ms = 0
    arguments = ["-y"]

    for index, (chunk, speech_result) in enumerate(items):
        audio_path = Path(speech_result.audio_path)
        arguments.extend(["-i", str(audio_path)])
        filters.append(
            f"[{index}:a]aresample={sample_rate},"
            f"aformat=sample_fmts=fltp:channel_layouts=mono[chunk{index}]"
        )
        concat_inputs.append(f"[chunk{index}]")

        duration_ms = int(getattr(speech_result, "duration_ms", 0))
        if duration_ms <= 0:
            raise ValueError(f"O chunk {index + 1} não possui duração válida.")
        next_language = (
            items[index + 1][0].language
            if index + 1 < len(items)
            else following_language
        )
        pause_ms = _pause_after_ms(chunk.text, chunk.language, next_language)
        if pause_ms:
            filters.append(
                f"anullsrc=r={sample_rate}:cl=mono,"
                f"atrim=duration={pause_ms / 1000:.3f},"
                f"asetpts=N/SR/TB[silence{index}]"
            )
            concat_inputs.append(f"[silence{index}]")

        text_sha256 = getattr(speech_result, "text_sha256", None)
        if not isinstance(text_sha256, str):
            text_sha256 = sha256(chunk.text.encode("utf-8")).hexdigest()
        cache_key = None
        speech_profile = getattr(speech_result, "profile", None)
        speech_parameters = getattr(speech_result, "parameters", None)
        if speech_profile is not None and isinstance(speech_parameters, dict):
            cache_payload = {
                "text": chunk.text,
                "profile": speech_profile.sha256,
                "parameters": speech_parameters,
            }
            cache_key = sha256(
                json.dumps(
                    cache_payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
        audio_sha256 = None
        if audio_path.is_file():
            with audio_path.open("rb") as stream:
                audio_sha256 = file_digest(stream, "sha256").hexdigest()

        start_ms = cursor_ms
        end_ms = start_ms + duration_ms
        records.append(
            {
                "slide_index": chunk.slide_index,
                "slide_id": chunk.slide_id,
                "source_field": chunk.source_field,
                "language": chunk.language,
                "text": chunk.text,
                "text_sha256": text_sha256,
                "cache_key": cache_key if isinstance(cache_key, str) else None,
                "audio_sha256": audio_sha256,
                "duration_ms": duration_ms,
                "sample_rate": int(getattr(speech_result, "sample_rate", sample_rate)),
                "channels": int(getattr(speech_result, "channels", 1)),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "timeline_start_ms": slide_start_ms + start_ms,
                "timeline_end_ms": slide_start_ms + end_ms,
                "pause_after_ms": pause_ms,
            }
        )
        cursor_ms = end_ms + pause_ms

    if len(concat_inputs) == 1:
        audio_chain = f"{concat_inputs[0]}loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    else:
        audio_chain = (
            f"{''.join(concat_inputs)}concat=n={len(concat_inputs)}:v=0:a=1,"
            "loudnorm=I=-16:TP=-1.5:LRA=11[out]"
        )
    filters.append(audio_chain)
    output.parent.mkdir(parents=True, exist_ok=True)
    arguments.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[out]",
            "-c:a",
            "pcm_s16le",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            str(output),
        ]
    )
    _run_ffmpeg(arguments)
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("A montagem dos chunks de narração gerou um WAV vazio.")
    with output.open("rb") as stream:
        combined_sha256 = file_digest(stream, "sha256").hexdigest()
    return cursor_ms, records, combined_sha256


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


def _probe_duration_ms(video: Path) -> int:
    try:
        result = subprocess.run(
            [
                get_settings().ffprobe_executable, "-v", "error",
                "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
                str(video),
            ],
            capture_output=True, text=True, check=False, timeout=30,
        )
        duration_ms = round(float(result.stdout.strip()) * 1000)
        if result.returncode != 0 or duration_ms <= 0:
            raise ValueError("FFprobe não confirmou a duração.")
        return duration_ms
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Não foi possível validar a duração final do Shadowing.") from exc


def _check_current_caption_approval(
    project: MediaProject, repository: SqlAlchemyEditorialProjectRepository
) -> None:
    """A queued render must not publish a cue that has since returned to draft."""
    if project.source_cut_job_id is not None:
        # TikTok-native ASR drafts are deliberately independent of Editorial.
        # Their bytes/times are already frozen in the immutable render snapshot.
        if not project.video_captions or project.source_youtube_id is None:
            raise ValueError("O vídeo independente não possui legendas.")
        return
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
            or not _optional_text(cue.approved_en)
            or not _optional_text(cue.approved_pt)
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
    # This render runs with ``snapshot_dir`` as FFmpeg's working directory so
    # captions.ass can remain portable.  Never pass a snapshot-prefixed *relative*
    # input path in that context: FFmpeg would resolve it below snapshot_dir a
    # second time (``.../renders/id/media_cache/.../source.mp4`` on Windows).
    source = (snapshot_dir / "source.mp4").resolve()
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
    output_duration = duration
    outro = None
    if payload.get("end_at_last_caption") or payload.get("add_outro"):
        active_end = max(
            (caption.end_ms for caption in project.video_captions if caption.enabled), default=0
        )
        if active_end <= 0:
            raise ValueError("Não há legendas ativas para definir o fim do vídeo.")
        if payload.get("add_outro"):
            output_duration = min(duration, active_end + 3500)
            if output_duration - active_end >= 1000:
                outro = (active_end, output_duration)
        else:
            output_duration = min(duration, max(1000, active_end))

    # Working-directory-relative ASS path works identically on Windows and Unix
    # and avoids fragile escaping of drive letters/colons inside FFmpeg filters.
    (snapshot_dir / "captions.ass").write_text(
        render_ass(
            project.video_captions, project.caption_style,
            project.paper_theme if project.background_mode == "paper" else None,
            outro=outro,
            motion_graphics=project.motion_graphics,
        ), encoding="utf-8"
    )
    execution.raise_if_cancelled()
    paper = project.background_mode == "paper"
    if paper:
        # A generated page is deliberately independent from the source visuals.
        backgrounds = {"cream": "0xF4EBDD", "kraft": "0xCFAF87", "night": "0x172238"}
        if project.paper_theme not in (*backgrounds, "aurora"):
            raise ValueError("Papel selecionado inválido.")
        if project.paper_theme == "aurora":
            # Rotating gradient source yields a gently animated background while
            # the original audio and cut-relative captions remain untouched.
            visual_source = (
                "gradients=s=1080x1920:r=30:c0=0x0B1732:c1=0x21577B:"
                f"c2=0x593B7A:n=3:t=spiral:speed=0.003:d={output_duration / 1000:.3f}"
            )
            filter_graph = "setsar=1,vignette=PI/7,ass=captions.ass,format=yuv420p"
        else:
            page_color = backgrounds[project.paper_theme]
            grid_color = (
                "0xA6D2E4@0.10" if project.paper_theme == "night" else "0x6B7B83@0.13"
            )
            visual_source = (
                f"color=c={page_color}:s=1080x1920:r=30:d={output_duration / 1000:.3f}"
            )
            filter_graph = (
                f"setsar=1,drawgrid=w=1080:h=75:t=1:c={grid_color},"
                "noise=alls=5:allf=u,ass=captions.ass,format=yuv420p"
            )
        args = ["-y", "-f", "lavfi", "-i", visual_source, "-i", str(source)]
    else:
        filter_graph = (
            "scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,setsar=1,ass=captions.ass,format=yuv420p"
        )
        args = ["-y", "-i", str(source)]
    mode = payload["audio_mode"]
    if mode == "uploaded":
        args += ["-stream_loop", "-1", "-i", str(uploaded_audio.resolve())]

    # Mix generated effects into the selected audio at cut-relative timestamps.
    audio_inputs: list[str] = []
    audio_filters: list[str] = []
    base_audio_index = (1 if paper else 0) if mode == "original" else (
        2 if paper else 1
    ) if mode == "uploaded" else None
    next_input = 2 if paper else 1
    if mode == "uploaded":
        next_input += 1
    if base_audio_index is not None:
        audio_filters.append(
            f"[{base_audio_index}:a]aresample=44100,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo[baseaudio]"
        )
        audio_inputs.append("[baseaudio]")
    sound_specs = {
        "pop": (
            "sine=frequency=720:sample_rate=44100:duration=0.20",
            "volume=0.20,afade=t=out:st=0.04:d=0.16",
        ),
        "success": (
            "sine=frequency=1046:sample_rate=44100:duration=0.24",
            "volume=0.16,afade=t=out:st=0.08:d=0.16",
        ),
        "ding": (
            "sine=frequency=1320:sample_rate=44100:duration=0.28",
            "volume=0.17,afade=t=out:st=0.08:d=0.20",
        ),
        "whoosh": (
            "anoisesrc=color=white:sample_rate=44100:duration=0.26",
            "highpass=f=500,lowpass=f=4200,volume=0.13,afade=t=out:st=0.04:d=0.22",
        ),
    }
    sound_events = [
        graphic
        for graphic in project.motion_graphics
        if graphic.enabled and graphic.sound != "none" and graphic.start_ms < output_duration
    ]
    for index, graphic in enumerate(sound_events):
        source_spec, effect_filter = sound_specs[graphic.sound]
        args += ["-f", "lavfi", "-i", source_spec]
        delay = graphic.start_ms
        audio_filters.append(
            f"[{next_input}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"{effect_filter},adelay={delay}|{delay}[effect{index}]"
        )
        audio_inputs.append(f"[effect{index}]")
        next_input += 1
    args += ["-map", "0:v:0", "-vf", filter_graph, "-r", "30", "-c:v", "libx264",
             "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if audio_inputs:
        audio_filters.append(
            f"{''.join(audio_inputs)}amix=inputs={len(audio_inputs)}:"
            f"duration={'first' if base_audio_index is not None else 'longest'}:"
            "dropout_transition=0,apad,"
            f"atrim=duration={output_duration / 1000:.3f}[aout]"
        )
        args += ["-filter_complex", ";".join(audio_filters), "-map", "[aout]",
                 "-c:a", "aac", "-ar", "44100", "-b:a", "192k"]
    else:
        args += ["-an"]
    # final.mp4 is deliberately relative to cwd=snapshot_dir; source/audio
    # inputs above are absolute because they originate outside that cwd.
    args += ["-t", f"{output_duration / 1000:.3f}", "final.mp4"]
    _run_ffmpeg(args, cwd=snapshot_dir)
    execution.heartbeat()
    return [output_duration], digest


def _render_shadowing_source(
    project: MediaProject,
    payload: dict[str, Any],
    snapshot_dir: Path,
    execution: JobExecution,
) -> tuple[list[int], str]:
    """Assemble approved original speech + a silent repeat window per practice."""
    source = (snapshot_dir / "source.mp4").resolve()
    if not source.is_file():
        raise ValueError("O recorte de Shadowing congelado não está disponível.")
    with source.open("rb") as stream:
        digest = file_digest(stream, "sha256").hexdigest()
    if digest != payload.get("source_video_sha256"):
        raise ValueError("O corte original mudou após solicitar o Shadowing.")
    duration = payload.get("source_duration_ms")
    blocks = payload.get("shadowing_blocks")
    if not isinstance(duration, int) or not isinstance(blocks, list) or not blocks:
        raise ValueError("O plano congelado de Shadowing está incompleto.")
    if len(blocks) > 12:
        raise ValueError("O Shadowing ultrapassa o limite de 12 práticas.")
    durations: list[int] = []
    segments: list[Path] = []
    paper_colors = {"cream": "0xF4EBDD", "kraft": "0xCFAF87", "night": "0x172238"}
    for index, block in enumerate(blocks):
        execution.raise_if_cancelled()
        start, end, pause = block["start_ms"], block["end_ms"], block["pause_duration_ms"]
        if not (0 <= start < end <= duration and 2000 <= pause <= 9000):
            raise ValueError("A janela de fala ou pausa do Shadowing é inválida.")
        spoken_ms = end - start
        for phase, segment_ms in (("listen", spoken_ms), ("repeat", pause)):
            filename = f"{index:02d}-{phase}"
            ass_name = f"{filename}.ass"
            text = MediaCaption(
                cue_id=uuid4(), start_ms=0, end_ms=segment_ms,
                en=block["en"],
                pt=block["pt"] if phase == "listen" else "SUA VEZ · REPITA AGORA",
                note="OUÇA E IMITE" if phase == "listen" else "REPITA EM VOZ ALTA",
            )
            (snapshot_dir / ass_name).write_text(
                render_ass(
                    [text], project.caption_style,
                    project.paper_theme if project.background_mode == "paper" else None,
                ), encoding="utf-8"
            )
            seconds = f"{segment_ms / 1000:.3f}"
            is_paper = project.background_mode == "paper"
            if phase == "listen" and not is_paper:
                args = [
                    "-y", "-ss", f"{start / 1000:.3f}", "-t", seconds, "-i", str(source),
                    "-map", "0:v:0", "-map", "0:a:0",
                ]
                visual = (
                    "scale=1080:1920:force_original_aspect_ratio=increase,"
                    f"crop=1080:1920,setsar=1,ass={ass_name},format=yuv420p"
                )
            else:
                color = (
                    paper_colors.get(project.paper_theme, "0x172238")
                    if is_paper else "0x101A31"
                )
                args = [
                    "-y", "-f", "lavfi", "-i", f"color=c={color}:s=1080x1920:r=30:d={seconds}",
                ]
                if phase == "listen":
                    args += ["-ss", f"{start / 1000:.3f}", "-t", seconds, "-i", str(source)]
                else:
                    args += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
                args += ["-map", "0:v:0", "-map", "1:a:0"]
                visual = f"setsar=1,ass={ass_name},format=yuv420p"
            segment = snapshot_dir / f"{filename}.mp4"
            args += [
                "-vf", visual, "-r", "30", "-t", seconds,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "2",
                "-b:a", "192k", "-movflags", "+faststart", segment.name,
            ]
            _run_ffmpeg(args, cwd=snapshot_dir)
            segments.append(segment)
            durations.append(segment_ms)
            execution.heartbeat()
    expected = payload.get("shadowing_duration_ms")
    if (
        not isinstance(expected, int)
        or sum(durations) != expected
        or not 35_000 <= expected <= 60_000
    ):
        raise ValueError("A duração congelada do Shadowing é inválida.")
    concat = snapshot_dir / "shadowing-segments.txt"
    concat.write_text(
        "".join(f"file '{part.name}'\n" for part in segments), encoding="utf-8"
    )
    _run_ffmpeg(
        ["-y", "-f", "concat", "-safe", "0", "-i", concat.name,
         "-t", f"{expected / 1000:.3f}", "-c", "copy", "-movflags", "+faststart", "final.mp4"],
        cwd=snapshot_dir,
    )
    return durations, digest


def _slide_motion_filter(motion: str, duration_ms: int, width: int) -> str:
    """Smooth photo-camera presets; avoids CPU-heavy generative video models."""
    height = width * 16 // 9
    if motion == "still":
        return f"scale={width}:{height},format=yuv420p"
    frames = max(1, round(duration_ms * 30 / 1000) - 1)
    progress = f"on/{frames}"
    if motion == "zoom_in":
        zoom = f"1+0.08*{progress}"
        x = "(iw-iw/zoom)/2"
    elif motion == "zoom_out":
        zoom = f"1.08-0.08*{progress}"
        x = "(iw-iw/zoom)/2"
    elif motion == "pan_left":
        zoom = "1.10"
        x = f"(iw-iw/zoom)*{progress}"
    elif motion == "pan_right":
        zoom = "1.10"
        x = f"(iw-iw/zoom)*(1-{progress})"
    else:
        raise ValueError("Movimento de câmera desconhecido.")
    return (
        f"zoompan=z='{zoom}':x='{x}':y='(ih-ih/zoom)/2':"
        f"d=1:s={width}x{height}:fps=30,format=yuv420p"
    )


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
        narration_manifest_records: list[dict[str, Any]] = []
        slide_audio_records: list[dict[str, Any]] = []
        visual_mode = payload.get("visual_mode", "slides")
        if visual_mode == "shadowing":
            current_blocks, current_duration = resolve_tiktok_shadowing(project, repository)
            if (
                current_blocks != payload.get("shadowing_blocks")
                or current_duration != payload.get("shadowing_duration_ms")
            ):
                raise ValueError("O Shadowing mudou durante a preparação do vídeo.")
            durations, source_digest = _render_shadowing_source(
                project, payload, snapshot_dir, execution
            )
        elif visual_mode == "video_source":
            _check_current_caption_approval(project, repository)
            durations, source_digest = _render_video_source(
                project, payload, snapshot_dir, uploaded_audio, execution
            )
        else:
            default_language = "en" if payload.get("voice_language") == "en" else "pt"
            chunk_limit = (
                MAX_SPEECH_CHUNK_CHARACTERS
                if voice and voice.model_id in QWEN_MODELS
                else MAX_COMPATIBILITY_CHUNK_CHARACTERS
            )
            narration_chunks = (
                build_project_speech_chunks(
                    project.slides,
                    voice,
                    default_language,
                    max_characters=chunk_limit,
                )
                if voice else []
            )
            rendered_chunks: list[Any] = []
            if voice and narration_chunks:
                languages = {chunk.language for chunk in narration_chunks}
                if len(languages) > 1 and voice.model_id not in QWEN_MODELS:
                    raise ValueError(
                        "Narração bilíngue EN/PT exige uma voz Qwen3-TTS VoiceDesign ou Base."
                    )
                with _keep_lease(execution):
                    execute_many = getattr(speech, "execute_many", None)
                    if callable(execute_many):
                        batch_result = execute_many(
                            profile=voice,
                            segments=[
                                (chunk.text, chunk.parameters) for chunk in narration_chunks
                            ],
                        )
                        if not isinstance(batch_result, list):
                            raise RuntimeError(
                                "O sintetizador retornou um lote de chunks inválido."
                            )
                        rendered_chunks = batch_result
                    else:
                        rendered_chunks = [
                            speech.execute(
                                text=chunk.text,
                                profile=voice,
                                parameters=chunk.parameters,
                            )
                            for chunk in narration_chunks
                        ]
                if len(rendered_chunks) != len(narration_chunks):
                    raise RuntimeError("A síntese retornou uma quantidade incorreta de chunks.")

            chunks_by_slide: dict[int, list[tuple[TikTokSpeechChunk, Any]]] = {}
            for chunk, rendered in zip(narration_chunks, rendered_chunks, strict=True):
                chunks_by_slide.setdefault(chunk.slide_index, []).append((chunk, rendered))
            following_language_by_slide: dict[int, str] = {}
            for chunk_index, chunk in enumerate(narration_chunks[:-1]):
                next_chunk = narration_chunks[chunk_index + 1]
                if next_chunk.slide_index != chunk.slide_index:
                    following_language_by_slide[chunk.slide_index] = next_chunk.language

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
                    slide_chunks = chunks_by_slide.get(index, [])
                    if slide_chunks:
                        narration_file = snapshot_dir / f"{index:03d}-narration.wav"
                        slide_start_ms = sum(durations)
                        audio_duration_ms, chunk_records, audio_sha256 = _assemble_voice_chunks(
                            slide_chunks,
                            narration_file,
                            slide_start_ms=slide_start_ms,
                            following_language=following_language_by_slide.get(index),
                        )
                        narration_manifest_records.extend(chunk_records)
                        slide_audio_records.append(
                            {
                                "slide_index": index,
                                "slide_id": slide.id,
                                "filename": narration_file.name,
                                "audio_sha256": audio_sha256,
                                "duration_ms": audio_duration_ms,
                                "timeline_start_ms": slide_start_ms,
                                "sample_rate": int(
                                    getattr(slide_chunks[0][1], "sample_rate", 24000)
                                ),
                                "channels": 1,
                            }
                        )
                        tail_padding_ms = (
                            100 if following_language_by_slide.get(index) else 400
                        )
                        duration = max(duration, audio_duration_ms + tail_padding_ms)
                        args += ["-i", str(narration_file)]
                    else:
                        args += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"]
                secs = f"{duration / 1000:.3f}"
                animated = project.animated_scenes
                width = 720 if animated and payload.get("render_quality") != "full" else 1080
                motion_filter = (
                    _slide_motion_filter(slide.motion, duration, width)
                    if animated else "scale=1080:1920,format=yuv420p"
                )
                args += [
                    "-t",
                    secs,
                    "-vf",
                    motion_filter,
                    "-r",
                    "30",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast" if animated else "veryfast",
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
        final_duration_ms = sum(durations)
        if visual_mode == "shadowing":
            final_duration_ms = _probe_duration_ms(final)
            if abs(final_duration_ms - sum(durations)) > 750:
                raise RuntimeError(
                    "A duração do MP4 não corresponde à prática selecionada. Refazer exportação."
                )
        if visual_mode == "shadowing":
            current_blocks, _ = resolve_tiktok_shadowing(project, repository)
            if current_blocks != payload["shadowing_blocks"]:
                raise ValueError("O Shadowing mudou durante a renderização.")
        elif source_digest is not None:
            # Manifest is the publication gate for download endpoints. Check
            # again after a long FFmpeg render, before making it accessible.
            _check_current_caption_approval(project, repository)
        with final.open("rb") as output_stream:
            video_sha256 = file_digest(output_stream, "sha256").hexdigest()
        narration_manifest_sha256 = None
        if voice and narration_manifest_records:
            narration_payload = {
                "contract": "nova-tiktok-media-narration/1",
                "voice_profile_sha256": voice.sha256,
                "voice_model_id": voice.model_id,
                "voice_design_seed": (
                    42 if voice.model_id == "qwen3-tts-1.7b-voice-design" else None
                ),
                "slide_audio": slide_audio_records,
                "chunks": narration_manifest_records,
            }
            narration_path = snapshot_dir / "narration-manifest.json"
            narration_temporary = snapshot_dir / "narration-manifest.tmp"
            narration_temporary.write_text(
                json.dumps(narration_payload, ensure_ascii=False, sort_keys=True, indent=2),
                encoding="utf-8",
            )
            os.replace(narration_temporary, narration_path)
            with narration_path.open("rb") as stream:
                narration_manifest_sha256 = file_digest(stream, "sha256").hexdigest()

        manifest = {
            "contract": "nova-tiktok-media-render/1",
            "project_id": str(project_id),
            "revision": project.revision,
            "render_id": str(render_id),
            "audio_mode": mode,
            "visual_mode": payload.get("visual_mode", "slides"),
            "background_mode": project.background_mode,
            "paper_theme": project.paper_theme,
            "animated_scenes": project.animated_scenes,
            "slide_motions": [slide.motion for slide in project.slides],
            "render_quality": payload.get("render_quality", "balanced"),
            "output_resolution": (
                ("720x1280" if payload.get("render_quality") != "full" else "1080x1920")
                if project.animated_scenes and visual_mode == "slides"
                else "1080x1920" if visual_mode == "slides" else None
            ),
            "image_hashes": payload.get("image_hashes", []),
            "source_video_sha256": source_digest,
            "source_scene_id": str(project.source_scene_id) if source_digest else None,
            "caption_count": (
                sum(1 for item in project.video_captions if item.enabled) if source_digest else 0
            ),
            "shadowing_block_ids": (
                list(project.shadowing_clip.block_ids)
                if visual_mode == "shadowing" and project.shadowing_clip else []
            ),
            "voice_sha256": voice.sha256 if voice else None,
            "narration_manifest_sha256": narration_manifest_sha256,
            "narration_chunk_count": len(narration_manifest_records),
            "duration_ms": final_duration_ms,
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
            "duration_ms": final_duration_ms,
            "video_url": f"/api/tiktok-media/projects/{project_id}/renders/{render_id}/video",
        }

    return handle
