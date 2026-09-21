from __future__ import annotations

import io
import json
import zipfile

import pytest

from nova_generator.domain.stories import StoryPackageViolation, validate_story_package


def _package(
    document: dict, images: dict[str, bytes] | None = None, extras: dict[str, bytes] | None = None
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("story.json", json.dumps(document, ensure_ascii=False))
        for path, content in (images or {"images/001.jpg": b"image-one"}).items():
            archive.writestr(path, content)
        for path, content in (extras or {}).items():
            archive.writestr(path, content)
    return output.getvalue()


def _document() -> dict:
    return {
        "schema": "generator-story",
        "schema_version": "1.0",
        "title": "Coração & Key?",
        "language": "en",
        "aspect_ratio": "9:16",
        "cues": [
            {
                "order": 1,
                "image": "images/001.jpg",
                "en": "“Don’t… stop,” Maya said.",
                "pt": "“Não… pare”, disse Maya.",
                "highlights": [
                    {"text": "Don’t", "type": "important_word", "pt": "Não", "occurrence": 1},
                    {"text": "Maya", "type": "structure", "pt": "Maya", "occurrence": 1},
                ],
            }
        ],
    }


def test_valid_package_preserves_literal_text_highlights_and_image_hash() -> None:
    story = validate_story_package(_package(_document(), {"images/001.jpg": b"source-image"}))

    cue = story.cues[0]
    assert cue.en == "“Don’t… stop,” Maya said."
    assert cue.pt == "“Não… pare”, disse Maya."
    assert cue.highlights[0].text == "Don’t"
    assert story.images[0].path == "images/001.jpg"
    assert (
        story.images[0].sha256 == "bf9047cbca14ea2d33450c728e196acddcb52333f5cf1b6b75c8c7f66794885f"
    )


@pytest.mark.parametrize(
    ("mutation", "expected_path"),
    [
        (lambda d: d["cues"][0].update(image="images/missing.jpg"), "$.cues[0].image"),
        (
            lambda d: d["cues"][0]["highlights"][0].update(text="missing"),
            "$.cues[0].highlights[0].text",
        ),
        (lambda d: d["cues"][0].update(order=2), "$.cues[0].order"),
    ],
)
def test_rejects_invalid_cue_references_with_field_diagnostics(
    mutation, expected_path: str
) -> None:
    document = _document()
    mutation(document)

    with pytest.raises(StoryPackageViolation) as error:
        validate_story_package(_package(document))

    assert any(issue.path == expected_path for issue in error.value.issues)


def test_rejects_unsafe_and_ambiguous_archive_members() -> None:
    with pytest.raises(StoryPackageViolation) as error:
        validate_story_package(
            _package(
                _document(),
                extras={"../outside.txt": b"no", "notes.txt": b"no"},
            )
        )

    paths = {issue.path for issue in error.value.issues}
    assert "zip:../outside.txt" in paths
    assert "zip:notes.txt" in paths


def test_rejects_images_not_declared_by_a_cue() -> None:
    with pytest.raises(StoryPackageViolation) as error:
        validate_story_package(
            _package(_document(), {"images/001.jpg": b"one", "images/002.png": b"two"})
        )

    assert any(issue.path == "zip:images/002.png" for issue in error.value.issues)


def test_highlight_occurrence_selects_the_literal_repeated_instance() -> None:
    document = _document()
    document["cues"][0]["en"] = "Go, go, go!"
    document["cues"][0]["highlights"] = [
        {"text": "go", "type": "important_word", "pt": "vá", "occurrence": 2}
    ]

    story = validate_story_package(_package(document))

    assert story.cues[0].highlights[0].occurrence == 2
