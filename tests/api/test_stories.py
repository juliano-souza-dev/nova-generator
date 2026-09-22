import io
import json
import zipfile
from hashlib import sha256
from types import SimpleNamespace
from uuid import UUID

from nova_generator.core.settings import get_settings
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.worker.story_render_handler import make_story_render_handler


def _archive(*, image="images/one.jpg"):
    document = {
        "schema": "generator-story",
        "schema_version": "1.0",
        "title": "História Á",
        "language": "en",
        "aspect_ratio": "9:16",
        "cues": [
            {
                "order": 1,
                "image": image,
                "en": "Don’t stop.",
                "pt": "Não pare.",
                "highlights": [
                    {"text": "Don’t", "type": "important_word", "pt": "Não", "occurrence": 1}
                ],
            }
        ],
    }
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        archive.writestr("story.json", json.dumps(document, ensure_ascii=False))
        archive.writestr("images/one.jpg", b"image")
    return result.getvalue()


def test_upload_reports_field_error_and_does_not_enqueue(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path))
    get_settings.cache_clear()
    response = client.post(
        "/api/stories",
        files={"file": ("story.zip", _archive(image="images/missing.jpg"), "application/zip")},
    )
    assert response.status_code == 422
    assert {issue["path"] for issue in response.json()["issues"]} == {
        "$.cues[0].image",
        "zip:images/one.jpg",
    }
    assert client.get("/api/jobs").json()["total"] == 0


def test_review_render_and_publication_gate(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path))
    get_settings.cache_clear()
    response = client.post(
        "/api/stories", files={"file": ("story.zip", _archive(), "application/zip")}
    )
    assert response.status_code == 201
    story = response.json()
    assert story["cues"][0]["en"] == "Don’t stop."
    assert story["cues"][0]["pt"] == "Não pare."
    assert client.get(story["image_urls"]["images/one.jpg"]).content == b"image"
    assert (
        client.post(f"/api/stories/{story['id']}/publication", json={"youtube": "bad"}).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/stories/{story['id']}/publication", json={"youtube": "abcdefghijk"}
        ).status_code
        == 409
    )
    voice = client.post(
        "/api/voices",
        json={
            "name": "Ana",
            "model_id": "chatterbox-nano",
            "model_sha256": "a" * 64,
            "parameters": {},
        },
    ).json()
    queued = client.post(
        f"/api/stories/{story['id']}/render", json={"voice_profile_id": voice["id"]}
    )
    assert queued.status_code == 202
    job = client.get(f"/api/jobs/{queued.json()['job_id']}").json()
    assert job["kind"] == "story.render"
    assert job["input"]["voice_snapshot"]["snapshot_sha256"] == voice["snapshot_sha256"]

    output = tmp_path / "stories" / story["id"] / "render"
    output.mkdir()
    (output / "story_final.mp4").write_bytes(b"video")
    manifest = {
        "schema": "nova-generator-story-render",
        "title": "História Á",
        "final_video_sha256": sha256(b"video").hexdigest(),
        "cues": [
            {
                "order": 1,
                "image": "images/one.jpg",
                "duration_ms": 1234,
                "en_sha256": sha256("Don’t stop.".encode()).hexdigest(),
                "pt_sha256": sha256("Não pare.".encode()).hexdigest(),
            }
        ],
    }
    (output / "story-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    published = client.post(
        f"/api/stories/{story['id']}/publication", json={"youtube": "abcdefghijk"}
    )
    assert published.status_code == 200
    assert published.json()["cues"][0]["en"] == "Don’t stop."
    assert published.json()["youtubeVideoId"] == "abcdefghijk"
    (output / "story_final.mp4").write_bytes(b"changed")
    assert (
        client.post(
            f"/api/stories/{story['id']}/publication", json={"youtube": "abcdefghijk"}
        ).status_code
        == 409
    )


def test_worker_uses_frozen_voice_snapshot_and_validated_images(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path))
    get_settings.cache_clear()
    story = client.post(
        "/api/stories", files={"file": ("story.zip", _archive(), "application/zip")}
    ).json()
    voice = client.post(
        "/api/voices",
        json={
            "name": "Ana",
            "model_id": "chatterbox-nano",
            "model_sha256": "a" * 64,
            "parameters": {},
        },
    ).json()
    queued = client.post(
        f"/api/stories/{story['id']}/render", json={"voice_profile_id": voice["id"]}
    ).json()
    job_data = client.get(f"/api/jobs/{queued['job_id']}").json()

    class Renderer:
        def execute(self, *, package, images, voice, output_directory):
            assert package.cues[0].en == "Don’t stop."
            assert images["images/one.jpg"].read_bytes() == b"image"
            assert voice.sha256 == job_data["input"]["voice_snapshot"]["snapshot_sha256"]
            return SimpleNamespace(
                final_video_path=output_directory / "story_final.mp4",
                manifest_path=output_directory / "story-manifest.json",
                duration_ms=100,
            )

    class Execution:
        def raise_if_cancelled(self):
            pass

        def heartbeat(self):
            pass

    job = Job(UUID(job_data["id"]), "story.render", "queued", job_data["input"], None, 0, 3)
    result = make_story_render_handler(tmp_path, Renderer())(job, Execution())
    assert result["production_id"] == story["id"]
