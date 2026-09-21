import json
from unittest.mock import Mock, patch

from app import _materials_external_inputs, connected_speech_page, connected_speech_import_page, connected_speech_review_page


def test_legacy_cs_pages_redirect_to_materials():
    for page in (connected_speech_page, connected_speech_import_page, connected_speech_review_page):
        assert page().headers['location'] == '/materials-external'


def test_dialogue_materials_do_not_require_cs_review():
    canonical = Mock()
    canonical.is_file.return_value = True
    canonical.read_text.return_value = json.dumps({'project': {'content_type': 'dialogue'}, 'snapshot_id': 'test'})
    plan = Mock()
    plan.is_file.return_value = True
    with patch('app._read_state', return_value={'shadowing': {'completed': True}}), patch('app.WORD_TIMING_CANONICAL_FILE', canonical), patch('app.SHADOWING_PLAN_FILE', plan):
        _, review, _, _ = _materials_external_inputs()
    assert review['completed'] is True
    assert review['items'] == []
