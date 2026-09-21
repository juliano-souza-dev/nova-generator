"""Restore editable Generator documents from its HUB transport JSON."""
import copy
import hashlib
import json
import uuid

from materials_final import _validate_hub_final_json


def decode_final_project(payload, is_youtube_url, legacy_origin=None):
    if not isinstance(payload, dict) or not isinstance(payload.get('kit'), dict):
        raise ValueError('Selecione o hub_final.json gerado pelo Generator.')
    _validate_hub_final_json(payload)
    kit = payload['kit']
    if not is_youtube_url(str(kit.get('youtube') or '')):
        raise ValueError('O JSON final precisa conter kit.youtube com uma URL válida do YouTube.')
    start, end = int(kit.get('scene_start_ms') or 0), int(kit.get('scene_end_ms') or 0)
    if not 0 <= start < end:
        raise ValueError('O intervalo do vídeo no JSON final é inválido.')
    dual = payload.get('dualScene') or []
    if dual:
        urls = {str(b['pt'].get('youtube') or '') for b in dual}
        if len(urls) != 1 or not is_youtube_url(next(iter(urls))):
            raise ValueError('Dual Scene precisa conter uma única fonte YouTube PT válida.')
    project = copy.deepcopy((payload.get('generator') or {}).get('project') or {})
    project.update({'youtube': kit['youtube'], 'content_type': kit.get('contentType') or 'kit', 'source_video_start_ms': start, 'source_video_end_ms': end})
    project.setdefault('scene_duration_ms', end - start)
    window = (payload.get('generator') or {}).get('media_window') or {}
    if window:
        media_start, media_end = int(window['start_ms']), int(window['end_ms'])
    else:
        cue_starts = [int(c.get('speech_start_ms') if c.get('speech_start_ms') is not None else c.get('subtitle_start_ms') or 0) for c in payload['cues']]
        last_cue = max(int(c.get('speech_end_ms') or c.get('subtitle_end_ms') or 0) for c in payload['cues'])
        last_en = max([int(b['en'].get('end_ms') or 0) for b in dual] or [0])
        absolute_timeline = min(cue_starts) >= max(0, start - 1500) and last_cue <= end + 5000
        if legacy_origin is not None:
            media_start = int(legacy_origin)
            media_end = max(end, media_start + last_cue, media_start + last_en)
        elif absolute_timeline:
            media_start, media_end = 0, max(end, last_cue, last_en)
        else:
            media_start, media_end = start, max(end, start + last_cue, start + last_en)
    if not 0 <= media_start < media_end:
        raise ValueError('Origem da mídia inválida.')
    project['media_source_start_ms'], project['media_source_end_ms'] = media_start, media_end
    cues = copy.deepcopy(payload['cues'])
    cards = []
    for cue in cues:
        cue['approved_en'] = str(cue.get('final_en') or cue.get('approved_en') or cue.get('original_en') or '')
        cue.setdefault('original_en', cue['approved_en'])
        for card in (cue.pop('anki', {}) or {}).get('items') or []:
            cards.append({**card, 'cue_order': cue['order']})
    canonical = {'snapshot_id': 'import-' + uuid.uuid4().hex, 'project': project, 'cues': cues}
    for key in ('study', 'shadowingConfig', 'dualScene', 'music', 'wbw_practices'):
        if key in payload:
            canonical[key] = copy.deepcopy(payload[key])
    return canonical, cards


def install_final_project(app, payload, canonical, cards):
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    write(app.WORKSPACE_DIR / 'imported_hub_final.json', payload)
    files = [app.EXTERNAL_AI_RETURN_FILE, app.CUE_REVIEW_CANONICAL_FILE, app.WORD_REVIEW_CANONICAL_FILE, app.CUE_TIMING_CANONICAL_FILE, app.WORD_TIMING_CANONICAL_FILE]
    for path in files:
        write(path, canonical)
    write(app.EXTERNAL_AI_ONE_PASS_FILE, {'anki': {'items': cards}, 'wbw_practices': canonical.get('wbw_practices') or []})
    plan = copy.deepcopy(payload.get('shadowingPractice') or {})
    if plan:
        write(app.SHADOWING_PLAN_FILE, plan)
    dual = canonical.get('dualScene') or []
    if dual:
        write(app.DUAL_SCENE_FILE, {'version': 1, 'completed': True, 'dualScene': dual})
    state = app._read_state()
    kit, project = payload['kit'], canonical['project']
    state['imported_final'] = {'filename': 'imported_hub_final.json', 'media_pending': True}
    state['en'].update({'url': kit['youtube'], 'title': kit['title'], 'validated': True, 'embeddable': True})
    if dual:
        state['pt'].update({'url': dual[0]['pt']['youtube'], 'validated': True, 'embeddable': True})
    state['configuration'].update({'configured': True, 'content_type': 'music' if kit.get('contentType') == 'music' else 'kit', 'dual_scene': bool(dual), 'transcription_mode': 'external'})
    state['cut'].update({'saved': True, 'start_ms': project.get('media_source_start_ms', project['source_video_start_ms']), 'end_ms': project.get('media_source_end_ms', project['source_video_end_ms'])})
    state['external_ai'].update({'validated': True, 'status': 'validated'})
    orders = [c['order'] for c in canonical['cues']]
    snapshot = canonical['snapshot_id']
    for key in ('cue_review', 'cue_timing'):
        state[key].update({'status': 'completed', 'completed': True, 'source_snapshot_id': snapshot, 'total': len(orders), 'accepted_orders': orders, 'current_order': orders[0]})
    positions = app._word_positions(canonical)
    units = app._word_timing_positions(canonical)
    state['word_review'].update({'status': 'completed', 'completed': True, 'source_snapshot_id': snapshot, 'total_words': len(positions), 'accepted_keys': [app._word_key(*p) for p in positions], 'current_cue_order': orders[0], 'current_word_index': 0})
    state['cue_timing']['source_revision'] = hashlib.sha256(app.WORD_REVIEW_CANONICAL_FILE.read_bytes()).hexdigest()
    state['word_timing'].update({'status': 'completed', 'completed': True, 'source_snapshot_id': snapshot, 'source_revision': hashlib.sha256(app.CUE_TIMING_CANONICAL_FILE.read_bytes()).hexdigest(), 'timing_scope_version': 'per-word-v2-cue-authoritative', 'total_units': len(units), 'accepted_keys': [app._word_timing_key(*p) for p in units], 'current_cue_order': orders[0], 'current_unit_index': 0})
    state['shadowing'].update({'status': 'completed', 'completed': bool(plan), 'source_snapshot_id': snapshot, 'source_revision': hashlib.sha256(app.WORD_TIMING_CANONICAL_FILE.read_bytes()).hexdigest(), 'segments': plan.get('editor_segments') or plan.get('segments') or [], 'pause_markers_ms': plan.get('pause_markers_ms') or []})
    state['dual_scene'].update({'status': 'completed', 'completed': bool(dual), 'blocks': [{'id': f'block-{i}', 'en_start_ms': b['en']['start_ms'], 'en_end_ms': b['en']['end_ms'], 'pt_start_ms': b['pt']['start_ms'], 'pt_end_ms': b['pt']['end_ms']} for i,b in enumerate(dual,1)]})
    app._write_state(state)
