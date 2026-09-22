from __future__ import annotations

import json
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Any

from nova_generator.application.ports.wav_probe import WavProbe
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.filesystem.voice_references import FileVoiceReferenceStore
from nova_generator.infrastructure.speech.ffprobe_wav_probe import FfprobeWavProbe


class ChatterboxNanoSynthesizer:
    """Runs Chatterbox in a separate Python process; API workers never load the model."""

    def __init__(
        self,
        runner: Path,
        executable: str = "python",
        wav_probe: WavProbe | None = None,
        reference_store: FileVoiceReferenceStore | None = None,
    ) -> None:
        self._runner = runner
        self._executable = executable
        self._wav_probe = wav_probe or FfprobeWavProbe()
        self._reference_store = reference_store

    def synthesize(
        self,
        *,
        text: str,
        profile: VoiceProfileSnapshot,
        parameters: dict[str, Any],
        output: Path,
    ) -> SynthesizedSpeech:
        output.parent.mkdir(parents=True, exist_ok=True)
        if any(
            key.lower().endswith(("_path", "_file")) for key in (*profile.parameters, *parameters)
        ):
            raise ValueError("Caminhos de arquivo não são aceitos nos parâmetros da voz.")
        reference_root = None
        if profile.reference_audio_sha256:
            store = self._reference_store
            if store is None:
                raise ValueError("Biblioteca de WAV de referência não configurada.")
            stored = store.get(profile.reference_audio_sha256)
            if stored is None:
                raise ValueError("WAV de referência do perfil ausente ou alterado.")
            reference_root = str(store.root.resolve())
        request = {
            "text": text,
            "profile": {"model_id": profile.model_id, "parameters": profile.parameters},
            "parameters": parameters,
            "output": str(output),
            "reference_audio_sha256": profile.reference_audio_sha256,
            "reference_root": reference_root,
        }
        try:
            completed = subprocess.run(
                [self._executable, str(self._runner)],
                input=json.dumps(request, ensure_ascii=False),
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
                timeout=300,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(
                "Não foi possível iniciar o processo isolado do Chatterbox."
            ) from exc
        if completed.returncode != 0:
            detail = completed.stderr.strip() or "erro não informado"
            raise RuntimeError(f"Chatterbox falhou: {detail}")
        if output.suffix.lower() != ".wav" or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("Chatterbox não produziu WAV canônico válido.")
        duration_ms, sample_rate, channels = self._wav_probe.inspect_wav(output)
        return SynthesizedSpeech(
            str(output),
            sha256(text.encode("utf-8")).hexdigest(),
            profile,
            parameters,
            duration_ms,
            sample_rate,
            channels,
        )
