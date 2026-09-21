"""Standalone experimental editor. All writes stay in this copy's editor_workspace."""
from __future__ import annotations
import array
import copy
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from music_video import MusicLyricsRenderer, _font, render_music_lyrics_video
from tiktok_media import TypographyRenderer, BlackNeonRenderer, language_document
from editor_effects import EXTRA_RENDERERS
from editor_palette import PALETTES

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'editor_workspace'
DATA.mkdir(exist_ok=True)
app = FastAPI(title='Frame Lab · experimental editor')
app.mount('/static', StaticFiles(directory=ROOT/'static'), name='static')
lock = threading.RLock()
jobs = {}
BUILTIN_BACKGROUNDS = {'gradient':'Aurora — degradê', 'neon':'Mundo neon', 'study':'Estúdio de Londres'}


def background_library():
    result={key:{'id':key,'title':title,'path':ROOT/'static/editor/backgrounds'/f'{key}.png','builtin':True}
            for key,title in BUILTIN_BACKGROUNDS.items() if (ROOT/'static/editor/backgrounds'/f'{key}.png').is_file()}
    for path in (DATA/'backgrounds').glob('*.jpg'):
        if re.fullmatch(r'[a-f0-9]{32}',path.stem):
            meta=read_json(path.with_suffix('.json'),{})
            result[path.stem]={'id':path.stem,'title':meta.get('title') or 'Minha imagem','path':path,'builtin':False}
    return result


@lru_cache(maxsize=128)
def media_digest(path, size, modified_ns):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def source_key(video, canonical):
    stat=video.stat()
    digest=media_digest(str(video),stat.st_size,stat.st_mtime_ns)
    return hashlib.sha256((digest+json.dumps(canonical,sort_keys=True)).encode()).hexdigest()[:24]


def read_json(path, fallback=None):
    try: return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError): return fallback


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    temp.replace(path)


def probe(path):
    result = subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)],capture_output=True,text=True,encoding='utf-8',errors='replace')
    if result.returncode: raise ValueError('Não foi possível ler esta mídia.')
    data=json.loads(result.stdout)
    video=next((s for s in data.get('streams',[]) if s['codec_type']=='video'),None)
    if video is None: raise ValueError('O arquivo não contém vídeo.')
    return {'width':video['width'],'height':video['height'],'duration_ms':round(float(data['format']['duration'])*1000),'audio':any(s['codec_type']=='audio' for s in data['streams'])}


CANONICAL_STAGES = (
    ('word_timing/canonical_scene_word_timing_reviewed.json','WbW Timing'),
    ('cue_timing/canonical_scene_timing_reviewed.json','Cue Timing'),
    ('word_review/canonical_scene_word_reviewed.json','Word by Word'),
    ('cue_review/canonical_scene_reviewed.json','Revisão de frases'),
    ('external_ai/canonical_scene.json','Retorno da IA'),
    ('process/output/initial_scene.json','Transcrição inicial'),
)


def project_document(folder, full_source=False):
    """Use the most advanced available timings, without requiring final approval."""
    for relative,stage in CANONICAL_STAGES:
        doc=read_json(folder/relative)
        if not isinstance(doc,dict) or not isinstance(doc.get('cues'),list):continue
        doc=copy.deepcopy(doc)
        # Keep only existing valid WbW intervals. Never invent alignment for early drafts.
        cues=[]
        for cue in doc['cues']:
            if not isinstance(cue,dict):continue
            words=[]
            for word in cue.get('words') or []:
                try:
                    if str(word.get('text') or '').strip() and 0<=int(word['start_ms'])<int(word['end_ms']):words.append(word)
                except (KeyError,ValueError,TypeError,AttributeError):continue
            if not words:continue
            cue['words']=words
            cue.setdefault('speech_start_ms',min(int(w['start_ms']) for w in words))
            cue.setdefault('speech_end_ms',max(int(w['end_ms']) for w in words))
            cues.append(cue)
        doc['cues']=cues
        if not cues:continue
        if full_source:
            project=doc.get('project') or {}
            offset=int(project.get('media_source_start_ms',project.get('source_video_start_ms',0)) or 0)
            for cue in cues:
                cue['speech_start_ms']+=offset;cue['speech_end_ms']+=offset
                for word in cue['words']:
                    word['start_ms']=int(word['start_ms'])+offset;word['end_ms']=int(word['end_ms'])+offset
        return doc,stage if cues else 'Sem WbW disponível'
    return {'cues':[],'project':{}},'Sem WbW disponível'


def projects():
    result={}
    index=read_json(ROOT/'projects/index.json',{}) or {}
    active=index.get('active_project_id')
    indexed={str(item.get('id')):item for item in index.get('projects',[]) if isinstance(item,dict) and re.fullmatch(r'[A-Za-z0-9_-]+',str(item.get('id','')))}
    folders=[]
    if (ROOT/'workspace').is_dir():folders.append((active or '',ROOT/'workspace',indexed.get(active,{})))
    for project_id in dict.fromkeys([*indexed,*[p.name for p in sorted((ROOT/'projects').glob('*')) if p.is_dir()]]):
        if project_id==active and (ROOT/'workspace/state.json').is_file():continue
        folders.append((project_id,ROOT/'projects'/project_id/'workspace',indexed.get(project_id,{})))
    for project_id,folder,item in folders:
        state=read_json(folder/'state.json',{}) or {}
        video=next((folder/name for name in ('process/output/scene_video.mp4','source/en/original.mp4','process/source/original.mp4') if (folder/name).is_file()),None)
        if not video and not (state or item):continue
        doc,stage=project_document(folder,bool(video and video.name!='scene_video.mp4'))
        title=(state.get('en') or {}).get('title') or item.get('name') or folder.parent.name
        content_type=(state.get('configuration') or {}).get('content_type') or 'scene'
        common={'title':title,'canonical':doc,'generator_project_id':project_id,'content_type':content_type,'stage':stage,'available':bool(video),'active':project_id==active if active else folder==ROOT/'workspace'}
        if video:
            key=source_key(video,doc)
            # Equal media in different named projects must remain independently selectable.
            if key in result:key=hashlib.sha256((key+project_id).encode()).hexdigest()[:24]
            result[key]={'id':key,'video':video,**common}
        else:
            key='pending-'+project_id
            result[key]={'id':key,'video':None,**common,'stage':'Preparar ou enviar a mídia no Generator'}
    # Immutable editor revisions retain existing edits after project switches/updates.
    for folder in (DATA/'sources').glob('*'):
        meta=read_json(folder/'source.json')
        if meta and (folder/'source.mp4').is_file():
            if folder.name in result:continue
            result[folder.name]={'id':folder.name,'title':meta['title'],'video':folder/'source.mp4','canonical':meta['canonical'],'available':True,'stage':'Rascunho salvo no editor','generator_project_id':meta.get('generator_project_id',''),'content_type':meta.get('content_type',''),'saved':True}
    for folder in (DATA/'imports').glob('*'):
        meta=read_json(folder/'source.json')
        if meta and (folder/'source.mp4').is_file():
            result[folder.name]={'id':folder.name,'title':meta['title'],'video':folder/'source.mp4','canonical':{'project':{},'cues':[]},'available':True,'stage':'Mídia importada','content_type':'import','saved':True}
    return result


def source_for(key):
    source=projects().get(key)
    if not source:raise HTTPException(404,'Projeto não encontrado no Generator.')
    if not source.get('available',True):raise HTTPException(422,'Este projeto ainda não tem mídia. Prepare ou envie o vídeo no Generator; não é necessário concluir o projeto.')
    if not source['video'].is_relative_to(DATA):
        with lock:
            folder=DATA/'sources'/key
            folder.mkdir(parents=True,exist_ok=True)
            if not (folder/'source.json').is_file():
                temporary=folder/'copy.tmp'
                shutil.copy2(source['video'],temporary)
                temporary.replace(folder/'source.mp4')
                atomic_json(folder/'source.json',{'title':source['title'],'canonical':source['canonical'],'generator_project_id':source.get('generator_project_id',''),'content_type':source.get('content_type','')})
            source={**source,'video':folder/'source.mp4'}
    return source


def folder_for(key):
    source_for(key)
    path=DATA/'drafts'/key
    path.mkdir(parents=True,exist_ok=True)
    return path


class Clip(BaseModel):
    id: str = Field(min_length=1,max_length=80)
    asset: str = ''
    title: str = Field(default='',max_length=250)
    kind: str = 'video'
    duration_ms: int = 0
    muted: bool = False
    in_ms: int = Field(ge=0)
    out_ms: int = Field(gt=0)


def clip_metadata(key,clip):
    if not re.fullmatch(r'[a-f0-9]{32}\.mp4',clip.asset):raise HTTPException(422,'Mídia da timeline inválida.')
    path=folder_for(key)/clip.asset
    info=read_json(path.with_suffix('.clip.json'),{})
    if not path.is_file() or not info:raise HTTPException(422,'Mídia da timeline não encontrada.')
    return info


class EffectOptions(BaseModel):
    intensity: float = Field(default=.7,ge=0,le=1)
    duration_ms: int = Field(default=350,ge=80,le=1500)
    decay_ms: int = Field(default=300,ge=0,le=1000)
    color_a: str = Field(default='#ac83ff',pattern=r'^#[0-9a-fA-F]{6}$')
    color_b: str = Field(default='#6cf5dc',pattern=r'^#[0-9a-fA-F]{6}$')
    zoom: float = Field(default=2.2,ge=1.4,le=3)
    blur: bool = True
    glitch: bool = False
    whole_line: bool = False
    shimmer: bool = False
    bar: bool = False
    focus_multiplier: float = Field(default=2.5,ge=1,le=4)
    ghost: bool = False
    split: float = Field(default=.55,ge=.35,le=.7)
    horizontal: bool = False


class Draft(BaseModel):
    revision: int = Field(default=0,ge=0)
    clips: list[Clip] = Field(min_length=1,max_length=100)
    style: str = 'black_neon'
    effect_options: EffectOptions = Field(default_factory=EffectOptions)
    language: str = 'en'
    aspect: str = 'vertical'
    text_scale: float = Field(default=1,ge=.6,le=4)
    text_mode: str = Field(default='style',pattern=r'^(style|solid|gradient)$')
    text_color: str = Field(default='#ffffff',pattern=r'^#[0-9a-fA-F]{6}$')
    text_gradient: str = Field(default='aurora',pattern=r'^(aurora|sunset|ocean|neon|fire|ice)$')
    text_y: float = Field(default=.48,ge=.15,le=.85)
    video_zoom: float = Field(default=1,ge=1,le=2)
    volume: float = Field(default=1,ge=0,le=1.5)
    background_asset: str = ''
    background_video: str = ''
    captions: list[dict] = Field(default_factory=list,max_length=1000)


def validate_draft(key, draft):
    source=source_for(key)
    metadata=probe(source['video'])
    if draft.style not in {'lyrics','typography','black_neon','clean',*EXTRA_RENDERERS} or draft.language not in {'en','pt'} or draft.aspect not in {'vertical','landscape','square','source'}:
        raise HTTPException(422,'Estilo, idioma ou formato inválido.')
    if len({c.id for c in draft.clips}) != len(draft.clips):raise HTTPException(422,'Os trechos precisam de identificadores únicos.')
    for clip in draft.clips:
        limit=clip_metadata(key,clip)['duration_ms'] if clip.asset else metadata['duration_ms']
        if clip.out_ms-clip.in_ms < 100 or clip.out_ms>limit+40:raise HTTPException(422,'Cada trecho deve ter ao menos 0,1 s e estar dentro do vídeo.')
    if draft.background_asset and not re.fullmatch(r'[a-f0-9]{32}\.jpg',draft.background_asset):raise HTTPException(422,'Imagem inválida.')
    if draft.background_asset and not (folder_for(key)/draft.background_asset).is_file():raise HTTPException(422,'Imagem de fundo não encontrada.')
    if draft.background_video and (not re.fullmatch(r'[a-f0-9]{32}\.mp4',draft.background_video) or not (folder_for(key)/draft.background_video).is_file()):raise HTTPException(422,'Vídeo de fundo não encontrado.')
    if draft.background_asset and draft.background_video:raise HTTPException(422,'Escolha imagem ou vídeo para o fundo.')
    for cue in draft.captions:
        try:
            start,end=int(cue['speech_start_ms']),int(cue['speech_end_ms'])
            if not 0 <= start < end <= metadata['duration_ms']+100:raise ValueError()
            for word in cue.get('words',[]):
                if not 0 <= int(word['start_ms']) < int(word['end_ms']) <= metadata['duration_ms']+100 or not str(word.get('text') or '').strip():raise ValueError()
                if len(str(word.get('text','')))>300 or len(str(word.get('pt','')))>300:raise ValueError()
        except (ValueError,TypeError,KeyError):raise HTTPException(422,'Revise os textos e tempos das palavras; há um intervalo inválido.')
    if draft.style!='clean' and not draft.captions:raise HTTPException(422,'Este vídeo ainda não tem legendas. Use o estilo Vídeo limpo.')
    return source,metadata


def default_draft(source,metadata):
    cues=copy.deepcopy(source['canonical'].get('cues',[]))
    return Draft(clips=[Clip(id='clip-1',in_ms=0,out_ms=metadata['duration_ms'])],captions=cues,style='black_neon' if cues else 'clean').model_dump()


def load_draft(key):
    source=source_for(key)
    meta=probe(source['video'])
    return read_json(folder_for(key)/'draft.json',default_draft(source,meta))


def timeline_document(draft):
    """Map every cut/reorder into output time; preserve source reviews unchanged."""
    result={'project':{'content_type':'music'},'cues':[]}
    cursor=0
    for clip in draft.clips:
        for original in ([] if clip.asset else draft.captions):
            start=max(clip.in_ms,int(original['speech_start_ms']))
            end=min(clip.out_ms,int(original['speech_end_ms']))
            if end<=start:continue
            cue=copy.deepcopy(original)
            cue['speech_start_ms']=cursor+start-clip.in_ms
            cue['speech_end_ms']=cursor+end-clip.in_ms
            words=[]
            for word in original.get('words',[]):
                left=max(start,int(word['start_ms']));right=min(end,int(word['end_ms']))
                if right>left:words.append({**word,'start_ms':cursor+left-clip.in_ms,'end_ms':cursor+right-clip.in_ms})
            cue['words']=words
            if words:
                cue['approved_en']=' '.join(w['text'] for w in words)
                # Group translation is resolved before cuts, so lead words cannot be lost.
                result['cues'].append(cue)
        cursor+=clip.out_ms-clip.in_ms
    result['project']['scene_duration_ms']=cursor
    return result


def output_document(draft):
    copy_draft=draft.model_copy(deep=True)
    if draft.style!='clean':
        try:
            translated=language_document({'cues':draft.captions},draft.language)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(422,str(exc)) from exc
        copy_draft.captions=translated['cues']
    return timeline_document(copy_draft)


def render_factory(draft):
    base={'lyrics':MusicLyricsRenderer,'typography':TypographyRenderer,'black_neon':BlackNeonRenderer,**EXTRA_RENDERERS}[draft.style]
    class Positioned(base):
        def __init__(self,canonical,size):
            self.text_mode=draft.text_mode
            self.text_color=draft.text_color
            self.text_gradient=draft.text_gradient
            self.options=draft.effect_options.model_dump()
            super().__init__(canonical,size)
            if draft.style=='lyrics':
                self.font=_font(self.font.size*draft.text_scale,740)
                self.next_font=_font(self.next_font.size*draft.text_scale,600)
        def _font(self,size):
            return super()._font(max(8,round(size*draft.text_scale)))
        def _layout(self,index):
            words,box,placements,next_text=super()._layout(index)
            shift=round(self.height*draft.text_y-(box[1]+box[3])/2)
            shift=max(-box[1],min(shift,self.height-box[3]-round(45*self.scale)))
            return words,(box[0],box[1]+shift,box[2],box[3]+shift),[(n,t,x,y+shift,w) for n,t,x,y,w in placements],next_text
        def layout(self,index):
            if index in self.cache:return self.cache[index]
            # Keep the chosen size: automatic fit used to undo larger font settings.
            font=self._font(max(12,round(self.width*.082)))
            gap=font.getlength(' ')
            rows=[];row=[];length=0
            for n,word in enumerate(self.cues[index]['words']):
                for text in (str(word['text']) if draft.style=='handwritten' else str(word['text']).upper()).split():
                    width=font.getlength(text)
                    if row and length+gap+width>self.width*.86*(1-draft.effect_options.split if draft.style=='split_focus' and draft.effect_options.horizontal else 1):
                        rows.append((row,length));row=[];length=0
                    if row:length+=gap
                    row.append((n,text,length,width));length+=width
            if row:rows.append((row,length))
            line_height=font.size*1.22
            center_x=self.width/2
            center_y=self.height*draft.text_y
            if draft.style=='split_focus':
                if draft.effect_options.horizontal:center_x=self.width*(1+draft.effect_options.split)/2
                else:center_y=self.height*(draft.effect_options.split+(1-draft.effect_options.split)*draft.text_y)
            top=center_y-len(rows)*line_height/2
            placements=[(n,text,center_x-length/2+x,top+r*line_height,width)
                        for r,(row,length) in enumerate(rows) for n,text,x,width in row]
            self.cache[index]=(font,placements)
            return self.cache[index]
    return Positioned


def dimensions(draft,meta,height=720):
    ratios={'vertical':9/16,'landscape':16/9,'square':1,'source':meta['width']/meta['height']}
    # Resolution is measured on the shorter side: 360p, 720p or 1080p.
    ratio=ratios[draft.aspect]
    w,h=(height,round(height/ratio)) if ratio<1 else (round(height*ratio),height)
    return w+w%2,h+h%2


def video_filter(draft,size):
    w,h=size
    zoom=draft.video_zoom
    if draft.style=='split_focus':
        horizontal=draft.effect_options.horizontal
        rw=round(w*draft.effect_options.split/2)*2 if horizontal else w
        rh=h if horizontal else round(h*draft.effect_options.split/2)*2
        return f"scale={rw}:{rh}:force_original_aspect_ratio=decrease,scale=ceil(iw*{zoom}/2)*2:ceil(ih*{zoom}/2)*2,crop='min(iw,{rw})':'min(ih,{rh})',pad={rw}:{rh}:(ow-iw)/2:(oh-ih)/2:color=0x05040e,pad={w}:{h}:0:0:color=0x05040e,setsar=1,fps=30"
    return f'scale={math.ceil(w*zoom/2)*2}:{math.ceil(h*zoom/2)*2}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps=30'


def run_ffmpeg(command):
    result=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y',*command],capture_output=True,text=True,encoding='utf-8',errors='replace')
    if result.returncode:raise RuntimeError(result.stderr[-1400:])


def compose_source(key,draft,temp,output,size,source,meta,job):
    document=output_document(draft)
    parts=[]
    for index,clip in enumerate(draft.clips):
        job.update(percent=round(20*index/len(draft.clips)),message=f'Preparando trecho {index+1}/{len(draft.clips)}')
        part=temp/f'{index}.mp4'
        args=['-ss',str(clip.in_ms/1000),'-i',str(source['video']),'-t',str((clip.out_ms-clip.in_ms)/1000),'-vf',video_filter(draft,size),'-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p']
        if meta['audio']:args+=['-af',f'volume={draft.volume}','-c:a','aac','-b:a','192k']
        args+=[str(part)];run_ffmpeg(args);parts.append(part)
    (temp/'concat.txt').write_text('\n'.join(f"file '{p.name}'" for p in parts),encoding='utf-8')
    merged=temp/'joined.mp4'
    run_ffmpeg(['-f','concat','-safe','0','-i',str(temp/'concat.txt'),'-c','copy',str(merged)])
    if draft.background_video or draft.background_asset:
        visual=folder_for(key)/(draft.background_video or draft.background_asset)
        combined=temp/'combined.mp4'
        loop=['-stream_loop','-1'] if draft.background_video else ['-loop','1']
        run_ffmpeg([*loop,'-i',str(visual),'-i',str(merged),
            '-map','0:v:0','-map','1:a:0?','-t',str(sum(c.out_ms-c.in_ms for c in draft.clips)/1000),
            '-vf',video_filter(draft,size),'-c:v','libx264','-preset','veryfast','-crf','18',
            '-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',str(combined)])
        merged=combined
    if draft.style=='clean' or not document['cues']:shutil.copy2(merged,output)
    else:
        if not document['cues']:raise ValueError('O recorte não contém palavras. Escolha Vídeo limpo ou amplie o recorte.')
        job.update(percent=22,message='Renderizando animações…')
        backdrop=None
        if not (draft.background_video or draft.background_asset) and draft.style in {'typography','black_neon'}:
            backdrop=temp/'background.png'
            Image.new('RGB',size,(255,255,255) if draft.style=='typography' else (5,4,14)).save(backdrop)
        render_music_lyrics_video(document,merged,output,renderer_factory=render_factory(draft),
            background=backdrop,
            static_background=draft.style in {'typography','black_neon'} and not (draft.background_video or draft.background_asset),
            progress=lambda percent:job.update(percent=22+round(percent*.77),message=f'Renderizando animações · {percent}%'))


def render_export(key,draft,job_id,resolution):
    job=jobs[job_id]
    try:
        source,meta=validate_draft(key,draft)
        document=output_document(draft)
        size=dimensions(draft,meta,resolution)
        job_dir=folder_for(key)/'exports'/job_id
        job_dir.mkdir(parents=True)
        with tempfile.TemporaryDirectory(prefix='render-',dir=job_dir) as temp_name:
            temp=Path(temp_name)
            output=job_dir/'FrameLab.mp4'
            if any(c.asset for c in draft.clips):
                sequence=[]
                for index,clip in enumerate(draft.clips):
                    part=temp/f'sequence-{index}.mp4'
                    if clip.asset:
                        info=clip_metadata(key,clip)
                        args=([ '-stream_loop','-1'] if info['kind']=='image' else [])+['-ss',str(clip.in_ms/1000),'-i',str(folder_for(key)/clip.asset)]
                        if not info['audio'] or clip.muted:args+=['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']
                        audio='1:a:0' if not info['audio'] or clip.muted else '0:a:0'
                        w,h=size
                        args+=['-map','0:v:0','-map',audio,'-t',str((clip.out_ms-clip.in_ms)/1000),'-vf',f'scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2',str(part)]
                        run_ffmpeg(args)
                    else:
                        segment=draft.model_copy(deep=True);segment.clips=[clip]
                        segment_dir=temp/f'base-{index}';segment_dir.mkdir()
                        compose_source(key,segment,segment_dir,part,size,source,meta,job)
                    # Every segment has an identical audio layout, including silent images.
                    normalized=temp/f'normalized-{index}.mp4'
                    info=probe(part)
                    args=['-i',str(part)]
                    if not info['audio']:args+=['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']
                    args+=['-map','0:v:0','-map','0:a:0' if info['audio'] else '1:a:0','-t',str((clip.out_ms-clip.in_ms)/1000),'-c:v','copy','-c:a','aac','-ar','48000','-ac','2',str(normalized)]
                    run_ffmpeg(args);sequence.append(normalized)
                    job.update(percent=round(90*(index+1)/len(draft.clips)),message=f'Montando trecho {index+1}/{len(draft.clips)}')
                listing=temp/'sequence.txt';listing.write_text('\n'.join(f"file '{part.name}'" for part in sequence),encoding='utf-8')
                run_ffmpeg(['-f','concat','-safe','0','-i',str(listing),'-c','copy','-movflags','+faststart',str(output)])
            else:compose_source(key,draft,temp,output,size,source,meta,job)
            atomic_json(job_dir/'edit.json',draft.model_dump())
        job.update(status='ready',percent=100,message='MP4 pronto.',download_url=f'/api/editor/projects/{key}/exports/{job_id}',size=output.stat().st_size)
    except Exception as exc:job.update(status='failed',message=str(exc),percent=100)


@app.get('/')
def home():return FileResponse(ROOT/'static/editor/index.html')


@app.get('/api/editor/projects')
def project_list():
    return {'projects':[{**{key:p.get(key) for key in ('id','title','available','stage','content_type','generator_project_id','active','saved')},'cue_count':len(p['canonical'].get('cues',[]))} for p in projects().values()]}


@app.post('/api/editor/import')
async def import_video(request:Request):
    key=uuid.uuid4().hex
    directory=DATA/'imports'/key
    directory.mkdir(parents=True)
    temporary=directory/'upload.tmp'
    size=0
    try:
        with temporary.open('wb') as stream:
            async for chunk in request.stream():
                size+=len(chunk)
                if size>1024**3:raise HTTPException(413,'Use um vídeo de até 1 GB neste protótipo.')
                stream.write(chunk)
        audio_only=False
        try:probe(temporary)
        except ValueError:
            inspected=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(temporary)],capture_output=True,text=True)
            try:
                info=json.loads(inspected.stdout)
                audio_only=not any(s['codec_type']=='video' for s in info['streams']) and any(s['codec_type']=='audio' for s in info['streams'])
                duration=float(info['format']['duration'])
                if not audio_only or not math.isfinite(duration) or duration<=0:raise ValueError()
            except (ValueError,KeyError,TypeError):raise HTTPException(422,'Use um arquivo de vídeo ou áudio válido.')
        # Normalize the container/codecs so browser playback is reliable.
        import asyncio
        inputs=(['-f','lavfi','-i','color=c=black:s=720x1280:r=30','-i',str(temporary),'-t',str(duration),'-map','0:v:0','-map','1:a:0']
                if audio_only else ['-i',str(temporary),'-map','0:v:0','-map','0:a:0?'])
        await asyncio.to_thread(run_ffmpeg,[*inputs,
            '-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',
            '-c:a','aac','-movflags','+faststart',str(directory/'source.mp4')])
        from urllib.parse import unquote
        title=unquote(request.headers.get('x-file-name','Vídeo importado'))[:180]
        atomic_json(directory/'source.json',{'title':title,'audio_only':audio_only})
    finally:
        temporary.unlink(missing_ok=True)
    return {'id':key,'title':title}


@app.post('/api/editor/projects/{key}/hub-json')
async def import_hub_json(key:str,request:Request,mode:str='exact',shift_ms:int=0):
    from editor_hub_import import decode_editor_hub
    source=source_for(key)
    data=bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data)>20*1024*1024:raise HTTPException(413,'O JSON deve ter no máximo 20 MB.')
    try:
        payload=json.loads(data.decode('utf-8-sig'))
        result=decode_editor_hub(payload,probe(source['video'])['duration_ms'],mode,shift_ms)
    except (ValueError,RuntimeError,TypeError,KeyError,UnicodeError) as exc:
        raise HTTPException(422,str(exc)) from exc
    # Keep the exact imported file for traceability; changes apply through normal draft save.
    atomic_json(folder_for(key)/'hub_imports'/(hashlib.sha256(data).hexdigest()+'.json'),payload)
    return result


@app.get('/api/editor/projects/{key}')
def get_project(key:str):
    source=source_for(key)
    return {'id':key,'title':source['title'],'media_url':f'/api/editor/projects/{key}/media','metadata':probe(source['video']),'draft':load_draft(key)}


@app.get('/api/editor/projects/{key}/media')
def media(key:str):return FileResponse(source_for(key)['video'],media_type='video/mp4')


@app.put('/api/editor/projects/{key}')
def save_project(key:str,draft:Draft):
    validate_draft(key,draft)
    with lock:
        current=load_draft(key)
        if draft.revision!=current['revision']:raise HTTPException(409,'O rascunho mudou em outra aba. Reabra o projeto antes de continuar.')
        draft.revision+=1
        atomic_json(folder_for(key)/'draft.json',draft.model_dump())
    return {'revision':draft.revision}


@app.get('/api/editor/projects/{key}/waveform')
def waveform(key:str):
    source=source_for(key)
    cache=folder_for(key)/'waveform.json'
    if cache.is_file():return read_json(cache)
    result=subprocess.run(['ffmpeg','-v','error','-i',str(source['video']),'-vn','-ac','1','-ar','2000','-f','s16le','pipe:1'],capture_output=True)
    samples=array.array('h');samples.frombytes(result.stdout)
    step=max(1,math.ceil(len(samples)/1200))
    points=[round(max(abs(v) for v in samples[i:i+step])/32768,4) for i in range(0,len(samples),step)] if samples else []
    data={'points':points};atomic_json(cache,data);return data


@app.post('/api/editor/projects/{key}/background')
async def upload_background(key:str,request:Request):
    path=folder_for(key)/(uuid.uuid4().hex+'.jpg')
    data=bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data)>20*1024*1024:raise HTTPException(413,'Use uma imagem de até 20 MB.')
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {'PNG','JPEG','WEBP'} or image.width*image.height>40_000_000:raise ValueError()
            image=ImageOps.exif_transpose(image).convert('RGB');image.thumbnail((3840,3840));image.save(path,quality=95)
    except Exception:raise HTTPException(422,'Use uma imagem JPG, PNG ou WebP válida.')
    from urllib.parse import unquote
    library=DATA/'backgrounds';library.mkdir(parents=True,exist_ok=True)
    shutil.copy2(path,library/path.name)
    atomic_json((library/path.name).with_suffix('.json'),{'title':unquote(request.headers.get('x-file-name','Minha imagem'))[:180]})
    return {'asset':path.name,'url':f'/api/editor/projects/{key}/assets/{path.name}'}


@app.get('/api/editor/backgrounds')
def list_backgrounds():
    return {'images':[{k:v for k,v in item.items() if k!='path'} | {'url':f'/api/editor/backgrounds/{item["id"]}/media'}
                      for item in background_library().values()]}


@app.get('/api/editor/backgrounds/{image_id}/media')
def background_image(image_id:str):
    item=background_library().get(image_id)
    if not item:raise HTTPException(404,'Fundo não encontrado.')
    return FileResponse(item['path'])


@app.post('/api/editor/projects/{key}/backgrounds/{image_id}/select')
def select_background(key:str,image_id:str):
    item=background_library().get(image_id)
    if not item:raise HTTPException(404,'Fundo não encontrado.')
    name=(hashlib.sha256(image_id.encode()).hexdigest()[:32] if item['builtin'] else image_id)+'.jpg'
    path=folder_for(key)/name
    if not path.is_file():
        with Image.open(item['path']) as picture:
            ImageOps.exif_transpose(picture).convert('RGB').save(path,quality=95)
    return {'asset':name,'url':f'/api/editor/projects/{key}/assets/{name}'}


@app.get('/api/editor/projects/{key}/assets/{asset}')
def asset(key:str,asset:str):
    if not re.fullmatch(r'[a-f0-9]{32}\.(jpg|mp4)',asset):raise HTTPException(404)
    path=folder_for(key)/asset
    if not path.is_file():raise HTTPException(404)
    return FileResponse(path)


@app.post('/api/editor/projects/{key}/background-video')
async def upload_background_video(key:str,request:Request):
    import asyncio
    folder=folder_for(key)
    name=uuid.uuid4().hex
    temporary=folder/(name+'.upload')
    output=folder/(name+'.mp4')
    size=0
    try:
        with temporary.open('wb') as stream:
            async for chunk in request.stream():
                size+=len(chunk)
                if size>1024**3:raise HTTPException(413,'Use um vídeo de fundo de até 1 GB.')
                stream.write(chunk)
        try:meta=probe(temporary)
        except ValueError as exc:raise HTTPException(422,str(exc)) from exc
        await asyncio.to_thread(run_ffmpeg,['-i',str(temporary),'-map','0:v:0','-an',
            '-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',
            '-movflags','+faststart',str(output)])
    finally:temporary.unlink(missing_ok=True)
    return {'asset':output.name,'url':f'/api/editor/projects/{key}/assets/{output.name}',
            'duration_ms':meta['duration_ms'],'muted':True}


@app.post('/api/editor/projects/{key}/export')
def export(key:str,draft:Draft,resolution:int=360):
    if resolution not in {360,720,1080}:raise HTTPException(422,'Resolução inválida.')
    validate_draft(key,draft)
    # Reject missing PT/timing before starting a long render.
    output_document(draft)
    with lock:
        if any(j['status']=='running' for j in jobs.values()):raise HTTPException(409,'Aguarde a exportação atual terminar.')
        job_id=uuid.uuid4().hex
        jobs[job_id]={'id':job_id,'project_id':key,'status':'running','percent':0,'message':'Preparando exportação…'}
    threading.Thread(target=render_export,args=(key,draft.model_copy(deep=True),job_id,resolution),daemon=True).start()
    return jobs[job_id]


@app.get('/api/editor/jobs/{job_id}')
def job_status(job_id:str):
    if job_id not in jobs:
        if not re.fullmatch(r'[a-f0-9]{32}',job_id):raise HTTPException(404)
        for output in (DATA/'drafts').glob(f'*/exports/{job_id}/FrameLab.mp4'):
            if (output.parent/'edit.json').is_file():
                key=output.parents[2].name
                return {'id':job_id,'project_id':key,'status':'ready','percent':100,'message':'MP4 pronto.',
                        'download_url':f'/api/editor/projects/{key}/exports/{job_id}','size':output.stat().st_size}
        raise HTTPException(404)
    return dict(jobs[job_id])


@app.get('/api/editor/projects/{key}/exports/{job_id}')
def download_export(key:str,job_id:str):
    if not re.fullmatch(r'[a-f0-9]{32}',job_id):raise HTTPException(404)
    path=folder_for(key)/'exports'/job_id/'FrameLab.mp4'
    if not path.is_file():raise HTTPException(404)
    return FileResponse(path,media_type='video/mp4',filename='FrameLab.mp4')


@app.post('/api/editor/projects/{key}/preview')
def preview(key:str,draft:Draft,time_ms:int=0):
    source,meta=validate_draft(key,draft)
    document=output_document(draft)
    total=sum(c.out_ms-c.in_ms for c in draft.clips)
    time_ms=max(0,min(time_ms,total-1));cursor=0
    for clip in draft.clips:
        duration=clip.out_ms-clip.in_ms
        if time_ms<cursor+duration:source_time=clip.in_ms+time_ms-cursor;break
        cursor+=duration
    size=dimensions(draft,meta,360)
    if clip.asset:
        info=clip_metadata(key,clip);visual=folder_for(key)/clip.asset
        visual_time=0 if info['kind']=='image' else source_time
        w,h=size
        result=subprocess.run(['ffmpeg','-v','error','-ss',str(visual_time/1000),'-i',str(visual),'-frames:v','1','-vf',f'scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2','-f','image2pipe','-vcodec','png','pipe:1'],capture_output=True)
        if result.returncode or not result.stdout:raise HTTPException(422,'Não foi possível preparar este trecho.')
        frame=Image.open(io.BytesIO(result.stdout)).convert('RGB');buffer=io.BytesIO();frame.save(buffer,format='JPEG',quality=90)
        return Response(buffer.getvalue(),media_type='image/jpeg')
    if draft.background_asset and draft.style!='split_focus':
        with Image.open(folder_for(key)/draft.background_asset) as image:
            scaled=(math.ceil(size[0]*draft.video_zoom),math.ceil(size[1]*draft.video_zoom))
            fitted=ImageOps.fit(image.convert('RGB'),scaled)
            left=(scaled[0]-size[0])//2;top=(scaled[1]-size[1])//2
            frame=fitted.crop((left,top,left+size[0],top+size[1]))
    elif not draft.background_video and draft.style in {'typography','black_neon'}:
        frame=Image.new('RGB',size,(255,255,255) if draft.style=='typography' else (5,4,14))
    else:
        visual=folder_for(key)/(draft.background_video or draft.background_asset) if (draft.background_video or draft.background_asset) else source['video']
        visual_time=0 if draft.background_asset else time_ms%max(1,probe(visual)['duration_ms']) if draft.background_video else source_time
        result=subprocess.run(['ffmpeg','-v','error',*(['-loop','1'] if draft.background_asset else []),'-ss',str(visual_time/1000),'-i',str(visual),'-frames:v','1','-vf',video_filter(draft,size),'-f','image2pipe','-vcodec','png','pipe:1'],capture_output=True)
        if result.returncode or not result.stdout:raise HTTPException(422,'Não foi possível preparar a prévia.')
        frame=Image.open(io.BytesIO(result.stdout)).convert('RGB')
    if draft.style!='clean':frame=render_factory(draft)(document,size).render(frame,time_ms)
    buffer=io.BytesIO();frame.save(buffer,format='JPEG',quality=90)
    return Response(buffer.getvalue(),media_type='image/jpeg')

@app.post('/api/editor/projects/{key}/timeline-media')
async def upload_timeline_media(key:str,request:Request):
    import asyncio
    from urllib.parse import unquote
    source_for(key)
    folder=folder_for(key);name=uuid.uuid4().hex
    temporary=folder/(name+'.upload');output=folder/(name+'.mp4')
    size=0;kind='video'
    try:
        with temporary.open('wb') as stream:
            async for chunk in request.stream():
                size+=len(chunk)
                if size>1024**3:raise HTTPException(413,'Use uma mídia de até 1 GB.')
                stream.write(chunk)
        try:
            with Image.open(temporary) as image:
                if image.width*image.height>40000000 or size>20*1024**2:raise HTTPException(413,'Use imagem de até 20 MB e 40 megapixels.')
                ImageOps.exif_transpose(image).convert('RGB').save(folder/(name+'.jpg'),quality=95)
                kind='image'
        except (Image.UnidentifiedImageError,OSError):pass
        if kind=='image':
            await asyncio.to_thread(run_ffmpeg,['-loop','1','-i',str(folder/(name+'.jpg')),'-t','5','-vf','scale=ceil(iw/2)*2:ceil(ih/2)*2,fps=30','-an','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(output)])
        else:
            try:probe(temporary)
            except ValueError as exc:raise HTTPException(422,'Envie um vídeo ou uma imagem válida.') from exc
            await asyncio.to_thread(run_ffmpeg,['-i',str(temporary),'-map','0:v:0','-map','0:a:0?','-vf','scale=ceil(iw/2)*2:ceil(ih/2)*2,fps=30','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-movflags','+faststart',str(output)])
        info=probe(output);info['kind']=kind
        if kind=='image':info['duration_ms']=600000
        atomic_json(output.with_suffix('.clip.json'),info)
        return {'clip':Clip(id=uuid.uuid4().hex,asset=output.name,kind=kind,title=unquote(request.headers.get('x-file-name','Mídia'))[:250],duration_ms=info['duration_ms'],in_ms=0,out_ms=5000 if kind=='image' else info['duration_ms']).model_dump()}
    finally:temporary.unlink(missing_ok=True)
