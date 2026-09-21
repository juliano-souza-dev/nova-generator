"""Music-only TikTok Media variants and portable export manifest."""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from editor_palette import text_color
from music_video import FONT, MusicLyricsRenderer, _font, render_music_lyrics_video

VERTICAL_SIZE = (1080, 1920)
STYLES = ('lyrics', 'typography', 'black_neon')


def language_document(canonical, language):
    result = copy.deepcopy(canonical)
    for cue in result.get('cues', []):
        source = cue.get('words') or []
        words = []
        if language == 'en':
            words = copy.deepcopy(source)
        else:
            index = 0
            while index < len(source):
                word = source[index]
                group = str(word.get('pt_group') or '').strip()
                segment = [word]
                cursor = index + 1
                if group:
                    while cursor < len(source) and str(source[cursor].get('pt_group') or '').strip() == group:
                        segment.append(source[cursor]); cursor += 1
                    if len(segment) < 2 or word.get('pt_group_role') != 'lead' or any(w.get('pt_group_role') != 'member' for w in segment[1:]):
                        raise ValueError(f'Cue {cue.get("order", "")}: revise o grupo PT {group} no Word by Word.')
                text = str(word.get('pt') or '').strip()
                if text:
                    words.append({'text': text, 'start_ms': word.get('start_ms'), 'end_ms': segment[-1].get('end_ms'), **({'is_focus': True} if any(w.get('is_focus') for w in segment) else {})})
                index = cursor
            if not words:
                words = copy.deepcopy(cue.get('ptWords') or cue.get('pt_words') or [])
            cue['approved_en'] = str(cue.get('approved_pt') or cue.get('pt') or ' '.join(str(w.get('text') or '') for w in words))
        if not words:
            raise ValueError(f'Cue {cue.get("order", "")}: Word by Word {language.upper()} ausente. Revise antes de exportar essa versão.')
        for word in words:
            if not str(word.get('text') or '').strip() or word.get('start_ms') is None or word.get('end_ms') is None or int(word['end_ms']) <= int(word['start_ms']):
                raise ValueError(f'Cue {cue.get("order", "")}: palavra {language.upper()} sem texto ou tempo válido.')
        cue['words'] = words
        cue['speech_start_ms'] = min(int(cue.get('speech_start_ms') or 0), min(int(w['start_ms']) for w in words))
        cue['speech_end_ms'] = max(int(cue.get('speech_end_ms') or 0), max(int(w['end_ms']) for w in words))
    return result


class TypographyRenderer:
    background_color = (255,255,255)
    neon = False

    def __init__(self, canonical, size):
        self.width, self.height = size
        self.cues = sorted(canonical.get('cues', []), key=lambda c: int(c.get('speech_start_ms') or 0))
        self.cache = {}

    def _font(self, size):
        if self.neon:
            return _font(size, 740)
        font = ImageFont.truetype(str(FONT.with_name('LibreBodoni.ttf')), size)
        font.set_variation_by_axes([600])
        return font

    def layout(self, index):
        if index in self.cache:
            return self.cache[index]
        words = self.cues[index]['words']
        size = max(12, round(self.width*.082))
        available = self.width*.82
        while True:
            font = self._font(size)
            gap = font.getlength(' ')
            rows, row, length = [], [], 0
            for n, word in enumerate(words):
                text = str(word['text']).upper()
                # Translation groups remain a single timed unit but may wrap as separate words.
                for part in text.split():
                    width = font.getlength(part)
                    if row and length+gap+width > available:
                        rows.append((row,length)); row, length = [],0
                    if row: length += gap
                    row.append((n,part,length,width)); length += width
            if row: rows.append((row,length))
            if size <= 12 or (max((r[1] for r in rows),default=0) <= available and len(rows)*size*1.18 <= self.height*.55):
                break
            size -= 2
        placements = []
        total_height = len(rows)*size*1.18
        top = self.height*.46-total_height/2
        for r,(row,length) in enumerate(rows):
            for n,text,offset,width in row:
                placements.append((n,text,(self.width-length)/2+offset,top+r*size*1.18,width))
        self.cache[index] = (font,placements)
        return font,placements

    def render(self, frame, milliseconds):
        frame = frame.convert('RGBA')
        # A translucent wash makes custom backgrounds legible in both themes.
        tint = (0,0,0,145) if self.neon else (255,255,255,175)
        frame = Image.alpha_composite(frame,Image.new('RGBA',frame.size,tint))
        index = next((i for i,c in enumerate(self.cues) if int(c['speech_start_ms']) <= milliseconds < int(c['speech_end_ms'])),None)
        if index is None: return frame.convert('RGB')
        cue = self.cues[index]
        font,placements = self.layout(index)
        ink = Image.new('RGBA',frame.size)
        draw = ImageDraw.Draw(ink)
        for n,text,x,y,width in placements:
            word = cue['words'][n]
            elapsed = milliseconds-int(word['start_ms'])
            if elapsed < 0: continue
            enter = min(1,elapsed/180)
            ease = 1-(1-enter)**3
            y += (1-ease)*font.size*.22
            active = milliseconds < int(word['end_ms'])
            color = ((79,244,255) if active else (181,126,255)) if self.neon else (9,9,14)
            opacity = round(255*ease)
            color = text_color(self,x+font.getlength(text)/2,color)
            draw.text((x,y),text,font=font,fill=(*color,opacity),anchor='lt')
        if self.neon:
            glow = ink.filter(ImageFilter.GaussianBlur(max(2,self.width*.008)))
            frame = Image.alpha_composite(frame,glow)
            frame = Image.alpha_composite(frame,ink.filter(ImageFilter.GaussianBlur(max(1,self.width*.002))))
        # Fade the full composition at the end of each cue.
        fade = min(1,max(0,(int(cue['speech_end_ms'])-milliseconds)/120))
        if fade < 1: ink.putalpha(ink.getchannel('A').point(lambda a:round(a*fade)))
        return Image.alpha_composite(frame,ink).convert('RGB')


class BlackNeonRenderer(TypographyRenderer):
    background_color = (5,4,14)
    neon = True


def generate_tiktok_media(canonical, source, output_dir, *, options=None, background=None, retry_only=None, progress=None):
    if (canonical.get('project') or {}).get('content_type') != 'music':
        return {'artifacts':[], 'failures':[]}
    options = options or {}
    output_dir.mkdir(parents=True,exist_ok=True)
    artifacts, failures = [], []
    selected = retry_only
    size = VERTICAL_SIZE if options.get('aspect','vertical') == 'vertical' else None
    def emit(message):
        if progress: progress(90,message)
    def run(task,name,action):
        path = output_dir/name
        if selected is None or task in selected:
            try:
                emit(f'TikTok Media · {name}')
                action(path)
            except Exception as exc:
                path.unlink(missing_ok=True)
                failures.append({'id':task,'label':name,'error':str(exc)})
        if path.is_file():
            artifacts.append({'kind':path.suffix[1:],'group':'tiktok_media','name':name,'path':str(path),'size':path.stat().st_size})
    factories = {'lyrics':MusicLyricsRenderer,'typography':TypographyRenderer,'black_neon':BlackNeonRenderer}
    for style in STYLES:
        for language in ('en','pt'):
            def render(path,style=style,language=language):
                document = language_document(canonical,language)
                render_music_lyrics_video(document,source,path,renderer_factory=factories[style],output_size=size,
                    background=background,static_background=style!='lyrics',
                    progress=lambda percent:emit(f'TikTok Media · {style.upper()} {language.upper()} · {percent}%'))
            run(f'tiktok.{style}.{language}',f'tiktok_{style}_{language}.mp4',render)
    run('tiktok.clean','tiktok_video_limpo.mp4',lambda path:shutil.copy2(source,path))
    def audio(path):
        result=subprocess.run(['ffmpeg','-v','error','-y','-i',str(source),'-vn','-c:a','pcm_s16le',str(path)],capture_output=True,text=True,encoding='utf-8',errors='replace')
        if result.returncode: raise RuntimeError(result.stderr)
    run('tiktok.audio','tiktok_audio.wav',audio)
    # Always rebuild the ZIP to reflect partial success and selective retries.
    manifest = {'version':1,'title':(canonical.get('project') or {}).get('youtube_title',''),
        'aspect':options.get('aspect','vertical'),'background':'image' if background else 'style_default',
        'audio':'original','files':[a['name'] for a in artifacts], 'failures':failures,
        'missing_files':[name for name in [*(f'tiktok_{style}_{lang}.mp4' for style in STYLES for lang in ('en','pt')), 'tiktok_video_limpo.mp4', 'tiktok_audio.wav'] if name not in {a['name'] for a in artifacts}],
        'notes':'EN/PT usam o mesmo áudio original e os tempos revisados. Vídeo limpo mantém o enquadramento da fonte.'}
    package = output_dir/'TikTok_Media.zip'
    try:
        with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
            for artifact in artifacts: archive.write(artifact['path'],artifact['name'])
        artifacts.append({'kind':'zip','group':'tiktok_media','name':package.name,'path':str(package),'size':package.stat().st_size})
    except Exception as exc:
        package.unlink(missing_ok=True)
        failures.append({'id':'tiktok.bundle','label':package.name,'error':str(exc)})
    return {'artifacts':artifacts,'failures':failures}
