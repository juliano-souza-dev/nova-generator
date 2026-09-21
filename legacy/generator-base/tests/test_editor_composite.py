import io
import subprocess
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
import app
import editor_server as editor


def test_visual_video_is_muted_and_loops_while_original_audio_is_kept():
    with TemporaryDirectory() as temporary:
        root=Path(temporary)
        audio=root/'voice.wav';background=root/'background.mp4'
        editor.run_ffmpeg(['-f','lavfi','-i','sine=frequency=440:duration=2',str(audio)])
        editor.run_ffmpeg(['-f','lavfi','-i','color=c=red:s=160x160:r=30:d=0.5',
            '-f','lavfi','-i','sine=frequency=880:duration=0.5','-c:v','libx264','-c:a','aac','-shortest',str(background)])
        with patch.object(editor,'DATA',root/'editor_workspace'):
            editor.DATA.mkdir()
            client=TestClient(app.app)
            response=client.post('/api/editor/import',content=audio.read_bytes())
            assert response.status_code==200,response.text
            key=response.json()['id']
            project=client.get('/api/editor/projects/'+key).json()
            response=client.post('/api/editor/projects/'+key+'/background-video',content=background.read_bytes())
            assert response.status_code==200,response.text
            asset=response.json()['asset']
            assert editor.probe(editor.folder_for(key)/asset)['audio'] is False
            draft=editor.Draft(**project['draft']);draft.background_video=asset
            job=uuid.uuid4().hex;editor.jobs[job]={'status':'running'}
            try:
                editor.render_export(key,draft,job,720)
                assert editor.jobs[job]['status']=='ready',editor.jobs[job]
                output=editor.folder_for(key)/'exports'/job/'FrameLab.mp4'
                assert abs(editor.probe(output)['duration_ms']-2000)<100
                frame=subprocess.run(['ffmpeg','-v','error','-ss','1.5','-i',str(output),'-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],capture_output=True,check=True).stdout
                pixel=Image.open(io.BytesIO(frame)).getpixel((360,640))
                assert pixel[0]>200 and pixel[1]<30 and pixel[2]<30
                pcm=subprocess.run(['ffmpeg','-v','error','-i',str(output),'-t','1','-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'],capture_output=True,check=True).stdout
                samples=np.frombuffer(pcm,dtype=np.int16)
                frequency=np.fft.rfftfreq(len(samples),1/8000)[np.argmax(abs(np.fft.rfft(samples)))]
                assert abs(frequency-440)<3  # Background's 880 Hz must never become the output audio.
                image=io.BytesIO();Image.new('RGB',(100,100),(0,255,0)).save(image,format='PNG')
                response=client.post('/api/editor/projects/'+key+'/background',content=image.getvalue())
                assert response.status_code==200
                draft.background_video='';draft.background_asset=response.json()['asset']
                preview=editor.preview(key,draft,1500)
                pixel=Image.open(io.BytesIO(preview.body)).getpixel((180,320))
                assert pixel[1]>220 and pixel[0]<30
            finally:editor.jobs.pop(job,None)
