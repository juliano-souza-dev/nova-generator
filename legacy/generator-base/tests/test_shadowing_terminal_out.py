from app import _build_shadowing_plan


def test_last_out_ends_plan_without_trailing_media():
    plan = _build_shadowing_plan({}, [], None, 120000, [
        {"id": "first", "start_ms": 10000, "end_ms": 20000, "pause_markers_ms": [15000]},
        {"id": "last", "start_ms": 30000, "end_ms": 45000, "pause_markers_ms": [35000]},
    ])
    assert plan["end"]["at_ms"] == 35000
    assert plan["source_window"]["end_ms"] == 35000
    assert plan["blocks"][-1]["end_ms"] == 35000
    assert plan["blocks"][-1]["continue_at_ms"] is None
    assert plan["blocks"][-1]["terminal"] is True
    assert all(block["end_ms"] <= 35000 for block in plan["blocks"])


def test_internal_pauses_preserve_all_included_content():
    for pauses in ([12000, 18000], [14000]):
        plan = _build_shadowing_plan({}, [], None, 120000, [
            {"id": "segment", "start_ms": 10000, "end_ms": 20000, "pause_markers_ms": pauses},
        ])
        blocks = plan["blocks"]
        assert blocks[0]["start_ms"] == 10000
        assert blocks[-1]["end_ms"] == pauses[-1]
        assert sum(b["end_ms"] - b["start_ms"] for b in blocks) == pauses[-1] - 10000
        assert all(a["end_ms"] == b["start_ms"] for a, b in zip(blocks, blocks[1:]))


def test_preview_builds_selected_segment_without_saving():
    from unittest.mock import patch
    from app import ShadowingDraftRequest, shadowing_preview

    with patch("app._ensure_shadowing", return_value=({}, {}, 120000)):
        result = shadowing_preview(ShadowingDraftRequest(segments=[
            {"id": "selected", "start_ms": 30000, "end_ms": 45000, "pause_markers_ms": [35000]},
        ]))
    assert result["ok"] is True
    assert result["plan"]["blocks"][0]["start_ms"] == 30000
    assert result["plan"]["blocks"][-1]["end_ms"] == 35000


def test_segment_tails_and_unmarked_segments_are_discarded():
    rows = [
        {"id": "first", "start_ms": 10000, "end_ms": 20000, "pause_markers_ms": [12000, 15000]},
        {"id": "empty", "start_ms": 21000, "end_ms": 25000, "pause_markers_ms": []},
        {"id": "last", "start_ms": 30000, "end_ms": 45000, "pause_markers_ms": [35000]},
    ]
    plan = _build_shadowing_plan({}, [], None, 120000, rows)
    assert [(b["start_ms"], b["end_ms"]) for b in plan["blocks"]] == [(10000, 12000), (12000, 15000), (30000, 35000)]
    assert plan["blocks"][1]["continue_at_ms"] == 30000
    assert plan["selected_duration_ms"] == 10000
    assert plan["editor_segments"] == rows


def test_unmarked_draft_remains_editable():
    plan = _build_shadowing_plan({}, [], None, 10000, [
        {"id": "new", "start_ms": 0, "end_ms": 10000, "pause_markers_ms": []},
    ])
    assert plan["blocks"] == []
    assert plan["selected_duration_ms"] == 0
    assert plan["editor_segments"][0]["end_ms"] == 10000
