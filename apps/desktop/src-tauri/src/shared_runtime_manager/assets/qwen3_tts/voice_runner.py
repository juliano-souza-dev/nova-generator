"""Persistent JSON-lines worker for Qwen3-TTS Base and VoiceDesign profiles."""
import contextlib
import json
import os
import sys
import traceback
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


def handle_request(model, profile_path: Path, request: dict, set_stage, prompt_cache: dict) -> dict:
    operation = request.get("operation")
    if operation == "prepare_voice":
        set_stage("reference_audio_encoding")
        with contextlib.redirect_stdout(sys.stderr):
            items = model.create_voice_clone_prompt(
                ref_audio=str(Path(request["reference_audio"]).resolve()),
                ref_text=str(request["reference_text"]),
                x_vector_only_mode=False,
            )
        set_stage("voice_prompt_saving")
        prompt_path = profile_path / "voice_clone_prompt.pt"
        torch.save(items, prompt_path)
        (profile_path / "voice_clone_mode.txt").write_text("full_prompt", encoding="utf-8")
        stat = prompt_path.stat()
        prompt_cache[str(prompt_path.resolve())] = {
            "signature": (stat.st_mtime_ns, stat.st_size),
            "prompt": items,
        }
        return {
            "status": "completed",
            "profile_path": str(profile_path),
            "voice_clone_mode": "full_prompt",
        }

    if operation == "prepare_voice_design":
        instruct = str(request.get("instruct", "")).strip()
        if not 10 <= len(instruct) <= 800:
            raise ValueError("A descrição da voz precisa ter entre 10 e 800 caracteres.")
        set_stage("voice_design_profile_saving")
        (profile_path / "voice_design_instruct.txt").write_text(instruct, encoding="utf-8")
        return {"status": "completed", "profile_path": str(profile_path), "voice_mode": "voice_design"}

    if operation == "synthesize":
        voice_mode = str(request.get("voice_mode", "voice_clone"))
        if voice_mode == "voice_design":
            instruct = str(request.get("instruct") or (profile_path / "voice_design_instruct.txt").read_text(encoding="utf-8")).strip()
            if not 10 <= len(instruct) <= 800:
                raise ValueError("A descrição da voz precisa ter entre 10 e 800 caracteres.")
        elif voice_mode != "voice_clone":
            raise ValueError("Modo de voz Qwen desconhecido.")
        prompt_path = profile_path / "voice_clone_prompt.pt"
        set_stage("voice_prompt_loading")
        prompt = None
        if voice_mode == "voice_clone":
            cache_key = str(prompt_path.resolve())
            stat = prompt_path.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
            cached = prompt_cache.get(cache_key)
            if cached is not None and cached.get("signature") == signature:
                prompt = cached["prompt"]
            else:
                prompt = torch.load(prompt_path, map_location="cpu", weights_only=False)
                prompt_cache[cache_key] = {"signature": signature, "prompt": prompt}
        # Rebuild profiles created with speaker-only conditioning using the
        # full reference prompt, preserving the original reference WAV.
        mode_path = profile_path / "voice_clone_mode.txt"
        current_mode = mode_path.read_text(encoding="utf-8").strip() if mode_path.is_file() else ""
        if voice_mode == "voice_clone" and current_mode != "full_prompt":
            reference_audio = request.get("reference_audio") or str(profile_path / "reference.wav")
            reference_text = str(request.get("reference_text") or "").strip()
            # Some existing app integrations send only the profile directory.
            # Keep an existing prompt usable when the integration does not
            # provide the reference audio and transcript needed to rebuild it.
            if Path(reference_audio).is_file() and reference_text:
                set_stage("reference_audio_encoding")
                with contextlib.redirect_stdout(sys.stderr):
                    prompt = model.create_voice_clone_prompt(
                        ref_audio=str(Path(reference_audio).resolve()),
                        ref_text=reference_text,
                        x_vector_only_mode=False,
                    )
                set_stage("voice_prompt_saving")
                torch.save(prompt, prompt_path)
                mode_path.write_text("full_prompt", encoding="utf-8")
                stat = prompt_path.stat()
                prompt_cache[str(prompt_path.resolve())] = {
                    "signature": (stat.st_mtime_ns, stat.st_size),
                    "prompt": prompt,
                }
        if voice_mode == "voice_clone" and (not isinstance(prompt, (list, tuple)) or not prompt):
            raise ValueError("O perfil de voz contém um prompt Qwen inválido ou vazio.")
        text = str(request["text"]).strip()
        language = str(request.get("language", "English")).strip() or "English"
        # A terminal punctuation mark gives the model a clearer prosodic boundary
        # when an Anki expression arrives as a bare phrase.
        if text and text[-1] not in ".!?…;:":
            text += "."
        set_stage("voice_generation")
        with contextlib.redirect_stdout(sys.stderr):
            if voice_mode == "voice_design":
                segment_instruct = instruct
                language_key = language.casefold()
                if language_key == "english":
                    suffix = "Keep the same speaker identity and vocal timbre; use clear, natural General American English pronunciation and intonation."
                elif language_key == "portuguese":
                    suffix = "Keep the same speaker identity and vocal timbre; use fluent, natural Brazilian Portuguese pronunciation and intonation."
                else:
                    suffix = "Keep the same speaker identity and vocal timbre; use natural pronunciation and intonation for the requested language."
                if suffix.casefold() not in segment_instruct.casefold() and len(segment_instruct) + len(suffix) + 2 <= 800:
                    segment_instruct = segment_instruct.rstrip(". ") + ". " + suffix
                wavs, sample_rate = model.generate_voice_design(
                    text=text, language=language, instruct=segment_instruct, do_sample=True
                )
            else:
                wavs, sample_rate = model.generate_voice_clone(
                    text=text, language=language, voice_clone_prompt=prompt,
                    non_streaming_mode=True, do_sample=True, top_k=50, top_p=0.95,
                    temperature=0.85, repetition_penalty=1.08,
                    subtalker_dosample=True, subtalker_top_k=50,
                    subtalker_top_p=0.95, subtalker_temperature=0.85,
                )
        set_stage("audio_pacing")
        # Qwen3-TTS Base does not expose a native speech-rate argument. Use a
        # pitch-preserving phase vocoder for a modest, configurable slowdown.
        import librosa
        import numpy as np
        speech_rate = float(os.environ.get("SRM_TTS_SPEECH_RATE", "0.92"))
        speech_rate = min(1.0, max(0.85, speech_rate))
        waveform = np.asarray(wavs[0], dtype=np.float32)
        if abs(speech_rate - 1.0) > 1e-3:
            waveform = librosa.effects.time_stretch(y=waveform, rate=speech_rate)
        # A short tail avoids the abrupt cutoff common in isolated flashcards.
        tail = np.zeros(int(sample_rate * 0.14), dtype=waveform.dtype)
        waveform = np.concatenate((waveform, tail))
        set_stage("audio_file_writing")
        output = Path(request["output_path"]).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        # Keep the previous valid audio untouched until the replacement is complete.
        temporary_output = output.with_name(
            f".{output.stem}.{os.getpid()}.partial{output.suffix}"
        )
        try:
            sf.write(str(temporary_output), waveform, sample_rate)
            if not temporary_output.is_file() or temporary_output.stat().st_size <= 44:
                raise RuntimeError("O arquivo de áudio temporário está vazio ou inválido.")
            os.replace(temporary_output, output)
        finally:
            try:
                temporary_output.unlink()
            except FileNotFoundError:
                pass
        return {
            "status": "completed",
            "output_path": str(output),
            "sample_rate": int(sample_rate),
            "language": language,
            "speech_rate": speech_rate,
        }

    raise ValueError("Unsupported operation: " + str(operation))


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: voice_runner.py <model-directory> <profile-directory>", file=sys.stderr)
        return 2

    model_path = Path(sys.argv[1]).resolve()
    profile_path = Path(sys.argv[2]).resolve()
    stage = "runtime_initialization"
    try:
        cpu_count = os.cpu_count() or 4
        torch.set_num_threads(max(1, min(cpu_count, 8)))
        torch.set_num_interop_threads(1)
        stage = "model_loading"
        print(json.dumps({
            "type": "progress",
            "id": None,
            "operation": "startup",
            "stage": stage,
        }), flush=True)
        with contextlib.redirect_stdout(sys.stderr):
            try:
                model = Qwen3TTSModel.from_pretrained(
                    str(model_path), device_map="cpu", dtype=torch.float32,
                    low_cpu_mem_usage=True,
                )
                print("voice_loader=optimized", file=sys.stderr, flush=True)
            except Exception as optimized_error:
                oom_type = getattr(torch, "OutOfMemoryError", None)
                error_message = str(optimized_error).lower()
                memory_pressure = isinstance(optimized_error, MemoryError) or (
                    oom_type is not None and isinstance(optimized_error, oom_type)
                ) or any(marker in error_message for marker in (
                    "out of memory",
                    "can't allocate memory",
                    "cannot allocate memory",
                    "defaultcpuallocator",
                    "not enough memory",
                ))
                if memory_pressure:
                    print(
                        f"voice_loader=fallback_skipped_memory_pressure reason={type(optimized_error).__name__}: {optimized_error}",
                        file=sys.stderr,
                        flush=True,
                    )
                    raise
                print(f"voice_loader=legacy_fallback reason={type(optimized_error).__name__}: {optimized_error}", file=sys.stderr, flush=True)
                model = Qwen3TTSModel.from_pretrained(
                    str(model_path), device_map={"": "cpu"}, dtype=torch.float32,
                    attn_implementation="sdpa",
                )
    except Exception as error:
        print(json.dumps({
            "status": "error",
            "id": None,
            "operation": "startup",
            "stage": stage,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False), flush=True)
        return 1

    # A worker serves one profile at a time. Keep its prepared prompt in RAM
    # for the duration of the batch, and invalidate it if the on-disk prompt changes.
    prompt_cache = {}

    for line_number, raw in enumerate(sys.stdin, start=1):
        request = {}
        operation = "request_parsing"
        stage = "request_parsing"
        try:
            request = json.loads(raw)
            stage = "request_validation"
            if not isinstance(request, dict):
                raise TypeError("A solicitação recebida precisa ser um objeto JSON.")
            operation = str(request.get("operation") or "unknown")
            stage = "voice_prompt_loading" if operation == "synthesize" else "voice_prompt_preparation"
            request_id = request.get("id")
            def set_stage(value):
                nonlocal stage
                stage = value
                print(json.dumps({
                    "type": "progress",
                    "id": request_id,
                    "operation": operation,
                    "stage": value,
                }, ensure_ascii=False), flush=True)
            set_stage(stage)
            response = handle_request(model, profile_path, request, set_stage, prompt_cache)
            response.update({
                "id": request.get("id"),
                "operation": operation,
                "stage": "completed",
            })
        except Exception as error:
            response = {
                "status": "error",
                "id": request.get("id") if isinstance(request, dict) else None,
                "operation": operation,
                "stage": stage,
                "line": line_number,
                "error_type": type(error).__name__,
                "error": str(error),
                "traceback": traceback.format_exc(),
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
        # A failed card invalidates the current batch. Stop immediately instead
        # of spending CPU synthesizing cards whose results cannot be committed.
        if response.get("status") == "error":
            break

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
