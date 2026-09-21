import json
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import materials_final as materials
from test_final_project_import import fixture
from final_project_import import decode_final_project
import app


def test_material_generation_never_calls_video_renderers():
    canonical,_=decode_final_project(fixture(),app._is_youtube_url)
    canonical['project'].update(source_video_end_ms=40000,scene_duration_ms=30000)
    with TemporaryDirectory() as temporary:
        root=Path(temporary)
        with patch.object(materials,'render_shadowing_video') as shadow, \
             patch.object(materials,'render_dual_scene_video') as dual, \
             patch.object(materials,'render_music_video') as music, \
             patch('tiktok_media.generate_tiktok_media') as tiktok:
            for content_type in ['dialogue','music']:
                canonical['project']['content_type']=content_type
                out=root/content_type
                result=materials.generate_final_materials(canonical,{'anki':{'items':[]}},
                    shadowing_plan={'enabled':True,'blocks':[]},tts_dir=root/'tts',output_dir=out,source_title='Test')
                assert not result['failures'],result['failures']
                assert json.loads((out/'hub_final.json').read_text())['kit']['contentType']==content_type
                assert not any(a['kind']=='mp4' for a in result['artifacts'])
                with zipfile.ZipFile(out/'materials_final.zip') as archive:
                    assert 'hub_final.json' in archive.namelist()
                    assert not any(n.endswith('.mp4') for n in archive.namelist())
            shadow.assert_not_called();dual.assert_not_called();music.assert_not_called();tiktok.assert_not_called()
