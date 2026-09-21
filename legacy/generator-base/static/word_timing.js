(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editor = null;
  let saving = false;
  let fullAreaPlayback = false;
  let hubPreviewFrame = 0;
  let hubPreviewLastMs = null;
  let hubPreviewFlash = null;
  const hubPreviewQueue = [];
  const query = new URLSearchParams(location.search);
  const repairCue = Number(query.get('cue') || 0);
  const repairUnit = query.has('unit') ? Number(query.get('unit')) : null;
  const repairKind = String(query.get('repair') || '');
  const repairMode = ['hub_json', 'wbw_practice'].includes(repairKind);
  const requestedReturn = String(query.get('return_to') || '');
  const returnTo = requestedReturn.startsWith('/') && !requestedReturn.startsWith('//') ? requestedReturn : '';
  let repairLoaded = false;

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
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const status = (text, kind='') => { const el=$('wordTimingMessage'); el.textContent=text||''; el.className=`inline-status ${kind}`; };
  const unitKey = (cueOrder, unitIndex) => `${Number(cueOrder)}:${Number(unitIndex)}`;

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
    $('wordTimingAccepted').textContent = String(state.accepted_units || 0);
    $('wordTimingPending').textContent = String(state.pending_units || 0);
    $('wordTimingProgress').textContent = `${state.accepted_units || 0}/${state.total_units || 0}`;
    $('wordTimingCueList').innerHTML = (state.cues || []).map(item => `<button type="button" class="cue-timing-item ${item.status}${Number(item.order)===Number(state.current_cue_order)?' active':''}" data-order="${Number(item.order)}"><span class="cue-list-order">${String(Number(item.order)).padStart(2,'0')}</span><span class="cue-timing-copy"><b>${escapeHtml(item.label || 'Cue')}</b><small>${Number(item.accepted)||0}/${Number(item.total)||0} unidades salvas</small></span><span class="cue-list-status">${item.status==='accepted'?'SALVA':'PENDENTE'}</span></button>`).join('');
    $('wordTimingCueList').querySelectorAll('[data-order]').forEach(button => button.addEventListener('click', () => loadCue(Number(button.dataset.order))));
  }

  function renderUnitStrip() {
    const current = Number(state.current_unit_index || 0);
    $('wordTimingStrip').innerHTML = (state.unit_items || []).map(unit => `<button type="button" class="word-timing-unit ${unit.status}${Number(unit.unit_index)===current?' active':''}" data-unit="${Number(unit.unit_index)}" title="${escapeHtml(unit.pt || '')}"><span>${escapeHtml(unit.en || '—')}</span>${unit.is_group?'<i>GRUPO</i>':''}</button>`).join('');
    $('wordTimingStrip').querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => loadUnit(Number(state.current_cue_order), Number(button.dataset.unit))));
    $('wordTimingStrip').querySelector('.active')?.scrollIntoView?.({block:'nearest', inline:'center'});
  }

  function previewTimeline() {
    const currentKey = unitKey(state?.current_cue_order, state?.current_unit_index);
    let liveRange = null;
    try { liveRange = editor?.getRange?.() || null; } catch (_) {}
    return (state?.timeline || []).map(item => {
      if (String(item.key) !== currentKey || !liveRange) return item;
      return {...item, start_ms:liveRange.start, end_ms:liveRange.end};
    });
  }

  function activeAt(now) {
    const active = previewTimeline().filter(item => now >= Number(item.start_ms||0) && now < Number(item.end_ms||0));
    if (!active.length) return null;
    active.sort((a,b) => Number(b.start_ms||0) - Number(a.start_ms||0) || Number(b.unit_index||0) - Number(a.unit_index||0));
    return active[0];
  }

  function renderVideoSubtitle() {
    const video = $('wordTimingVideo');
    const overlay = $('wordTimingSubtitleOverlay');
    if (!video || !overlay || !state) return;
    const now = Math.round((Number(video.currentTime)||0)*1000);
    const active = activeAt(now);
    if (!active) {
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden','true');
      $('wordTimingSubtitleEn').innerHTML='';
      $('wordTimingSubtitlePt').innerHTML='';
      return;
    }
    const cueUnits = previewTimeline().filter(item => Number(item.cue_order) === Number(active.cue_order));
    const activeKey = String(active.key || '');
    $('wordTimingSubtitleEn').innerHTML = cueUnits.map(item => `<span class="wbw-timing-token${String(item.key)===activeKey?' current':''}${item.is_group?' grouped':''}">${escapeHtml(item.en||'')}</span>`).join(' ');
    $('wordTimingSubtitlePt').innerHTML = cueUnits.map(item => `<span class="wbw-timing-token${String(item.key)===activeKey?' current':''}${item.is_group?' grouped':''}">${escapeHtml(item.pt||'')}</span>`).join(' ');
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden','false');
  }

  async function toggleFullAreaPlayback() {
    const video=$('wordTimingVideo');
    if (!video || !editor) return;
    if (fullAreaPlayback && !video.paused) { video.pause(); fullAreaPlayback=false; return; }
    editor.cancelPlayback?.();
    fullAreaPlayback=true;
    try { await video.play(); }
    catch(error){ fullAreaPlayback=false; status(error?.message||'Não foi possível reproduzir a cena.','error'); }
  }

  function bindEditor() {
    const video=$('wordTimingVideo');
    if (!video.src) video.src=`${state.media_url}?v=${Date.now()}`;
    video.preservesPitch=true;
    video.playbackRate=Number($('wordTimingSpeed')?.value||1);
    if (!editor) {
      editor=new window.MSGWaveEditor.RangeEditor({
        stage:$('wordTimingWaveStage'), canvas:$('wordTimingWaveCanvas'), video,
        startInput:$('wordTimingIn'), endInput:$('wordTimingOut'),
        durationMs:Number(state.duration_ms)||1, peaks:state.waveform||[], durationLabel:$('wordTimingDuration'),
        zoom:Number($('wordTimingWaveZoom')?.value||64), maxZoom:200,
        onChange:({start,end})=>{ $('wordTimingDuration').textContent=`${((end-start)/1000).toFixed(3)}s`; renderVideoSubtitle(); },
        onError:(error)=>status(error.message,'error')
      });
      video.addEventListener('timeupdate',()=>{ $('wordTimingPlayhead').textContent=fmt(Math.round((video.currentTime||0)*1000)); renderVideoSubtitle(); },{passive:true});
      video.addEventListener('seeked',renderVideoSubtitle,{passive:true});
      video.addEventListener('loadedmetadata',renderVideoSubtitle,{passive:true});
      video.addEventListener('ended',()=>{fullAreaPlayback=false;renderVideoSubtitle();},{passive:true});
    } else if (Array.isArray(state.waveform)) {
      editor.setData({peaks:state.waveform,durationMs:Number(state.duration_ms)||1});
    }
  }

  function renderUnit() {
    applyMusicChrome();
    const unit=state.unit||{};
    state.current_cue_order=Number(unit.cue_order||state.current_cue_order||1);
    state.current_unit_index=Number(unit.unit_index??state.current_unit_index??0);
    renderSidebar(); renderUnitStrip(); bindEditor();
    const number=Number(state.current_unit_index)+1;
    const total=(state.unit_items||[]).length;
    $('wordTimingTitle').textContent=`Cue ${String(state.current_cue_order).padStart(2,'0')} · ${unit.is_group?'Grupo':'Word'} ${number}/${total}`;
    $('wordTimingText').textContent=String(state.cue?.approved_en||'');
    $('wordTimingCurrentEn').textContent=String(unit.en||'—');
    $('wordTimingCurrentPt').textContent=String(unit.pt||'—');
    $('wordTimingUnitType').textContent=unit.is_group?'GRUPO WbW':'WORD';
    $('wordTimingCenter').textContent=unit.is_group?'Centralizar grupo':'Centralizar word';
    $('wordTimingPlay').textContent=unit.is_group?'▶ Reproduzir grupo':'▶ Reproduzir word';
    $('wordTimingStatus').textContent=unit.accepted?'SALVA':'PENDENTE';
    $('wordTimingStatus').classList.toggle('ready',Boolean(unit.accepted));
    editor.setRange(Number(unit.start_ms)||0,Number(unit.end_ms)||1,{silent:true});
    if (Number($('wordTimingWaveZoom')?.value||1)>1) editor.centerOnRange?.();
    try { $('wordTimingVideo').currentTime=(Number(unit.start_ms)||0)/1000; } catch (_) {}
    renderVideoSubtitle();
    $('wordTimingComplete').hidden=!state.completed;
    const nextButton=$('wordTimingNext');
    if(nextButton){
      const next=state.next_stage||{};
      const shadowing=state.completed&&next.kind==='shadowing'&&next.url;
      const dualScene=state.completed&&next.kind==='dual_scene'&&next.url;
      const materials=state.completed&&next.kind==='materials_external'&&next.url;
      nextButton.disabled=!(shadowing||dualScene||materials);
      nextButton.textContent=materials?'Avançar para materiais →':(dualScene?'Avançar para Dual Scene →':(shadowing?'Avançar para Shadowing →':'Próxima etapa · bloqueada'));
      nextButton.onclick=(shadowing||dualScene||materials)?()=>{location.href=next.url}:null;
    }
    if (repairMode && repairLoaded) {
      $('saveWordTiming').textContent=returnTo?'Salvar correção e voltar →':'Salvar correção';
      status(`Correção solicitada pelo JSON do HUB. Ajuste somente esta ${unit.is_group?'unidade':'word'} e salve.`, 'error');
    } else {
      $('saveWordTiming').textContent=state.completed?'Etapa concluída':`Salvar ${unit.is_group?'grupo':'word'} e próxima →`;
      status(unit.accepted?'Unidade já salva. Ajuste novamente se necessário e salve.':unit.is_group?'A cue é a janela inicial. Ajuste o grupo livremente; o IN/OUT pode ultrapassar a cue até o limite da mídia.':'A cue é a janela inicial. Ajuste a word livremente; o IN/OUT pode ultrapassar a cue até o limite da mídia.');
    }
  }

  async function restore(){
    const data=await api('/api/word-timing/state');
    state=data.review||{};
    if (repairMode && repairCue>0) {
      const unit = repairUnit === null || !Number.isFinite(repairUnit) ? Number(state.current_unit_index||0) : repairUnit;
      repairLoaded=true;
      await loadUnit(repairCue, unit);
      $('topState').textContent='Corrigir WbW para HUB';
      return;
    }
    renderUnit();
  }
  async function loadCue(order){ editor?.cancelPlayback?.(); fullAreaPlayback=false; const waveform=state.waveform; const data=await api(`/api/word-timing/cue/${Number(order)}`); state={...(data.review||{}),waveform}; renderUnit(); }
  async function loadUnit(cueOrder,unitIndex){ editor?.cancelPlayback?.(); fullAreaPlayback=false; const waveform=state.waveform; const data=await api(`/api/word-timing/unit/${Number(cueOrder)}/${Number(unitIndex)}`); state={...(data.review||{}),waveform}; renderUnit(); }

  async function saveUnit(){
    if(saving||!editor||!state)return;
    saving=true; const button=$('saveWordTiming');
    try{
      editor.cancelPlayback?.(); fullAreaPlayback=false; button.disabled=true; button.textContent='Salvando…';
      const {start,end}=editor.getRange();
      const data=await api('/api/word-timing/save',{method:'POST',body:JSON.stringify({cue_order:state.current_cue_order,unit_index:state.current_unit_index,start_ms:start,end_ms:end})});
      const waveform=state.waveform; state={...(data.review||{}),waveform};
      status(`✓ ${state?.unit?.is_group?'Grupo':'Word'} salva.`,'success');
      if (repairMode && repairLoaded && returnTo) {
        location.href = `${returnTo}${returnTo.includes('?')?'&':'?'}wbw_fixed=1`;
        return;
      }
      if(data.completed){renderUnit();$('wordTimingComplete').hidden=false;$('topState').textContent='WbW timing concluído';return;}
      await loadUnit(Number(data.next.cue_order),Number(data.next.unit_index));
    }catch(error){status(error.message,'error');}
    finally{saving=false;button.disabled=false;if(repairMode&&repairLoaded){button.textContent=returnTo?'Salvar correção e voltar →':'Salvar correção';}else if(!state?.completed){button.textContent=`Salvar ${state?.unit?.is_group?'grupo':'word'} e próxima →`;}}
  }

  async function saveCueUnits(){
    if(saving||!editor||!state||repairMode)return;
    saving=true; const button=$('saveWordTiming');
    try{
      editor.cancelPlayback?.(); fullAreaPlayback=false; button.disabled=true; button.textContent='Salvando cue…';
      const cueOrder=Number(state.current_cue_order);
      const {start,end}=editor.getRange();
      const data=await api('/api/word-timing/save-cue',{method:'POST',body:JSON.stringify({cue_order:cueOrder,current_unit_index:Number(state.current_unit_index),current_start_ms:start,current_end_ms:end})});
      const waveform=state.waveform; state={...(data.review||{}),waveform};
      status(`✓ ${Number(data.saved_units||0)} unidade(s) da Cue ${String(cueOrder).padStart(2,'0')} salvas.`,'success');
      if(data.completed){renderUnit();$('wordTimingComplete').hidden=false;$('topState').textContent='WbW timing concluído';return;}
      await loadUnit(Number(data.next.cue_order),Number(data.next.unit_index));
    }catch(error){status(error.message,'error');}
    finally{saving=false;button.disabled=false;if(!state?.completed)button.textContent=`Salvar ${state?.unit?.is_group?'grupo':'word'} e próxima →`;}
  }

  async function realignUnits(){
    if(!state||repairMode)return;
    const button=$('realignWordTiming');
    if(button.disabled)return;
    button.disabled=true;button.textContent='Realinhando…';
    try{
      editor?.cancelPlayback?.();fullAreaPlayback=false;
      const waveform=state.waveform;
      const {start,end}=editor.getRange();
      const data=await api('/api/word-timing/realign',{method:'POST',body:JSON.stringify({cue_order:Number(state.current_cue_order),anchor_unit_index:Number(state.current_unit_index),anchor_start_ms:start,anchor_end_ms:end})});
      state={...(data.review||{}),waveform};
      renderUnit();
      status(`✓ ${Number(data.moved||0)} word(s) realinhadas dentro da Cue ${String(state.current_cue_order).padStart(2,'0')}, com intervalo de 100 ms.`,'success');
    }catch(error){status(error.message,'error');}
    finally{button.disabled=false;button.textContent='Realinhar words desta cue (Ctrl + R)';}
  }

  function changeVideoSpeed(direction){
    const select=$('wordTimingSpeed');
    const next=Math.max(0,Math.min(select.options.length-1,select.selectedIndex+direction));
    if(next===select.selectedIndex)return;
    select.selectedIndex=next;
    select.dispatchEvent(new Event('change',{bubbles:true}));
  }

  function renderHubTestCaption(){
    const video=$('wordTimingTestVideo');
    const caption=$('wordTimingTestCaption');
    if(!video||!caption||!state)return;
    const now=Math.round((Number(video.currentTime)||0)*1000);
    const cue=(state.cues||[]).find(item=>now>=Number(item.subtitle_start_ms||item.speech_start_ms||0)&&now<Number(item.subtitle_end_ms||item.speech_end_ms||0));
    if(!cue){caption.hidden=true;caption.replaceChildren();return;}
    const words=previewTimeline().filter(item=>Number(item.cue_order)===Number(cue.order));
    if(hubPreviewLastMs!==null&&now>=hubPreviewLastMs){
      words.filter(item=>Number(item.start_ms||0)>hubPreviewLastMs&&Number(item.end_ms||0)<=now).forEach(item=>{if(!hubPreviewQueue.some(key=>key===String(item.key))&&String(hubPreviewFlash?.key||'')!==String(item.key))hubPreviewQueue.push(String(item.key))});
    }else if(hubPreviewLastMs!==null&&now<hubPreviewLastMs){hubPreviewQueue.length=0;hubPreviewFlash=null;}
    hubPreviewLastMs=now;
    if(hubPreviewFlash&&performance.now()>=hubPreviewFlash.until)hubPreviewFlash=null;
    if(!hubPreviewFlash&&hubPreviewQueue.length)hubPreviewFlash={key:hubPreviewQueue.shift(),until:performance.now()+90};
    const active=hubPreviewFlash?words.find(item=>String(item.key)===String(hubPreviewFlash.key)):words.find(item=>now>=Number(item.start_ms||0)&&now<Number(item.end_ms||0));
    caption.replaceChildren();
    if(words.length){
      words.forEach(word=>{
        const token=document.createElement('span');
        token.className=`hub-word-preview-token${active&&String(active.key)===String(word.key)?' active':''}`;
        token.textContent=String(word.en||'');
        caption.appendChild(token);
      });
    }else{caption.textContent=String(cue.label||'');}
    caption.hidden=!caption.textContent.trim();
  }

  function runHubPreviewFrames(){
    cancelAnimationFrame(hubPreviewFrame);
    const tick=()=>{if(!$('wordTimingTestDialog')?.open)return;renderHubTestCaption();hubPreviewFrame=requestAnimationFrame(tick)};
    hubPreviewFrame=requestAnimationFrame(tick);
  }

  async function toggleHubTest({fromStart=false}={}){
    if(!state)return;
    const dialog=$('wordTimingTestDialog');
    const video=$('wordTimingTestVideo');
    if(dialog.open){dialog.close();return;}
    editor?.cancelPlayback?.();fullAreaPlayback=false;
    const cue=(state.cues||[]).find(item=>Number(item.order)===Number(state.current_cue_order));
    if(!video.src)video.src=state.media_url;
    video.preservesPitch=true;
    video.playbackRate=1;
    dialog.showModal();
    hubPreviewLastMs=null;hubPreviewFlash=null;hubPreviewQueue.length=0;runHubPreviewFrames();
    try{video.currentTime=fromStart?0:Math.max(0,Number(cue?.speech_start_ms??state.unit?.start_ms??0)/1000);await video.play();}
    catch(_){renderHubTestCaption();}
  }

  function handleRealignShortcut(event){
    if((event.code==='KeyR'||String(event.key||'').toLowerCase()==='r')&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat){
      event.preventDefault();event.stopImmediatePropagation();realignUnits();
    }
  }
  window.addEventListener('keydown',handleRealignShortcut,true);

  document.addEventListener('keydown',(event)=>{
    if(event.code==='Enter'&&event.ctrlKey&&!event.altKey&&!event.repeat){event.preventDefault();event.stopImmediatePropagation();toggleHubTest({fromStart:event.shiftKey});return;}
    if(isTyping(event.target)||(event.repeat&&event.code!=='KeyG'))return;
    if(event.code==='KeyG'&&event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();saveCueUnits();return;}
    if((event.code==='ArrowLeft'||event.code==='ArrowRight')&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();changeVideoSpeed(event.code==='ArrowLeft'?-1:1);return;}
    if(event.code==='Space'&&event.shiftKey){event.preventDefault();event.stopImmediatePropagation();toggleFullAreaPlayback();return;}
    if(event.code==='Space'&&!event.shiftKey){fullAreaPlayback=false;}
    if(event.code==='KeyG'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();saveUnit();}
  },true);

  $('wordTimingWaveZoom').addEventListener('input',(event)=>{const zoom=Number(event.target.value||1);$('wordTimingWaveZoomValue').textContent=`${zoom}×`;try{editor?.setZoom?.(zoom);editor?.centerOnRange?.();}catch(error){status(error.message,'error');}});
  $('wordTimingCenter').addEventListener('click',()=>{try{editor?.centerOnRange?.();}catch(error){status(error.message,'error');}});
  $('wordTimingSpeed').addEventListener('change',(event)=>{const video=$('wordTimingVideo');if(video){video.preservesPitch=true;video.playbackRate=Number(event.target.value||1);}});
  $('wordTimingMarkIn').addEventListener('click',()=>{try{editor.setInFromPlayhead();}catch(error){status(error.message,'error');}});
  $('wordTimingMarkOut').addEventListener('click',()=>{try{editor.setOutFromPlayhead();}catch(error){status(error.message,'error');}});
  $('wordTimingPlay').addEventListener('click',()=>{fullAreaPlayback=false;editor.playSelection().catch(error=>status(error.message,'error'));});
  $('testWordTiming').addEventListener('click',()=>toggleHubTest());
  $('realignWordTiming').addEventListener('click',realignUnits);
  $('saveWordTiming').addEventListener('click',saveUnit);
  $('closeWordTimingTest').addEventListener('click',()=>$('wordTimingTestDialog').close());
  $('wordTimingTestDialog').addEventListener('close',()=>{cancelAnimationFrame(hubPreviewFrame);hubPreviewLastMs=null;hubPreviewFlash=null;hubPreviewQueue.length=0;$('wordTimingTestVideo').pause();$('wordTimingTestCaption').hidden=true;});
  $('wordTimingTestDialog').addEventListener('click',(event)=>{if(event.target===$('wordTimingTestDialog'))$('wordTimingTestDialog').close();});
  $('wordTimingTestVideo').addEventListener('timeupdate',renderHubTestCaption,{passive:true});
  $('wordTimingTestVideo').addEventListener('seeked',renderHubTestCaption,{passive:true});
  restore().catch(error=>status(error.message,'error'));
})();
