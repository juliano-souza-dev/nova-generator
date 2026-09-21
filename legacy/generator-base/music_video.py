"""Burn the HUB Music lyric composition into scene-local MP4 frames.

Visual reference: HUB public/css/music-light.css and player.css. No UI controls
are rendered. Pillow is already installed through qrcode[pil].
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from editor_palette import text_color

FONT = Path(__file__).parent / 'static' / 'fonts' / 'Inter.ttf'


def _font(size, weight):
    font = ImageFont.truetype(str(FONT), max(8, round(size)))
    font.set_variation_by_axes([14, weight])
    return font


def _text(cue):
    return str(cue.get('approved_en') or cue.get('original_en') or cue.get('en') or '')


class MusicLyricsRenderer:
    """Deterministic composition on a decoded video frame, using local milliseconds."""

    def __init__(self, canonical, size):
        self.width, self.height = size
        self.scale = self.width / 1232
        self.cues = sorted((c for c in canonical.get('cues', []) if isinstance(c, dict)),
                           key=lambda c: int(c.get('speech_start_ms') or 0))
        self.font = _font(27 * self.scale, 740)
        self.next_font = _font(12 * self.scale, 600)
        self.cache = {}
        self.sprites = {}

    def _layout(self, index):
        if index in self.cache:
            return self.cache[index]
        cue = self.cues[index]
        words = [w for w in cue.get('words', []) if isinstance(w, dict) and str(w.get('text') or '').strip()]
        texts = [str(w['text']) for w in words] or _text(cue).split()
        s = self.scale
        panel_width = round(min(self.width * .92, 760 * s))
        gap = self.font.getlength(' ') + .13 * self.font.size
        rows, row, length = [], [], 0
        # Wrap long lyrics while keeping all words and their individual timings.
        for n, text in enumerate(texts):
            width = self.font.getlength(text)
            if row and length + gap + width > panel_width - 20 * s:
                rows.append((row, length)); row, length = [], 0
            if row:
                length += gap
            row.append((n, text, length, width))
            length += width
        if row:
            rows.append((row, length))
        line_height = self.font.size * 1.28
        panel_height = round(max(1, len(rows)) * line_height + 14 * s)
        next_text = ''
        next_height = 0
        bottom = round(self.height * .04)
        y = self.height - bottom - panel_height - round(10 * s) - next_height
        x = (self.width - panel_width) // 2
        placements = []
        for row_index, (row, length) in enumerate(rows):
            left = (self.width - length) / 2
            for n, text, offset, width in row:
                placements.append((n, text, left + offset, y + 7 * s + row_index * line_height, width))
        result = (words, (x, y, x + panel_width, y + panel_height), placements, next_text)
        self.cache[index] = result
        return result

    def render(self, frame, milliseconds):
        index = next((i for i, cue in enumerate(self.cues)
                      if int(cue.get('speech_start_ms') or 0) <= milliseconds < int(cue.get('speech_end_ms') or 0)), None)
        if index is None:
            return frame
        cue = self.cues[index]
        words, box, placements, next_text = self._layout(index)
        s = self.scale
        x, y, right, bottom = box
        overlay = Image.new('RGBA', frame.size)
        draw = ImageDraw.Draw(overlay)
        active = next((i for i, w in enumerate(words) if int(w.get('start_ms') or 0) <= milliseconds < int(w.get('end_ms') or 0)), -1)
        for n, text, left, top, width in placements:
            opacity = 209 if active >= 0 and n < active else 112
            color = (251, 253, 253, opacity if words else 255)
            if n == active:
                age = max(0, milliseconds - int(words[n].get('start_ms') or 0))
                # Match the small 200 ms upward hop on the active HUB word.
                lift = 5 * age / 96 if age < 96 else (5 - 3 * min(1, (age-96)/104))
                top -= lift * s
                color = (244, 207, 114, 255)
            color = (*text_color(self,left+width/2,color[:3]),color[3])
            key = (text, color)
            if key not in self.sprites:
                pad = max(3, round(12*s))
                sprite = Image.new('RGBA', (max(1,round(width))+pad*2, self.font.size*2+pad*2))
                shadow = Image.new('RGBA', sprite.size)
                ImageDraw.Draw(shadow).text((pad,pad+2*s), text, font=self.font, anchor='lt', fill=(0,0,0,97))
                sprite = Image.alpha_composite(sprite, shadow.filter(ImageFilter.GaussianBlur(3*s)))
                if n == active:
                    glow = Image.new('RGBA', sprite.size)
                    ImageDraw.Draw(glow).text((pad,pad), text, font=self.font, anchor='lt', fill=(*color[:3],61))
                    sprite = Image.alpha_composite(sprite, glow.filter(ImageFilter.GaussianBlur(6*s)))
                ImageDraw.Draw(sprite).text((pad,pad), text, font=self.font, fill=color, anchor='lt')
                self.sprites[key] = (sprite, pad)
            sprite, pad = self.sprites[key]
            if n == active:
                factor = .985 + .07*min(1,age/96) if age < 96 else 1.055-.03*min(1,(age-96)/104)
                resized = sprite.resize((max(1,round(sprite.width*factor)),max(1,round(sprite.height*factor))), Image.Resampling.LANCZOS)
                left -= (resized.width-sprite.width)/2
                sprite = resized
            overlay.alpha_composite(sprite, (round(left-pad), round(top-pad)))
        bar_width = round(min(560*s, self.width*.78))
        bar_x = (self.width-bar_width)//2
        bar_y = bottom + round(8*s)
        bar_height = max(1, round(2*s))
        draw.rounded_rectangle((bar_x, bar_y, bar_x+bar_width, bar_y+bar_height), radius=bar_height, fill=(255,255,255,33))
        start = int(cue.get('speech_start_ms') or 0)
        duration = max(1, int(cue.get('speech_end_ms') or 0) - start)
        filled = round(bar_width * min(1, max(0, (milliseconds-start)/duration)))
        for dx in range(filled):
            t = dx / max(1, filled-1)
            color = tuple(round(a+(b-a)*t) for a,b in zip((154,135,221), (240,207,124))) + (255,)
            draw.line((bar_x+dx, bar_y, bar_x+dx, bar_y+bar_height), fill=color)
        if next_text:
            draw.text((self.width/2, bar_y+bar_height+6*s), next_text, font=self.next_font,
                      fill=(244,248,248,148), anchor='mt')
        return Image.alpha_composite(frame.convert('RGBA'), overlay).convert('RGB')


def render_music_lyrics_video(canonical, source_video, output, *, renderer_factory=MusicLyricsRenderer, output_size=None, background=None, static_background=False, progress=None):
    """source_video is PROCESS_VIDEO_FILE: already cut, never seek by YouTube offset."""
    if not source_video.is_file():
        raise RuntimeError('Vídeo recortado de Música não encontrado.')
    if not canonical.get('cues'):
        raise RuntimeError('Revise as letras antes de exportar o vídeo de Música.')
    probe = subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(source_video)],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
    if probe.returncode:
        raise RuntimeError('Não foi possível ler o vídeo de Música: ' + probe.stderr)
    metadata = json.loads(probe.stdout)
    stream = next((s for s in metadata['streams'] if s['codec_type'] == 'video'), None)
    if stream is None:
        raise RuntimeError('A fonte não contém vídeo.')
    width, height = int(stream['width']), int(stream['height'])
    sar = str(stream.get('sample_aspect_ratio') or '1:1').split(':')
    if len(sar) == 2 and float(sar[1]) > 0:
        width = round(width * float(sar[0]) / float(sar[1])) or width
    rotation = next((int(s.get('rotation') or 0) for s in stream.get('side_data_list', []) if 'rotation' in s), 0)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    if output_size is not None:
        width, height = output_size
    width, height = width + width % 2, height + height % 2
    num, den = str(stream.get('avg_frame_rate') or '30/1').split('/')
    fps = min(60, float(num)/float(den)) if float(den) else 30
    fps = fps if fps > 0 else 30
    duration = float(metadata['format']['duration'])
    requested = int((canonical.get('project') or {}).get('scene_duration_ms') or 0)
    if requested > 0:
        duration = min(duration, requested/1000)
    output.parent.mkdir(parents=True, exist_ok=True)
    renderer = renderer_factory(canonical, (width, height))
    from PIL import ImageOps
    backdrop = None
    if background is not None:
        with Image.open(background) as image:
            backdrop = ImageOps.fit(ImageOps.exif_transpose(image).convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    with tempfile.TemporaryDirectory(prefix='generator_music_', dir=output.parent) as temp_name:
        temp = Path(temp_name)
        encoded = temp / 'music.mp4'
        decoder = encoder = None
        with (temp/'decode.log').open('w+b') as dec_log, (temp/'encode.log').open('w+b') as enc_log:
            try:
                decoder = subprocess.Popen(['ffmpeg','-v','error','-i',str(source_video),'-t',str(duration),
                    '-vf',((f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}' if output_size else f'scale={width}:{height}') + f',setsar=1,fps={fps}'), '-f','rawvideo','-pix_fmt','rgb24','pipe:1'],
                    stdout=subprocess.PIPE, stderr=dec_log)
                encoder = subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24',
                    '-s',f'{width}x{height}','-r',str(fps),'-i','pipe:0','-i',str(source_video),
                    '-map','0:v:0','-map','1:a:0?','-t',str(duration),'-c:v','libx264','-preset','veryfast',
                    '-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',str(encoded)],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=enc_log)
                count = 0
                frame_bytes = width*height*3
                while True:
                    data = decoder.stdout.read(frame_bytes)
                    if not data:
                        break
                    if len(data) != frame_bytes:
                        raise RuntimeError('Frame incompleto ao ler o vídeo de Música.')
                    frame = backdrop.copy() if backdrop is not None else (Image.new('RGB', (width,height), renderer.background_color) if static_background else Image.frombytes('RGB', (width,height), data))
                    encoder.stdin.write(renderer.render(frame, count*1000/fps).tobytes())
                    count += 1
                    if progress and count % max(1, round(fps)) == 0:
                        progress(min(99, round(count / fps / duration * 100)))
                decoder.stdout.close()
                encoder.stdin.close()
                if decoder.wait() or encoder.wait() or not count:
                    raise RuntimeError('FFmpeg não concluiu a exportação de Música.')
                encoded.replace(output)
            except Exception as exc:
                for process in (decoder, encoder):
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.wait()
                dec_log.seek(0); enc_log.seek(0)
                detail = (dec_log.read()+enc_log.read()).decode('utf-8', errors='replace')[-2000:]
                raise RuntimeError(f'Falha ao exportar Música: {exc}\n{detail}') from exc
            finally:
                for process in (decoder, encoder):
                    if process:
                        for pipe in (process.stdin, process.stdout):
                            if pipe and not pipe.closed:
                                pipe.close()
