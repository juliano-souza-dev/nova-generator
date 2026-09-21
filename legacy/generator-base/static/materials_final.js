(() => {
  const $ = (id) => document.getElementById(id);
  let poll = null;
  let autoStarted = false;
  let musicMode = false;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    return data;
  };


  async function applyMusicContext() {
    try {
      const state = await api('/api/state');
      const music = state?.configuration?.content_type === 'music';
      musicMode = music;
      document.body.classList.toggle('music-flow', music);
      if (!music) return;
      document.querySelectorAll('.flow-nav a').forEach(a => {
        const href = a.getAttribute('href');
        if (['/connected-speech','/connected-speech-import','/connected-speech-review'].includes(href)) a.hidden = true;
        const number = a.querySelector('span');
        if (href === '/materials-external' && number) number.textContent = '11';
        if (href === '/materials-review' && number) number.textContent = '12';
        if (href === '/materials-final' && number) number.textContent = '13';
      });
      const eyebrow = document.querySelector('.page-hero .eyebrow');
      if (eyebrow) eyebrow.textContent = 'ETAPA 13 · GROQ TTS + RENDERIZAÇÃO LOCAL';
      const stageNumber = document.querySelector('.stage-panel:not(#tiktokPanel) .stage-number');
      if (stageNumber) stageNumber.textContent = '13';
      const hero = document.querySelector('.page-hero p');
      if (hero) hero.textContent = 'A Groq gera somente TTS dos cards aprovados. O Generator cria o JSON Music do HUB, Anki, áudios e o pacote final. Os vídeos são produzidos no editor integrado.';
    } catch (_) {}
  }

  const groups = [
    ['hub', 'JSON do HUB', 'Arquivo final para importar no Admin do ImmersionHub.'],
    ['anki', 'Anki', 'Deck sem áudio e deck com TTS aprovado.'],
    ['tts', 'Áudios TTS', 'Pacote WAV e manifest técnico gerados pela Groq.'],
    ['package', 'Pacote completo', 'ZIP com os materiais finais e o JSON do HUB.'],
    ['other', 'Outros arquivos', 'Artefatos auxiliares da geração final.'],
  ];

  function artifactGroup(item) {
    if (item.group) return String(item.group);
    const kind = String(item.kind || '').toLowerCase();
    if (kind === 'hub_json') return 'hub';
    if (kind === 'pdf') return 'pdf';
    if (kind === 'apkg') return 'anki';
    if (kind === 'zip' && item.name === 'materials_final.zip') return 'package';
    if (kind === 'zip' || kind === 'json') return 'tts';
    return 'other';
  }

  function kindLabel(item) {
    const kind = String(item.kind || 'FILE').toLowerCase();
    if (kind === 'hub_json') return 'JSON HUB';
    if (kind === 'apkg') return 'APKG';
    return kind.toUpperCase();
  }

  function artifactCard(item) {
    return `<a class="material-artifact-card" href="${esc(item.download_url)}">
      <span>${esc(kindLabel(item))}</span>
      <div><b>${esc(item.name)}</b><small>${esc(item.size_label || '')}</small></div>
      <i>↓</i>
    </a>`;
  }

  function renderArtifacts(items) {
    const byGroup = new Map(groups.map(([key]) => [key, []]));
    for (const item of items || []) {
      const key = artifactGroup(item);
      (byGroup.get(key) || byGroup.get('other')).push(item);
    }
    $('finalArtifacts').innerHTML = groups.map(([key, title, description]) => {
      const rows = byGroup.get(key) || [];
      if (!rows.length) return '';
      return `<section class="final-artifact-section final-artifact-${esc(key)}">
        <header class="final-artifact-head">
          <div><span>${esc(key === 'hub' ? 'PUBLICAÇÃO' : 'ARQUIVOS')}</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>
          <b>${rows.length}</b>
        </header>
        <div class="final-artifact-grid">${rows.map(artifactCard).join('')}</div>
      </section>`;
    }).join('');
  }

  function renderRecovery(items) {
    const failures = (items || []).filter((item) => item && ['word_timing', 'wbw_practice'].includes(item.recovery?.type));
    const box = $('finalRecovery');
    if (!box) return;
    if (!failures.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = failures.map((item) => {
      const recovery = item.recovery || {};
      if (recovery.type === 'wbw_practice') {
        const cue = Number(recovery.cue_order || 0);
        const position = Number(recovery.practice_index || 0);
        const expression = recovery.expression_en || `Prática ${position}`;
        const range = `${Number(recovery.practice_start_ms || 0)}–${Number(recovery.practice_end_ms || 0)} ms`;
        return `<section class="final-recovery-card">
          <div>
            <span>PRÁTICA WbW FORA DA CUE</span>
            <h3>Cue ${esc(cue)} · “${esc(expression)}”</h3>
            <p>Intervalo salvo: <b>${esc(range)}</b>. A cue foi modificada depois da criação desta prática.</p>
            <small>Confira o timing da cue ou remova somente esta prática opcional do JSON final.</small>
          </div>
          <div class="final-recovery-actions">
            <a class="btn btn-primary btn-lg" href="${esc(recovery.fix_url || '/word-timing')}">Ir até a cue →</a>
            <button class="btn btn-outline" type="button" data-retry-recovery>Tentar novamente</button>
            <button class="btn btn-outline" type="button" data-ignore-practice="${esc(position)}">Ignorar e remover prática</button>
          </div>
        </section>`;
      }
      const cue = Number(recovery.cue_order || 0);
      const position = Number(recovery.word_position || 0);
      const text = recovery.word_text || 'word';
      const cueRange = `${Number(recovery.cue_start_ms || 0)}–${Number(recovery.cue_end_ms || 0)} ms`;
      const wordRange = `${Number(recovery.word_start_ms || 0)}–${Number(recovery.word_end_ms || 0)} ms`;
      return `<section class="final-recovery-card">
        <div>
          <span>WbW TIMING PRECISA DE CORREÇÃO</span>
          <h3>Cue ${esc(cue)} · posição ${esc(position)} · “${esc(text)}”</h3>
          <p>Cue: <b>${esc(cueRange)}</b> · Word: <b>${esc(wordRange)}</b></p>
          <small>Corrija a unidade no editor WbW. O Generator não altera timing automaticamente.</small>
        </div>
        <a class="btn btn-primary btn-lg" href="${esc(recovery.fix_url || '/word-timing')}">Corrigir no WbW Timing →</a>
      </section>`;
    }).join('');
  }

  function render(data) {
    const job = data.materials || {};
    const status = String(job.status || 'idle');
    const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
    $('finalPercent').textContent = `${percent}%`;
    $('finalBar').style.width = `${percent}%`;
    $('finalMessage').textContent = job.message || 'Aguardando…';
    $('finalChip').textContent = status === 'ready' ? 'PRONTO' : status === 'partial' ? 'PARCIAL' : status === 'running' ? 'GERANDO' : status === 'failed' ? 'ERRO' : 'AGUARDANDO';
    $('finalChip').classList.toggle('ready', status === 'ready');
    $('finalChip').classList.toggle('partial', status === 'partial');
    $('finalLogs').textContent = (job.logs || []).join('\n') || 'Aguardando…';
    $('finalError').hidden = !job.error;
    $('finalError').textContent = job.error || '';
    $('finalStart').disabled = status === 'running';
    $('finalRetryFailed').disabled = status === 'running';
    $('finalRetryFailed').hidden = !['partial', 'failed'].includes(status) || !(job.failed_items || []).some((item) => item && item.id && item.id !== 'pipeline');
    renderRecovery(job.failed_items || []);
    renderArtifacts((job.artifacts || []).filter(item => !['dual_scene','tiktok_media','music_video','shadowing_video'].includes(item.group) && item.kind !== 'mp4'));

    if (status === 'running' && !poll) poll = setInterval(load, 700);
    if (status !== 'running' && poll) {
      clearInterval(poll);
      poll = null;
    }
    if (status === 'idle' && !autoStarted && !musicMode) {
      autoStarted = true;
      start();
    }
  }

  async function load() {
    try {
      render(await api('/api/materials-final/state'));
    } catch (error) {
      $('finalError').hidden = false;
      $('finalError').textContent = error.message;
    }
  }

  async function retryFailed() {
    try {
      render(await api('/api/materials-final/retry-failed', { method: 'POST', body: '{}' }));
      if (!poll) poll = setInterval(load, 700);
    } catch (error) {
      $('finalError').hidden = false;
      $('finalError').textContent = error.message;
    }
  }

  async function start() {
    try {
      render(await api('/api/materials-final/start', { method: 'POST', body: '{}' }));
      if (!poll) poll = setInterval(load, 700);
    } catch (error) {
      $('finalError').hidden = false;
      $('finalError').textContent = error.message;
    }
  }

  $('finalRecovery')?.addEventListener('click', async (event) => {
    const ignore = event.target.closest('[data-ignore-practice]');
    const retry = event.target.closest('[data-retry-recovery]');
    if (!ignore && !retry) return;
    event.preventDefault();
    try {
      if (ignore) {
        render(await api('/api/materials-final/wbw-practice/ignore', {
          method: 'POST',
          body: JSON.stringify({ practice_index: Number(ignore.dataset.ignorePractice || 0) }),
        }));
      } else {
        await retryFailed();
      }
      if (!poll) poll = setInterval(load, 700);
    } catch (error) {
      $('finalError').hidden = false;
      $('finalError').textContent = error.message;
    }
  });

  $('finalRetryFailed').addEventListener('click', retryFailed);
  $('finalStart').addEventListener('click', start);
  applyMusicContext().finally(load);
})();
