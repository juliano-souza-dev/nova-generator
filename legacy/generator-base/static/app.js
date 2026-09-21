(() => {
  const page = document.body.dataset.page || 'source';
  const $ = (id) => document.getElementById(id);
  const topState = $('topState');
  let enValidationToken = 0;
  let ptValidationToken = 0;
  let ptIsValid = false;
  let enDebounce = 0;
  let ptDebounce = 0;
  let wavePoll = 0;
  let processPoll = 0;
  let rangeEditor = null;

  function setStatus(el, text, kind='') {
    if (!el) return;
    el.textContent = text || '';
    el.className = `inline-status${kind ? ` ${kind}` : ''}`;
  }

  async function api(url, options={}) {
    const init = {...options};
    init.headers = {...(options.headers || {})};
    if (options.body && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    const res = await fetch(url, init);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.detail || data.message || `HTTP ${res.status}`);
    return data;
  }

  function typeValue() {
    return document.querySelector('input[name="contentType"]:checked')?.value || 'kit';
  }

  function transcriptionValue() {
    return document.querySelector('input[name="transcriptionMode"]:checked')?.value || 'external';
  }

  function fmt(ms) {
    if (window.MSGWaveEditor) return window.MSGWaveEditor.formatMs(ms);
    const value = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(value / 3600000);
    const minutes = Math.floor((value % 3600000) / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const millis = value % 1000;
    return `${hours ? `${String(hours).padStart(2,'0')}:` : ''}${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(millis).padStart(3,'0')}`;
  }

  function renderNavState(state) {
    const music = state.configuration?.content_type === 'music';
    document.body.classList.toggle('music-flow', music);
    if (music) {
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
    const sourceReady = Boolean(state.en?.validated && state.en?.embeddable && state.en?.url);
    const cfg = state.configuration || {};
    const configReady = Boolean(cfg.configured && ['kit','music'].includes(cfg.content_type) && (cfg.content_type === 'music' || !cfg.dual_scene || (state.pt?.validated && state.pt?.embeddable && state.pt?.url)));
    const processReady = Boolean(configReady && state.cut?.saved);
    const externalReady = Boolean(processReady && state.process?.status === 'ready');
    const cueReviewReady = Boolean(externalReady && state.external_ai?.validated);
    const wordReviewReady = Boolean(cueReviewReady && state.cue_review?.completed);
    const cueTimingReady = Boolean(wordReviewReady && state.word_review?.completed);
    const wordTimingReady = Boolean(cueTimingReady && state.cue_timing?.completed);
    document.querySelectorAll('[data-gated="config"]').forEach((a) => a.classList.toggle('is-disabled', !sourceReady));
    document.querySelectorAll('[data-gated="wave"]').forEach((a) => a.classList.toggle('is-disabled', !configReady));
    document.querySelectorAll('[data-gated="process"]').forEach((a) => a.classList.toggle('is-disabled', !processReady));
    document.querySelectorAll('[data-gated="external-ai"]').forEach((a) => a.classList.toggle('is-disabled', !externalReady));
    document.querySelectorAll('[data-gated="cue-review"]').forEach((a) => a.classList.toggle('is-disabled', !cueReviewReady));
    document.querySelectorAll('[data-gated="word-review"]').forEach((a) => a.classList.toggle('is-disabled', !wordReviewReady));
    document.querySelectorAll('[data-gated="cue-timing"]').forEach((a) => a.classList.toggle('is-disabled', !cueTimingReady));
    document.querySelectorAll('[data-gated="word-timing"]').forEach((a) => a.classList.toggle('is-disabled', !wordTimingReady));
  }

  async function validateSource(role) {
    const input = role === 'en' ? $('enUrl') : $('ptUrl');
    const status = role === 'en' ? $('enStatus') : $('ptStatus');
    const button = role === 'en' ? $('validateEn') : $('validatePt');
    const value = String(input?.value || '').trim();
    if (!value) {
      setStatus(status, role === 'en' ? 'Cole uma URL do YouTube.' : 'Informe o vídeo equivalente em Português.');
      if (role === 'pt') {
        ptIsValid = false;
        if ($('acceptPt')) $('acceptPt').disabled = true;
        if ($('ptValidated')) $('ptValidated').hidden = true;
      }
      return false;
    }

    const token = role === 'en' ? ++enValidationToken : ++ptValidationToken;
    setStatus(status, 'Validando URL e permissão de incorporação…', 'loading');
    if (button) button.disabled = true;
    try {
      const data = await api('/api/youtube/validate', {method:'POST', body:JSON.stringify({video_url:value, role})});
      if ((role === 'en' ? enValidationToken : ptValidationToken) !== token) return false;
      const source = data.source || {};
      if (!data.can_proceed) {
        setStatus(status, `URL reconhecida, mas não pode prosseguir: ${source.reason || 'Este vídeo não permite reprodução incorporada.'}`, 'error');
        if (role === 'en' && $('enValidated')) $('enValidated').hidden = true;
        if (role === 'pt') {
          ptIsValid = false;
          $('acceptPt').disabled = true;
          $('ptValidated').hidden = true;
        }
        return false;
      }

      if (role === 'en') {
        $('enTitle').textContent = source.title || 'Vídeo EN validado';
        $('enValidatedUrl').textContent = source.url || value;
        $('enValidated').hidden = false;
        setStatus(status, '✓ URL válida e vídeo incorporável. Podemos prosseguir.', 'success');
        if (topState) topState.textContent = 'fonte EN validada';
      } else {
        ptIsValid = true;
        $('ptTitle').textContent = source.title || 'Fonte PT validada';
        $('ptValidated').hidden = false;
        $('acceptPt').disabled = false;
        setStatus(status, '✓ URL PT válida e vídeo incorporável.', 'success');
      }
      const state = await api('/api/state');
      renderNavState(state);
      return true;
    } catch (error) {
      setStatus(status, error.message || 'Falha na validação.', 'error');
      if (role === 'en' && $('enValidated')) $('enValidated').hidden = true;
      if (role === 'pt') {
        ptIsValid = false;
        $('acceptPt').disabled = true;
        $('ptValidated').hidden = true;
      }
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function updateContentTypeUI() {
    if (page !== 'config') return;
    const music = typeValue() === 'music';
    $('dualToggleWrap').hidden = music;
    $('musicPending').hidden = !music;
    $('continueConfig').disabled = false;
    $('continueConfig').textContent = music ? 'Prosseguir para recorte musical →' : 'Prosseguir →';
  }

  async function configureMedia(options) {
    const mediaSource = document.querySelector('input[name="mediaSource"]:checked')?.value || 'youtube';
    if (mediaSource === 'manual') {
      const file = $('manualVideo').files[0];
      if (file) {
        setStatus($('configStatus'), 'Enviando e preparando vídeo… Aguarde a conclusão.', 'loading');
        const response = await fetch('/api/source/upload', {method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:file});
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || 'Falha ao enviar vídeo.');
        $('manualVideo').value = '';
        $('manualVideoHint').textContent = 'Vídeo enviado e pronto para usar.';
      }
    }
    return api('/api/configure', {method:'POST', body:JSON.stringify({...options, media_source:mediaSource})});
  }

  async function configureKit(dual) {
    $('continueConfig').disabled = true;
    setStatus($('configStatus'), 'Preparando a próxima página…', 'loading');
    try {
      const configured = await configureMedia({content_type:'kit', dual_scene:Boolean(dual), transcription_mode:transcriptionValue()});
      window.location.assign(configured.next_url || '/wave');
    } catch (error) {
      setStatus($('configStatus'), error.message, 'error');
      $('continueConfig').disabled = false;
    }
  }

  async function continueConfiguration() {
    if (typeValue() === 'music') {
      $('continueConfig').disabled = true;
      setStatus($('configStatus'), 'Preparando o Wave Editor da música…', 'loading');
      try {
        const configured = await configureMedia({content_type:'music', dual_scene:false, transcription_mode:transcriptionValue()});
        window.location.assign(configured.next_url || '/wave');
      } catch (error) {
        setStatus($('configStatus'), error.message, 'error');
        $('continueConfig').disabled = false;
      }
      return;
    }
    const dual = $('dualScene').checked;
    if (dual && !ptIsValid) {
      $('ptModal').showModal();
      setTimeout(() => $('ptUrl').focus(), 50);
      return;
    }
    await configureKit(dual);
  }

  async function acceptPtAndContinue() {
    if (!ptIsValid) return;
    $('acceptPt').disabled = true;
    try {
      const configured = await configureMedia({content_type:'kit', dual_scene:true, transcription_mode:transcriptionValue()});
      $('ptModal').close();
      window.location.assign(configured.next_url || '/wave');
    } catch (error) {
      setStatus($('ptStatus'), error.message, 'error');
      $('acceptPt').disabled = !ptIsValid;
    }
  }

  function bindWave(data, cut) {
    if (!window.MSGWaveEditor) return;
    const sourceVideo = $('sourceVideo');
    sourceVideo.src = `${data.media_url}?v=${Date.now()}`;
    const cutStart = Number(cut?.start_ms ?? 0);
    const cutEnd = Number(cut?.end_ms ?? Math.min(Number(data.duration_ms) || 30000, 30000));
    $('startTime').value = fmt(cutStart);
    $('endTime').value = fmt(cutEnd);
    if (!rangeEditor) {
      rangeEditor = new window.MSGWaveEditor.RangeEditor({
        stage:$('globalWaveStage'), canvas:$('globalWaveCanvas'), video:sourceVideo,
        startInput:$('startTime'), endInput:$('endTime'), durationMs:Number(data.duration_ms)||1, peaks:data.waveform||[],
        durationLabel:$('durationLabel'),
        onChange:({start,end}) => { $('durationLabel').textContent = `${((end-start)/1000).toFixed(3)}s`; },
        onError:(error) => setStatus($('cutMessage'), error.message, 'error')
      });
    } else {
      rangeEditor.setData({peaks:data.waveform||[], durationMs:Number(data.duration_ms)||1});
    }
    rangeEditor.setRange(cutStart, cutEnd, {silent:true});
    sourceVideo.addEventListener('timeupdate', () => { $('playheadLabel').textContent = fmt(Math.round((sourceVideo.currentTime||0)*1000)); }, {passive:true});
  }

  async function renderWaveStatus() {
    const state = await api('/api/state');
    renderNavState(state);
    const wave = state.wave || {};
    const status = wave.status || 'idle';
    const pct = Math.max(0, Math.min(100, Number(wave.percent)||0));
    $('wavePreparePercent').textContent = `${pct}%`;
    $('wavePrepareBar').style.width = `${pct}%`;
    $('wavePrepareText').textContent = wave.message || 'Preparando…';
    $('wavePrepareDetail').textContent = wave.error || (status === 'ready' ? 'Vídeo EN e waveform carregados.' : 'O vídeo é preparado apenas uma vez para esta fonte.');

    if (status === 'failed') {
      $('waveStageChip').textContent = 'ERRO';
      $('waveStageChip').classList.remove('ready');
      $('wavePrepareDetail').style.color = '#ff8b78';
      clearInterval(wavePoll); wavePoll = 0;
      return;
    }
    if (status === 'ready') {
      $('waveStageChip').textContent = 'PRONTO';
      $('waveStageChip').classList.add('ready');
      $('wavePreparing').hidden = true;
      $('waveWorkspace').hidden = false;
      bindWave(wave, state.cut || {});
      clearInterval(wavePoll); wavePoll = 0;
    }
  }

  function startWavePolling() {
    $('wavePreparing').hidden = false;
    $('waveWorkspace').hidden = true;
    renderWaveStatus().catch((e) => { $('wavePrepareDetail').textContent = e.message; });
    if (!wavePoll) wavePoll = setInterval(() => renderWaveStatus().catch(()=>{}), 700);
  }

  async function restoreSource() {
    const state = await api('/api/state');
    renderNavState(state);
    if (state.en?.url) $('enUrl').value = state.en.url;
    if (state.en?.validated && state.en?.embeddable) {
      $('enTitle').textContent = state.en.title || 'Vídeo EN validado';
      $('enValidatedUrl').textContent = state.en.url;
      $('enValidated').hidden = false;
      setStatus($('enStatus'), '✓ URL válida e vídeo incorporável. Podemos prosseguir.', 'success');
      if (topState) topState.textContent = 'fonte EN validada';
    }
  }

  async function restoreConfig() {
    const state = await api('/api/state');
    renderNavState(state);
    const en = state.en || {};
    $('sourceSummary').innerHTML = `<span class="mini-kicker">FONTE EN VALIDADA</span><b>${escapeHtml(en.title || 'Vídeo EN')}</b><code>${escapeHtml(en.url || '')}</code>`;
    if (state.wave?.source_kind === 'manual') {
      document.querySelector('input[name="mediaSource"][value="manual"]').checked = true;
      $('manualVideoHint').textContent = 'Vídeo enviado anteriormente. Selecione outro arquivo apenas para substituí-lo.';
    }
    $('manualVideo').addEventListener('change', () => {
      if ($('manualVideo').files.length) document.querySelector('input[name="mediaSource"][value="manual"]').checked = true;
    });
    const cfg = state.configuration || {};
    if (cfg.content_type) document.querySelector(`input[name="contentType"][value="${cfg.content_type}"]`)?.click();
    document.querySelector(`input[name="transcriptionMode"][value="${cfg.transcription_mode || 'external'}"]`)?.click();
    $('dualScene').checked = Boolean(cfg.dual_scene);
    if (state.pt?.url) $('ptUrl').value = state.pt.url;
    ptIsValid = Boolean(state.pt?.validated && state.pt?.embeddable);
    if (ptIsValid) {
      $('ptValidated').hidden = false;
      $('ptTitle').textContent = state.pt.title || 'Fonte PT validada';
      $('acceptPt').disabled = false;
      setStatus($('ptStatus'), '✓ URL PT válida e vídeo incorporável.', 'success');
    }
    updateContentTypeUI();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  async function restoreWave() {
    const state = await api('/api/state');
    renderNavState(state);
    if (topState) topState.textContent = state.configuration?.content_type === 'music' ? 'music · trecho de 30s ou mais' : (state.configuration?.dual_scene ? 'kit · DualScene' : 'kit · cena');
    document.body.classList.toggle('music-flow', state.configuration?.content_type === 'music');
    if (state.configuration?.content_type === 'music') {
      if ($('waveHeroTitle')) $('waveHeroTitle').textContent = 'Defina o trecho da música';
      if ($('waveHeroCopy')) $('waveHeroCopy').textContent = 'Selecione pelo menos 30 segundos, sem limite máximo além da duração do vídeo. Somente este microtrecho seguirá para lyrics, WbW e HUB.';
      if ($('wavePanelCopy')) $('wavePanelCopy').textContent = 'Ajuste IN e OUT do microtrecho musical. Mínimo 30s · máximo 60s.';
    }
    startWavePolling();
  }


  function processIcon(kind) {
    if (kind === 'audio') return 'WAV';
    if (kind === 'json') return '{ }';
    return 'MP4';
  }

  function renderProcessState(proc) {
    const status = String(proc?.status || 'idle');
    const percent = Math.max(0, Math.min(100, Number(proc?.percent) || 0));
    if ($('processPercent')) $('processPercent').textContent = `${percent}%`;
    if ($('processBar')) $('processBar').style.width = `${percent}%`;
    if ($('processMessage')) $('processMessage').textContent = proc?.message || 'Aguardando…';
    if ($('processStageChip')) {
      $('processStageChip').textContent = status === 'ready' ? 'PRONTO' : status === 'failed' ? 'ERRO' : 'PROCESSANDO';
      $('processStageChip').classList.toggle('ready', status === 'ready');
    }

    const logs = Array.isArray(proc?.logs) ? proc.logs : [];
    const logBox = $('processLogs');
    if (logBox) {
      if (!logs.length) {
        logBox.innerHTML = '<div class="log-empty">Aguardando o primeiro evento do pipeline…</div>';
      } else {
        logBox.innerHTML = logs.map((item) => {
          const time = String(item.at || '').split('T')[1]?.replace(/\+.*/, '') || '--:--:--';
          const level = escapeHtml(item.level || 'info');
          return `<div class="log-line ${level}"><time>${escapeHtml(time)}</time><span>${escapeHtml(item.message || '')}</span></div>`;
        }).join('');
        logBox.scrollTop = logBox.scrollHeight;
      }
    }

    const artifacts = Array.isArray(proc?.artifacts) ? proc.artifacts : [];
    const list = $('artifactList');
    if (list) {
      if (!artifacts.length) {
        list.innerHTML = '<div class="artifact-empty"><b>Nenhum arquivo disponível ainda.</b><span>Os arquivos aparecem aqui assim que cada etapa termina.</span></div>';
      } else {
        list.innerHTML = artifacts.map((item) => `
          <a class="artifact-card" href="${escapeHtml(item.download_url || '#')}" download>
            <span class="artifact-icon">${escapeHtml(processIcon(item.kind))}</span>
            <span class="artifact-copy"><b>${escapeHtml(item.name || 'arquivo')}</b><small>${escapeHtml(item.description || '')}</small></span>
            <span class="artifact-meta">${escapeHtml(item.size_label || '')}<strong>↓</strong></span>
          </a>`).join('');
      }
    }
    if ($('processError')) {
      const error = String(proc?.error || '');
      $('processError').hidden = !error;
      $('processError').textContent = error;
    }
    if (topState) topState.textContent = status === 'ready' ? 'mídia pronta' : status === 'failed' ? 'erro no processamento' : `${percent}% · processando`;
    if ($('processNext')) $('processNext').hidden = status !== 'ready';
    if ($('processNext') && proc?.next_url) { $('processNext').href = proc.next_url; if (proc.next_url === '/cue-review') $('processNext').textContent = 'Continuar edição do JSON →'; }
    if ($('processAgain')) {
      $('processAgain').hidden = status !== 'ready' && status !== 'failed';
      if (status === 'ready' || status === 'failed') {
        $('processAgain').disabled = false;
        $('processAgain').textContent = 'Processar novamente';
      }
    }
    if (status === 'ready' || status === 'failed') {
      clearInterval(processPoll); processPoll = 0;
    }
  }

  async function pollProcess() {
    const proc = await api('/api/process/status');
    renderProcessState(proc);
  }

  async function restoreProcess() {
    const state = await api('/api/state');
    renderNavState(state);
    renderProcessState({...state.process, next_url: state.resume_after_media || ((state.imported_final || state.media_refresh_preserve_reviews) ? (state.configuration?.dual_scene ? '/dual-scene' : '/cue-review') : '/external-ai')});
    const status = String(state.process?.status || 'idle');
    if (status === 'idle') {
      await api('/api/process/start', {method:'POST'});
      await pollProcess();
    }
    if (!['ready','failed'].includes(String((await api('/api/process/status')).status || ''))) {
      if (!processPoll) processPoll = setInterval(() => pollProcess().catch(()=>{}), 550);
    }
  }


  function externalIcon(kind) {
    if (kind === 'audio') return 'WAV';
    if (kind === 'text') return 'TXT';
    if (kind === 'zip') return 'ZIP';
    return '{ }';
  }

  function renderExternalArtifacts(external) {
    const artifacts = Array.isArray(external?.artifacts) ? external.artifacts : [];
    const box = $('externalArtifacts');
    if (!box) return;
    if (!artifacts.length) {
      box.innerHTML = '<div class="artifact-empty"><b>Preparando pacote…</b><span>Gerando JSON canônico, instruções e ZIP.</span></div>';
      return;
    }
    box.innerHTML = artifacts.map((item) => `
      <a class="external-artifact-card" href="${escapeHtml(item.download_url || '#')}" download>
        <span class="artifact-icon">${escapeHtml(externalIcon(item.kind))}</span>
        <span class="artifact-copy"><b>${escapeHtml(item.name || 'arquivo')}</b><small>${escapeHtml(item.description || '')}</small></span>
        <span class="artifact-meta">${escapeHtml(item.size_label || '')}<strong>↓</strong></span>
      </a>`).join('');
  }

  function renderExternalValidation(external) {
    const validated = Boolean(external?.validated);
    const error = String(external?.error || '');
    if ($('externalStageChip')) {
      $('externalStageChip').textContent = validated ? 'VALIDADO' : (external?.status === 'invalid' ? 'REVISAR JSON' : 'PRONTO');
      $('externalStageChip').classList.toggle('ready', validated || external?.status === 'prepared');
    }
    if ($('externalValidationError')) {
      $('externalValidationError').hidden = !error;
      $('externalValidationError').textContent = error;
    }
    if ($('externalValidationSuccess')) {
      $('externalValidationSuccess').hidden = !validated;
      if (validated) {
        const summary = external.validation_summary || {};
        $('externalValidatedFile').textContent = external.returned_filename || 'external_ai_return.json';
        $('externalValidatedSummary').textContent = `${summary.cues || 0} cues · ${summary.words || 0} words · ${summary.pt_groups || 0} grupos PT · snapshot ${summary.snapshot_id || external.snapshot_id || ''}`;
      }
    }
    if ($('externalNext')) { $('externalNext').disabled = !validated; $('externalNext').textContent = validated ? 'Revisar cues →' : 'Revisar cues →'; }
    if (validated) {
      $('externalDropTitle').textContent = '✓ Retorno validado';
      $('externalDropSubtitle').textContent = 'Você pode arrastar outro JSON para substituir e validar novamente.';
      if (topState) topState.textContent = 'JSON externo validado';
    }
  }

  async function prepareExternal() {
    const data = await api('/api/external-ai/prepare', {method:'POST'});
    const external = data.external_ai || {};
    renderExternalArtifacts(external);
    renderExternalValidation(external);
    if ($('externalPrepareError')) $('externalPrepareError').hidden = true;
    return external;
  }

  async function importExternalFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name || '')) throw new Error('Selecione um arquivo .json.');
    const drop = $('externalDropZone');
    drop?.classList.add('is-loading');
    $('externalDropTitle').textContent = 'Validando JSON…';
    $('externalDropSubtitle').textContent = file.name;
    if ($('externalValidationError')) $('externalValidationError').hidden = true;
    try {
      // Preserve the original JSON text exactly as selected by the user.
      // Parsing + re-stringifying in JavaScript normalizes numeric lexemes
      // (e.g. 3.0 -> 3), which can falsely change protected field types.
      const raw = await file.text();
      try { JSON.parse(raw); } catch (_) { throw new Error('O arquivo não contém JSON válido.'); }
      const res = await fetch(`/api/external-ai/import?filename=${encodeURIComponent(file.name || 'external_ai_return.json')}`, {
        method:'POST',
        headers:{'Content-Type':'application/json; charset=utf-8'},
        body:raw
      });
      let data = {};
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Falha na validação (HTTP ${res.status}).`);
      renderExternalArtifacts(data.external_ai || {});
      renderExternalValidation(data.external_ai || {});
      $('externalDropTitle').textContent = '✓ JSON aceito';
      $('externalDropSubtitle').textContent = `${file.name} · pronto para a próxima etapa`;
    } finally {
      drop?.classList.remove('is-loading');
    }
  }

  let cueReviewData = null;
  let cueAIOriginal = {approved_en:'', pt:''};
  let cueSavedCurrent = {approved_en:'', pt:''};
  let cueWasAccepted = false;
  let cueInvalidationSent = false;
  let cueInvalidationPromise = null;
  let cueActiveOrder = 1;
  let cueActiveStartMs = 0;
  let cueActiveEndMs = 1;
  let cueReviewContextMenu = null;
  let cueReviewFullPlayback = false;
  let cueReviewPlaybackFrame = 0;
  let fineSplitWaveform = null;
  let fineSplitPointMs = 0;
  let fineSplitOrder = 0;
  let fineSplitDragging = false;
  let fineSplitPreviewEndMs = 0;
  let fineSplitSeekFrame = 0;
  let fineSplitWords = [];
  let fineSplitWordIndex = 1;

  function cueParseTime(value) {
    const text = String(value || '').trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
    const match = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!match) throw new Error('Use HH:MM:SS.mmm, MM:SS.mmm ou segundos.');
    return (Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(String(match[4] || '0').padEnd(3, '0'));
  }

  function cueReviewChanged() {
    if (!$('cueEnglish') || !$('cuePortuguese')) return false;
    return String($('cueEnglish').value || '') !== String(cueAIOriginal.approved_en || '')
      || String($('cuePortuguese').value || '') !== String(cueAIOriginal.pt || '');
  }

  function updateRestoreCueButton() {
    const button = $('restoreAICue');
    if (!button) return;
    button.hidden = !cueReviewChanged();
  }

  function cueCurrentDiffersFromSaved() {
    return String($('cueEnglish')?.value || '') !== String(cueSavedCurrent.approved_en || '')
      || String($('cuePortuguese')?.value || '') !== String(cueSavedCurrent.pt || '');
  }

  function markCuePendingLocally() {
    cueWasAccepted = false;
    $('cueReviewStatusChip').textContent = 'PENDENTE';
    $('cueReviewStatusChip').classList.remove('ready');
    if ($('cueReviewComplete')) $('cueReviewComplete').hidden = true;
    if ($('cueReviewNextWrap')) $('cueReviewNextWrap').hidden = true;
    if ($('cueReviewNext')) $('cueReviewNext').disabled = true;
    document.querySelectorAll('[data-gated="word-review"]').forEach((a) => a.classList.add('is-disabled'));
    document.querySelectorAll('[data-gated="cue-timing"]').forEach((a) => a.classList.add('is-disabled'));
    document.querySelectorAll('[data-gated="word-timing"]').forEach((a) => a.classList.add('is-disabled'));
  }

  async function invalidateAcceptedCueOnEdit() {
    updateRestoreCueButton();
    if (!cueWasAccepted || cueInvalidationSent || !cueCurrentDiffersFromSaved()) return;
    cueInvalidationSent = true;
    markCuePendingLocally();
    setStatus($('cueReviewMessage'), 'Texto alterado · cue voltou para PENDENTE. Salve novamente para liberar o WbW.', '');
    cueInvalidationPromise = api('/api/cue-review/invalidate', {method:'POST', body:JSON.stringify({order:cueActiveOrder})});
    try {
      const data = await cueInvalidationPromise;
      renderCueReviewSidebar(data.review || {});
    } catch (error) {
      cueInvalidationSent = false;
      setStatus($('cueReviewMessage'), error.message, 'error');
    } finally {
      cueInvalidationPromise = null;
    }
  }

  function renderCueReviewSidebar(review) {
    cueReviewData = review;
    if ($('cueAcceptedCount')) $('cueAcceptedCount').textContent = String(review.accepted || 0);
    if ($('cuePendingCount')) $('cuePendingCount').textContent = String(review.pending || 0);
    if ($('cueReviewProgress')) $('cueReviewProgress').textContent = `${review.accepted || 0}/${review.total || 0}`;
    if ($('cueVideoWindow')) $('cueVideoWindow').textContent = `Janela YouTube no JSON: ${fmt(Number(review.playback_start_ms || 0))} → ${fmt(Number(review.playback_end_ms || 0))}. As cues mantêm os próprios tempos.`;
    const list = $('cueReviewList');
    if (!list) return;
    const items = Array.isArray(review.items) ? review.items : [];
    list.innerHTML = items.map((item) => {
      const status = item.status === 'accepted' ? 'accepted' : 'pending';
      const statusLabel = status === 'accepted' ? 'ACEITA' : 'PENDENTE';
      return `<button class="cue-review-list-item ${status}${Number(item.order) === Number(cueActiveOrder) ? ' active' : ''}" type="button" data-cue-order="${Number(item.order)}">
        <span class="cue-list-order">${String(Number(item.order)).padStart(2,'0')}</span>
        <span class="cue-list-copy">${escapeHtml(item.label || 'Cue')}</span>
        <span class="cue-list-status">${statusLabel}</span>
      </button>`;
    }).join('');
    list.querySelectorAll('[data-cue-order]').forEach((button) => button.addEventListener('click', () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      loadCueReviewCue(Number(button.dataset.cueOrder), {autoplay:true}).catch((error) => setStatus($('cueReviewMessage'), error.message, 'error'));
    }));
    list.querySelectorAll('[data-cue-order]').forEach((button) => button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openCueReviewContextMenu(event, Number(button.dataset.cueOrder));
    }));
  }

  function applyCueReviewCue(cue) {
    cueActiveOrder = Number(cue.order) || 1;
    cueAIOriginal = {
      approved_en: String(cue.ai?.approved_en || ''),
      pt: String(cue.ai?.pt || '')
    };
    cueSavedCurrent = {
      approved_en: String(cue.current?.approved_en || ''),
      pt: String(cue.current?.pt || '')
    };
    cueWasAccepted = Boolean(cue.accepted);
    cueInvalidationSent = false;
    cueInvalidationPromise = null;
    cueActiveStartMs = Number(cue.start_ms || 0);
    cueActiveEndMs = Number(cue.end_ms || Math.max(cueActiveStartMs + 1, 1));
    cueReviewFullPlayback = false;
    cancelAnimationFrame(cueReviewPlaybackFrame);
    $('cueEnglish').value = cueSavedCurrent.approved_en;
    $('cuePortuguese').value = cueSavedCurrent.pt;
    if ($('cueReviewIn')) $('cueReviewIn').value = fmt(cueActiveStartMs);
    if ($('cueReviewOut')) $('cueReviewOut').value = fmt(cueActiveEndMs);
    $('cueReviewTitle').textContent = `Cue ${String(cueActiveOrder).padStart(2,'0')}`;
    $('cueReviewStatusChip').textContent = cue.accepted ? 'ACEITA' : 'PENDENTE';
    $('cueReviewStatusChip').classList.toggle('ready', Boolean(cue.accepted));
    $('saveCueReview').textContent = cueReviewData?.total === cueActiveOrder ? 'Salvar cue →' : 'Salvar e próxima →';
    setStatus($('cueReviewMessage'), cue.accepted ? 'Cue já validada. Você pode editar e salvar novamente.' : 'Revise EN e PT e clique em Salvar.', cue.accepted ? 'success' : '');
    updateRestoreCueButton();
    if (cueReviewData) renderCueReviewSidebar(cueReviewData);
    const video = $('cueReviewVideo');
    if (video) {
      video.pause();
      video.currentTime = cueActiveStartMs / 1000;
      if ($('cueVideoState')) $('cueVideoState').textContent = `Cue atual · ${fmt(cueActiveStartMs)} → ${fmt(cueActiveEndMs)}`;
      if (cue.autoplay) video.play().catch(() => {});
    }
  }

  async function loadCueReviewCue(order, options={}) {
    const data = await api(`/api/cue-review/cue/${Number(order)}`);
    const cue = data.cue || {};
    cue.autoplay = Boolean(options.autoplay);
    if (cueReviewData) cueReviewData.cue = cue;
    applyCueReviewCue(cue);
  }

  async function restoreCueReviewPage(options={}) {
    const state = await api('/api/state');
    renderNavState(state);
    const data = await api('/api/cue-review/state');
    const review = data.review || {};
    cueActiveOrder = Number(review.current_order) || 1;
    renderCueReviewSidebar(review);
    if ($('cueReviewComplete')) $('cueReviewComplete').hidden = !review.completed;
    if ($('cueReviewNextWrap')) $('cueReviewNextWrap').hidden = !review.completed;
    if ($('cueReviewNext')) $('cueReviewNext').disabled = !review.completed;
    if (review.completed && topState) topState.textContent = 'cues validadas';
    if (options.loadCue !== false) await loadCueReviewCue(cueActiveOrder);
    return review;
  }

  async function saveCueReview() {
    const button = $('saveCueReview');
    try {
      button.disabled = true;
      button.textContent = 'Salvando…';
      if (cueInvalidationPromise) await cueInvalidationPromise;
      const data = await api('/api/cue-review/save', {
        method:'POST',
        body:JSON.stringify({
          order:cueActiveOrder,
          approved_en:String($('cueEnglish').value || ''),
          pt:String($('cuePortuguese').value || ''),
          start_ms:cueParseTime($('cueReviewIn').value),
          end_ms:cueParseTime($('cueReviewOut').value)
        })
      });
      const review = await restoreCueReviewPage({loadCue:false});
      setStatus($('cueReviewMessage'), `✓ Cue ${String(data.saved_order).padStart(2,'0')} validada.`, 'success');
      if (data.completed || review.completed) {
        $('cueReviewComplete').hidden = false;
        if ($('cueReviewNextWrap')) $('cueReviewNextWrap').hidden = false;
        if ($('cueReviewNext')) $('cueReviewNext').disabled = false;
        $('saveCueReview').textContent = '✓ Cue salva';
        setTimeout(() => $('cueReviewComplete').scrollIntoView({behavior:'smooth', block:'center'}), 80);
        return;
      }
      await loadCueReviewCue(Number(data.next_order));
    } finally {
      button.disabled = false;
      if (!cueReviewData?.completed) button.textContent = cueReviewData?.total === cueActiveOrder ? 'Salvar cue →' : 'Salvar e próxima →';
    }
  }

  function restoreCueFromAI() {
    $('cueEnglish').value = cueAIOriginal.approved_en;
    $('cuePortuguese').value = cueAIOriginal.pt;
    invalidateAcceptedCueOnEdit();
    setStatus($('cueReviewMessage'), 'Valores da IA restaurados. Clique em Salvar para validá-los.', 'success');
    $('cueEnglish').focus();
  }

  async function deleteCueReview() {
    if ((Number(cueReviewData?.total) || 0) <= 1) throw new Error('Não é possível excluir a única cue restante.');
    const preview = String($('cueEnglish')?.value || '').trim();
    const confirmed = window.confirm(`Excluir a Cue ${String(cueActiveOrder).padStart(2,'0')}?\n\n${preview}\n\nOs tempos das outras cues não serão modificados.`);
    if (!confirmed) return;
    const button = $('deleteCueReview');
    button.disabled = true;
    button.textContent = 'Excluindo…';
    try {
      const data = await api('/api/cue-review/delete', {method:'POST', body:JSON.stringify({order:cueActiveOrder})});
      const review = data.review || {};
      cueReviewData = review;
      cueActiveOrder = Number(review.current_order) || 1;
      renderCueReviewSidebar(review);
      applyCueReviewCue(review.cue || {});
      if ($('cueReviewComplete')) $('cueReviewComplete').hidden = !review.completed;
      if ($('cueReviewNextWrap')) $('cueReviewNextWrap').hidden = !review.completed;
      if ($('cueReviewNext')) $('cueReviewNext').disabled = !review.completed;
      setStatus($('cueReviewMessage'), `✓ Cue excluída. ${review.total || 0} cues restantes; timings preservados.`, 'success');
    } finally {
      button.disabled = false;
      button.textContent = 'Excluir cue';
    }
  }

  async function createCueAfterPlayhead() {
    const video = $('cueReviewVideo');
    const startMs = Math.max(0, Math.round(Number(video?.currentTime || 0) * 1000));
    const next = (cueReviewData?.items || []).find(item => Number(item.order) === cueActiveOrder + 1);
    const durationMs = Math.round(Number(video?.duration || 0) * 1000);
    const endMs = Math.min(Number(next?.start_ms || durationMs || startMs + 2000), startMs + 2000);
    if (endMs <= startMs) throw new Error('Posicione o playhead em um espaço válido para criar a cue.');
    const data = await api('/api/cue-review/create', {method:'POST', body:JSON.stringify({after_order:cueActiveOrder,start_ms:startMs,end_ms:endMs})});
    cueReviewData = data.review || {};
    renderCueReviewSidebar(cueReviewData);
    applyCueReviewCue(cueReviewData.cue || {});
    $('cueEnglish').focus();
    setStatus($('cueReviewMessage'), 'Nova cue criada. Preencha EN/PT, ajuste IN/OUT e salve.', 'success');
  }

  async function createCueRelative(order, direction) {
    const items = Array.isArray(cueReviewData?.items) ? cueReviewData.items : [];
    const index = items.findIndex(item => Number(item.order) === Number(order));
    if (index < 0) throw new Error('Cue não encontrada.');
    const current = items[index], previous = items[index - 1], next = items[index + 1];
    let afterOrder, startMs, endMs;
    if (direction === 'before') {
      afterOrder = Math.max(0, Number(order) - 1);
      endMs = Number(current.start_ms);
      startMs = Math.max(Number(previous?.end_ms || 0), endMs - 2000);
    } else {
      afterOrder = Number(order);
      startMs = Number(current.end_ms);
      endMs = Math.min(Number(next?.start_ms || Math.round(Number($('cueReviewVideo')?.duration || 0) * 1000)), startMs + 2000);
    }
    if (!(endMs > startMs)) throw new Error('Não existe espaço temporal livre nesse lado da cue. Use o playhead para criar e depois ajuste IN/OUT.');
    const data = await api('/api/cue-review/create', {method:'POST', body:JSON.stringify({after_order:afterOrder,start_ms:startMs,end_ms:endMs})});
    cueReviewData = data.review || {};
    renderCueReviewSidebar(cueReviewData);
    applyCueReviewCue(cueReviewData.cue || {});
    $('cueEnglish').focus();
  }

  async function mergeCueReview(order, direction) {
    const data = await api('/api/cue-review/merge', {method:'POST', body:JSON.stringify({order:Number(order),direction})});
    cueReviewData = data.review || {};
    renderCueReviewSidebar(cueReviewData);
    applyCueReviewCue(cueReviewData.cue || {});
    setStatus($('cueReviewMessage'), `✓ Cues unidas. Revise o texto combinado e salve novamente.`, 'success');
  }

  function drawFineSplitWave() {
    const stage = $('fineSplitWaveStage'), canvas = $('fineSplitWaveCanvas');
    if (!stage || !canvas) return;
    const dpr = window.devicePixelRatio || 1, width = Math.max(320, stage.clientWidth), height = 150;
    canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr); ctx.fillStyle='#06100c'; ctx.fillRect(0,0,width,height);
    const peaks = fineSplitWaveform?.waveform || [], duration = Number(fineSplitWaveform?.duration_ms || 1), span = Math.max(1, cueActiveEndMs-cueActiveStartMs);
    ctx.strokeStyle='#54a082'; ctx.lineWidth=1; ctx.beginPath();
    for(let x=0;x<width;x++){ const ms=cueActiveStartMs+x/width*span, idx=Math.max(0,Math.min(peaks.length-1,Math.floor(ms/duration*peaks.length))), amp=Number(peaks[idx]||0), y=height/2-amp*(height*.4); x ? ctx.lineTo(x,y) : ctx.moveTo(x,y); }
    ctx.stroke(); ctx.strokeStyle='#1e4938'; ctx.beginPath(); ctx.moveTo(0,height/2); ctx.lineTo(width,height/2); ctx.stroke();
    const markerX=(fineSplitPointMs-cueActiveStartMs)/span*width;
    ctx.fillStyle='rgba(65,230,164,.07)';ctx.fillRect(0,0,markerX,height);ctx.fillStyle='rgba(255,81,72,.08)';ctx.fillRect(markerX,0,width-markerX,height);
    ctx.strokeStyle='#ff5148'; ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(markerX,18); ctx.lineTo(markerX,height); ctx.stroke();
    ctx.fillStyle='#ff5148'; ctx.beginPath(); ctx.arc(markerX,18,12,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='#3a0806'; ctx.lineWidth=3; ctx.stroke();
    $('fineSplitTime').textContent=fmt(fineSplitPointMs);
  }

  function renderFineSplitWords() {
    const root=$('fineSplitWords');if(!root)return;
    root.innerHTML=fineSplitWords.map((word,index)=>`<span class="fine-split-word ${index<fineSplitWordIndex?'before':''} ${index===fineSplitWordIndex-1?'last-current':''} ${index===fineSplitWordIndex?'first-new':''}">${escapeHtml(word.text||'—')}</span>`).join('');
  }

  function fineSplitIndexAt(ms) {
    if(fineSplitWords.length<2)return 0;
    let best=1,bestDistance=Infinity;
    for(let index=1;index<fineSplitWords.length;index++){
      const previousEnd=Number(fineSplitWords[index-1]?.end_ms||fineSplitWords[index-1]?.start_ms||0),nextStart=Number(fineSplitWords[index]?.start_ms||previousEnd),boundary=(previousEnd+nextStart)/2,distance=Math.abs(boundary-ms);
      if(distance<bestDistance){best=index;bestDistance=distance;}
    }
    return best;
  }

  function showFineSplitBoundary() {
    if(fineSplitWords.length<2)return setStatus($('fineSplitMessage'),'Esta cue não possui palavras suficientes para uma quebra fina.','error');
    const before=fineSplitWords.slice(0,fineSplitWordIndex).map(word=>word.text).join(' '),after=fineSplitWords.slice(fineSplitWordIndex).map(word=>word.text).join(' ');
    setStatus($('fineSplitMessage'),`Corte temporal: ${fmt(fineSplitPointMs)} · texto provisório — Cue atual: ${before}  |  Nova cue: ${after}`,'');
  }

  function syncFineSplitVideo() {
    cancelAnimationFrame(fineSplitSeekFrame);
    fineSplitSeekFrame=requestAnimationFrame(()=>[$('fineSplitVideo'),$('cueReviewVideo')].forEach(video=>{if(video){video.pause();if(Math.abs(video.currentTime-fineSplitPointMs/1000)>.001)video.currentTime=fineSplitPointMs/1000;}}));
  }

  function moveFineSplitMarker(clientX) {
    const stage=$('fineSplitWaveStage'), rect=stage.getBoundingClientRect(), ratio=Math.max(0.002,Math.min(.998,(clientX-rect.left)/rect.width));
    fineSplitPointMs=Math.round(cueActiveStartMs+ratio*(cueActiveEndMs-cueActiveStartMs));
    const nextIndex=fineSplitIndexAt(fineSplitPointMs);if(nextIndex!==fineSplitWordIndex){fineSplitWordIndex=nextIndex;renderFineSplitWords();}
    syncFineSplitVideo();drawFineSplitWave();showFineSplitBoundary();
  }

  async function previewFineSplit() {
    const video=$('fineSplitVideo'); if(!video)return;
    const start=Math.max(cueActiveStartMs,fineSplitPointMs-1000);
    fineSplitPreviewEndMs=fineSplitPointMs;video.pause();video.currentTime=start/1000;
    if(video.seeking)await new Promise(resolve=>video.addEventListener('seeked',resolve,{once:true}));
    video.play().catch(error=>setStatus($('fineSplitMessage'),error.message,'error'));
  }

  async function openFineSplit(order) {
    if(Number(order)!==Number(cueActiveOrder)) await loadCueReviewCue(order);
    const cueData=await api(`/api/cue-review/cue/${Number(order)}`);
    fineSplitWords=Array.isArray(cueData.cue?.words)?cueData.cue.words:[];
    if(!fineSplitWaveform) fineSplitWaveform=await api('/api/cue-review/waveform');
    fineSplitOrder=Number(order); fineSplitPointMs=Math.round((cueActiveStartMs+cueActiveEndMs)/2);
    fineSplitWordIndex=fineSplitIndexAt(fineSplitPointMs);
    $('fineSplitTitle').textContent=`Separar Cue ${String(order).padStart(2,'0')}`;
    renderFineSplitWords();showFineSplitBoundary();$('fineSplitDialog').showModal(); requestAnimationFrame(drawFineSplitWave);
    const video=$('fineSplitVideo'); if(video){video.pause();video.currentTime=fineSplitPointMs/1000;}
    const mainVideo=$('cueReviewVideo'); if(mainVideo){mainVideo.pause();mainVideo.currentTime=fineSplitPointMs/1000;}
  }

  async function confirmFineSplit() {
    const button=$('fineSplitConfirm'); button.disabled=true;
    try {
      const data = await api('/api/cue-review/split', {method:'POST', body:JSON.stringify({order:fineSplitOrder,split_ms:fineSplitPointMs})});
      $('fineSplitVideo')?.pause(); fineSplitPreviewEndMs=0;
      $('fineSplitDialog').close();
      cueReviewData = data.review || {};
      renderCueReviewSidebar(cueReviewData);
      applyCueReviewCue(cueReviewData.cue || {});
      setStatus($('cueReviewMessage'), `✓ Cue quebrada exatamente em ${fmt(fineSplitPointMs)}. Agora você pode corrigir o texto das duas cues.`, 'success');
    } catch(error) { setStatus($('fineSplitMessage'),error.message,'error'); }
    finally { button.disabled=false; }
  }

  async function splitCueReview(order) {
    await openFineSplit(order);
  }

  function closeCueReviewContextMenu() {
    cueReviewContextMenu?.remove();
    cueReviewContextMenu = null;
  }

  function openCueReviewContextMenu(event, order) {
    closeCueReviewContextMenu();
    const menu = document.createElement('div');
    menu.className = 'cue-context-menu';
    const total = Number(cueReviewData?.total || 0);
    menu.innerHTML = `<button type="button" data-action="open">Abrir cue</button><button type="button" data-action="merge-previous" ${Number(order) <= 1 ? 'disabled' : ''}>Juntar com a anterior</button><button type="button" data-action="merge-next" ${Number(order) >= total ? 'disabled' : ''}>Juntar com a próxima</button><button type="button" data-action="split">Quebra de cue fina…</button><span></span><button type="button" data-action="before">+ Criar cue antes</button><button type="button" data-action="after">+ Criar cue depois</button><span></span><button type="button" data-action="video-start">Usar IN como início do vídeo</button><button type="button" data-action="video-end">Usar OUT como fim do vídeo</button><span></span><button type="button" class="danger" data-action="delete">Excluir cue</button>`;
    document.body.appendChild(menu);
    const width = 230, height = 420;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY))}px`;
    cueReviewContextMenu = menu;
    menu.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
      const action = button.dataset.action;
      closeCueReviewContextMenu();
      try {
        if (action === 'open') await loadCueReviewCue(order, {autoplay:true});
        else if (action === 'before' || action === 'after') await createCueRelative(order, action);
        else if (action === 'merge-previous') await mergeCueReview(order, 'previous');
        else if (action === 'merge-next') await mergeCueReview(order, 'next');
        else if (action === 'split') await splitCueReview(order);
        else {
          await loadCueReviewCue(order);
          if (action === 'delete') await deleteCueReview();
          else await setCueVideoWindow(action === 'video-start' ? 'start' : 'end');
        }
      } catch (error) { setStatus($('cueReviewMessage'), error.message, 'error'); }
    }));
  }

  async function setCueVideoWindow(kind) {
    const body = kind === 'start' ? {start_ms:cueParseTime($('cueReviewIn').value)} : {end_ms:cueParseTime($('cueReviewOut').value)};
    const data = await api('/api/cue-review/video-window', {method:'POST', body:JSON.stringify(body)});
    renderCueReviewSidebar(data.review || {});
    setStatus($('cueReviewMessage'), '✓ Janela do YouTube atualizada no JSON. Nenhuma cue foi rebased.', 'success');
  }


  let wordReviewData = null;
  let wordActiveCue = 1;
  let wordActiveIndex = 0;
  let wordActiveStartMs = 0;
  let wordActiveEndMs = 0;
  let wordReviewFullPlayback = false;

  function renderWordCueSidebar(review) {
    wordReviewData = review;
    if ($('wordAcceptedCount')) $('wordAcceptedCount').textContent = String(review.accepted_words || 0);
    if ($('wordPendingCount')) $('wordPendingCount').textContent = String(review.pending_words || 0);
    if ($('wordReviewProgress')) $('wordReviewProgress').textContent = `${review.accepted_words || 0}/${review.total_words || 0}`;
    const list = $('wordCueList');
    if (!list) return;
    const cues = Array.isArray(review.cues) ? review.cues : [];
    list.innerHTML = cues.map((cue) => {
      const status = cue.status === 'accepted' ? 'accepted' : 'pending';
      const statusLabel = status === 'accepted' ? 'ACEITA' : 'PENDENTE';
      const active = Number(cue.order) === Number(wordActiveCue) ? ' active' : '';
      return `<button class="word-cue-item ${status}${active}" type="button" data-word-cue-order="${Number(cue.order)}">
        <span class="cue-list-order">${String(Number(cue.order)).padStart(2,'0')}</span>
        <span class="word-cue-copy"><b>${escapeHtml(cue.label || 'Cue')}</b><small>${Number(cue.accepted || 0)}/${Number(cue.total || 0)} words</small></span>
        <span class="word-cue-status">${statusLabel}</span>
      </button>`;
    }).join('');
    list.querySelectorAll('[data-word-cue-order]').forEach((button) => button.addEventListener('click', () => {
      loadWordCue(Number(button.dataset.wordCueOrder)).catch((error) => setStatus($('wordReviewMessage'), error.message, 'error'));
    }));
  }

  function renderWordStrip(review) {
    const strip = $('wordStrip');
    if (!strip) return;
    const items = Array.isArray(review.word_items) ? review.word_items : [];
    strip.innerHTML = items.map((item) => {
      const active = Number(item.index) === Number(wordActiveIndex) ? ' active' : '';
      const accepted = item.status === 'accepted' ? ' accepted' : '';
      return `<button type="button" class="${accepted}${active}" data-word-index="${Number(item.index)}" title="Word ${Number(item.number)}">${escapeHtml(item.text || `#${Number(item.number)}`)}</button>`;
    }).join('');
    strip.querySelectorAll('[data-word-index]').forEach((button) => button.addEventListener('click', () => {
      loadWord(Number(wordActiveCue), Number(button.dataset.wordIndex)).catch((error) => setStatus($('wordReviewMessage'), error.message, 'error'));
    }));
  }

  function renderWordUnits(review) {
    const host = $('wordUnitEditor');
    if (!host) return;
    const currentMembers = new Set((review.word?.semantic_member_indices || [wordActiveIndex]).map(Number));
    const units = Array.isArray(review.unit_items) ? review.unit_items : [];
    host.innerHTML = units.map((unit) => {
      const members = (unit.member_indices || []).map(Number);
      const active = members.some((index) => currentMembers.has(index)) ? ' active' : '';
      const grouped = unit.is_group ? ' grouped' : '';
      const accepted = unit.status === 'accepted' ? ' accepted' : '';
      const pt = String(unit.pt || '').trim();
      return `<button type="button" class="word-unit-card${active}${grouped}${accepted}" data-unit-word-index="${Number(unit.lead_index)}">
        <span class="word-unit-kind">${unit.is_group ? 'GRUPO' : 'WORD'}</span>
        <b>${escapeHtml(unit.en || '—')}</b>
        <small>${escapeHtml(pt || 'PT pendente')}</small>
      </button>`;
    }).join('');
    host.querySelectorAll('[data-unit-word-index]').forEach((button) => button.addEventListener('click', () => {
      loadWord(Number(wordActiveCue), Number(button.dataset.unitWordIndex)).catch((error) => setStatus($('wordReviewMessage'), error.message, 'error'));
    }));
    host.querySelector('.active')?.scrollIntoView?.({block:'nearest', inline:'center'});
  }

  function applyWordReview(review) {
    wordReviewData = review;
    const word = review.word || {};
    wordActiveCue = Number(word.cue_order || review.current_cue_order || 1);
    wordActiveIndex = Number(word.word_index ?? review.current_word_index ?? 0);
    wordActiveStartMs = Number(word.start_ms || 0);
    wordActiveEndMs = Number(word.end_ms || Math.max(wordActiveStartMs + 1, 1));
    renderWordCueSidebar(review);
    renderWordStrip(review);
    renderWordUnits(review);
    if ($('wordEnglish')) $('wordEnglish').value = String(word.text || '');
    if ($('wordPortuguese')) $('wordPortuguese').value = String(word.pt || '');
    if ($('wordReviewTitle')) $('wordReviewTitle').textContent = `Cue ${String(wordActiveCue).padStart(2,'0')} · Word ${String(Number(word.word_number || wordActiveIndex + 1)).padStart(2,'0')}/${Number(word.words_in_cue || 0)}`;
    if ($('wordCueContext')) $('wordCueContext').textContent = `${word.cue_text || ''}${word.cue_pt ? ` · ${word.cue_pt}` : ''}`;
    if ($('wordTiming')) $('wordTiming').textContent = `${fmt(Number(word.start_ms || 0))} → ${fmt(Number(word.end_ms || 0))}`;
    const groupInfo = $('wordGroupInfo');
    if (groupInfo) {
      const group = word.group;
      groupInfo.hidden = !group;
      groupInfo.textContent = group ? `UNIDADE PT · ${group.members_text || group.id}` : '';
    }
    if ($('wordPtLabel')) $('wordPtLabel').textContent = word.group ? 'Tradução da unidade' : 'Tradução';
    if ($('groupWordPrevious')) $('groupWordPrevious').disabled = !word.can_group_previous;
    if ($('groupWordNext')) $('groupWordNext').disabled = !word.can_group_next;
    if ($('ungroupWord')) $('ungroupWord').disabled = !(word.group && Array.isArray(word.group.member_indices) && word.group.member_indices.length > 1);
    if ($('wordReviewStatusChip')) {
      $('wordReviewStatusChip').textContent = word.accepted ? 'ACEITA' : 'PENDENTE';
      $('wordReviewStatusChip').classList.toggle('ready', Boolean(word.accepted));
    }
    if ($('saveWordReview')) $('saveWordReview').textContent = review.completed ? '✓ Word salva' : 'Salvar e próxima →';
    if ($('wordReviewComplete')) $('wordReviewComplete').hidden = !review.completed;
    if ($('wordReviewNext')) $('wordReviewNext').disabled = !review.completed;
    setStatus($('wordReviewMessage'), word.accepted ? 'Word já validada. Você pode editar e salvar novamente.' : 'Revise a word e sua tradução e clique em Salvar.', word.accepted ? 'success' : '');
  }

  async function restoreWordReviewPage() {
    const state = await api('/api/state');
    renderNavState(state);
    const data = await api('/api/word-review/state');
    applyWordReview(data.review || {});
    if (data.review?.completed && topState) topState.textContent = 'words validadas';
    return data.review || {};
  }

  async function loadWordCue(order) {
    const data = await api(`/api/word-review/cue/${Number(order)}`);
    applyWordReview(data.review || {});
  }

  async function loadWord(cueOrder, wordIndex) {
    const data = await api(`/api/word-review/word/${Number(cueOrder)}/${Number(wordIndex)}`);
    applyWordReview(data.review || {});
  }

  async function saveWordReview() {
    const button = $('saveWordReview');
    try {
      button.disabled = true;
      button.textContent = 'Salvando…';
      const data = await api('/api/word-review/save', {
        method:'POST',
        body:JSON.stringify({
          cue_order:wordActiveCue,
          word_index:wordActiveIndex,
          text:String($('wordEnglish').value || ''),
          pt:String($('wordPortuguese').value || '')
        })
      });
      const state = await api('/api/word-review/state');
      applyWordReview(state.review || {});
      if (data.completed || state.review?.completed) {
        if (topState) topState.textContent = 'words validadas';
        setStatus($('wordReviewMessage'), '✓ 100% das words e traduções foram validadas.', 'success');
        setTimeout(() => $('wordReviewComplete')?.scrollIntoView({behavior:'smooth', block:'center'}), 80);
        return;
      }
      setStatus($('wordReviewMessage'), `✓ Word ${Number(data.saved?.word_index ?? 0) + 1} validada.`, 'success');
    } finally {
      button.disabled = false;
      if (!wordReviewData?.completed) button.textContent = 'Salvar e próxima →';
    }
  }

  async function restructureWordReview(action, direction='next') {
    const current = wordReviewData?.word || {};
    const dirty = String($('wordEnglish')?.value || '') !== String(current.text || '')
      || String($('wordPortuguese')?.value || '') !== String(current.pt || '');
    if (dirty) throw new Error('Salve a edição atual antes de agrupar ou desagrupar.');
    const isUngroup = action === 'ungroup';
    const endpoint = isUngroup ? '/api/word-review/ungroup' : '/api/word-review/group';
    const buttons = [$('groupWordPrevious'), $('ungroupWord'), $('groupWordNext')].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const body = {cue_order:wordActiveCue, word_index:wordActiveIndex};
      if (!isUngroup) body.direction = direction;
      const data = await api(endpoint, {method:'POST', body:JSON.stringify(body)});
      applyWordReview(data.review || {});
      setStatus($('wordReviewMessage'), isUngroup
        ? '✓ Unidade desagrupada. Cada word voltou a ter sua própria tradução; revise os campos pendentes.'
        : '✓ Unidades agrupadas. Revise a tradução da nova unidade e salve.', 'success');
      if ($('wordReviewComplete')) $('wordReviewComplete').hidden = true;
      if ($('wordReviewNext')) $('wordReviewNext').disabled = true;
    } finally {
      const word = wordReviewData?.word || {};
      if ($('groupWordPrevious')) $('groupWordPrevious').disabled = !word.can_group_previous;
      if ($('groupWordNext')) $('groupWordNext').disabled = !word.can_group_next;
      if ($('ungroupWord')) $('ungroupWord').disabled = !(word.group && Array.isArray(word.group.member_indices) && word.group.member_indices.length > 1);
    }
  }

  async function restoreExternal() {
    const state = await api('/api/state');
    renderNavState(state);
    try {
      const external = await prepareExternal();
      renderExternalValidation(external);
    } catch (error) {
      if ($('externalPrepareError')) {
        $('externalPrepareError').hidden = false;
        $('externalPrepareError').textContent = error.message;
      }
      throw error;
    }
  }

  if (page === 'source') {
    $('validateEn').addEventListener('click', () => validateSource('en'));
    $('enUrl').addEventListener('input', () => {
      clearTimeout(enDebounce);
      $('enValidated').hidden = true;
      enDebounce = setTimeout(() => validateSource('en'), 850);
    });
    restoreSource().catch(() => {});
  }

  if (page === 'config') {
    document.querySelectorAll('input[name="contentType"]').forEach((input) => input.addEventListener('change', updateContentTypeUI));
    $('continueConfig').addEventListener('click', continueConfiguration);
    $('validatePt').addEventListener('click', () => validateSource('pt'));
    $('ptForm').addEventListener('submit', (event) => { event.preventDefault(); validateSource('pt'); });
    $('closePtModal').addEventListener('click', () => $('ptModal').close());
    $('cancelPtModal').addEventListener('click', () => $('ptModal').close());
    $('ptUrl').addEventListener('input', () => {
      clearTimeout(ptDebounce);
      ptIsValid = false;
      $('acceptPt').disabled = true;
      $('ptValidated').hidden = true;
      ptDebounce = setTimeout(() => validateSource('pt'), 850);
    });
    $('acceptPt').addEventListener('click', acceptPtAndContinue);
    restoreConfig().catch((error) => setStatus($('configStatus'), error.message, 'error'));
  }


  if (page === 'external-ai') {
    const zone = $('externalDropZone');
    const input = $('externalFileInput');
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
      importExternalFile(input.files?.[0]).catch((error) => {
        $('externalValidationError').hidden = false;
        $('externalValidationError').textContent = error.message;
        $('externalDropTitle').textContent = 'JSON recusado';
        $('externalDropSubtitle').textContent = 'Corrija o arquivo e tente novamente.';
      });
      input.value = '';
    });
    ['dragenter','dragover'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add('is-dragging'); }));
    ['dragleave','drop'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove('is-dragging'); }));
    zone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      importExternalFile(file).catch((error) => {
        $('externalValidationError').hidden = false;
        $('externalValidationError').textContent = error.message;
        $('externalDropTitle').textContent = 'JSON recusado';
        $('externalDropSubtitle').textContent = 'Corrija o arquivo e tente novamente.';
      });
    });
    if ($('externalNext')) $('externalNext').addEventListener('click', () => { if (!$('externalNext').disabled) window.location.assign('/cue-review'); });
    restoreExternal().catch(() => {});
  }


  if (page === 'cue-review') {
    const fineStage=$('fineSplitWaveStage');
    fineStage?.addEventListener('pointerdown',(event)=>{fineSplitDragging=true;fineStage.setPointerCapture(event.pointerId);moveFineSplitMarker(event.clientX);});
    fineStage?.addEventListener('pointermove',(event)=>{if(fineSplitDragging)moveFineSplitMarker(event.clientX);});
    fineStage?.addEventListener('pointerup',(event)=>{fineSplitDragging=false;fineStage.releasePointerCapture(event.pointerId);});
    fineStage?.addEventListener('click',(event)=>moveFineSplitMarker(event.clientX));
    fineStage?.addEventListener('keydown',(event)=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();fineSplitPointMs=Math.max(cueActiveStartMs+1,Math.min(cueActiveEndMs-1,fineSplitPointMs+(event.key==='ArrowLeft'?-10:10)));fineSplitWordIndex=fineSplitIndexAt(fineSplitPointMs);syncFineSplitVideo();renderFineSplitWords();drawFineSplitWave();showFineSplitBoundary();});
    $('fineSplitConfirm')?.addEventListener('click',confirmFineSplit);
    $('fineSplitPreview')?.addEventListener('click',previewFineSplit);
    $('fineSplitVideo')?.addEventListener('timeupdate',()=>{const video=$('fineSplitVideo');if(!video?.paused&&fineSplitPreviewEndMs&&video.currentTime*1000>=fineSplitPreviewEndMs){video.pause();video.currentTime=fineSplitPointMs/1000;fineSplitPreviewEndMs=0;}});
    const closeFineSplit=()=>{$('fineSplitVideo')?.pause();fineSplitPreviewEndMs=0;$('fineSplitDialog').close();};
    $('fineSplitCancel')?.addEventListener('click',closeFineSplit);
    $('fineSplitClose')?.addEventListener('click',closeFineSplit);
    window.addEventListener('resize',()=>{if($('fineSplitDialog')?.open)drawFineSplitWave();});
    document.addEventListener('pointerdown', (event) => { if (cueReviewContextMenu && !event.target.closest('.cue-context-menu')) closeCueReviewContextMenu(); });
    document.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && cueReviewContextMenu) { closeCueReviewContextMenu(); return; }
      if(event.code==='Space'&&$('fineSplitDialog')?.open){event.preventDefault();const video=$('fineSplitVideo');if(!video)return;if(!video.paused){video.pause();fineSplitPreviewEndMs=0;}else if(event.shiftKey){fineSplitPreviewEndMs=0;video.play().catch(()=>{});}else previewFineSplit();return;}
      if (event.ctrlKey || event.metaKey || event.altKey || (event.repeat && event.code !== 'KeyG')) return;
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(target.tagName));
      if (editing) return;
      if (event.code === 'Space') {
        event.preventDefault();
        const video = $('cueReviewVideo');
        if (!video) return;
        if (!video.paused) { video.pause(); cueReviewFullPlayback=false; }
        else if (event.shiftKey) { cueReviewFullPlayback=true; video.play().catch((error) => setStatus($('cueReviewMessage'), `Não foi possível reproduzir: ${error.message}`, 'error')); }
        else { cueReviewFullPlayback=false; video.currentTime=cueActiveStartMs/1000; video.play().catch((error) => setStatus($('cueReviewMessage'), `Não foi possível reproduzir: ${error.message}`, 'error')); }
      } else if (event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (!$('saveCueReview')?.disabled) saveCueReview().catch((error) => setStatus($('cueReviewMessage'), error.message, 'error'));
      }
    });
    $('cueEnglish').addEventListener('input', () => invalidateAcceptedCueOnEdit());
    $('cuePortuguese').addEventListener('input', () => invalidateAcceptedCueOnEdit());
    $('restoreAICue').addEventListener('click', restoreCueFromAI);
    $('deleteCueReview')?.addEventListener('click', () => deleteCueReview().catch((error) => setStatus($('cueReviewMessage'), error.message, 'error')));
    $('createCueAfter')?.addEventListener('click', () => createCueAfterPlayhead().catch((error) => setStatus($('cueReviewMessage'), error.message, 'error')));
    $('videoStartAtCue')?.addEventListener('click', () => setCueVideoWindow('start').catch((error) => setStatus($('cueReviewMessage'), error.message, 'error')));
    $('videoEndAtCue')?.addEventListener('click', () => setCueVideoWindow('end').catch((error) => setStatus($('cueReviewMessage'), error.message, 'error')));
    $('cueInAtPlayhead')?.addEventListener('click', () => {
      const ms = Math.round(Number($('cueReviewVideo')?.currentTime || 0) * 1000);
      $('cueReviewIn').value = fmt(ms); cueActiveStartMs = ms;
    });
    $('cueOutAtPlayhead')?.addEventListener('click', () => {
      const ms = Math.round(Number($('cueReviewVideo')?.currentTime || 0) * 1000);
      $('cueReviewOut').value = fmt(ms); cueActiveEndMs = ms;
    });
    $('cueReviewIn')?.addEventListener('change', () => { try { cueActiveStartMs = cueParseTime($('cueReviewIn').value); $('cueReviewVideo').currentTime = cueActiveStartMs / 1000; } catch (error) { setStatus($('cueReviewMessage'), error.message, 'error'); } });
    $('cueReviewOut')?.addEventListener('change', () => { try { cueActiveEndMs = cueParseTime($('cueReviewOut').value); $('cueReviewVideo').currentTime = cueActiveEndMs / 1000; } catch (error) { setStatus($('cueReviewMessage'), error.message, 'error'); } });
    $('cueReviewVideo')?.addEventListener('loadedmetadata', () => {
      const state = $('cueVideoState');
      if (state) { state.textContent = 'Vídeo pronto'; state.className = 'cue-video-state ready'; }
    });
    $('cueReviewVideo')?.addEventListener('error', () => {
      const state = $('cueVideoState');
      const error = $('cueReviewVideo')?.error;
      if (state) { state.textContent = `Não foi possível abrir o vídeo${error?.message ? ` · ${error.message}` : ''}`; state.className = 'cue-video-state error'; }
    });
    $('cueReviewVideo')?.addEventListener('timeupdate', () => {
      const video = $('cueReviewVideo');
      if (!cueReviewFullPlayback && !video?.paused && cueActiveEndMs > cueActiveStartMs && video.currentTime * 1000 >= cueActiveEndMs) { video.pause(); video.currentTime = cueActiveEndMs / 1000; }
    });
    $('cueReviewVideo')?.addEventListener('play', () => {
      const video = $('cueReviewVideo');
      cancelAnimationFrame(cueReviewPlaybackFrame);
      const watchCueEnd = () => {
        if (!video || video.paused || cueReviewFullPlayback) return;
        if (cueActiveEndMs > cueActiveStartMs && video.currentTime * 1000 >= cueActiveEndMs - 8) {
          video.pause();
          video.currentTime = cueActiveEndMs / 1000;
          return;
        }
        cueReviewPlaybackFrame = requestAnimationFrame(watchCueEnd);
      };
      if (!cueReviewFullPlayback) cueReviewPlaybackFrame = requestAnimationFrame(watchCueEnd);
    });
    $('cueReviewVideo')?.addEventListener('pause', () => cancelAnimationFrame(cueReviewPlaybackFrame));
    if ($('cueReviewVideo')?.readyState >= 1 && $('cueVideoState')) {
      $('cueVideoState').textContent = 'Vídeo pronto';
      $('cueVideoState').className = 'cue-video-state ready';
    }
    $('saveCueReview').addEventListener('click', () => saveCueReview().catch((error) => setStatus($('cueReviewMessage'), error.message, 'error')));
    if ($('cueReviewNext')) $('cueReviewNext').addEventListener('click', () => { if (!$('cueReviewNext').disabled) window.location.assign('/word-review'); });
    restoreCueReviewPage().then((review) => { if ($('cueReviewNext')) $('cueReviewNext').disabled = !review.completed; }).catch((error) => setStatus($('cueReviewMessage'), error.message, 'error'));
  }

  if (page === 'word-review') {
    document.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.repeat && event.code !== 'KeyG')) return;
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(target.tagName));
      if (editing) return;
      if (event.code === 'Space') {
        event.preventDefault();
        const video = $('wordReviewVideo');
        if (!video) return;
        if (!video.paused) { video.pause(); wordReviewFullPlayback=false; }
        else if (event.shiftKey) { wordReviewFullPlayback=true; video.play().catch((error) => setStatus($('wordReviewMessage'), `Não foi possível reproduzir: ${error.message}`, 'error')); }
        else { wordReviewFullPlayback=false; video.currentTime=wordActiveStartMs/1000; video.play().catch((error) => setStatus($('wordReviewMessage'), `Não foi possível reproduzir: ${error.message}`, 'error')); }
      } else if (event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (!$('saveWordReview')?.disabled) saveWordReview().catch((error) => setStatus($('wordReviewMessage'), error.message, 'error'));
      }
    });
    $('wordReviewVideo')?.addEventListener('timeupdate',()=>{const video=$('wordReviewVideo');if(!wordReviewFullPlayback&&!video?.paused&&wordActiveEndMs>wordActiveStartMs&&video.currentTime*1000>=wordActiveEndMs){video.pause();video.currentTime=wordActiveEndMs/1000;}});
    if ($('wordReviewNext')) $('wordReviewNext').addEventListener('click', () => { if (!$('wordReviewNext').disabled) window.location.assign('/cue-timing'); });
    $('saveWordReview').addEventListener('click', () => saveWordReview().catch((error) => setStatus($('wordReviewMessage'), error.message, 'error')));
    $('groupWordPrevious')?.addEventListener('click', () => restructureWordReview('group','previous').catch((error) => setStatus($('wordReviewMessage'), error.message, 'error')));
    $('groupWordNext')?.addEventListener('click', () => restructureWordReview('group','next').catch((error) => setStatus($('wordReviewMessage'), error.message, 'error')));
    $('ungroupWord')?.addEventListener('click', () => restructureWordReview('ungroup').catch((error) => setStatus($('wordReviewMessage'), error.message, 'error')));
    restoreWordReviewPage().catch((error) => setStatus($('wordReviewMessage'), error.message, 'error'));
  }


  if (page === 'process') {
    $('processAgain')?.addEventListener('click', async () => {
      const button = $('processAgain');
      button.disabled = true;
      button.textContent = 'Reprocessando…';
      try {
        const data = await api('/api/process/start?force=true', {method:'POST'});
        renderProcessState(data.process || {});
        if (!processPoll) processPoll = setInterval(() => pollProcess().catch(()=>{}), 550);
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Processar novamente';
        setStatus($('processError'), error.message, 'error');
      }
    });
    restoreProcess().catch((error) => renderProcessState({status:'failed',percent:100,message:'Falha ao carregar processamento.',error:error.message,logs:[]}));
  }

  if (page === 'wave') {
    $('markIn').addEventListener('click', () => { try { rangeEditor?.setInFromPlayhead(); } catch(e) { setStatus($('cutMessage'),e.message,'error'); } });
    $('markOut').addEventListener('click', () => { try { rangeEditor?.setOutFromPlayhead(); } catch(e) { setStatus($('cutMessage'),e.message,'error'); } });
    $('playSelection').addEventListener('click', () => rangeEditor?.playSelection().catch((e)=>setStatus($('cutMessage'),e.message,'error')));
    $('saveCut').addEventListener('click', async () => {
      const button = $('saveCut');
      try {
        if (!rangeEditor) throw new Error('O Wave Editor ainda não está pronto.');
        button.disabled = true;
        button.textContent = 'Salvando e iniciando…';
        const {start,end} = rangeEditor.getRange();
        const data = await api('/api/cut/save', {method:'POST', body:JSON.stringify({start_ms:start,end_ms:end})});
        if (data.media_reused) {
          setStatus($('cutMessage'), `✓ ${data.message} · ${fmt(start)} → ${fmt(end)}`, 'success');
          if (topState) topState.textContent = 'mídia reaproveitada';
        } else {
          setStatus($('cutMessage'), `✓ ${data.message} · ${fmt(start)} → ${fmt(end)} · iniciando processamento…`, 'success');
          await api('/api/process/start', {method:'POST'});
          if (topState) topState.textContent = 'processamento iniciado';
        }
        window.location.assign('/process');
      } catch(e) {
        button.disabled = false;
        button.textContent = 'Salvar recorte e continuar →';
        setStatus($('cutMessage'),e.message,'error');
      }
    });
    restoreWave().catch((error) => { $('wavePrepareDetail').textContent = error.message; });
  }
})();
