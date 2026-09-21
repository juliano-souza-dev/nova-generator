import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app
from materials_cache import content_digest


def test_approval_timestamp_does_not_change_identity():
    assert content_digest({'anki': ['same'], 'approved_at_utc': 'before'}) == content_digest({'anki': ['same'], 'approved_at_utc': 'after'})
    assert content_digest({'anki': ['same']}) != content_digest({'anki': ['changed']})


def test_reuse_skips_worker_and_rejects_missing_artifacts():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        output = root / 'output'
        output.mkdir()
        (output / 'hub_final.json').write_text('{}')
        job = {'status': 'ready', 'artifacts': [{'name': 'hub_final.json', 'group': 'hub', 'size_bytes': 2}]}
        (root / 'reuse.json').write_text(json.dumps({'identity': 'same', 'job': job}))
        with patch.object(app, 'MATERIALS_FINAL_DIR', root), patch.object(app, 'MATERIALS_FINAL_OUTPUT_DIR', output), patch.object(app, '_materials_final_identity', return_value='same'), patch.object(app, '_materials_final_ready', return_value=True), patch.object(app, '_read_state', return_value={}), patch.object(app, '_update_state'), patch.object(app.threading, 'Thread') as worker:
            assert app.materials_final_start()['reused'] is True
            worker.assert_not_called()
            with patch.object(app, '_materials_final_identity', return_value='changed'):
                assert app._cached_materials_final() is None
            (output / 'hub_final.json').unlink()
            assert app._cached_materials_final() is None


def test_tts_reuses_audio_after_reapproval_without_groq():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        audio = root / 'tts'
        audio.mkdir()
        voices = ('diana', 'hannah', 'troy', 'austin')
        for voice in voices:
            (audio / voice).mkdir()
            (audio / voice / 'cue_0001.wav').write_bytes(b'previous-audio')
        manifest = root / 'tts_manifest.json'
        manifest.write_text(json.dumps({'identity': {'old_approval': True}, 'items': [
            {'cue_order': 1, 'text': 'Hello', 'filename': f'{voice}/cue_0001.wav', 'model': 'model', 'voice': voice}
            for voice in voices
        ]}))
        with patch.object(app, 'MATERIALS_TTS_DIR', audio), patch.object(app, 'MATERIALS_TTS_MANIFEST_FILE', manifest), patch.object(app, 'MATERIALS_TTS_AUDIO_ZIP_FILE', root / 'audio.zip'), patch.object(app, 'public_ai_settings', return_value={'has_api_key': True, 'tts_model': 'model', 'tts_voice': 'voice'}), patch.object(app, '_materials_final_progress'), patch.object(app, 'synthesize_tts') as groq:
            result = app._materials_tts_for_approved({'cues': [{'order': 1, 'approved_en': 'Hello'}]}, {'approved_at_utc': 'new', 'anki': {'items': [{'cue_order': 1}]}})
            assert len(result['items']) == 4
            groq.assert_not_called()
