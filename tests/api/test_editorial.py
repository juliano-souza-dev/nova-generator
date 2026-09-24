import json
from hashlib import sha256
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from fastapi.testclient import TestClient

from nova_generator.api.dependencies import get_session_factory
from nova_generator.application.use_cases.import_legacy_editorial_project import (
    ImportLegacyEditorialProject,
)
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)


def _seed(client: TestClient):
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="api-editorial",
        imported_by="test",
    )
    scene_id = uuid5(NAMESPACE_URL, "nova-generator/scene/api-editorial/1")
    cue = repository.get_scene_cues(scene_id)[0]
    return repository, scene_id, cue


def test_text_and_word_timing_commands_preserve_literals_and_reject_overlap(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    edited = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "“I can't… go?”",
            "approved_pt": "“Não posso… ir?”",
        },
    )
    assert edited.status_code == 200
    body = edited.json()
    assert body["approved_pt"] == "“Não posso… ir?”"
    assert body["approved_pt_sha256"] == sha256(body["approved_pt"].encode()).hexdigest()
    words = repository.get_cue_words(cue.id)
    invalid = client.put(
        f"/api/editorial/cues/{cue.id}/words/timing",
        json={
            "author": "editor",
            "timings": [
                {"id": str(words[0].id), "start_ms": 100, "end_ms": 500},
                {"id": str(words[1].id), "start_ms": 400, "end_ms": 700},
                {"id": str(words[2].id), "start_ms": 1500, "end_ms": 1900},
            ],
        },
    )
    assert invalid.status_code == 422
    assert "ordered" in invalid.json()["detail"]


def test_split_merge_and_undo_keep_word_provenance_and_revision_history(client: TestClient) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    split = client.post(
        f"/api/editorial/cues/{cue.id}/split",
        json={
            "author": "editor",
            "after_word_id": str(words[1].id),
            "first": {
                "original_en": "“I can't…",
                "approved_en": "“I can't…",
                "approved_pt": "“Eu não posso…",
            },
            "second": {"original_en": "go?”", "approved_en": "go?”", "approved_pt": "ir?”"},
        },
    )
    assert split.status_code == 200
    first, second = split.json()
    assert first["provenance"]["split_from"] == str(cue.id)
    split_words = repository.get_cue_words(uuid5(NAMESPACE_URL, "unused"))
    assert split_words == []
    left_id, right_id = first["id"], second["id"]
    persisted = repository.get_scene_cues(scene_id)
    assert len(persisted) == 2
    assert repository.get_cue_words(persisted[0].id)[0].provenance["moved_from_cue"] == str(cue.id)
    second_words_before = repository.get_cue_words(persisted[1].id)
    target_start = persisted[0].speech_end_ms + 10
    delta = target_start - persisted[1].speech_start_ms
    realigned = client.post(
        f"/api/editorial/cues/{right_id}/realign",
        json={"author": "editor", "target_start_ms": target_start},
    )
    assert realigned.status_code == 200
    assert realigned.json()["speech_timing"]["start_ms"] == target_start
    second_words_after = repository.get_cue_words(persisted[1].id)
    assert second_words_after[0].start_ms == second_words_before[0].start_ms + delta
    merge = client.post(
        "/api/editorial/cues/merge",
        json={
            "author": "editor",
            "first_cue_id": left_id,
            "second_cue_id": right_id,
            "text": {
                "original_en": "“I can't… go?”",
                "approved_en": "“I can't… go?”",
                "approved_pt": "“Eu não posso… ir?”",
            },
        },
    )
    assert merge.status_code == 200
    assert merge.json()["provenance"]["merged_from"] == [left_id, right_id]
    merge_revision = repository.list_revisions(scene_id)[-1]
    undo = client.post(
        f"/api/editorial/scenes/{scene_id}/undo",
        json={"author": "editor", "revision_id": str(merge_revision.id)},
    )
    assert undo.status_code == 200
    assert [item["id"] for item in undo.json()] == [left_id, right_id]
    assert sum(len(item["words"]) for item in undo.json()) == 3
    assert len(repository.list_revisions(scene_id)) == 5
    assert left_id != right_id


def test_merge_requires_adjacent_cues(client: TestClient) -> None:
    _, _, cue = _seed(client)
    response = client.post(
        "/api/editorial/cues/merge",
        json={
            "author": "editor",
            "first_cue_id": str(cue.id),
            "second_cue_id": str(cue.id),
            "text": {"original_en": "x", "approved_en": "x", "approved_pt": "x"},
        },
    )
    assert response.status_code == 422
    assert "consecutive" in response.json()["detail"]


def test_semantic_word_group_uses_one_natural_translation_and_can_be_undone(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    original_timings = [(word.start_ms, word.end_ms) for word in words]
    individual = ["Eu", "não consigo", "ir?"]
    for word, pt in zip(words, individual, strict=True):
        response = client.put(
            f"/api/editorial/cues/{cue.id}/words/translation",
            json={"author": "editor", "word_id": str(word.id), "pt": pt},
        )
        assert response.status_code == 200

    grouped = client.post(
        f"/api/editorial/cues/{cue.id}/words/group",
        json={
            "author": "editor",
            "word_id": str(words[0].id),
            "direction": "next",
            "pt": "Não consigo",
        },
    )
    assert grouped.status_code == 200
    first_group = grouped.json()
    group_id = first_group[0]["semantic_group_id"]
    assert group_id
    assert first_group[0]["pt"] == "Não consigo"
    assert first_group[1]["pt"] is None

    expanded = client.post(
        f"/api/editorial/cues/{cue.id}/words/group",
        json={
            "author": "editor",
            "word_id": str(words[1].id),
            "direction": "next",
            "pt": "Não consigo ir?",
        },
    )
    assert expanded.status_code == 200
    semantic_unit = expanded.json()
    assert len({item["semantic_group_id"] for item in semantic_unit}) == 1
    assert [item["pt"] for item in semantic_unit] == ["Não consigo ir?", None, None]
    assert [(item["start_ms"], item["end_ms"]) for item in semantic_unit] == original_timings

    ungrouped = client.post(
        f"/api/editorial/cues/{cue.id}/words/ungroup",
        json={"author": "editor", "word_id": str(words[2].id)},
    )
    assert ungrouped.status_code == 200
    restored = ungrouped.json()
    assert [item["semantic_group_id"] for item in restored] == [None, None, None]
    assert [item["pt"] for item in restored] == individual
    assert [(item["start_ms"], item["end_ms"]) for item in restored] == original_timings


def test_ai_semantic_units_are_saved_atomically_as_draft_without_changing_timings(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    original_timings = [(word.start_ms, word.end_ms) for word in words]
    response = client.put(
        f"/api/editorial/cues/{cue.id}/words/semantic-units",
        json={
            "author": "editor",
            "expected_revision": cue.revision,
            "units": [
                {
                    "word_ids": [str(words[0].id), str(words[1].id), str(words[2].id)],
                    "pt": "Não consigo ir?",
                }
            ],
        },
    )
    assert response.status_code == 200
    saved = response.json()
    assert [item["pt"] for item in saved] == ["Não consigo ir?", None, None]
    assert len({item["semantic_group_id"] for item in saved}) == 1
    assert [(item["start_ms"], item["end_ms"]) for item in saved] == original_timings
    changed_cue = repository.get_cue(cue.id)
    assert changed_cue is not None
    assert changed_cue.revision == cue.revision + 1
    assert changed_cue.provenance["approval"] == "draft"

    invalid = client.put(
        f"/api/editorial/cues/{cue.id}/words/semantic-units",
        json={
            "author": "editor",
            "expected_revision": changed_cue.revision,
            "units": [
                {"word_ids": [str(words[0].id), str(words[1].id)], "pt": "Primeira"},
                {"word_ids": [str(words[1].id), str(words[2].id)], "pt": "Sobreposta"},
            ],
        },
    )
    assert invalid.status_code == 422
    persisted = repository.get_cue_words(cue.id)
    assert [word.provenance.get("pt") for word in persisted] == [
        "Não consigo ir?",
        None,
        None,
    ]
    assert [(word.start_ms, word.end_ms) for word in persisted] == original_timings
