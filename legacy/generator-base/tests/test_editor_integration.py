import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
import app
import editor_server as editor
from editor_hub_import import decode_editor_hub
from test_final_project_import import fixture


def test_hub_import_preserves_reviewed_words_and_translation():
    payload=fixture();before=copy.deepcopy(payload)
    decoded=decode_editor_hub(payload,10000)
    assert decoded['captions'][0]['words']==payload['cues'][0]['words']
    assert decoded['captions'][0]['pt']==payload['cues'][0]['pt']
    assert decoded['applied_shift_ms']==0
    assert payload==before


def test_full_media_origin_and_reject_wrong_media():
    payload=fixture()
    decoded=decode_editor_hub(payload,30000,'full_source')
    assert decoded['captions'][0]['words'][0]['start_ms']==11200
    assert decoded['applied_shift_ms']==10000
    with pytest.raises(ValueError):decode_editor_hub(payload,1000)


def test_source_snapshot_survives_active_project_switch():
    with TemporaryDirectory() as temporary:
        root=Path(temporary);data=root/'editor_workspace';data.mkdir()
        video=root/'workspace/process/output/scene_video.mp4';video.parent.mkdir(parents=True)
        video.write_bytes(b'first-source')
        with patch.object(editor,'ROOT',root),patch.object(editor,'DATA',data):
            first=next(iter(editor.projects()))
            opened=editor.source_for(first)
            video.write_bytes(b'second-source')
            assert opened['video'].read_bytes()==b'first-source'
            assert editor.source_for(first)['video'].read_bytes()==b'first-source'
            assert len(editor.projects())==2


def test_integrated_routes_do_not_replace_generator_home():
    client=TestClient(app.app)
    home=client.get('/')
    assert 'Seus projetos' in home.text
    assert 'href="/editor"' in home.text
    page=client.get('/editor')
    assert page.status_code==200
    assert 'JSON do Hub' in page.text
    assert client.get('/static/editor/editor.js').status_code==200
    assert len([r for r in app.app.routes if r.path=='/api/editor/projects'])==1
