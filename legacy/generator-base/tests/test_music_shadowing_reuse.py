from app import _build_shadowing_plan
from materials_final import _validate_hub_final_json, build_hub_final_json


def _music_canonical():
    return {
        "snapshot_id": "music-shadowing-test",
        "project": {
            "content_type": "music",
            "youtube": "https://www.youtube.com/watch?v=test",
            "scene_start_ms": 10000,
            "scene_end_ms": 40000,
            "scene_duration_ms": 30000,
        },
        "shadowingConfig": {
            "studentPause": {
                "marginSeconds": 0.8,
                "minSeconds": 1.5,
                "maxSeconds": 6.0,
            }
        },
        "cues": [
            {
                "order": 1,
                "speech_start_ms": 0,
                "speech_end_ms": 10000,
                "approved_en": "First lyric line",
                "original_en": "First lyric line",
                "pt": "Primeira linha",
                "words": [],
            },
            {
                "order": 2,
                "speech_start_ms": 10000,
                "speech_end_ms": 20000,
                "approved_en": "Second lyric line",
                "original_en": "Second lyric line",
                "pt": "Segunda linha",
                "words": [],
            },
        ],
    }


def test_music_reuses_scene_shadowing_plan_and_hub_transport():
    canonical = _music_canonical()
    plan = _build_shadowing_plan(canonical, [10000], 20000, 30000)

    assert plan["enabled"] is True
    assert plan["mode"] == "single_scene_pause_blocks"
    assert plan["block_count"] == 2
    assert plan["blocks"][0]["cue_orders"] == [1]
    assert plan["blocks"][1]["cue_orders"] == [2]

    hub = build_hub_final_json(
        canonical,
        {"pdf_content": {}, "anki": {"items": []}},
        plan,
        source_title="Music test",
    )
    assert hub["kit"]["contentType"] == "music"
    assert hub["shadowingConfig"] == canonical["shadowingConfig"]
    assert hub["shadowingPractice"] == plan
    assert hub["connectedSpeech"] == []
    _validate_hub_final_json(hub)
