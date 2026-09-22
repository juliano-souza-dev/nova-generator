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
