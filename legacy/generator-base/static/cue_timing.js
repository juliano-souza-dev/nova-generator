(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editor = null;
  let editingSpeaker = '';
  let savingCue = false;
  let fullAreaPlayback = false;
  let contextCueOrder = 0;
  const query = new URLSearchParams(location.search);
  const recoveryCue = Number(query.get('cue') || 0);
  const requestedReturn = String(query.get('return_to') || '');
  const recoveryReturn = requestedReturn.startsWith('/') && !requestedReturn.startsWith('//') ? requestedReturn : '';
  const recoveryMode = query.get('repair') === 'wbw_practice' && recoveryCue > 0;

  const isTyping = (target) => {
    const tag = target?.tagName?.toLowerCase?.();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
  };

  const api = async (url, options={}) => {
    const response = await fetch(url, {headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options});
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
    return data;
  };
  const fmt = (ms) => window.MSGWaveEditor?.formatMs(ms) || String(ms);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  const status = (text, kind='') => { const el=$('cueTimingMessage'); el.textContent=text||''; el.className=`inline-status ${kind}`; };

  function applyMusicChrome() {
    if (String(state?.content_type || '') !== 'music') return;
    document.body.classList.add('music-flow');
    document.querySelectorAll('.flow-nav a').forEach((a) => {
      const href = a.getAttribute('href');
      if (['/connected-speech','/connected-speech-import','/connected-speech-review'].includes(href)) a.hidden = true;
      const number = a.querySelector('span');
      const label = a.querySelector('b');
      if (href === '/external-ai' && label) label.textContent = 'IA Ext · Lyrics';
      if (href === '/cue-review' && label) label.textContent = 'Revisar Lyrics';
      if (href === '/cue-timing' && label) label.textContent = 'Lyric Timing';
      if (href === '/word-timing' && label) label.textContent = 'WbW Timing';
      if (href === '/materials-external' && number) number.textContent = '11';
      if (href === '/materials-review' && number) number.textContent = '12';
      if (href === '/materials-final' && number) number.textContent = '13';
    });
  }

  function renderSidebar() {
    $('cueTimingAccepted').textContent = String(state.accepted || 0);
    $('cueTimingPending').textContent = String(state.pending || 0);
    $('cueTimingProgress').textContent = `${state.accepted || 0}/${state.total || 0}`;
    $('cueTimingList').innerHTML = (state.items || []).map(item => `<button type="button" class="cue-timing-item ${item.status}${Number(item.order)===Number(state.current_order)?' active':''}" data-order="${Number(item.order)}"><span class="cue-list-order">${String(Number(item.order)).padStart(2,'0')}</span><span class="cue-timing-copy"><b>${escapeHtml(item.label || 'Cue')}</b><small>${fmt(item.start_ms)} → ${fmt(item.end_ms)}${item.speaker ? ` · ${escapeHtml(item.speaker)}` : ''}</small></span><span class="cue-list-status">${item.status==='accepted'?'SALVA':'PENDENTE'}</span></button>`).join('');
    $('cueTimingList').querySelectorAll('[data-order]').forEach(button => button.addEventListener('click', () => loadCue(Number(button.dataset.order))));
    $('cueTimingList').querySelectorAll('[data-order]').forEach(button => button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showCueContextMenu(Number(button.dataset.order), event.clientX, event.clientY);
    }));
  }

  function hideCueContextMenu() {
    const menu=$('cueContextMenu');
    if(menu) menu.hidden=true;
    contextCueOrder=0;
  }

  function showCueContextMenu(order,x,y) {
    const menu=$('cueContextMenu');
    if(!menu)return;
    contextCueOrder=order;
    menu.hidden=false;
    const width=210;
    const height=190;
    menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-width-8))}px`;
    menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-height-8))}px`;
  }

  async function runCueContextAction(action) {
    const order=contextCueOrder;
    hideCueContextMenu();
    if(!order)return;
    if(action==='delete'){await deleteCue(order);return;}
    await loadCue(order);
    if(action==='play') await editor.playSelection();
    if(action==='seek') {
      const video=$('cueTimingVideo');
      if(video) video.currentTime=Number(state?.cue?.start_ms||0)/1000;
    }
  }

  function previewItems() {
    const currentOrder = Number(state?.current_order || 0);
    let liveRange = null;
    try { liveRange = editor?.getRange?.() || null; } catch (_) {}
    return (state?.items || []).map((item) => {
      if (Number(item.order) !== currentOrder) return item;
      return {
        ...item,
        label: String(state?.cue?.approved_en || item.label || ''),
        pt: String(state?.cue?.pt || item.pt || ''),
        start_ms: liveRange ? liveRange.start : Number(state?.cue?.start_ms ?? item.start_ms ?? 0),
        end_ms: liveRange ? liveRange.end : Number(state?.cue?.end_ms ?? item.end_ms ?? 0),
      };
    });
  }

  function renderVideoSubtitle() {
    const video = $('cueTimingVideo');
    const overlay = $('cueTimingSubtitleOverlay');
    if (!video || !overlay || !state) return;
    const now = Math.round((Number(video.currentTime) || 0) * 1000);
    const active = previewItems().filter((item) => now >= Number(item.start_ms || 0) && now < Number(item.end_ms || 0));
    const item = active.find((candidate) => Number(candidate.order) === Number(state.current_order)) || active[0] || null;
    if (!item) {
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden', 'true');
      $('cueTimingSubtitleEn').textContent = '';
      $('cueTimingSubtitlePt').textContent = '';
      return;
    }
    $('cueTimingSubtitleEn').textContent = String(item.label || '');
    $('cueTimingSubtitlePt').textContent = String(item.pt || '');
    $('cueTimingSubtitlePt').hidden = !String(item.pt || '').trim();
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
  }

  async function toggleFullAreaPlayback() {
    const video = $('cueTimingVideo');
    if (!video || !editor) return;
    if (fullAreaPlayback && !video.paused) {
      video.pause();
      fullAreaPlayback = false;
      return;
    }
    editor.cancelPlayback?.();
    fullAreaPlayback = true;
    try {
      await video.play();
    } catch (error) {
      fullAreaPlayback = false;
      status(error?.message || 'Não foi possível reproduzir a cena.', 'error');
    }
  }

  function speakerOptions() { return Array.isArray(state?.speaker_options) ? state.speaker_options : []; }
  function renderSpeakerSelect() {
    const current = String(state?.cue?.speaker || '');
    $('cueSpeakerSelect').innerHTML = '<option value="">Sem speaker</option>' + speakerOptions().map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    $('cueSpeakerSelect').value = current;
  }
  function renderSpeakerList() {
    const list = $('cueSpeakerList');
    const options = speakerOptions();
    if (!options.length) { list.innerHTML = '<small>Cadastre os falantes uma vez; eles aparecerão no seletor de todas as cues.</small>'; return; }
    list.innerHTML='';
    options.forEach(name => {
      const chip=document.createElement('span'); chip.className='cue-speaker-chip';
      if (editingSpeaker.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR')) {
        const input=document.createElement('input'); input.value=name; input.maxLength=80;
        const save=document.createElement('button'); save.type='button'; save.textContent='✓'; save.title='Salvar nome';
        const cancel=document.createElement('button'); cancel.type='button'; cancel.textContent='×'; cancel.title='Cancelar';
        save.onclick=()=>renameSpeaker(name,input.value); cancel.onclick=()=>{editingSpeaker='';renderSpeakerList();};
        input.onkeydown=(event)=>{if(event.key==='Enter'){event.preventDefault();renameSpeaker(name,input.value);} if(event.key==='Escape'){event.preventDefault();editingSpeaker='';renderSpeakerList();}};
        chip.append(input,save,cancel); list.appendChild(chip); queueMicrotask(()=>{input.focus();input.select();}); return;
      }
      const label=document.createElement('span'); label.textContent=name;
      const edit=document.createElement('button'); edit.type='button'; edit.textContent='✎'; edit.title=`Renomear ${name}`; edit.onclick=()=>{editingSpeaker=name;renderSpeakerList();};
      const del=document.createElement('button'); del.type='button'; del.textContent='×'; del.title=`Excluir ${name}`; del.onclick=()=>deleteSpeaker(name);
      chip.append(label,edit,del); list.appendChild(chip);
    });
  }

  function bindEditor() {
    const video=$('cueTimingVideo');
    if (!video.src) video.src = `${state.media_url}?v=${Date.now()}`;
    video.preservesPitch = true;
    video.playbackRate = Number($('cueTimingSpeed')?.value || 1);
    if (!editor) {
      editor = new window.MSGWaveEditor.RangeEditor({
        stage:$('cueTimingWaveStage'), canvas:$('cueTimingWaveCanvas'), video,
        startInput:$('cueTimingIn'), endInput:$('cueTimingOut'),
        durationMs:Number(state.duration_ms)||1, peaks:state.waveform||[], durationLabel:$('cueTimingDuration'),
        onChange:({start,end}) => {
          $('cueTimingDuration').textContent=`${((end-start)/1000).toFixed(3)}s`;
          renderVideoSubtitle();
        },
        onError:(error)=>status(error.message,'error')
      });
      video.addEventListener('timeupdate',()=>{
        $('cueTimingPlayhead').textContent=fmt(Math.round((video.currentTime||0)*1000));
        renderVideoSubtitle();
      },{passive:true});
      video.addEventListener('seeked',renderVideoSubtitle,{passive:true});
      video.addEventListener('loadedmetadata',renderVideoSubtitle,{passive:true});
      video.addEventListener('ended',()=>{ fullAreaPlayback=false; renderVideoSubtitle(); },{passive:true});
    } else if (Array.isArray(state.waveform)) {
      editor.setData({peaks:state.waveform,durationMs:Number(state.duration_ms)||1});
    }
  }

  function renderCue() {
    applyMusicChrome();
    const cue=state.cue || {};
    state.current_order=Number(cue.order || state.current_order || 1);
    renderSidebar();
    const isMusic = String(state.content_type || '') === 'music';
    document.querySelector('.cue-speaker-panel')?.toggleAttribute('hidden', isMusic);
    if (!isMusic) { renderSpeakerList(); renderSpeakerSelect(); }
    bindEditor();
    $('cueTimingTitle').textContent=`Cue ${String(state.current_order).padStart(2,'0')}`;
    $('cueTimingText').textContent=String(cue.approved_en || '');
    $('cueTimingPt').textContent=String(cue.pt || '—');
    $('cueTimingStatus').textContent=cue.accepted?'SALVA':'PENDENTE';
    $('cueTimingStatus').classList.toggle('ready',Boolean(cue.accepted));
    editor.setRange(Number(cue.start_ms)||0,Number(cue.end_ms)||1,{silent:true});
    if (Number($('cueTimingWaveZoom')?.value || 1) > 1) editor.centerOnRange?.();
    try { $('cueTimingVideo').currentTime=(Number(cue.start_ms)||0)/1000; } catch (_) {}
    renderVideoSubtitle();
    $('cueTimingComplete').hidden=!state.completed;
    document.querySelector('[data-gated="word-timing"]')?.classList.toggle('is-disabled', !state.completed);
    $('saveCueTiming').textContent=state.total===state.current_order?'Salvar cue →':'Salvar cue e próxima →';
    status(String(state.content_type||'')==='music' ? (cue.accepted?'Linha já salva. Você pode ajustar IN/OUT novamente.':'Ajuste IN/OUT da linha cantada e salve.') : (cue.accepted?'Cue já salva. Você pode ajustar IN/OUT ou speaker e salvar novamente.':'Ajuste IN/OUT e speaker, depois salve.'));
  }

  async function restore() {
    const data=await api('/api/cue-timing/state');
    state=data.review || {};
    if (recoveryMode) {
      await loadCue(recoveryCue);
      status(`Confira o IN/OUT da cue ${recoveryCue}. Esta é a cue associada à prática WbW com erro.`, 'error');
      return;
    }
    renderCue();
  }
  async function loadCue(order) {
    editor?.cancelPlayback?.();
    fullAreaPlayback = false;
    const waveform=state.waveform;
    const data=await api(`/api/cue-timing/cue/${Number(order)}`);
    state={...(data.review||{}), waveform};
    renderCue();
  }
  async function saveCue() {
    if (savingCue || !editor || !state) return;
    savingCue = true;
    const button=$('saveCueTiming');
    try {
      editor.cancelPlayback?.();
      fullAreaPlayback = false;
      button.disabled=true; button.textContent='Salvando…';
      const {start,end}=editor.getRange();
      const data=await api('/api/cue-timing/save',{method:'POST',body:JSON.stringify({order:state.current_order,start_ms:start,end_ms:end,speaker:(String(state.content_type||'')==='music'?'':$('cueSpeakerSelect').value)})});
      const waveform=state.waveform;
      state={...(data.review||{}), waveform};
      status(`✓ Cue ${String(data.saved_order).padStart(2,'0')} salva.`,'success');
      if (recoveryMode && recoveryReturn) {
        location.href=`${recoveryReturn}${recoveryReturn.includes('?')?'&':'?'}wbw_practice_fixed=1`;
        return;
      }
      if (data.completed) { renderCue(); $('cueTimingComplete').hidden=false; $('topState').textContent='cue timing concluído'; return; }
      await loadCue(Number(data.next_order));
    } catch (error) { status(error.message,'error'); }
    finally {
      savingCue = false;
      button.disabled=false;
      if (!state?.completed) button.textContent=state?.total===state?.current_order?'Salvar cue →':'Salvar cue e próxima →';
    }
  }
  async function deleteCue(order=Number(state?.current_order||0)) {
    if (!state || Number(state.total || 0) <= 1) { status('Não é possível excluir a única cue restante.','error'); return; }
    const item=(state.items||[]).find(candidate=>Number(candidate.order)===Number(order));
    if(!confirm(`Excluir a Cue ${String(order).padStart(2,'0')} e todas as words associadas?\n\n${String(item?.label||'')}\n\nOs timings das outras cues não serão alterados.`))return;
    const button=$('deleteCueTiming');
    button.disabled=true; button.textContent='Excluindo…';
    try {
      editor?.cancelPlayback?.(); fullAreaPlayback=false;
      const waveform=state.waveform;
      const data=await api('/api/cue-timing/delete',{method:'POST',body:JSON.stringify({order})});
      state={...(data.review||{}),waveform};
      renderCue();
      status(`✓ Cue excluída com ${Number(data.deleted_words||0)} word(s). Outros timings preservados.`,'success');
    } catch(error) { status(error.message,'error'); }
    finally { button.disabled=false; button.textContent='Excluir cue + WbW'; }
  }
  async function realignCues() {
    if (!state) return;
    const button=$('realignCueTiming');
    if (button.disabled) return;
    button.disabled=true; button.textContent='Realinhando…';
    try {
      editor?.cancelPlayback?.(); fullAreaPlayback=false;
      const waveform=state.waveform;
      const data=await api('/api/cue-timing/realign',{method:'POST'});
      state={...(data.review||{}),waveform};
      renderCue();
      status(`✓ ${Number(data.moved||0)} cue(s) realinhadas. A Cue ${String(data.anchor_order||0).padStart(2,'0')} foi mantida como âncora.`,'success');
    } catch(error) { status(error.message,'error'); }
    finally { button.disabled=false; button.textContent='Realinhar próximas (Ctrl + R)'; }
  }
  async function addSpeaker() {
    const input=$('newCueSpeaker'); const name=String(input.value||'').trim(); if(!name)return;
    try { const waveform=state.waveform; const data=await api('/api/cue-timing/speakers/add',{method:'POST',body:JSON.stringify({name})}); state={...(data.review||{}),waveform}; input.value=''; renderCue(); status(`✓ Speaker ${name} adicionado.`,'success'); } catch(error){status(error.message,'error');}
  }
  async function renameSpeaker(currentName,newName) {
    newName=String(newName||'').trim(); if(!newName)return;
    try { const waveform=state.waveform; const data=await api('/api/cue-timing/speakers/rename',{method:'POST',body:JSON.stringify({current_name:currentName,new_name:newName})}); state={...(data.review||{}),waveform}; editingSpeaker=''; renderCue(); status(`✓ ${currentName} → ${newName}.`,'success'); } catch(error){status(error.message,'error');}
  }
  async function deleteSpeaker(name) {
    const affected=(state.items||[]).filter(item=>String(item.speaker||'').toLocaleLowerCase('pt-BR')===String(name).toLocaleLowerCase('pt-BR')).length;
    if(!confirm(`Excluir ${name}?${affected?`\n\n${affected} cue(s) ficarão sem speaker.`:''}`))return;
    try { const waveform=state.waveform; const data=await api('/api/cue-timing/speakers/delete',{method:'POST',body:JSON.stringify({name})}); state={...(data.review||{}),waveform}; renderCue(); status(`✓ Speaker ${name} excluído.`,'success'); } catch(error){status(error.message,'error');}
  }
  function changeVideoSpeed(direction) {
    const select=$('cueTimingSpeed');
    const next=Math.max(0,Math.min(select.options.length-1,select.selectedIndex+direction));
    if (next===select.selectedIndex) return;
    select.selectedIndex=next;
    select.dispatchEvent(new Event('change',{bubbles:true}));
  }

  document.addEventListener('keydown',(event)=>{
    if(event.key==='Escape')hideCueContextMenu();
    if (event.code === 'KeyR' && event.ctrlKey && !event.altKey && !event.repeat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      realignCues();
      return;
    }
    if (isTyping(event.target) || (event.repeat && event.code !== 'KeyG')) return;
    if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      changeVideoSpeed(event.code === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.code === 'Space' && event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleFullAreaPlayback();
      return;
    }
    if (event.code === 'KeyG' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      saveCue();
    }
  }, true);

  document.addEventListener('pointerdown',(event)=>{if(!$('cueContextMenu')?.contains(event.target))hideCueContextMenu();},true);
  window.addEventListener('scroll',hideCueContextMenu,true);
  window.addEventListener('resize',hideCueContextMenu);
  $('cueContextMenu').querySelectorAll('[data-cue-context-action]').forEach(button=>button.addEventListener('click',()=>runCueContextAction(button.dataset.cueContextAction).catch(error=>status(error.message,'error'))));

  $('cueTimingWaveZoom').addEventListener('input',(event)=>{
    const zoom=Number(event.target.value||1);
    $('cueTimingWaveZoomValue').textContent=`${zoom}×`;
    try { editor?.setZoom?.(zoom); editor?.centerOnRange?.(); } catch(error){ status(error.message,'error'); }
  });
  $('cueTimingCenterCue').addEventListener('click',()=>{try{editor?.centerOnRange?.();}catch(error){status(error.message,'error');}});
  $('cueTimingSpeed').addEventListener('change',(event)=>{
    const video=$('cueTimingVideo');
    if(video) {
      video.preservesPitch=true;
      video.playbackRate=Number(event.target.value||1);
    }
  });

  $('cueTimingMarkIn').addEventListener('click',()=>{try{editor.setInFromPlayhead();}catch(error){status(error.message,'error');}});
  $('cueTimingMarkOut').addEventListener('click',()=>{try{editor.setOutFromPlayhead();}catch(error){status(error.message,'error');}});
  $('cueTimingPlay').addEventListener('click',()=>editor.playSelection().catch(error=>status(error.message,'error')));
  $('deleteCueTiming').addEventListener('click',deleteCue);
  $('realignCueTiming').addEventListener('click',realignCues);
  $('saveCueTiming').addEventListener('click',saveCue);
  $('addCueSpeaker').addEventListener('click',addSpeaker);
  $('newCueSpeaker').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();addSpeaker();}});
  restore().catch(error=>status(error.message,'error'));
})();
