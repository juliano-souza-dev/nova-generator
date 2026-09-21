"""Text palettes shared by previews and MP4 renderers."""
from PIL import ImageColor
PALETTES={
 'aurora':['#ac83ff','#6cf5dc'],
 'sunset':['#ff8066','#ffdf80','#fc72c7'],
 'ocean':['#49baff','#87fff2'],
 'neon':['#fd67f9','#9e89ff','#58f5ff'],
 'fire':['#ff5858','#ffad42','#fff2a8'],
 'ice':['#ffffff','#b4ddff'],
}
def text_color(renderer,x,default):
    mode=getattr(renderer,'text_mode','style')
    if mode=='solid':return ImageColor.getrgb(renderer.text_color)
    if mode=='gradient':
        stops=[ImageColor.getrgb(c) for c in PALETTES[renderer.text_gradient]]
        p=max(0,min(1,x/max(1,renderer.width)))*(len(stops)-1)
        i=min(len(stops)-2,int(p));fraction=p-i
        return tuple(round(a+(b-a)*fraction) for a,b in zip(stops[i],stops[i+1]))
    return default
