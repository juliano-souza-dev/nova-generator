from materials_final import _write_shadowing_ass


def test_shadowing_ass_keeps_listening_captions_and_repeat_card_inside_block(tmp_path):
    canonical = {
        "cues": [
            {
                "order": 1,
                "speech_start_ms": 1000,
                "speech_end_ms": 2000,
                "approved_en": "Listen to me",
                "pt": "Escute-me",
            },
            {
                "order": 2,
                "speech_start_ms": 3000,
                "speech_end_ms": 4000,
                "approved_en": "Outside block",
                "pt": "Fora do bloco",
            },
        ]
    }
    block = {
        "start_ms": 1000,
        "end_ms": 2000,
        "pause_duration_ms": 1500,
        "cue_orders": [1],
    }
    output = tmp_path / "shadowing.ass"

    _write_shadowing_ass(canonical, block, output)

    text = output.read_text(encoding="utf-8-sig")
    assert "Listen to me" in text
    assert "Escute-me" in text
    assert "Outside block" not in text
    assert "0:00:01.00,0:00:02.50,Repeat" in text
