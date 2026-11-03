"""Local Qwen3-TTS 1.7B model registry and reproducible checkpoint identity."""

from __future__ import annotations

from functools import lru_cache
from hashlib import sha256
from pathlib import Path

from nova_generator.core.settings import Settings
from nova_generator.infrastructure.speech.model_checkpoint import _hash_file

VOICE_DESIGN = "qwen3-tts-1.7b-voice-design"
VOICE_CLONE = "qwen3-tts-1.7b-base"
QWEN_MODELS = {
    VOICE_DESIGN: "Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    VOICE_CLONE: "Qwen3-TTS-12Hz-1.7B-Base",
}


def qwen_model_dir(settings: Settings, model_id: str) -> Path:
    if model_id not in QWEN_MODELS:
        raise ValueError("Modelo Qwen3-TTS desconhecido.")
    return settings.qwen_model_root.expanduser() / QWEN_MODELS[model_id]


def qwen_model_sha256(settings: Settings, model_id: str) -> str:
    """Fingerprint all local weights and configuration, not just a mutable model name."""
    directory = qwen_model_dir(settings, model_id)
    if not (directory / "config.json").is_file():
        raise ValueError(
            f"Modelo Qwen3-TTS não instalado em {directory}. "
            "Baixe os pesos locais antes de criar a voz."
        )
    weights = sorted(path for path in directory.rglob("*.safetensors") if path.is_file())
    if not weights:
        raise ValueError(f"Pesos .safetensors do Qwen3-TTS ausentes em {directory}.")
    files = [directory / "config.json", *weights]
    # Include the model's auxiliary configs/tokenizer metadata in the identity.
    files.extend(
        path for path in sorted(directory.rglob("*.json"))
        if path.is_file() and path.name != "config.json"
    )
    manifest = [
        (str(path.relative_to(directory)), path.stat().st_size, path.stat().st_mtime_ns)
        for path in files
    ]
    return _fingerprint(str(directory.resolve()), tuple(manifest))


@lru_cache(maxsize=8)
def _fingerprint(
    root: str, manifest: tuple[tuple[str, int, int], ...]
) -> str:
    digest = sha256()
    for name, size, modified in manifest:
        path = Path(root) / name
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(_hash_file(str(path.resolve()), size, modified).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def validate_qwen_voice(
    model_id: str, reference_audio_sha256: str | None, parameters: dict[str, object]
) -> None:
    if model_id == VOICE_DESIGN:
        if reference_audio_sha256:
            raise ValueError("A voz criada por descrição não utiliza áudio de referência.")
        if set(parameters) != {"instruct"}:
            raise ValueError("Informe somente a descrição de interpretação (instruct).")
        description = parameters["instruct"]
        if not isinstance(description, str) or not 10 <= len(description.strip()) <= 800:
            raise ValueError("Descreva a voz e sua interpretação em 10 a 800 caracteres.")
    elif model_id == VOICE_CLONE:
        if not reference_audio_sha256:
            raise ValueError("A clonagem local requer áudio de referência autorizado.")
        if set(parameters) != {"reference_text"}:
            raise ValueError("Informe somente a transcrição da referência (reference_text).")
        transcript = parameters["reference_text"]
        if not isinstance(transcript, str) or not 1 <= len(transcript.strip()) <= 1000:
            raise ValueError("Transcreva literalmente o áudio de referência (até 1000 caracteres).")
    else:
        raise ValueError("Modelo Qwen3-TTS desconhecido.")
