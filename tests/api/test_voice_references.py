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
