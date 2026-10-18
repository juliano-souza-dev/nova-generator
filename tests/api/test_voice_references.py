import io
import wave
from hashlib import sha256

from nova_generator.core.settings import get_settings


def _wav(seconds: int = 2) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 16000 * seconds)
    return output.getvalue()


def test_upload_library_and_create_voice_without_manual_hashes(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    checkpoint = tmp_path / "t3_nano_v1.safetensors"
    checkpoint.write_bytes(b"model checkpoint")
    monkeypatch.setenv("NOVA_GENERATOR_CHATTERBOX_MODEL_FILE", str(checkpoint))
    get_settings.cache_clear()

    content = _wav()
    uploaded = client.post(
        "/api/voices/references", files={"file": ("speaker.wav", content, "audio/wav")}
    )
    assert uploaded.status_code == 201
    reference = uploaded.json()
    assert reference["sha256"] == sha256(content).hexdigest()
    assert reference["duration_ms"] == 2000
    assert client.get("/api/voices/references").json() == [reference]
    assert client.get(reference["audio_url"]).content == content
    assert client.get("/api/voices/model").json() == {
        "available": True,
        "model_sha256": sha256(checkpoint.read_bytes()).hexdigest(),
    }

    created = client.post(
        "/api/voices",
        json={
            "name": "Narradora A",
            "reference_audio_sha256": reference["sha256"],
            "parameters": {},
        },
    )
    assert created.status_code == 201
    assert created.json()["model_sha256"] == sha256(checkpoint.read_bytes()).hexdigest()
    assert created.json()["reference_audio_sha256"] == reference["sha256"]
    job = client.get("/api/jobs").json()["items"][0]
    assert job["input"]["voice_snapshot"]["reference_audio_sha256"] == reference["sha256"]


def test_rejects_invalid_wav_unknown_hash_and_user_paths(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    bad = client.post(
        "/api/voices/references", files={"file": ("bad.wav", b"not audio", "audio/wav")}
    )
    assert bad.status_code == 422
    unknown = client.post(
        "/api/voices",
        json={
            "name": "Bad",
            "model_sha256": "a" * 64,
            "reference_audio_sha256": "b" * 64,
            "parameters": {},
        },
    )
    assert unknown.status_code == 422
    unsafe = client.post(
        "/api/voices",
        json={
            "name": "Bad",
            "model_sha256": "a" * 64,
            "parameters": {"reference_audio_path": "C:/secret.wav"},
        },
    )
    assert unsafe.status_code == 422
    assert client.get("/api/voices/references").json() == []


def test_accept_mp3_and_ogg_and_store_canonical_wav(client, tmp_path, monkeypatch):
    """The API stores decoded WAV, never the original compressed voice file."""
    from pathlib import Path
    from types import SimpleNamespace

    from nova_generator.infrastructure.filesystem import voice_references

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    canonical = _wav()

    def fake_ffmpeg(command, **kwargs):
        assert command[0] == "ffmpeg"
        assert "-ac" in command and "-ar" in command
        assert command[command.index("-ac") + 1] == "1"
        assert command[command.index("-ar") + 1] == "24000"
        assert kwargs["timeout"] == 30
        Path(command[-1]).write_bytes(canonical)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(voice_references.subprocess, "run", fake_ffmpeg)
    for extension, mime in (("mp3", "audio/mpeg"), ("ogg", "audio/ogg")):
        response = client.post(
            "/api/voices/references",
            files={"file": (f"reference.{extension}", b"encoded-audio", mime)},
        )
        assert response.status_code == 201, response.text
        result = response.json()
        assert result["sha256"] == sha256(canonical).hexdigest()
        assert result["duration_ms"] == 2000
        assert result["sample_rate"] == 16000
        assert client.get(result["audio_url"]).content == canonical
    assert len(client.get("/api/voices/references").json()) == 1


def test_reject_unsupported_extensions_or_corrupted_compressed_audio(
    client, tmp_path, monkeypatch
):
    from types import SimpleNamespace

    from nova_generator.infrastructure.filesystem import voice_references

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    rejected = client.post(
        "/api/voices/references",
        files={"file": ("audio.flac", b"unsupported", "audio/flac")},
    )
    assert rejected.status_code == 422

    monkeypatch.setattr(
        voice_references.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1),
    )
    corrupted = client.post(
        "/api/voices/references",
        files={"file": ("broken.mp3", b"not-mp3", "audio/mpeg")},
    )
    assert corrupted.status_code == 422
    assert "inválido" in corrupted.json()["detail"]
    assert client.get("/api/voices/references").json() == []


def test_compressed_audio_conversion_requires_ffmpeg(client, tmp_path, monkeypatch):
    from nova_generator.infrastructure.filesystem import voice_references

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()

    def no_ffmpeg(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(voice_references.subprocess, "run", no_ffmpeg)
    response = client.post(
        "/api/voices/references",
        files={"file": ("voice.ogg", b"compressed", "audio/ogg")},
    )
    assert response.status_code == 422
    assert "FFmpeg" in response.json()["detail"]


def test_real_ffmpeg_decodes_mp3_and_ogg_into_voice_library(client, tmp_path, monkeypatch):
    """Smoke test real decoding when FFmpeg is installed in the test environment."""
    import shutil
    import subprocess

    import pytest

    if shutil.which("ffmpeg") is None:
        pytest.skip("FFmpeg is not installed on this runner")

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    original = tmp_path / "reference.wav"
    original.write_bytes(_wav())

    for extension, codec, mime in (
        ("mp3", "libmp3lame", "audio/mpeg"),
        ("ogg", "libvorbis", "audio/ogg"),
    ):
        output = tmp_path / f"reference.{extension}"
        encode = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(original),
                "-c:a",
                codec,
                str(output),
            ],
            capture_output=True,
            check=False,
            timeout=20,
        )
        if encode.returncode != 0:
            pytest.skip(f"FFmpeg encoder {codec} not available")
        response = client.post(
            "/api/voices/references",
            files={"file": (output.name, output.read_bytes(), mime)},
        )
        assert response.status_code == 201, response.text
        parsed = response.json()
        assert 1900 <= parsed["duration_ms"] <= 2200
        assert parsed["sample_rate"] == 24000
        assert parsed["channels"] == 1
        wav = client.get(parsed["audio_url"]).content
        assert sha256(wav).hexdigest() == parsed["sha256"]
        assert wav[:4] == b"RIFF"
