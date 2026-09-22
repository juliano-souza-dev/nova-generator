from __future__ import annotations

import json
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Any

from nova_generator.application.ports.wav_probe import WavProbe
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.speech.ffprobe_wav_probe import FfprobeWavProbe


class ChatterboxNanoSynthesizer:
    """Runs Chatterbox in a separate Python process; API workers never load the model."""

    def __init__(
        self, runner: Path, executable: str = "python", wav_probe: WavProbe | None = None
    ) -> None:
        self._runner = runner
        self._executable = executable
        self._wav_probe = wav_probe or FfprobeWavProbe()

    def synthesize(
        self,
        *,
        text: str,
        profile: VoiceProfileSnapshot,
        parameters: dict[str, Any],
        output: Path,
    ) -> SynthesizedSpeech:
        output.parent.mkdir(parents=True, exist_ok=True)
        request = {
            "text": text,
            "profile": {"model_id": profile.model_id, "parameters": profile.parameters},
            "parameters": parameters,
            "output": str(output),
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
