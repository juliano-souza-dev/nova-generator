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


def split_text_into_chunks(text: str, max_chars: int = 800) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    chunks = []
    remaining = text
    while remaining:
        remaining = remaining.lstrip()
        if len(remaining) <= max_chars:
            chunks.append(remaining)
            break
        segment = remaining[:max_chars]
        boundary = -1
        for match in __import__("re").finditer(r"[.!?。！？](?:\\s|$)", segment):
            boundary = match.start()
        if boundary < 0:
            for match in __import__("re").finditer(r"[;:,—](?:\\s|$)", segment):
                boundary = match.start()
        if boundary < 0:
            boundary = segment.rfind(" ")
        if boundary < 0:
            boundary = max_chars - 1
        chunk = remaining[:boundary + 1].strip()
        if not chunk:
            chunk = remaining[:max_chars].strip()
            boundary = max_chars - 1
        chunks.append(chunk)
        remaining = remaining[boundary + 1:]
    return chunks


def concatenate_chunks(chunks, sample_rate: int, crossfade_ms: int):
    import numpy as np
    if not chunks:
        return np.array([], dtype=np.float32)
    result = np.asarray(chunks[0], dtype=np.float32).copy()
    overlap_size = max(0, int(sample_rate * crossfade_ms / 1000))
    for chunk in chunks[1:]:
        chunk = np.asarray(chunk, dtype=np.float32)
        overlap = min(overlap_size, len(result), len(chunk))
        if overlap:
            fade_out = np.linspace(1.0, 0.0, overlap, dtype=np.float32)
            fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
            result[-overlap:] = result[-overlap:] * fade_out + chunk[:overlap] * fade_in
            result = np.concatenate((result, chunk[overlap:]))
        else:
            result = np.concatenate((result, chunk))
    return result


def apply_effects(waveform, sample_rate: int, effects_chain: list):
    enabled = [item for item in effects_chain if isinstance(item, dict) and item.get("enabled", True)]
    if not enabled:
        return waveform
    try:
        from pedalboard import (
            Pedalboard, Chorus, Reverb, Delay, Compressor, Gain,
            HighpassFilter, LowpassFilter, PitchShift,
        )
    except ImportError as error:
        raise RuntimeError(
            "Os efeitos de áudio ainda não estão instalados neste runtime. "
            "Atualize as dependências do Qwen3-TTS para habilitar o processamento."
        ) from error

    constructors = {
        "chorus": (Chorus, {
            "rate_hz": (1.0, 0.01, 20.0), "depth": (0.5, 0.0, 1.0),
            "feedback": (0.0, 0.0, 0.95), "centre_delay_ms": (7.0, 0.5, 50.0),
            "mix": (0.5, 0.0, 1.0),
        }),
        "reverb": (Reverb, {
            "room_size": (0.5, 0.0, 1.0), "damping": (0.5, 0.0, 1.0),
            "wet_level": (0.33, 0.0, 1.0), "dry_level": (0.4, 0.0, 1.0),
            "width": (1.0, 0.0, 1.0),
        }),
        "delay": (Delay, {
            "delay_seconds": (0.3, 0.01, 2.0), "feedback": (0.3, 0.0, 0.95),
            "mix": (0.3, 0.0, 1.0),
        }),
        "compressor": (Compressor, {
            "threshold_db": (-20.0, -60.0, 0.0), "ratio": (4.0, 1.0, 20.0),
            "attack_ms": (10.0, 0.1, 100.0), "release_ms": (100.0, 10.0, 1000.0),
        }),
        "gain": (Gain, {"gain_db": (0.0, -40.0, 40.0)}),
        "highpass": (HighpassFilter, {"cutoff_frequency_hz": (80.0, 20.0, 8000.0)}),
        "lowpass": (LowpassFilter, {"cutoff_frequency_hz": (8000.0, 200.0, 20000.0)}),
        "pitch_shift": (PitchShift, {"semitones": (0.0, -12.0, 12.0)}),
    }
    plugins = []
    for index, effect in enumerate(enabled):
        effect_type = effect.get("type")
        if effect_type not in constructors:
            raise ValueError(f"Efeito desconhecido na posição {index}: {effect_type}")
        constructor, definitions = constructors[effect_type]
        supplied = effect.get("params") or {}
        if not isinstance(supplied, dict):
            raise ValueError(f"Parâmetros inválidos para o efeito {effect_type}.")
        params = {}
        for name, (default, minimum, maximum) in definitions.items():
            value = supplied.get(name, default)
            if not isinstance(value, (int, float)) or not minimum <= float(value) <= maximum:
                raise ValueError(f"Parâmetro {name} inválido para o efeito {effect_type}.")
            params[name] = float(value)
        unknown = set(supplied) - set(definitions)
        if unknown:
            raise ValueError(f"Parâmetro não suportado em {effect_type}: {sorted(unknown)[0]}")
        plugins.append(constructor(**params))
    processed = Pedalboard(plugins)(waveform.astype("float32")[None, :], sample_rate)
    return processed[0]


def handle_request(model, profile_path: Path, request: dict, set_stage) -> dict:
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
        torch.save(items, profile_path / "voice_clone_prompt.pt")
        (profile_path / "voice_clone_mode.txt").write_text("full_prompt", encoding="utf-8")
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
        prompt = torch.load(prompt_path, map_location="cpu", weights_only=False) if voice_mode == "voice_clone" else None
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
        if voice_mode == "voice_clone" and (not isinstance(prompt, (list, tuple)) or not prompt):
            raise ValueError("O perfil de voz contém um prompt Qwen inválido ou vazio.")
        text = str(request["text"]).strip()
        language = str(request.get("language", "English")).strip() or "English"
        # A terminal punctuation mark gives the model a clearer prosodic boundary
        # when an Anki expression arrives as a bare phrase.
        if text and text[-1] not in ".!?…;:":
            text += "."
        import numpy as np
        set_stage("voice_generation")
        max_chunk_chars = int(request.get("max_chunk_chars", 800))
        max_chunk_chars = min(2000, max(100, max_chunk_chars))
        crossfade_ms = int(request.get("crossfade_ms", 50))
        crossfade_ms = min(250, max(0, crossfade_ms))
        chunks = split_text_into_chunks(text, max_chunk_chars)
        generated_chunks = []
        for chunk_index, chunk_text in enumerate(chunks):
            chunk_text = chunk_text.strip()
            if chunk_text and chunk_text[-1] not in ".!?…;:":
                chunk_text += "."
            with contextlib.redirect_stdout(sys.stderr):
                if voice_mode == "voice_design":
                    segment_instruct = instruct
                    if language.lower() == "english":
                        suffix = "Keep the same speaker identity and vocal timbre; use clear, natural American English pronunciation."
                        if suffix.lower() not in segment_instruct.lower() and len(segment_instruct) + len(suffix) + 2 <= 800:
                            segment_instruct = segment_instruct.rstrip(". ") + ". " + suffix
                    wavs, chunk_sample_rate = model.generate_voice_design(
                        text=chunk_text, language=language, instruct=segment_instruct, do_sample=True
                    )
                else:
                    wavs, chunk_sample_rate = model.generate_voice_clone(
                        text=chunk_text, language=language, voice_clone_prompt=prompt,
                        non_streaming_mode=True, do_sample=True, top_k=50, top_p=0.95,
                        temperature=0.85, repetition_penalty=1.08,
                        subtalker_dosample=True, subtalker_top_k=50,
                        subtalker_top_p=0.95, subtalker_temperature=0.85,
                    )
            if int(chunk_sample_rate) <= 0:
                raise RuntimeError("O motor TTS retornou uma taxa de amostragem inválida.")
            if generated_chunks and int(chunk_sample_rate) != int(sample_rate):
                raise RuntimeError("O motor TTS retornou taxas de amostragem diferentes entre trechos.")
            generated_chunks.append(np.asarray(wavs[0], dtype=np.float32))
            set_stage(f"voice_generation_chunk_{chunk_index + 1}_of_{len(chunks)}")
        waveform = concatenate_chunks(generated_chunks, int(chunk_sample_rate), crossfade_ms)
        applied_effects = request.get("effects_chain") or []
        if not isinstance(applied_effects, list):
            raise ValueError("A cadeia de efeitos precisa ser uma lista.")
        if applied_effects:
            set_stage("audio_effects")
            waveform = apply_effects(waveform, int(chunk_sample_rate), applied_effects)
        set_stage("audio_pacing")
        # Qwen3-TTS does not expose a native speech-rate argument. Use a
        # pitch-preserving phase vocoder for a modest, configurable slowdown.
        import librosa
        speech_rate = float(os.environ.get("SRM_TTS_SPEECH_RATE", "0.92"))
        speech_rate = min(1.0, max(0.85, speech_rate))
        if abs(speech_rate - 1.0) > 1e-3:
            waveform = librosa.effects.time_stretch(y=waveform, rate=speech_rate)
        # A short tail avoids the abrupt cutoff common in isolated flashcards.
        tail = np.zeros(int(chunk_sample_rate * 0.14), dtype=waveform.dtype)
        waveform = np.concatenate((waveform, tail))
        set_stage("audio_file_writing")
        output = Path(request["output_path"]).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output), waveform, sample_rate)
        return {
            "status": "completed",
            "output_path": str(output),
            "sample_rate": int(chunk_sample_rate),
            "chunks": len(chunks),
            "effects_applied": len([item for item in applied_effects if isinstance(item, dict) and item.get("enabled", True)]),
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
        with contextlib.redirect_stdout(sys.stderr):
            try:
                model = Qwen3TTSModel.from_pretrained(
                    str(model_path), device_map="cpu", dtype=torch.float32,
                    low_cpu_mem_usage=True,
                )
                print("voice_loader=optimized", file=sys.stderr, flush=True)
            except Exception as optimized_error:
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
            def set_stage(value):
                nonlocal stage
                stage = value
            response = handle_request(model, profile_path, request, set_stage)
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

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
