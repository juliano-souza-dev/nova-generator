(() => {
  "use strict";

  const mobile = window.matchMedia("(max-width: 767px)");
  const shortcutMap = {
    "cue-review": [["Espaço", "reproduzir cue"], ["Shift + Espaço", "contínuo do ponto atual"], ["G", "salvar e avançar"], ["Botão direito", "ações da cue"]],
    "word-review": [["Espaço", "reproduzir word/grupo"], ["Shift + Espaço", "contínuo do ponto atual"], ["G", "salvar e avançar"]],
    "cue-timing": [["Espaço", "reproduzir cue"], ["Shift + Espaço", "contínuo do ponto atual"], ["G", "salvar e avançar"], ["Ctrl + R", "realinhar"], ["← / →", "velocidade"], ["A / S", "marcar IN / OUT"], ["Ctrl + Z", "desfazer"]],
    "word-timing": [["Espaço", "reproduzir word"], ["Shift + Espaço", "contínuo do ponto atual"], ["G", "salvar e avançar"], ["Ctrl + R", "realinhar"], ["← / →", "velocidade"], ["A / S", "marcar IN / OUT"], ["Ctrl + Enter", "testar da cue"], ["Ctrl + Shift + Enter", "testar do início"]],
    "shadowing": [["Espaço", "reproduzir trecho"], ["Shift + Espaço", "contínuo do ponto atual"], ["A", "IN do trecho"], ["S", "OUT do trecho"], ["G", "adicionar pausa"]],
  };

  function installShortcutHelp() {
    const actions = document.querySelector(".top-actions");
    if (!actions || actions.querySelector(".shortcut-help")) return;
    const page = document.body.dataset.page || "";
    const rows = shortcutMap[page] || [["—", "Esta etapa não possui atalhos específicos"]];
    const host = document.createElement("div");
    host.className = "shortcut-help";
    host.innerHTML = `<button class="shortcut-help-trigger" type="button" aria-label="Atalhos desta etapa" aria-describedby="shortcutHelpPanel">?</button><div id="shortcutHelpPanel" class="shortcut-help-panel" role="tooltip"><b>ATALHOS · ESTA ETAPA</b>${rows.map(([key,label]) => `<span><kbd>${key}</kbd><em>${label}</em></span>`).join("")}</div>`;
    actions.prepend(host);
  }

  function centerActiveStage() {
    if (!mobile.matches) return;
    const nav = document.querySelector(".flow-nav");
    const active = nav?.querySelector("a.active");
    if (!nav || !active) return;
    const left = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: "auto" });
  }

  function init() {
    installShortcutHelp();
    centerActiveStage();
    window.addEventListener("orientationchange", centerActiveStage, { passive: true });
    if (typeof mobile.addEventListener === "function") {
      mobile.addEventListener("change", centerActiveStage);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

// music-without-shadowing-navigation
fetch('/api/state').then(response => response.json()).then(state => {
  if (state.configuration?.content_type === 'music' && state.configuration?.shadowing_enabled === false) {
    document.querySelectorAll('.flow-nav a[href="/shadowing"]').forEach(link => { link.hidden = true; });
  }
}).catch(() => {});

// Optional video editor: outside the required review sequence.
(() => {
  const install = () => {
    const host = document.querySelector('.top-actions');
    if (!host || host.querySelector('[href="/editor"]')) return;
    const link = document.createElement('a');
    link.href = '/editor'; link.className = 'btn btn-outline';
    link.textContent = 'Editor de vídeo'; host.prepend(link);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
