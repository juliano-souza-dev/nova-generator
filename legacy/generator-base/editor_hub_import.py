"""Reuse the Generator's Hub decoder; never estimate word timings."""
import copy
from urllib.parse import urlparse
from final_project_import import decode_final_project


def decode_editor_hub(payload, duration_ms, mode='exact', shift_ms=0):
    def youtube(url):
        parsed=urlparse(url)
        return parsed.scheme in {'https','http'} and parsed.hostname in {
            'youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be','www.youtu.be'}
    if mode not in {'exact','full_source'}:raise ValueError('Modo de sincronização inválido.')
    canonical,_=decode_final_project(payload,youtube)
    offset=int(shift_ms)
    if mode=='full_source':offset+=int(canonical['project']['media_source_start_ms'])
    cues=copy.deepcopy(canonical['cues'])
    count=0
    for cue in cues:
        for field in ('speech_start_ms','speech_end_ms','subtitle_start_ms','subtitle_end_ms'):
            if cue.get(field) is not None:cue[field]=int(cue[field])+offset
        for words_field in ('words','ptWords','pt_words'):
            for word in cue.get(words_field,[]):
                for field in ('start_ms','end_ms'):
                    value=word.get(field)
                    if isinstance(value,bool) or not isinstance(value,int):
                        raise ValueError('O JSON precisa conter tempos inteiros por palavra, em milissegundos.')
                    word[field]=value+offset
                if not 0<=word['start_ms']<word['end_ms']<=duration_ms+40:
                    raise ValueError('Os tempos das palavras não cabem na mídia. Use a mídia correspondente ou ajuste a origem dos tempos.')
                if words_field=='words':count+=1
        if not 0<=cue['speech_start_ms']<cue['speech_end_ms']<=duration_ms+40:
            raise ValueError('Os tempos das frases não cabem na mídia selecionada. Confira o recorte e a origem dos tempos.')
    if not count:raise ValueError('O JSON não contém Word by Word revisado. Importe o JSON final com os tempos por palavra.')
    return {'captions':cues,'title':payload['kit']['title'],'cue_count':len(cues),
            'word_count':count,'applied_shift_ms':offset}
