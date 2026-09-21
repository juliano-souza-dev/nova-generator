(() => {
  const $ = (id) => document.getElementById(id);
  const key = $('groqApiKey'), ttsModel = $('groqTtsModel'), voice = $('groqVoice');
  const loadBtn = $('groqLoadModels'), saveBtn = $('groqSave'), chip = $('groqConfigChip'), status = $('groqConfigStatus');
  const continueBtn = $('continueConfig');
  let ready = false;
  let hasSavedKey = false;
  let inspectedKey = '';
  const params = new URLSearchParams(window.location.search);
  const requestedReturnTo = String(params.get('return_to') || '').trim();
  const allowedReturnTargets = new Set(['/materials-external','/materials-final']);
  const returnTo = allowedReturnTargets.has(requestedReturnTo) ? requestedReturnTo : '';

  const setStatus = (text, tone='') => {
    status.textContent = text;
    status.className = `inline-status page-status${tone ? ` ${tone}` : ''}`;
  };
  const readError = async (response, fallback) => {
    let data={}; try { data=await response.json(); } catch (_) {}
    return data.detail || data.error || fallback;
  };
  const setReady = (value, text='') => {
    ready = Boolean(value); window.MSG_GROQ_READY = ready;
    chip.textContent = ready ? 'GROQ READY' : 'GROQ REQUIRED';
    chip.classList.toggle('ready', ready);
    if (text) setStatus(text, ready ? 'success' : 'error');
  };

  function fillModels(payload) {
    const models = Array.isArray(payload.models) ? payload.models : [];
    const tts = models.filter((item) => item.active !== false && String(item.id || '').toLowerCase().includes('orpheus'));
    $('groqTtsModelList').innerHTML = tts.map((item) => `<option value="${String(item.id).replace(/"/g,'&quot;')}"></option>`).join('');
    if (!ttsModel.value && tts[0]) ttsModel.value = tts[0].id;
    return {tts:tts.length};
  }

  async function loadSettings() {
    const response = await fetch('/api/ai/settings', {cache:'no-store'});
    if (!response.ok) throw new Error(await readError(response, 'Falha ao ler configurações Groq.'));
    const settings = (await response.json()).settings || {};
    hasSavedKey = Boolean(settings.has_api_key);
    ttsModel.value = settings.tts_model || 'canopylabs/orpheus-v1-english';
    voice.value = settings.tts_voice || 'hannah';
    key.value = '';
    key.placeholder = hasSavedKey ? '••••••••••••••  (chave salva)' : 'gsk_...';
    $('groqKeyHint').textContent = hasSavedKey ? 'Chave já configurada. Deixe vazio para manter.' : 'A chave salva nunca é devolvida ao navegador.';
    if (!hasSavedKey) { setReady(false, 'Cadastre a API key da Groq antes de prosseguir.'); return; }
    const check = await fetch('/api/ai/connection', {cache:'no-store'});
    if (!check.ok) { setReady(false, await readError(check, 'A configuração Groq não está válida.')); return; }
    setReady(true, '✓ Groq conectada. TTS e voz prontos.');
  }

  async function loadModels() {
    loadBtn.disabled = true; setStatus('Consultando modelos disponíveis na Groq…');
    try {
      const typed = key.value.trim();
      let response;
      if (typed) {
        response = await fetch('/api/ai/setup/inspect', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:typed})});
        if (response.ok) inspectedKey = typed;
      } else {
        response = await fetch('/api/ai/models', {cache:'no-store'});
      }
      if (!response.ok) throw new Error(await readError(response, 'Falha ao consultar modelos.'));
      const data = await response.json(); const count = fillModels(data);
      setStatus(`✓ ${count.tts} modelo(s) TTS disponível(is).`, 'success');
    } catch (error) { setReady(false, error.message); }
    finally { loadBtn.disabled = false; }
  }

  async function save() {
    saveBtn.disabled = true; setStatus('Salvando e validando Groq…');
    try {
      const typed = key.value.trim();
      if (!hasSavedKey && !typed) throw new Error('Informe a API key da Groq.');
      if (typed && inspectedKey !== typed) {
        const inspect = await fetch('/api/ai/setup/inspect', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:typed})});
        if (!inspect.ok) throw new Error(await readError(inspect, 'A API key não foi validada.'));
        inspectedKey = typed; fillModels(await inspect.json());
      }
      const response = await fetch('/api/ai/settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({tts_model:ttsModel.value.trim(),tts_voice:voice.value,api_key:typed || null})});
      if (!response.ok) throw new Error(await readError(response, 'Falha ao salvar e validar Groq.'));
      const saved = await response.json();
      const savedSettings = saved.settings || {};
      if (!savedSettings.ready) throw new Error(savedSettings.readiness_reason || 'A configuração foi salva, mas a Groq não ficou pronta.');
      hasSavedKey = true; key.value=''; key.placeholder='••••••••••••••  (chave salva)';
      setReady(true, '✓ Groq conectada e configuração salva.');
      if (returnTo) {
        setStatus('✓ Groq pronta. Voltando para a etapa atual…', 'success');
        window.setTimeout(() => window.location.assign(returnTo), 180);
      }
    } catch (error) { setReady(false, error.message); }
    finally { saveBtn.disabled = false; }
  }

  key.addEventListener('input', () => { inspectedKey=''; setReady(false, 'Chave alterada. Valide e salve novamente.'); });
  loadBtn.addEventListener('click', loadModels);
  saveBtn.addEventListener('click', save);
  continueBtn.addEventListener('click', (event) => {
    if (ready) return;
    event.preventDefault(); event.stopImmediatePropagation();
    setStatus('Valide a Groq antes de prosseguir para o Generator.', 'error');
    key.focus();
  }, true);
  loadSettings().catch((error) => setReady(false, error.message));
})();
