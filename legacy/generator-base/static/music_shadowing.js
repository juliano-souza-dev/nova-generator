(() => {
  const choice = document.getElementById('musicShadowingChoice');
  const toggle = document.getElementById('musicShadowingEnabled');
  fetch('/api/state').then(r => r.json()).then(state => {
    choice.hidden = state.configuration?.content_type !== 'music';
    toggle.checked = state.configuration?.shadowing_enabled !== false;
  });
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      const response = await fetch('/api/music/shadowing', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enabled:toggle.checked})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Não foi possível salvar.');
      location.assign(result.next_url);
    } catch (error) {
      toggle.checked = !toggle.checked;
      document.getElementById('musicShadowingChoiceStatus').textContent = error.message;
      toggle.disabled = false;
    }
  });
})();
