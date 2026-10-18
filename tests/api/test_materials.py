from pathlib import Path
from uuid import UUID, uuid4

from nova_generator.api.dependencies import get_session_factory
from nova_generator.domain.projects.entities import Cue, Project, Scene, utf8_sha256
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache


def _seed_project() -> tuple[str, str, str]:
    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    project_id, scene_id, first_id, second_id = (uuid4() for _ in range(4))
    repository.save_project(Project(project_id, "Test deck", "dialogue"))
    repository.save_scene(Scene(scene_id, project_id, 1, 5000))
    for order, cue_id, text in [(1, first_id, "Café?"), (2, second_id, "Hello.")]:
        repository.save_cue(
            Cue(
                cue_id,
                scene_id,
                order,
                100 * order,
                100 * order + 600,
                100 * order,
                100 * order + 600,
                "Ana",
                text,
                text,
                "Olá.",
                provenance={"tags": ["lesson"]},
            ),
            [],
        )
    return str(project_id), str(first_id), str(second_id)


def test_material_selection_keeps_approved_text_and_export_freezes_cards(
    client, tmp_path, monkeypatch
):
    from nova_generator.core.settings import get_settings

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    project_id, first_id, second_id = _seed_project()
    voice = client.post(
        "/api/voices",
        json={
            "name": "Ana",
            "model_id": "chatterbox-nano",
            "model_sha256": "a" * 64,
        },
    ).json()
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
    for text in ("Café?", "Hello."):
        key = cache.cache_key(text=text, profile=profile, parameters={})
        staging = cache.staging_path(key)
        staging.write_bytes(b"RIFF-canonical-" + text.encode())
        cache.save(key, SynthesizedSpeech(str(staging), "b" * 64, profile, {}, 600, 24000, 1))

    base = f"/api/projects/{project_id}/materials"
    response = client.get(base, params={"voice_id": voice["id"]})
    assert response.status_code == 200
    cards = response.json()["cards"]
    assert [card["reel_start_ms"] for card in cards] == [0, 600]
    assert cards[0]["tags"] == ["lesson"]
    assert cards[0]["editorial_ready"] is False
    assert cards[0]["highlights"] == []
    assert client.get(cards[0]["audio_url"]).content == b"RIFF-canonical-Caf\xc3\xa9?"

    changed = client.patch(f"{base}/{second_id}", json={"included": False})
    assert changed.status_code == 200
    assert changed.json()["approved_en"] == "Hello."
    listed = client.get(base, params={"voice_id": voice["id"]}).json()["cards"]
    assert [card["included"] for card in listed] == [True, False]
    queued = client.post(f"{base}/exports", json={"voice_id": voice["id"]})
    assert queued.status_code == 202
    job_id = queued.json()["job_id"]
    jobs = client.get("/api/jobs").json()["items"]
    export = next(job for job in jobs if job["id"] == job_id)
    assert export["input"]["cue_ids"] == [first_id]
    assert len(export["input"]["audio_hashes"][first_id]) == 64
    assert export["input"]["voice_snapshot"]["snapshot_sha256"] == profile.sha256
    assert export["input"]["pt_hashes"][first_id] == utf8_sha256("Olá.")
    assert len(export["input"]["editorial_sha256"]) == 64
    assert client.get(f"{base}/exports/{job_id}").json()["apkg_url"] is None
    assert client.get(f"{base}/latest-export").json()["job_id"] == job_id
    assert (
        client.post(
            f"{base}/exports/{job_id}/publication",
            json={"youtube": "bbbbbbbbbbb", "confirmed": False},
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{base}/exports/{job_id}/publication",
            json={"youtube": "bbbbbbbbbbb", "confirmed": True},
        ).status_code
        == 409
    )
    assert client.get(f"{base}/exports/{job_id}/hub_final.json").status_code == 404
    assert client.get(f"{base}/exports/{job_id}/anki.apkg").status_code == 404


def test_short_legacy_voice_reference_is_reported_before_anki_job(client, tmp_path, monkeypatch):
    import io
    import wave
    from hashlib import sha256

    from nova_generator.core.settings import get_settings
    from nova_generator.domain.voices import VoiceProfile
    from nova_generator.infrastructure.database.voice_profile_repository import (
        SqlAlchemyVoiceProfileRepository,
    )
    from nova_generator.infrastructure.filesystem.voice_references import FileVoiceReferenceStore

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    project_id, cue_id, _ = _seed_project()
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 16000 * 5)
    content = stream.getvalue()
    digest = sha256(content).hexdigest()
    store = FileVoiceReferenceStore(get_settings().media_cache_root)
    store.root.mkdir(parents=True)
    (store.root / f"{digest}.wav").write_bytes(content)
    voice_id = uuid4()
    SqlAlchemyVoiceProfileRepository(get_session_factory()).save(
        VoiceProfile(voice_id, "Juliana", 3, "chatterbox-turbo", "a" * 64, digest)
    )

    voices_response = client.get("/api/voices").json()
    assert voices_response[0]["reference_ready"] is False
    assert "pelo menos 6 segundos" in voices_response[0]["reference_message"]
    response = client.post(
        f"/api/projects/{project_id}/materials/{cue_id}/audio",
        json={"voice_id": str(voice_id)},
    )
    assert response.status_code == 422
    assert "referência" in response.json()["detail"].lower()
    assert client.get("/api/jobs").json()["total"] == 0


def test_short_anki_text_is_allowed_with_valid_voice_sample(client, tmp_path, monkeypatch):
    import io
    import wave

    from nova_generator.core.settings import get_settings

    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    get_settings.cache_clear()
    project_id, cue_id, _ = _seed_project()
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 16000 * 7)
    reference = client.post(
        "/api/voices/references",
        files={"file": ("speaker.wav", stream.getvalue(), "audio/wav")},
    )
    assert reference.status_code == 201
    voice = client.post(
        "/api/voices",
        json={
            "name": "Juliana",
            "model_sha256": "a" * 64,
            "reference_audio_sha256": reference.json()["sha256"],
        },
    )
    assert voice.status_code == 201
    assert voice.json()["reference_ready"] is True
    response = client.post(
        f"/api/projects/{project_id}/materials/{cue_id}/audio",
        json={"voice_id": voice.json()["id"]},
    )
    assert response.status_code == 202, response.text
    assert client.get("/api/jobs").json()["total"] == 2


def test_material_audio_requires_project_cue_and_voice(client):
    project_id, first_id, _ = _seed_project()
    base = f"/api/projects/{project_id}/materials"
    assert (
        client.post(f"{base}/{first_id}/audio", json={"voice_id": str(uuid4())}).status_code == 404
    )
    assert (
        client.get(
            f"{base}/{uuid4()}/audio",
            params={
                "voice_id": str(uuid4()),
                "voice_version": 1,
            },
        ).status_code
        == 404
    )


def test_materials_exclude_explicit_editorial_drafts(client):
    project_id, first_id, _ = _seed_project()
    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    cue = repository.get_cue(UUID(first_id))
    assert cue is not None
    repository.save_cue(
        Cue(
            cue.id,
            cue.scene_id,
            cue.order,
            cue.speech_start_ms,
            cue.speech_end_ms,
            cue.subtitle_start_ms,
            cue.subtitle_end_ms,
            cue.speaker,
            cue.original_en,
            cue.approved_en,
            cue.approved_pt,
            cue.revision,
            {**cue.provenance, "approval": "draft"},
        ),
        repository.get_cue_words(cue.id),
    )
    voice = client.post(
        "/api/voices",
        json={"name": "Draft gate", "model_id": "nano", "model_sha256": "d" * 64},
    ).json()
    cards = client.get(
        f"/api/projects/{project_id}/materials", params={"voice_id": voice["id"]}
    ).json()["cards"]
    assert all(card["cue_id"] != first_id for card in cards)


def test_gerar_material_requires_review_and_queues_complete_production(
    client, tmp_path, monkeypatch
):
    import io
    import json

    from nova_generator.core.settings import get_settings

    monkeypatch.setenv("NOVA_GENERATOR_PROJECT_ROOT", str(tmp_path / "projects"))
    get_settings.cache_clear()
    project_id, first_id, second_id = _seed_project()
    base = f"/api/projects/{project_id}"
    voice = client.post(
        "/api/voices",
        json={
            "name": "Juliana", "model_id": "chatterbox-turbo",
            "model_sha256": "a" * 64,
        },
    ).json()
    preapproval = client.post(
        f"{base}/materials/generate", json={"voice_id": voice["id"]}
    )
    assert preapproval.status_code == 409
    assert "aprove" in preapproval.json()["detail"]

    packaged = client.get(f"{base}/materials-ai/package").json()
    sections = [
        {
            "id": section,
            "title": f"Seção {section}",
            "paragraphs": ["Explicação sobre uso natural do inglês."],
            "exercises": [
                {"prompt": "Como se diz?", "answer": "Usando a expressão correta."}
            ] if section in {"guided_practice", "activities", "challenge"} else [],
        }
        for section in (
            "learning_path", "vocabulary", "structures", "guided_practice",
            "activities", "challenge", "review",
        )
    ]
    document = {
        "contract": "nova-generator-materials-output/1.0",
        "project_id": project_id,
        "source_sha256": packaged["source_sha256"],
        "title": "Aula completa",
        "sections": sections,
        "anki_cards": [
            {
                "cue_id": cue["id"],
                "front_en": cue["approved_en"],
                "back_pt": cue["approved_pt"],
                "explanation_pt": "Explicação contextual do card.",
            }
            for scene in packaged["source"]["scenes"]
            for cue in scene["cues"]
        ],
    }
    imported = client.post(
        f"{base}/materials-ai/import",
        files={"file": ("output.json", io.BytesIO(json.dumps(document).encode()), "application/json")},
    )
    assert imported.status_code == 200, imported.text
    still_draft = client.post(
        f"{base}/materials/generate", json={"voice_id": voice["id"]}
    )
    assert still_draft.status_code == 409
    approved = client.post(
        f"{base}/materials-ai/approval",
        json={"source_sha256": packaged["source_sha256"]},
    )
    assert approved.status_code == 200
    requested = client.post(
        f"{base}/materials/generate", json={"voice_id": voice["id"]}
    )
    assert requested.status_code == 202, requested.text
    export = requested.json()
    assert export["status"] == "queued"
    jobs = client.get("/api/jobs").json()["items"]
    job = next(item for item in jobs if item["id"] == export["job_id"])
    assert job["kind"] == "export_materials"
    assert job["input"]["generate_complete"] is True
    assert job["input"]["cue_ids"] == [first_id, second_id]
    assert job["input"]["audio_hashes"] == {}
    assert len(job["input"]["materials_sha256"]) == 64
    assert client.get(f"{base}/materials/latest-export").json()["job_id"] == export["job_id"]
    assert client.get(
        f"{base}/materials/exports/{export['job_id']}/material-didatico.pdf"
    ).status_code == 404


def test_gerar_material_ai_queues_durable_job_and_recovers_status(client, tmp_path, monkeypatch):
    from nova_generator.core.settings import get_settings

    monkeypatch.setenv("NOVA_GENERATOR_PROJECT_ROOT", str(tmp_path / "projects"))
    monkeypatch.delenv("NOVA_GENERATOR_GROQ_API_KEY", raising=False)
    get_settings.cache_clear()
    project_id, _, _ = _seed_project()
    api = f"/api/projects/{project_id}/materials-ai"
    missing = client.post(f"{api}/generate")
    assert missing.status_code == 409
    assert "Groq" in missing.json()["detail"]
    monkeypatch.setenv("NOVA_GENERATOR_GROQ_API_KEY", "test-only-token")
    get_settings.cache_clear()
    queued = client.post(f"{api}/generate")
    assert queued.status_code == 202, queued.text
    latest = client.get(f"{api}/latest-generation")
    assert latest.status_code == 200
    assert latest.json()["job_id"] == queued.json()["job_id"]
    job = client.get(f"/api/jobs/{queued.json()['job_id']}").json()
    assert job["kind"] == "generate_pedagogical_materials"
    assert job["input"]["selected_cue_ids"]
    assert len(job["input"]["source_sha256"]) == 64
