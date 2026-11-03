def _payload(name: str = "Ana") -> dict[str, object]:
    return {
        "name": name,
        "model_id": "chatterbox-nano",
        "model_sha256": "a" * 64,
        "parameters": {"speed": 1.0},
    }


def test_voice_versions_are_immutable_and_queue_previews(client):
    created = client.post("/api/voices", json=_payload()).json()
    assert created["version"] == 1
    assert created["snapshot_sha256"]
    versioned = client.post(
        f"/api/voices/{created['id']}/versions", json=_payload("Ana nova")
    ).json()
    assert versioned["version"] == 2
    listed = client.get("/api/voices").json()
    assert [(item["id"], item["version"]) for item in listed] == [(created["id"], 2)]
    jobs = client.get("/api/jobs").json()["items"]
    assert len(jobs) == 2
    assert all(job["kind"] == "synthesize_voice_preview" for job in jobs)


def test_voice_rejects_invalid_model_hash(client):
    response = client.post("/api/voices", json={**_payload(), "model_sha256": "bad"})
    assert response.status_code == 422


def test_preview_is_available_only_for_existing_cached_version(client, tmp_path, monkeypatch):
    from pathlib import Path
    from uuid import UUID

    from nova_generator.application.use_cases.manage_voice_profiles import PREVIEW_TEXT
    from nova_generator.core.settings import get_settings
    from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
    from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    voice = client.post("/api/voices", json=_payload()).json()
    detail_url = f"/api/voices/{voice['id']}/versions/1"
    assert client.get(detail_url).json()["preview_ready"] is False
    assert client.get(f"{detail_url}/preview").status_code == 404
    assert client.get(f"/api/voices/{voice['id']}/versions/2").status_code == 404

    profile = VoiceProfileSnapshot(
        UUID(voice["id"]),
        voice["name"],
        1,
        voice["model_id"],
        voice["model_sha256"],
        None,
        voice["parameters"],
    )
    cache = FileSpeechCache(Path(get_settings().media_cache_root))
    key = cache.cache_key(text=PREVIEW_TEXT, profile=profile, parameters={})
    staging = cache.staging_path(key)
    staging.write_bytes(b"RIFF-test-preview")
    cache.save(key, SynthesizedSpeech(str(staging), "a" * 64, profile, {}, 100, 24000, 1))
    assert client.get(detail_url).json()["preview_ready"] is True
    response = client.get(f"{detail_url}/preview")
    assert response.status_code == 200
    assert response.content == b"RIFF-test-preview"


def test_qwen_voice_design_model_status_and_portuguese_preview(client, tmp_path, monkeypatch):
    from nova_generator.application.use_cases.manage_voice_profiles import (
        QWEN_PREVIEW_TEXT,
    )
    from nova_generator.core.settings import get_settings

    root = tmp_path / "qwen"
    model = root / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    model.mkdir(parents=True)
    (model / "config.json").write_text("{}", encoding="utf-8")
    (model / "model.safetensors").write_bytes(b"local-dummy-weights")
    monkeypatch.setenv("NOVA_GENERATOR_QWEN_MODEL_ROOT", str(root))
    get_settings.cache_clear()

    model_status = client.get("/api/voices/model?model_id=qwen3-tts-1.7b-voice-design")
    assert model_status.json()["available"] is True
    payload = {
        "name": "Narradora de aulas",
        "model_id": "qwen3-tts-1.7b-voice-design",
        "parameters": {"instruct": "Voz brasileira muito natural e expressiva."},
    }
    created = client.post("/api/voices", json=payload)
    assert created.status_code == 201
    assert created.json()["reference_audio_sha256"] is None
    assert created.json()["model_sha256"] == model_status.json()["model_sha256"]
    queued = client.get("/api/jobs").json()["items"]
    assert any(
        job["kind"] == "synthesize_voice_preview"
        and job["input"]["text"] == QWEN_PREVIEW_TEXT
        for job in queued
    )


def test_qwen_clone_requires_reference_and_transcript(client, tmp_path, monkeypatch):
    from nova_generator.core.settings import get_settings

    root = tmp_path / "qwen"
    model = root / "Qwen3-TTS-12Hz-1.7B-Base"
    model.mkdir(parents=True)
    (model / "config.json").write_text("{}", encoding="utf-8")
    (model / "model.safetensors").write_bytes(b"local-dummy-weights")
    monkeypatch.setenv("NOVA_GENERATOR_QWEN_MODEL_ROOT", str(root))
    get_settings.cache_clear()
    payload = {
        "name": "Minha voz",
        "model_id": "qwen3-tts-1.7b-base",
        "parameters": {"reference_text": "A gravação de referência."},
    }
    response = client.post("/api/voices", json=payload)
    assert response.status_code == 422
    assert "referência" in response.json()["detail"].lower()
    response = client.post(
        "/api/voices",
        json={**payload, "reference_audio_sha256": "a" * 64},
    )
    assert response.status_code == 422
    assert client.get("/api/voices/model?model_id=unsupported").json()["available"] is False
