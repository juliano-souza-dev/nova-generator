from pathlib import Path
from tempfile import TemporaryDirectory

from materials_final import _write_dual_scene_ass


def test_vertical_subtitles_wrap_with_safe_margins_and_keep_wbw():
    text = 'And then a person came into my life and helped me understand what really matters'
    words = [{'text': word, 'start_ms': i * 200, 'end_ms': (i + 1) * 200} for i, word in enumerate(text.split())]
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / 'captions.ass'
        _write_dual_scene_ass({'cues': [{'speech_start_ms': 0, 'speech_end_ms': 4000, 'words': words, 'pt': 'NAO EXIBIR TRADUCAO'}]}, 0, 4000, path)
        output = path.read_text(encoding='utf-8-sig')
    assert 'WrapStyle: 0' in output
    assert 'WrapStyle: 2' not in output
    assert 'PlayResX: 1080' in output and 'PlayResY: 1920' in output
    assert ',96,96,420,1' in output
    assert r'{\c&H55E6AA&}And' in output
    assert 'NAO EXIBIR TRADUCAO' not in output
