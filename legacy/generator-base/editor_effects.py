"""Additional word effects used only by the experimental editor."""
import math
from PIL import Image, ImageDraw
from editor_palette import text_color
from tiktok_media import TypographyRenderer


class WordEffectRenderer(TypographyRenderer):
    neon = True  # Inter font, shared wrapping and timing contract
    effect = 'pop'

    def render(self, frame, milliseconds):
        frame=frame.convert('RGBA')
        frame=Image.alpha_composite(frame,Image.new('RGBA',frame.size,(0,0,0,115)))
        index=next((i for i,c in enumerate(self.cues) if c['speech_start_ms']<=milliseconds<c['speech_end_ms']),None)
        if index is None:return frame.convert('RGB')
        cue=self.cues[index]
        font,placements=self.layout(index)
        ink=Image.new('RGBA',frame.size)
        draw=ImageDraw.Draw(ink)
        for n,text,x,y,width in placements:
            word=cue['words'][n]
            elapsed=milliseconds-word['start_ms']
            active=0<=elapsed<word['end_ms']-word['start_ms']
            if self.effect=='typewriter':
                if elapsed<0:continue
                fraction=min(1,elapsed/max(1,min(350,word['end_ms']-word['start_ms'])))
                text=text[:math.ceil(len(text)*fraction)]
                draw.text((x,y),text,font=font,fill=text_color(self,x+width/2,(255,255,255)),anchor='lt')
                if active and int(milliseconds/220)%2==0:
                    end=x+font.getlength(text)
                    draw.rectangle((end+2,y,end+5,y+font.size),fill='#a3f4bf')
            elif self.effect=='highlight':
                if active:
                    pad=max(3,font.size*.13)
                    draw.rounded_rectangle((x-pad,y-pad,x+width+pad,y+font.size+pad),radius=pad*1.5,fill='#f9df65')
                draw.text((x,y),text,font=font,fill=text_color(self,x+width/2,(21,21,21) if active else (238,238,238)),anchor='lt')
            else:
                if elapsed<0:continue
                factor=1+.22*math.sin(min(1,elapsed/240)*math.pi) if active else 1
                popfont=self._font(max(8,round(font.size*factor)))
                # _font may apply the editor's text scale; use existing font size directly.
                if hasattr(font,'font_variant'):popfont=font.font_variant(size=max(8,round(font.size*factor)))
                px=x+(width-popfont.getlength(text))/2
                py=y-(popfont.size-font.size)/2
                draw.text((px,py),text,font=popfont,fill=text_color(self,x+width/2,(163,244,191) if active else (255,255,255)),anchor='lt',stroke_width=max(1,round(self.width/360)),stroke_fill='#12151e')
        return Image.alpha_composite(frame,ink).convert('RGB')


class PopRenderer(WordEffectRenderer):effect='pop'
class HighlightRenderer(WordEffectRenderer):effect='highlight'
class TypewriterRenderer(WordEffectRenderer):effect='typewriter'

EXTRA_RENDERERS={'pop':PopRenderer,'highlight':HighlightRenderer,'typewriter':TypewriterRenderer}

# Frame-by-frame effects: no wall clock, randomness or playback state.
from pathlib import Path
from PIL import ImageColor, ImageFilter, ImageFont


def clamp(value):return max(0.,min(1.,value))
def back(t):return 1+2.70158*(t-1)**3+1.70158*(t-1)**2

def bounce(t):
    if t<1/2.75:return 7.5625*t*t
    if t<2/2.75:t-=1.5/2.75;return 7.5625*t*t+.75
    if t<2.5/2.75:t-=2.25/2.75;return 7.5625*t*t+.9375
    t-=2.625/2.75;return 7.5625*t*t+.984375


def mix(a,b,t):return tuple(round(x+(y-x)*clamp(t)) for x,y in zip(a,b))


def word_state(effect, elapsed, duration, options):
    """Milliseconds relative to the reviewed word, independent of frame order."""
    strength=options.get('intensity',.7);speed=options.get('duration_ms',350)
    p=clamp(elapsed/max(1,speed));active=0<=elapsed<duration
    state=dict(opacity=1 if elapsed>=0 else 0,scale=1.,x=0.,y=0.,rotation=0.,blur=0.,glow=0.)
    if effect=='bounce_beat':
        p=clamp((elapsed+50)/speed)
        state.update(opacity=min(1,p*4),scale=max(.01,p+strength*(back(p)-p)),y=-20*strength*(1-bounce(p)))
    elif effect=='zoom_punch':
        ease=1 if p>=1 else 1-2**(-10*p)
        state.update(opacity=min(1,p*3),scale=1+(options.get('zoom',2.2)-1)*(1-ease),blur=8*(1-ease) if options.get('blur',True) else 0)
    elif effect=='shake_it' and 0<=elapsed<duration+150:
        amp=8*strength*math.exp(-elapsed/max(1,speed));t=elapsed/1000
        state.update(x=amp*math.sin(t*40),y=amp*.4*math.sin(t*55+.7),rotation=amp*.05*math.sin(t*30))
    elif effect=='fade_glow':
        tail=1-clamp((elapsed-duration)/max(1,options.get('decay_ms',300)))
        state.update(opacity=clamp(elapsed/speed)*tail,glow=(6+18*math.sin(math.pi*clamp(elapsed/max(1,duration))))*strength if elapsed>=0 else 0)
    elif effect=='handwritten':state.update(opacity=p,y=8*(1-p))
    return state


class NewEffectRenderer(TypographyRenderer):
    neon=True
    effect='bounce_beat'

    def _font(self,size):
        if self.effect=='handwritten':
            path=Path('C:/Windows/Fonts/segoepr.ttf')
            if path.is_file():return ImageFont.truetype(str(path),size)
        return super()._font(size)

    def render(self,frame,milliseconds):
        o=getattr(self,'options',{});a=ImageColor.getrgb(o.get('color_a','#ac83ff'));b=ImageColor.getrgb(o.get('color_b','#6cf5dc'))
        frame=frame.convert('RGBA')
        index=next((i for i,c in enumerate(self.cues) if c['speech_start_ms']<=milliseconds<c['speech_end_ms']),None)
        if index is None and self.effect=='fade_glow':
            index=next((i for i,c in reversed(list(enumerate(self.cues))) if c['speech_end_ms']<=milliseconds<c['speech_end_ms']+o.get('decay_ms',300)),None)
        if index is None:return frame.convert('RGB')
        cue=self.cues[index];words=cue['words'];font,placements=self.layout(index);unit=self.width/480
        if self.effect=='duotone_pulse':
            beats=sorted(set(w['start_ms'] for c in self.cues for w in c['words'] if w['start_ms']<=milliseconds))
            if beats:
                pulse=(1-clamp((milliseconds-beats[-1])/o.get('duration_ms',350)))**2
                frame=Image.alpha_composite(frame,Image.new('RGBA',frame.size,(*([a,b][(len(beats)-1)%2]),round(180*o.get('intensity',.7)*pulse))))
        focus=next((n for n,w in enumerate(words) if w.get('is_focus')),None)
        if focus is None:
            stop={'a','an','the','i','you','me','my','to','of','and','o','a','os','as','eu','de','do','da','e','em','um','uma'}
            candidates=[n for n,w in enumerate(words) if w['text'].lower().strip('.,!?') not in stop] or list(range(len(words)))
            focus=max(candidates,key=lambda n:words[n]['end_ms']-words[n]['start_ms']) if candidates else -1
        ink=Image.new('RGBA',frame.size)
        for n,text,x,y,width in placements:
            word=words[n];elapsed=milliseconds-word['start_ms'];duration=word['end_ms']-word['start_ms']
            state=word_state(self.effect,elapsed,duration,o);color=a
            if self.effect in {'gradient_flow','karaoke_bar','duotone_pulse','split_focus'}:state['opacity']=1
            if self.effect=='gradient_flow':
                progress=clamp((milliseconds-cue['speech_start_ms'])/max(1,cue['speech_end_ms']-cue['speech_start_ms']))
                color=mix(a,b,(progress+x/self.width*(1500/o.get('duration_ms',350)))%1 if o.get('shimmer') else progress)
            if self.effect=='shake_it' and o.get('whole_line'):
                current=next((w for w in words if w['start_ms']<=milliseconds<w['end_ms']),None)
                if current:state=word_state(self.effect,milliseconds-current['start_ms'],current['end_ms']-current['start_ms'],o)
            if self.effect=='big_word_focus':
                if n!=focus:
                    if not o.get('ghost'):continue
                    state['opacity']=.16
                else:
                    state=word_state('bounce_beat',elapsed,duration,o)
                    state['scale']*=o.get('focus_multiplier',2.5)
                    x=(self.width-width)/2
            color=text_color(self,x+width/2,color)
            if state['opacity']<=0:continue
            pad=max(16,round(font.size*.7));sprite=Image.new('RGBA',(max(1,math.ceil(width))+pad*2,font.size*2+pad*2))
            d=ImageDraw.Draw(sprite);alpha=round(255*state['opacity'])
            if self.effect=='karaoke_bar':
                d.text((pad,pad),text,font=font,anchor='lt',fill=(*b,255))
                progress=clamp(elapsed/max(1,duration))
                if o.get('bar'):
                    d.rectangle((pad,pad+font.size+4*unit,pad+width*progress,pad+font.size+7*unit),fill=(*a,255))
                else:
                    fill=Image.new('RGBA',sprite.size);ImageDraw.Draw(fill).text((pad,pad),text,font=font,anchor='lt',fill=(*color,255))
                    fill.paste((0,0,0,0),(round(pad+width*progress),0,fill.width,fill.height));sprite=Image.alpha_composite(sprite,fill)
            else:
                if self.effect=='shake_it' and o.get('glitch') and 0<=elapsed<duration and int(elapsed/80)%3==0:
                    for offset,tint in [(-3,(255,70,90)),(3,(70,150,255))]:d.text((pad+offset*unit,pad),text,font=font,anchor='lt',fill=(*tint,alpha))
                d.text((pad,pad),text,font=font,anchor='lt',fill=(*color,alpha),stroke_width=max(1,round(unit)),stroke_fill=(0,0,0,alpha//2))
            if state['glow']:
                glow=sprite.filter(ImageFilter.GaussianBlur(state['glow']*unit));sprite=Image.alpha_composite(glow,sprite)
            factor=max(.01,state['scale']);sw,sh=sprite.size
            if abs(factor-1)>.001:sprite=sprite.resize((max(1,round(sw*factor)),max(1,round(sh*factor))),Image.Resampling.BICUBIC)
            if state['blur']>0:sprite=sprite.filter(ImageFilter.GaussianBlur(state['blur']*unit))
            if state['rotation']:sprite=sprite.rotate(state['rotation'],resample=Image.Resampling.BICUBIC)
            ink.alpha_composite(sprite,(round(x-pad+(sw-sprite.width)/2+state['x']*unit),round(y-pad+(sh-sprite.height)/2+state['y']*unit)))
        return Image.alpha_composite(frame,ink).convert('RGB')


NEW_EFFECTS=('bounce_beat','shake_it','zoom_punch','fade_glow','gradient_flow','duotone_pulse','karaoke_bar','split_focus','handwritten','big_word_focus')
EXTRA_RENDERERS.update({name:type(''.join(p.title() for p in name.split('_'))+'Renderer',(NewEffectRenderer,),{'effect':name}) for name in NEW_EFFECTS})
