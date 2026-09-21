(() => {
  const $ = (id) => document.getElementById(id);

  const showError = (message) => {
    const box = $('connectedValidationError');
    if (box) { box.hidden = false; box.textContent = message; }
    $('connectedImportChip').textContent = 'JSON INVÁLIDO';
    $('connectedImportChip').classList.remove('ready');
    $('topState').textContent = 'Corrija o retorno';
  };

  const renderValidated = (data, filename) => {
    const summary = data.summary || {};
    const types = summary.types || {};
    const typeText = Object.entries(types).filter(([, count]) => Number(count) > 0).map(([type, count]) => `${type}: ${count}`).join(' · ');
    $('connectedImportChip').textContent = 'VALIDADO';
    $('connectedImportChip').classList.add('ready');
    $('topState').textContent = 'JSON validado';
    $('connectedValidationError').hidden = true;
    $('connectedValidationSuccess').hidden = false;
    $('connectedValidatedFile').textContent = filename || 'connected_speech_return.json';
    $('connectedValidatedSummary').textContent = `${summary.cues || 0} cues · ${summary.phenomena || 0} fenômenos${typeText ? ` · ${typeText}` : ''}`;
    $('connectedDropTitle').textContent = '✓ Retorno validado';
    $('connectedDropSubtitle').textContent = 'A conferência manual já está liberada.';
    $('connectedReviewNext').disabled = false;
  };

  async function importFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name || '')) return showError('Selecione um arquivo .json.');
    const drop = $('connectedDropZone');
    drop.classList.add('is-loading');
    $('connectedDropTitle').textContent = 'Validando Connected Speech…';
    $('connectedDropSubtitle').textContent = file.name;
    $('connectedValidationError').hidden = true;
    try {
      const raw = await file.text();
      try { JSON.parse(raw); } catch (_) { throw new Error('O arquivo não contém JSON válido.'); }
      const response = await fetch(`/api/connected-speech/import?filename=${encodeURIComponent(file.name || 'connected_speech_return.json')}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json; charset=utf-8'},
        body: raw,
      });
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Falha na validação (HTTP ${response.status}).`);
      renderValidated(data, file.name);
      window.setTimeout(() => { window.location.href = data.next_url || '/connected-speech-review'; }, 650);
    } catch (error) {
      showError(error.message || String(error));
      $('connectedDropTitle').textContent = 'JSON recusado';
      $('connectedDropSubtitle').textContent = file.name;
    } finally {
      drop.classList.remove('is-loading');
    }
  }

  const drop = $('connectedDropZone');
  const input = $('connectedFileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => importFile(input.files?.[0]));
  ['dragenter','dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('is-dragging'); }));
  ['dragleave','drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('is-dragging'); }));
  drop.addEventListener('drop', (event) => importFile(event.dataTransfer?.files?.[0]));
  $('connectedReviewNext').addEventListener('click', () => { window.location.href = '/connected-speech-review'; });

  fetch('/api/connected-speech/state')
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      const connected = data?.connected_speech;
      if (connected?.validated) renderValidated({summary: connected.validation_summary || {}}, connected.returned_filename || 'connected_speech_return.json');
    })
    .catch(() => {});
})();
