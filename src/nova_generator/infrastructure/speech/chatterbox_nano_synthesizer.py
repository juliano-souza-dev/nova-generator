from __future__ import annotations

import json
import logging
import os
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Any

from nova_generator.application.ports.wav_probe import WavProbe
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.filesystem.voice_references import (
    FileVoiceReferenceStore,
    validate_profile_reference,
)
from nova_generator.infrastructure.speech.ffprobe_wav_probe import FfprobeWavProbe

logger = logging.getLogger(__name__)


def _decode_output(value: bytes | str | None) -> str:
    """Decode subprocess diagnostics even when Windows/native libraries use a local code page."""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


class ChatterboxNanoSynthesizer:
    """Runs Chatterbox in a separate Python process; API workers never load the model."""

    def __init__(
        self,
        runner: Path,
        executable: str = "python",
        wav_probe: WavProbe | None = None,
        reference_store: FileVoiceReferenceStore | None = None,
        environment: dict[str, str] | None = None,
        engine_name: str = "Chatterbox",
        timeout_seconds: int = 300,
    ) -> None:
        self._runner = runner
        self._executable = executable
        self._wav_probe = wav_probe or FfprobeWavProbe()
        self._reference_store = reference_store
        self._environment = environment
        self._engine_name = engine_name
        self._timeout_seconds = timeout_seconds

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
            validate_profile_reference(store, profile.reference_audio_sha256)
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
                errors="replace",
                capture_output=True,
                check=False,
                timeout=self._timeout_seconds,
                env={**os.environ, **self._environment} if self._environment else None,
            )
        except subprocess.TimeoutExpired as exc:
            stderr = _decode_output(exc.stderr).strip()
            stdout = _decode_output(exc.stdout).strip()
            logger.error(
                "chatterbox_subprocess_timeout runner=%s timeout=%s stderr=%r stdout=%r",
                self._runner,
                exc.timeout,
                stderr[-16000:],
                stdout[-4000:],
                exc_info=True,
            )
            raise RuntimeError(
                f"A síntese do {self._engine_name} excedeu {self._timeout_seconds} segundos. "
                "Verifique a carga da CPU/GPU, o primeiro carregamento do modelo "
                "e os logs do worker antes de tentar novamente."
            ) from exc
        except OSError as exc:
            raise RuntimeError(
                f"Não foi possível iniciar o processo isolado do {self._engine_name}."
            ) from exc
        if completed.returncode != 0:
            detail = (
                _decode_output(completed.stderr).strip()
                or _decode_output(completed.stdout).strip()
                or "erro não informado"
            )
            raise RuntimeError(f"{self._engine_name} falhou: {detail}")
        if output.suffix.lower() != ".wav" or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError(f"{self._engine_name} não produziu WAV canônico válido.")
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
