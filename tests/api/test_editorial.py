import json
from dataclasses import replace
from datetime import UTC, datetime
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
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository


def _seed(client: TestClient, *, prepared: bool = True):
    fixture = Path(__file__).parents[1] / "fixtures" / "legacy_canonical_scene.json"
    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    ImportLegacyEditorialProject(repository).execute(
        json.loads(fixture.read_text(encoding="utf-8")),
        legacy_key="api-editorial",
        imported_by="test",
    )
    scene_id = uuid5(NAMESPACE_URL, "nova-generator/scene/api-editorial/1")
    cue = repository.get_scene_cues(scene_id)[0]
    if prepared:
        words = [
            replace(
                word,
                surface=("" if word.order == 1 else " ") + word.surface,
                provenance={**word.provenance, "pt": f"palavra {word.order}"},
            )
            for word in repository.get_cue_words(cue.id)
        ]
        cue = replace(
            cue,
            provenance={
                **cue.provenance,
                "editorial_preparation": "complete",
                "editorial_preparation_sha256": "test",
                "editorial_preparation_contract": "nova-generator-editorial-suggestions/1.3",
                "editorial_preparation_trailing": "",
            },
        )
        repository.save_cue(cue, words)
    return repository, scene_id, cue


def test_editorial_commands_are_blocked_before_required_preparation(client: TestClient) -> None:
    _, _, cue = _seed(client, prepared=False)
    response = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "Ready.",
            "approved_pt": "Pronto.",
        },
    )
    assert response.status_code == 409
    assert "preparation is incomplete" in response.json()["detail"]


def test_failed_editorial_assistance_job_can_be_retried_with_the_same_scene(
    client: TestClient,
) -> None:
    _, scene_id, _ = _seed(client, prepared=False)
    first = client.post(f"/api/editorial/scenes/{scene_id}/assistance")
    assert first.status_code == 202
    repository = SqlAlchemyJobRepository(get_session_factory())
    claimed = repository.claim_next(worker_id="test-worker", now=datetime.now(UTC))
    assert claimed is not None
    assert str(claimed.id) == first.json()["job_id"]
    assert repository.fail(
        job_id=str(claimed.id),
        worker_id="test-worker",
        error_message="Groq rate limit",
        now=datetime.now(UTC),
    )

    retried = client.post(f"/api/editorial/scenes/{scene_id}/assistance")

    assert retried.status_code == 202
    assert retried.json() == {"job_id": str(claimed.id), "status": "queued"}


def test_prepared_scene_remains_editable_when_manual_words_lack_pt(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    pending = [
        replace(
            word,
            provenance={
                **word.provenance,
                "pt": "" if index == 1 else word.provenance.get("pt"),
                "translation_review_required": index == 1,
                "editorial_timing_estimated": index == 1,
            },
        )
        for index, word in enumerate(words)
    ]
    repository.save_cue(cue, pending)
    # A translation gap after initial preparation must not cause 409 on all
    # editorial endpoints. The editor can save text while reviews remain pending.
    text_result = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": cue.approved_en,
            "approved_pt": "Tradução corrigida.",
            "approve": False,
        },
    )
    assert text_result.status_code == 200, text_result.text
    assert text_result.json()["approved_pt"] == "Tradução corrigida."
    word_result = client.put(
        f"/api/editorial/cues/{cue.id}/words/translation",
        json={"author": "editor", "word_id": str(words[1].id), "pt": "palavra"},
    )
    assert word_result.status_code == 200, word_result.text


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


def test_dragging_word_into_previous_cue_transfers_it_atomically(client: TestClient) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    right_id = uuid5(NAMESPACE_URL, "test-transfer-right")
    left = replace(
        cue, original_en="I", approved_en="I", approved_pt="Eu",
        speech_end_ms=1000, subtitle_end_ms=1000,
    )
    right = replace(
        cue, id=right_id, order=2, original_en="can't go", approved_en="can't go",
        approved_pt="Não posso ir",
        speech_start_ms=1100, speech_end_ms=2100,
        subtitle_start_ms=1100, subtitle_end_ms=2100,
    )
    right_words = [
        replace(
            words[1], cue_id=right_id, order=1, surface="can't",
            start_ms=1200, end_ms=1350,
            provenance={**words[1].provenance, "pt": "Não posso"},
        ),
        replace(words[2], cue_id=right_id, order=2, surface=" go", start_ms=1400, end_ms=1550),
    ]
    repository.replace_scene_cues(
        scene_id,
        [(left, [replace(words[0], surface="I", order=1)]), (right, right_words)],
    )
    overlap = client.post(
        f"/api/editorial/cues/{right_id}/words/transfer",
        json={
            "author": "editor", "word_id": str(words[1].id),
            "start_ms": 150, "end_ms": 400, "expected_revision": right.revision,
        },
    )
    assert overlap.status_code == 422
    assert [word.id for word in repository.get_cue_words(right_id)] == [words[1].id, words[2].id]
    response = client.post(
        f"/api/editorial/cues/{right_id}/words/transfer",
        json={
            "author": "editor",
            "word_id": str(words[1].id),
            "start_ms": 400,
            "end_ms": 600,
            "expected_revision": right.revision,
        },
    )
    assert response.status_code == 200, response.text
    changed_left, changed_right = repository.get_scene_cues(scene_id)
    left_words = repository.get_cue_words(left.id)
    remaining_right = repository.get_cue_words(right.id)
    assert [word.id for word in left_words] == [words[0].id, words[1].id]
    assert (left_words[-1].start_ms, left_words[-1].end_ms) == (400, 600)
    assert left_words[-1].original_start_ms == words[1].original_start_ms
    assert left_words[-1].provenance["moved_from_cue"] == str(right_id)
    assert changed_left.approved_en == "I can't"
    assert changed_right.approved_en == "go"
    assert changed_left.approved_pt == "Eu Não posso"
    assert changed_right.approved_pt == "ir"
    assert changed_right.speech_start_ms == 1400
    assert [word.id for word in remaining_right] == [words[2].id]
    assert changed_left.provenance["approval"] == "draft"
    assert changed_right.provenance["approval"] == "draft"
    assert all(
        word.provenance["translation_review_required"]
        for word in left_words + remaining_right
    )
    revision = repository.list_revisions(scene_id)[-1]
    assert revision.command == "transfer_word_to_adjacent_cue"
    undo = client.post(
        f"/api/editorial/scenes/{scene_id}/undo",
        json={"author": "editor", "revision_id": str(revision.id)},
    )
    assert undo.status_code == 200, undo.text
    assert [word.id for word in repository.get_cue_words(right_id)] == [words[1].id, words[2].id]


def test_dragging_word_into_gap_expands_previous_cue_and_shrinks_source(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    next_id = uuid5(NAMESPACE_URL, "test-transfer-gap-next")
    previous = replace(
        cue, approved_en="I", original_en="I", approved_pt="Eu",
        speech_start_ms=100, speech_end_ms=300,
        subtitle_start_ms=100, subtitle_end_ms=300,
    )
    following = replace(
        cue, id=next_id, order=2, approved_en="look now", original_en="look now",
        approved_pt="Olha agora", speech_start_ms=700, speech_end_ms=1500,
        subtitle_start_ms=700, subtitle_end_ms=1500,
    )
    repository.replace_scene_cues(scene_id, [
        (previous, [replace(words[0], surface="I", start_ms=100, end_ms=200)]),
        (following, [
            replace(words[1], cue_id=next_id, order=1, surface="look",
                    start_ms=780, end_ms=920,
                    provenance={**words[1].provenance, "pt": "Olha"}),
            replace(words[2], cue_id=next_id, order=2, surface=" now",
                    start_ms=1100, end_ms=1350),
        ]),
    ])
    response = client.post(
        f"/api/editorial/cues/{next_id}/words/transfer",
        json={
            "author": "editor", "word_id": str(words[1].id),
            "start_ms": 400, "end_ms": 550, "expected_revision": following.revision,
        },
    )
    assert response.status_code == 200, response.text
    previous_after, following_after = repository.get_scene_cues(scene_id)
    assert (previous_after.speech_start_ms, previous_after.speech_end_ms) == (100, 550)
    assert previous_after.subtitle_end_ms == 550
    assert (following_after.speech_start_ms, following_after.speech_end_ms) == (1100, 1500)
    assert following_after.subtitle_start_ms == 1100
    assert previous_after.approved_en == "I look"
    assert following_after.approved_en == "now"
    assert repository.get_cue_words(previous.id)[-1].id == words[1].id
    assert repository.get_cue_words(next_id)[0].id == words[2].id
    assert repository.list_revisions(scene_id)[-1].command == "transfer_word_to_adjacent_cue"


def test_dragging_word_into_gap_expands_following_cue_and_shrinks_source(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    next_id = uuid5(NAMESPACE_URL, "test-transfer-gap-forward")
    earlier = replace(
        cue, approved_en="I can't", original_en="I can't", approved_pt="Eu não posso",
        speech_start_ms=100, speech_end_ms=700,
        subtitle_start_ms=100, subtitle_end_ms=700,
    )
    following = replace(
        cue, id=next_id, order=2, approved_en="go", original_en="go",
        approved_pt="ir", speech_start_ms=1100, speech_end_ms=1800,
        subtitle_start_ms=1100, subtitle_end_ms=1800,
    )
    repository.replace_scene_cues(scene_id, [
        (earlier, [
            replace(words[0], surface="I", start_ms=100, end_ms=200),
            replace(words[1], order=2, surface=" can't", start_ms=300, end_ms=450),
        ]),
        (following, [replace(words[2], cue_id=next_id, order=1, surface="go",
                             start_ms=1200, end_ms=1400)]),
    ])
    response = client.post(
        f"/api/editorial/cues/{cue.id}/words/transfer",
        json={
            "author": "editor", "word_id": str(words[1].id),
            "start_ms": 850, "end_ms": 1000, "expected_revision": earlier.revision,
        },
    )
    assert response.status_code == 200, response.text
    earlier_after, following_after = repository.get_scene_cues(scene_id)
    assert earlier_after.speech_end_ms == 200
    assert earlier_after.subtitle_end_ms == 200
    assert following_after.speech_start_ms == 850
    assert following_after.subtitle_start_ms == 850
    assert earlier_after.approved_en == "I"
    assert following_after.approved_en == "can't go"
    assert repository.get_cue_words(next_id)[0].id == words[1].id


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


def test_editorial_can_merge_three_consecutive_cues_in_one_revision(client: TestClient) -> None:
    repository, scene_id, original = _seed(client)
    words = repository.get_cue_words(original.id)
    first_split = client.post(
        f"/api/editorial/cues/{original.id}/split",
        json={
            "author": "editor",
            "after_word_id": str(words[0].id),
            "first": {
                "original_en": "I",
                "approved_en": "I",
                "approved_pt": "Eu",
            },
            "second": {
                "original_en": "can't go?",
                "approved_en": "can't go?",
                "approved_pt": "não posso ir?",
            },
        },
    )
    assert first_split.status_code == 200, first_split.text
    left, right = first_split.json()
    right_words = repository.get_cue_words(
        next(cue.id for cue in repository.get_scene_cues(scene_id) if str(cue.id) == right["id"])
    )
    second_split = client.post(
        f"/api/editorial/cues/{right['id']}/split",
        json={
            "author": "editor",
            "after_word_id": str(right_words[0].id),
            "first": {
                "original_en": "can't",
                "approved_en": "can't",
                "approved_pt": "não posso",
            },
            "second": {
                "original_en": "go?",
                "approved_en": "go?",
                "approved_pt": "ir?",
            },
        },
    )
    assert second_split.status_code == 200, second_split.text
    three = repository.get_scene_cues(scene_id)
    assert len(three) == 3
    before_revisions = len(repository.list_revisions(scene_id))
    merged = client.post(
        "/api/editorial/cues/merge-many",
        json={
            "author": "editor",
            "cue_ids": [str(cue.id) for cue in three],
            "text": {
                "original_en": "I can't go?",
                "approved_en": "I can't go?",
                "approved_pt": "Eu não posso ir?",
            },
        },
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["provenance"]["approval"] == "draft"
    assert len(repository.list_revisions(scene_id)) == before_revisions + 1
    merged_cue = repository.get_scene_cues(scene_id)[0]
    assert [word.id for word in repository.get_cue_words(merged_cue.id)] == [
        word.id for word in words
    ]
    assert [(word.start_ms, word.end_ms) for word in repository.get_cue_words(merged_cue.id)] == [
        (word.start_ms, word.end_ms) for word in words
    ]
    revision = repository.list_revisions(scene_id)[-1]
    undo = client.post(
        f"/api/editorial/scenes/{scene_id}/undo",
        json={"author": "editor", "revision_id": str(revision.id)},
    )
    assert undo.status_code == 200
    assert len(undo.json()) == 3


def test_editorial_merge_requires_manual_confirmation_for_different_labels(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    result = client.post(
        f"/api/editorial/cues/{cue.id}/split",
        json={
            "author": "editor",
            "after_word_id": str(words[0].id),
            "first": {"original_en": "I", "approved_en": "I", "approved_pt": "Eu"},
            "second": {
                "original_en": "can't go?",
                "approved_en": "can't go?",
                "approved_pt": "não posso ir?",
            },
            "first_speaker": "Liam",
            "second_speaker": "Otis",
        },
    )
    assert result.status_code == 200
    ids = [str(cue.id) for cue in repository.get_scene_cues(scene_id)]
    payload = {
        "author": "editor",
        "cue_ids": ids,
        "text": {
            "original_en": "I can't go?",
            "approved_en": "I can't go?",
            "approved_pt": "Eu não posso ir?",
        },
        "speaker": "Liam",
    }
    denied = client.post("/api/editorial/cues/merge-many", json=payload)
    assert denied.status_code == 422
    assert len(repository.get_scene_cues(scene_id)) == 2
    accepted = client.post(
        "/api/editorial/cues/merge-many",
        json={**payload, "confirm_same_speaker": True},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["speaker"] == "Liam"
    assert accepted.json()["provenance"]["speaker_verified_by_editor"] is True


def test_manual_cue_text_edit_updates_words_and_requires_translation_review(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    originals = repository.get_cue_words(cue.id)
    changed = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "“I can't… stay?”",
            "approved_pt": "Eu não posso ficar?",
            "approve": False,
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["original_en"] == cue.original_en
    assert changed.json()["approved_en"] == "“I can't… stay?”"
    words = repository.get_cue_words(cue.id)
    assert "".join(word.surface for word in words) == "“I can't… stay?”"
    assert [word.id for word in words] == [word.id for word in originals]
    assert [(word.start_ms, word.end_ms) for word in words] == [
        (word.start_ms, word.end_ms) for word in originals
    ]
    assert words[-1].provenance["translation_review_required"] is True
    rejected = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "“I can't… stay?”",
            "approved_pt": "Eu não posso ficar?",
            "approve": True,
        },
    )
    assert rejected.status_code == 422
    reviewed = client.put(
        f"/api/editorial/cues/{cue.id}/words/translation",
        json={"author": "editor", "word_id": str(words[-1].id), "pt": "ficar?"},
    )
    assert reviewed.status_code == 200
    approved = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "“I can't… stay?”",
            "approved_pt": "Eu não posso ficar?",
            "approve": True,
        },
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["provenance"]["approval"] == "approved"
    assert [rev.command for rev in repository.list_revisions(scene_id)][-3:] == [
        "edit_draft_text",
        "edit_word_translation",
        "edit_approved_text",
    ]


def test_manual_word_surface_edit_changes_approved_cue_and_keeps_history(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    changed = client.put(
        f"/api/editorial/cues/{cue.id}/words/surface",
        json={"author": "editor", "word_id": str(words[-1].id), "surface": "stay"},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["original_en"] == cue.original_en
    assert changed.json()["approved_en"] == "".join(
        word.surface for word in repository.get_cue_words(cue.id)
    )
    assert changed.json()["provenance"]["approval"] == "draft"
    after = repository.get_cue_words(cue.id)
    assert after[-1].id == words[-1].id
    assert after[-1].start_ms == words[-1].start_ms
    assert after[-1].original_start_ms == words[-1].original_start_ms
    assert after[-1].provenance["editorial_original_surface"] == words[-1].surface
    revision = repository.list_revisions(scene_id)[-1]
    assert revision.command == "edit_word_surface"
    undone = client.post(
        f"/api/editorial/scenes/{scene_id}/undo",
        json={"author": "editor", "revision_id": str(revision.id)},
    )
    assert undone.status_code == 200
    assert repository.get_cue_words(cue.id)[-1].surface == words[-1].surface


def test_word_timing_fit_respects_words_without_shifting_neighbors(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    repository.save_cue(
        replace(cue, speech_start_ms=150, speech_end_ms=1700),
        words,
    )
    fitted = client.post(
        f"/api/editorial/cues/{cue.id}/fit-words",
        json={"author": "editor"},
    )
    assert fitted.status_code == 200, fitted.text
    assert fitted.json()["speech_timing"] == {"start_ms": 100, "end_ms": 1900}
    assert fitted.json()["provenance"]["approval"] == "draft"
    assert [word.id for word in repository.get_cue_words(cue.id)] == [
        word.id for word in words
    ]

def test_word_timing_review_persists_and_is_invalidated_on_reedit(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    word = words[0]
    revisions_before = len(repository.list_revisions(scene_id))
    completed = client.post(
        f"/api/editorial/cues/{cue.id}/words/complete",
        json={"author": "editor", "word_id": str(word.id)},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["provenance"]["word_timing_reviewed"] is True
    saved = repository.get_cue_words(cue.id)[0]
    assert (saved.id, saved.start_ms, saved.end_ms) == (
        word.id,
        word.start_ms,
        word.end_ms,
    )
    assert len(repository.list_revisions(scene_id)) == revisions_before + 1
    again = client.post(
        f"/api/editorial/cues/{cue.id}/words/complete",
        json={"author": "editor", "word_id": str(word.id)},
    )
    assert again.status_code == 200
    assert len(repository.list_revisions(scene_id)) == revisions_before + 1
    updated = client.put(
        f"/api/editorial/cues/{cue.id}/words/timing",
        json={
            "author": "editor",
            "timings": [
                {
                    "id": str(item.id),
                    "start_ms": item.start_ms + (10 if item.id == word.id else 0),
                    "end_ms": item.end_ms,
                }
                for item in words
            ],
        },
    )
    assert updated.status_code == 200, updated.text
    assert repository.get_cue_words(cue.id)[0].provenance.get("word_timing_reviewed") is not True
    assert repository.list_revisions(scene_id)[-2].command == "complete_word_timing_review"


def test_word_timing_review_rejects_invalid_word_without_persisting(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    invalid = replace(words[0], start_ms=words[0].end_ms)
    repository.save_cue(cue, [invalid, *words[1:]])
    before = len(repository.list_revisions(scene_id))
    response = client.post(
        f"/api/editorial/cues/{cue.id}/words/complete",
        json={"author": "editor", "word_id": str(invalid.id)},
    )
    assert response.status_code == 422
    assert len(repository.list_revisions(scene_id)) == before


def test_cue_start_trim_remaps_all_words_inside_new_interval(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    original_words = repository.get_cue_words(cue.id)
    revision_count = len(repository.list_revisions(scene_id))
    result = client.put(
        f"/api/editorial/cues/{cue.id}/timing",
        json={
            "author": "editor",
            "speech_timing": {"start_ms": 1100, "end_ms": 2100},
            "subtitle_timing": {"start_ms": 1090, "end_ms": 2150},
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["provenance"]["approval"] == "draft"
    actual = repository.get_cue_words(cue.id)
    assert [(word.start_ms, word.end_ms) for word in actual] == [
        (1100, 1175),
        (1200, 1400),
        (1800, 2000),
    ]
    assert [word.id for word in actual] == [word.id for word in original_words]
    assert [word.original_start_ms for word in actual] == [
        word.original_start_ms for word in original_words
    ]
    assert [word.provenance["pt"] for word in actual] == [
        word.provenance["pt"] for word in original_words
    ]
    assert len(repository.list_revisions(scene_id)) == revision_count + 1
    revision = repository.list_revisions(scene_id)[-1]
    undo = client.post(
        f"/api/editorial/scenes/{scene_id}/undo",
        json={"revision_id": str(revision.id), "author": "editor"},
    )
    assert undo.status_code == 200, undo.text
    assert [
        (word.start_ms, word.end_ms) for word in repository.get_cue_words(cue.id)
    ] == [(word.start_ms, word.end_ms) for word in original_words]


def test_moving_cue_preserves_word_durations_and_relative_pauses(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    original_words = repository.get_cue_words(cue.id)
    response = client.put(
        f"/api/editorial/cues/{cue.id}/timing",
        json={
            "author": "editor",
            "speech_timing": {"start_ms": 1100, "end_ms": 3100},
            "subtitle_timing": {"start_ms": 1090, "end_ms": 3150},
        },
    )
    assert response.status_code == 200, response.text
    actual = repository.get_cue_words(cue.id)
    assert [(word.start_ms, word.end_ms) for word in actual] == [
        (word.start_ms + 1000, word.end_ms + 1000) for word in original_words
    ]


def test_cue_timing_change_rejects_insufficient_word_space_without_mutation(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    original_words = repository.get_cue_words(cue.id)
    revisions = len(repository.list_revisions(scene_id))
    result = client.put(
        f"/api/editorial/cues/{cue.id}/timing",
        json={
            "author": "editor",
            "speech_timing": {"start_ms": 100, "end_ms": 102},
            "subtitle_timing": {"start_ms": 100, "end_ms": 102},
        },
    )
    assert result.status_code == 422
    assert repository.get_cue(cue.id).speech_end_ms == 2100
    assert repository.get_cue_words(cue.id) == original_words
    assert len(repository.list_revisions(scene_id)) == revisions


def test_subtitle_only_boundary_change_does_not_move_word_audio(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    original_words = repository.get_cue_words(cue.id)
    result = client.put(
        f"/api/editorial/cues/{cue.id}/timing",
        json={
            "author": "editor",
            "speech_timing": {"start_ms": 100, "end_ms": 2100},
            "subtitle_timing": {"start_ms": 150, "end_ms": 2050},
        },
    )
    assert result.status_code == 200, result.text
    assert repository.get_cue_words(cue.id) == original_words


def test_deleting_intrusive_english_word_preserves_following_word_timestamps_and_undo(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    original = repository.get_cue_words(cue.id)
    assert len(original) == 3
    original_cue = repository.get_cue(cue.id)
    revised = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "I go?",
            "approved_pt": "Eu vou?",
            "approve": False,
        },
    )
    assert revised.status_code == 200, revised.text
    updated = repository.get_cue_words(cue.id)
    assert len(updated) == 2
    assert "".join(word.surface for word in updated) == "I go?"
    assert [word.id for word in updated] == [original[0].id, original[2].id]
    assert updated[1].start_ms == original[2].start_ms
    assert updated[1].end_ms == original[2].end_ms
    assert [word.order for word in updated] == [1, 2]
    assert repository.get_cue(cue.id).original_en == original_cue.original_en
    revision = repository.list_revisions(scene_id)[-1]
    assert revision.command == "edit_draft_text"
    undone = client.post(
        f"/api/editorial/scenes/{scene_id}/undo",
        json={"author": "editor", "revision_id": str(revision.id)},
    )
    assert undone.status_code == 200, undone.text
    assert [word.id for word in repository.get_cue_words(cue.id)] == [
        word.id for word in original
    ]


def test_inserted_words_receive_provisional_timings_and_can_extend_cue(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    before = repository.get_cue_words(cue.id)
    revisions = len(repository.list_revisions(scene_id))
    response = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "I can't go now please?",
            "approved_pt": "Eu não posso ir agora, por favor?",
            "approve": False,
        },
    )
    assert response.status_code == 200, response.text
    new_cue = response.json()
    updated = repository.get_cue_words(cue.id)
    assert len(updated) == len(before) + 2
    assert [word.id for word in updated[:len(before)]] == [word.id for word in before]
    assert updated[-1].end_ms <= new_cue["speech_timing"]["end_ms"]
    assert new_cue["speech_timing"]["end_ms"] >= cue.speech_end_ms
    assert all(a.end_ms <= b.start_ms for a, b in zip(updated, updated[1:], strict=False))
    assert all(word.provenance.get("editorial_timing_estimated") for word in updated[-2:])
    assert all(word.provenance.get("word_timing_reviewed") is not True for word in updated[-2:])
    assert all(word.provenance.get("translation_review_required") for word in updated[-2:])
    assert len(repository.list_revisions(scene_id)) == revisions + 1


def test_portuguese_only_save_preserves_historic_corrected_english_and_timings(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    original = repository.get_cue_words(cue.id)
    corrected_text = "What's the point?"
    repository.save_cue(
        replace(
            cue,
            approved_en=corrected_text,
            provenance={
                **cue.provenance,
                "editorial_text_manually_corrected": True,
            },
        ),
        original,
    )
    revision_count = len(repository.list_revisions(scene_id))
    updated = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": corrected_text,
            "approved_pt": "Pra quê?",
            "approve": False,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["approved_pt"] == "Pra quê?"
    assert repository.get_cue_words(cue.id) == original
    assert len(repository.list_revisions(scene_id)) == revision_count + 1


def test_approval_does_not_recreate_word_rows_from_historic_text_mismatch(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    original = repository.get_cue_words(cue.id)
    corrected_text = "What's the point?"
    repository.save_cue(
        replace(cue, approved_en=corrected_text),
        original,
    )
    response = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": corrected_text,
            "approved_pt": "Pra quê?",
            "approve": True,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["provenance"]["approval"] == "approved"
    assert repository.get_cue_words(cue.id) == original


def test_translation_draft_saves_even_when_stored_word_timing_needs_repair(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    invalid = list(words)
    invalid[-1] = replace(invalid[-1], end_ms=cue.speech_end_ms + 40)
    repository.save_cue(cue, invalid)
    result = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": cue.approved_en,
            "approved_pt": "Correção ainda não revisada.",
            "approve": False,
        },
    )
    assert result.status_code == 200, result.text
    assert repository.get_cue_words(cue.id) == invalid
    assert result.json()["approved_pt"] == "Correção ainda não revisada."


def test_approval_can_confirm_a_previously_saved_provisional_cue_atomically(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    pending = [
        replace(
            word,
            provenance={
                **word.provenance,
                "pt": "" if index else "o que",
                "editorial_timing_estimated": True,
                "translation_review_required": index != 0,
            },
        )
        for index, word in enumerate(words)
    ]
    repository.save_cue(
        replace(cue, approved_en="What's the point?", approved_pt="Pra quê?"), pending
    )
    revisions_before = len(repository.list_revisions(scene_id))
    first = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "What's the point?",
            "approved_pt": "Pra quê?",
            "approve": True,
        },
    )
    assert first.status_code == 422
    assert repository.get_cue_words(cue.id) == pending
    assert len(repository.list_revisions(scene_id)) == revisions_before

    approved = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "What's the point?",
            "approved_pt": "Pra quê?",
            "approve": True,
            "confirm_word_timings": True,
            "group_cue_translation": True,
        },
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["provenance"]["approval"] == "approved"
    after = repository.get_cue_words(cue.id)
    assert [w.id for w in after] == [w.id for w in words]
    assert [(w.start_ms, w.end_ms) for w in after] == [
        (w.start_ms, w.end_ms) for w in words
    ]
    group_ids = {w.provenance.get("semantic_group_id") for w in after}
    assert len(group_ids) == 1
    assert None not in group_ids
    assert after[0].provenance["pt"] == "Pra quê?"
    assert all(w.provenance.get("pt") is None for w in after[1:])
    assert all(w.provenance.get("word_timing_reviewed") is True for w in after)
    assert all(not w.provenance.get("translation_review_required") for w in after)
    assert len(repository.list_revisions(scene_id)) == revisions_before + 1


def test_review_confirmations_cannot_approve_invalid_word_intervals(
    client: TestClient,
) -> None:
    repository, scene_id, cue = _seed(client)
    words = repository.get_cue_words(cue.id)
    invalid = list(words)
    invalid[-1] = replace(
        invalid[-1],
        end_ms=cue.speech_end_ms + 50,
        provenance={**invalid[-1].provenance, "editorial_timing_estimated": True},
    )
    repository.save_cue(cue, invalid)
    before = len(repository.list_revisions(scene_id))
    result = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": cue.approved_en,
            "approved_pt": cue.approved_pt,
            "approve": True,
            "confirm_word_timings": True,
        },
    )
    assert result.status_code == 422
    assert repository.get_cue_words(cue.id) == invalid
    assert len(repository.list_revisions(scene_id)) == before


def test_new_words_can_be_retimed_in_the_same_atomic_text_save(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    before = repository.get_cue_words(cue.id)
    # Keep the original word IDs and move only what the operator has decided.
    times = [
        {"start_ms": word.start_ms, "end_ms": word.end_ms}
        for word in before
    ]
    times.extend([
        {"start_ms": before[-1].end_ms + 10, "end_ms": before[-1].end_ms + 155},
        {"start_ms": before[-1].end_ms + 165, "end_ms": before[-1].end_ms + 320},
    ])
    new_end = max(cue.speech_end_ms, times[-1]["end_ms"] + 5)
    result = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "I can't go now please?",
            "approved_pt": "Eu não posso ir agora, por favor?",
            "approve": False,
            "proposed_speech_timing": {
                "start_ms": cue.speech_start_ms, "end_ms": new_end,
            },
            "proposed_word_timings": times,
        },
    )
    assert result.status_code == 200, result.text
    words = repository.get_cue_words(cue.id)
    assert len(words) == len(times)
    assert [(word.start_ms, word.end_ms) for word in words] == [
        (value["start_ms"], value["end_ms"]) for value in times
    ]
    assert [word.id for word in words[:len(before)]] == [word.id for word in before]


def test_removing_word_from_semantic_unit_marks_survivor_for_translation_review(
    client: TestClient,
) -> None:
    repository, _, cue = _seed(client)
    original = repository.get_cue_words(cue.id)
    semantic_group = "group-original"
    grouped = [
        replace(
            word,
            provenance={
                **word.provenance,
                **(
                    {"semantic_group_id": semantic_group,
                     "semantic_group_role": "lead" if index == 1 else "member",
                     "pt": "não consigo" if index == 1 else None}
                    if index in (1, 2) else {}
                ),
            },
        )
        for index, word in enumerate(original)
    ]
    repository.save_cue(cue, grouped)
    result = client.put(
        f"/api/editorial/cues/{cue.id}/text",
        json={
            "author": "editor",
            "approved_en": "I go?",
            "approved_pt": "Eu vou?",
            "approve": False,
        },
    )
    assert result.status_code == 200, result.text
    remaining = repository.get_cue_words(cue.id)
    assert len(remaining) == 2
    assert remaining[1].provenance.get("semantic_group_id") is None
    assert remaining[1].provenance["translation_review_required"] is True


def test_external_ai_package_can_be_regenerated_without_media_or_editorial_reset(
    client: TestClient,
) -> None:
    import io
    import zipfile

    repository, scene_id, cue = _seed(client)
    original = repository.get_scene_cues(scene_id)
    original_words = repository.get_cue_words(cue.id)
    endpoint = f"/api/editorial/scenes/{scene_id}/external-package"

    first = client.get(endpoint)
    second = client.get(endpoint)
    assert first.status_code == 200 and second.status_code == 200
    assert first.headers["cache-control"] == "no-store, no-cache, must-revalidate"
    with zipfile.ZipFile(io.BytesIO(first.content)) as earlier, zipfile.ZipFile(
        io.BytesIO(second.content)
    ) as later:
        assert earlier.read("editorial_input.json") == later.read("editorial_input.json")
        assert earlier.read("manifest.json") == later.read("manifest.json")

    with zipfile.ZipFile(io.BytesIO(second.content)) as archive:
        names = set(archive.namelist())
        assert "editorial_input.json" in names
        assert "anki/anki-ai-input.json" in names
        assert "anki/anki-ai-prompt.md" in names
        assert "manifest.json" in names
        source = json.loads(archive.read("editorial_input.json"))
        assert source["cues"][0]["id"] == str(cue.id)

    assert repository.get_scene_cues(scene_id) == original
    assert repository.get_cue_words(cue.id) == original_words
