import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import app
from fastapi import BackgroundTasks
from final_project_import import decode_final_project, install_final_project
from materials_final import build_hub_final_json


def fixture():
    canonical = {'snapshot_id': 'original', 'generator_media_window': {'start_ms': 10000, 'end_ms': 20000}, 'project': {'content_type': 'dialogue', 'youtube': 'https://www.youtube.com/watch?v=IBGVO0TiGjc', 'source_video_start_ms': 10000, 'source_video_end_ms': 20000}, 'cues': [{'order': 1, 'original_en': 'Hello there', 'approved_en': 'Hello there', 'pt': 'Olá', 'speech_start_ms': 1200, 'speech_end_ms': 2500, 'words': [{'text': 'Hello', 'pt': 'Olá', 'start_ms': 1200, 'end_ms': 1600}, {'text': 'there', 'pt': '', 'start_ms': 1700, 'end_ms': 2500}]}], 'wbw_practices': []}
    plan = {'enabled': True, 'blocks': [], 'segments': [], 'pause_markers_ms': []}
    return build_hub_final_json(canonical, {'anki': {'items': []}}, plan, source_title='Imported test')


def test_import_keeps_timings_text_and_existing_project_untouched():
    payload = fixture()
    before = copy.deepcopy(payload)
    canonical, cards = decode_final_project(payload, app._is_youtube_url)
    assert payload == before
    assert canonical['cues'][0]['words'] == payload['cues'][0]['words']
    assert canonical['cues'][0]['speech_start_ms'] == 1200
    assert canonical['project']['media_source_start_ms'] == 10000
    with TemporaryDirectory() as temp:
        root = Path(temp)
        facade = SimpleNamespace(**vars(app))
        for name,value in vars(app).items():
            if isinstance(value, Path) and value.is_relative_to(app.WORKSPACE_DIR):
                setattr(facade,name,root/value.relative_to(app.WORKSPACE_DIR))
        saved = {}
        facade._read_state = app._default_state
        facade._write_state = lambda s: saved.update(s)
        install_final_project(facade,payload,canonical,cards)
        assert saved['word_timing']['completed']
        assert saved['word_timing']['accepted_keys'] == ['1:0','1:1']
        assert saved['cut']['start_ms'] == 10000
        assert json.loads(facade.WORD_TIMING_CANONICAL_FILE.read_text(encoding='utf-8'))['cues'] == canonical['cues']


def test_legacy_cut_and_timeline_are_inferred_without_prompt():
    payload = fixture()
    del payload['generator']
    payload['kit'].update(scene_start_ms=7360, scene_end_ms=163610, scene_duration_ms=156250)
    cue = payload['cues'][0]
    cue['speech_start_ms'], cue['speech_end_ms'] = 7360, 10120
    cue['words'][0]['start_ms'], cue['words'][0]['end_ms'] = 7360, 8000
    cue['words'][1]['start_ms'], cue['words'][1]['end_ms'] = 8100, 10120
    canonical,_ = decode_final_project(payload, app._is_youtube_url)
    assert canonical['project']['media_source_start_ms'] == 0
    assert canonical['project']['media_source_end_ms'] == 163610
    assert canonical['cues'][0]['speech_start_ms'] == 7360

    canonical,_ = decode_final_project(payload, app._is_youtube_url, '10000')
    assert canonical['cues'][0]['speech_start_ms'] == 7360


def test_switch_to_dual_preserves_review_state():
    state = app._default_state()
    state['configuration'].update(configured=True,content_type='kit',transcription_mode='external')
    for role in ('en','pt'):
        state[role].update(validated=True,embeddable=True,url='https://youtu.be/IBGVO0TiGjc')
    state['word_timing'].update(completed=True,accepted_keys=['1:0'])
    state['cue_review'].update(completed=True,accepted_orders=[1])
    expected = copy.deepcopy(state['word_timing'])
    def update(fn):
        fn(state)
        return state
    with TemporaryDirectory() as temp:
        canonical = Path(temp)/'canonical.json'
        canonical.write_text('{}')
        with patch.object(app,'_read_state',return_value=state), patch.object(app,'_update_state',side_effect=update), patch.object(app,'WORD_TIMING_CANONICAL_FILE',canonical), patch.object(app.shutil,'rmtree') as delete:
            result = app.configure(app.ConfigureRequest(content_type='kit',dual_scene=True,transcription_mode='external'),BackgroundTasks())
            assert result['next_url'] == '/process'
            assert state['word_timing'] == expected
            delete.assert_not_called()
            assert state['media_refresh_preserve_reviews'] is True
