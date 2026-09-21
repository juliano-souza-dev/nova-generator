(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let review = null;
  let saveTimer = null;
  let saving = false;

  const api = async (url, options={}) => {
    const r = await fetch(url, {headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options});
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
    return d;
  };

  const pdfKeys = [];
  const activePdfKeys = () => pdfKeys;
  const decisionLabel = d => d === 'approved' ? 'APROVADO' : d === 'rejected' ? 'RECUSADO' : 'PENDENTE';

  function showError(message='') {
    $('reviewError').hidden = !message;
    $('reviewError').textContent = message;
  }

  function scheduleSave() {
    $('reviewSaveState').textContent = 'Salvando…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 350);
  }

  async function save() {
    if (!review || saving) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    saving = true;
    try {
      const data = await api('/api/materials-review/state', {method:'PUT', body:JSON.stringify(review)});
      review = data.review;
      renderSummary(data.summary, data.errors);
      $('reviewSaveState').textContent = 'Salvo';
    } catch (e) {
      showError(e.message);
      $('reviewSaveState').textContent = 'Erro ao salvar';
    } finally {
      saving = false;
    }
  }

  function setPdfDecision(key, decision) {
    review.pdfs[key].decision = decision;
    renderPdfs();
    renderSummary();
    scheduleSave();
  }

  function setCardDecision(index, decision, advance=false) {
    review.anki.items[index].decision = decision;
    const items = review.anki.items || [];
    let nextIndex = advance ? items.findIndex((card, position) => position > index && card.decision === 'pending') : -1;
    if (advance && nextIndex < 0) nextIndex = items.findIndex(card => card.decision === 'pending');
    renderAnki();
    renderSummary();
    scheduleSave();
    if (advance) requestAnimationFrame(() => {
      const target = nextIndex >= 0
        ? document.querySelector(`[data-card-index="${nextIndex}"]`)
        : $('reviewFinalize');
      target?.scrollIntoView({behavior:'smooth', block:'start'});
    });
  }

  function currentSummary() {
    const pdfVals = activePdfKeys().map(k => review?.pdfs?.[k]?.decision || 'pending');
    const cards = review?.anki?.items || [];
    return {
      pdf_total: pdfVals.length,
      pdf_pending: pdfVals.filter(x => x === 'pending').length,
      pdf_approved: pdfVals.filter(x => x === 'approved').length,
      pdf_rejected: pdfVals.filter(x => x === 'rejected').length,
      anki_total: cards.length,
      anki_pending: cards.filter(x => x.decision === 'pending').length,
      anki_approved: cards.filter(x => x.decision === 'approved').length,
      anki_rejected: cards.filter(x => x.decision === 'rejected').length,
    };
  }

  function renderSummary(summary=currentSummary(), errors=null) {
    if (!review) return;
    $('reviewSummary').innerHTML = `<div><b>${summary.anki_approved}/${summary.anki_total}</b><span>Anki aprovados</span></div><div><b>${summary.anki_rejected}</b><span>Recusados</span></div><div><b>${summary.anki_pending}</b><span>Pendentes</span></div>`;
    const pending = summary.pdf_pending + summary.anki_pending;
    $('reviewChip').textContent = review.status === 'approved' ? 'APROVADO' : pending ? 'REVISANDO' : 'PRONTO';
    $('reviewChip').classList.toggle('ready', !pending);
    $('reviewFinalize').disabled = !!pending;
    $('reviewFinalize').title = pending ? 'Decida todos os cards antes de continuar.' : '';
    if (errors && errors.length) $('reviewFinalize').title = errors.join(' ');
  }

  function pathParts(path) {
    return String(path || '').split('.').map(part => /^\d+$/.test(part) ? Number(part) : part);
  }

  function setByPath(root, path, value) {
    const parts = pathParts(path);
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
    cursor[parts[parts.length - 1]] = value;
  }

  function growEditor(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 42)}px`;
  }

  function editText(path, value, {className='', rows=1, label=''}={}) {
    return `<textarea class="pdf-inline-editor ${esc(className)}" data-pdf-path="${esc(path)}" rows="${rows}" aria-label="${esc(label)}">${esc(value)}</textarea>`;
  }

  function paperSection(title, body, extraClass='') {
    return `<section class="pdf-preview-section ${esc(extraClass)}"><h4>${esc(title)}</h4>${body}</section>`;
  }

  function renderStructures(content, prefix='structures_from_scene') {
    const items = Array.isArray(content.items) ? content.items : [];
    if (!items.length) return '<div class="pdf-empty">Sem estruturas.</div>';
    return `<div class="pdf-cs-list">${items.map((item,index) => {
      const contexts = Array.isArray(item.new_contexts) ? item.new_contexts : [];
      return `<article class="pdf-cs-block"><div class="pdf-cs-kicker">STRUCTURE ${index + 1} · CUES ${(Array.isArray(item.cue_orders) ? item.cue_orders : []).map(esc).join(' · ')}</div>
        ${editText(`${prefix}.items.${index}.title`, item.title || '', {className:'pdf-title-editor',label:'Título'})}
        <div class="pdf-edit-block"><b>Pattern</b>${editText(`${prefix}.items.${index}.pattern`, item.pattern || '', {rows:2,label:'Pattern'})}</div>
        <div class="pdf-edit-block"><b>Explicação</b>${editText(`${prefix}.items.${index}.explanation_pt`, item.explanation_pt || '', {rows:3,label:'Explicação'})}</div>
        <div class="pdf-edit-block"><b>Novos contextos</b>${contexts.map((ctx,cidx) => `<div class="pdf-preview-box">${editText(`${prefix}.items.${index}.new_contexts.${cidx}.en`, ctx?.en || '', {rows:1,label:'Contexto EN'})}${editText(`${prefix}.items.${index}.new_contexts.${cidx}.pt`, ctx?.pt || '', {rows:1,label:'Contexto PT'})}</div>`).join('')}</div>
        <div class="pdf-edit-block"><b>Make It Yours</b>${editText(`${prefix}.items.${index}.make_it_yours`, item.make_it_yours || '', {rows:2,label:'Make It Yours'})}</div>
      </article>`;
    }).join('')}</div>`;
  }

  function renderDay5Diagnostic(content, prefix='day_5_diagnostic') {
    const checks = Array.isArray(content.checks) ? content.checks : [];
    return paperSection('Intro', editText(`${prefix}.intro`, content.intro || '', {rows:2,label:'Diagnostic intro'})) +
      `<div class="pdf-cs-list">${checks.map((item,index) => `<article class="pdf-module-block"><div class="pdf-module-head"><span>CHECK ${index+1} · CUES ${(Array.isArray(item.cue_orders) ? item.cue_orders : []).map(esc).join(' · ')}</span></div><div class="pdf-module-body"><div><b>Título</b>${editText(`${prefix}.checks.${index}.title`, item.title || '', {rows:1,label:'Título'})}</div><div><b>Instruction</b>${editText(`${prefix}.checks.${index}.instruction`, item.instruction || '', {rows:2,label:'Instruction'})}</div><div><b>Success criteria</b>${editText(`${prefix}.checks.${index}.success_criteria`, item.success_criteria || '', {rows:2,label:'Success criteria'})}</div></div></article>`).join('')}</div>` +
      paperSection('Self-assessment', editText(`${prefix}.self_assessment`, content.self_assessment || '', {rows:2,label:'Self assessment'}));
  }

  function renderActivities(content, prefix='activities') {
    const standardGroup = (title,key) => {
      const items = Array.isArray(content[key]) ? content[key] : [];
      return items.length ? paperSection(title, items.map((item,index) => `<article class="pdf-module-block"><div class="pdf-module-head"><span>${title.toUpperCase()} ${index+1}</span></div><div class="pdf-module-body"><div><b>Prompt</b>${editText(`${prefix}.${key}.${index}.prompt`, item.prompt || '', {rows:2,label:'Prompt'})}</div><div><b>Self-check</b>${editText(`${prefix}.${key}.${index}.answer`, item.answer || '', {rows:2,label:'Self-check'})}</div>${Array.isArray(item.cue_orders) ? `<div class="pdf-cue-reference"><b>Cues</b><span>${item.cue_orders.map(esc).join(' · ')}</span></div>` : ''}</div></article>`).join('')) : '';
    };
    const hunt = Array.isArray(content.connected_speech_hunt) ? content.connected_speech_hunt : [];
    const transfers = Array.isArray(content.structure_transfer) ? content.structure_transfer : [];
    const shadow = content.shadowing_challenge && typeof content.shadowing_challenge === 'object' ? content.shadowing_challenge : {};
    const finalListening = content.final_listening && typeof content.final_listening === 'object' ? content.final_listening : {};
    return paperSection('Introdução', editText(`${prefix}.intro`, content.intro || '', {rows:3,label:'Introdução'})) +
      standardGroup('Listening Reconstruction','listening_reconstruction') +
      (hunt.length ? paperSection('Connected Speech Hunt', hunt.map((item,index) => `<article class="pdf-module-block"><div class="pdf-module-head"><span>HUNT ${index+1} · CS ${esc(item.sequence_order)}</span></div><div class="pdf-module-body"><div><b>Prompt</b>${editText(`${prefix}.connected_speech_hunt.${index}.prompt`, item.prompt || '', {rows:2,label:'Prompt'})}</div><div><b>Self-check</b>${editText(`${prefix}.connected_speech_hunt.${index}.answer`, item.answer || '', {rows:2,label:'Resposta'})}</div></div></article>`).join('')) : '') +
      (transfers.length ? paperSection('Structure Transfer · 2–3 frases originais', transfers.map((item,index) => `<article class="pdf-module-block"><div class="pdf-module-head"><span>${esc(item.structure_title || `STRUCTURE ${index+1}`)}</span></div><div class="pdf-module-body"><div><b>Prompt</b>${editText(`${prefix}.structure_transfer.${index}.prompt`, item.prompt || '', {rows:2,label:'Prompt'})}</div><div><b>Model answers</b>${(Array.isArray(item.model_answers) ? item.model_answers : []).map((answer,aidx) => editText(`${prefix}.structure_transfer.${index}.model_answers.${aidx}`, answer, {rows:1,label:`Model answer ${aidx+1}`})).join('')}</div></div></article>`).join('')) : '') +
      standardGroup('Vocabulary Recall · Linha a Linha','vocabulary_recall') +
      paperSection('Shadowing Challenge · ritmo, pausas e entonação', `<div class="pdf-edit-block"><b>Prompt</b>${editText(`${prefix}.shadowing_challenge.prompt`, shadow.prompt || '', {rows:2,label:'Shadowing prompt'})}</div><div class="pdf-edit-block"><b>Success criteria</b>${editText(`${prefix}.shadowing_challenge.success_criteria`, shadow.success_criteria || '', {rows:2,label:'Shadowing criteria'})}</div><div class="pdf-cue-reference"><b>Cues</b><span>${(Array.isArray(shadow.cue_orders) ? shadow.cue_orders : []).map(esc).join(' · ')}</span></div>`) +
      paperSection('Final Listening · sem legendas', `<div class="pdf-edit-block"><b>Prompt</b>${editText(`${prefix}.final_listening.prompt`, finalListening.prompt || '', {rows:2,label:'Final listening prompt'})}</div><div class="pdf-edit-block"><b>Registro de compreensão</b>${editText(`${prefix}.final_listening.comprehension_record`, finalListening.comprehension_record || '', {rows:2,label:'Comprehension record'})}</div>`);
  }

  function renderHowToStudy(content) {
    const days = Array.isArray(content.days) ? content.days : [];
    if (!days.length) return '<div class="pdf-empty">Fluxo de estudo não disponível.</div>';
    return `<div class="pdf-day-list">${days.map(row => `<article class="pdf-day-block"><span class="pdf-day-number">DIA ${esc(row.day)}</span><div><strong>${esc(row.title || '')}</strong>${(Array.isArray(row.steps) ? row.steps : []).map((step,index) => `<p><b>${index+1}.</b> ${esc(step)}</p>`).join('')}</div></article>`).join('')}</div><div class="pdf-derived-note"><b>Bloco 1 · protegido pelo Generator</b><span>A IA externa não pode editar, substituir nem deslocar o How To Study.</span></div>`;
  }

  function renderConnectedSpeech(content, prefix='connected_speech') {
    const items = Array.isArray(content.items) ? content.items : [];
    if (!items.length) return '<div class="pdf-empty">Nenhum Connected Speech aprovado para este kit.</div>';
    return `<div class="pdf-cs-list">${items.map((item,index) => `<article class="pdf-cs-block"><div class="pdf-cs-kicker">CS ${index + 1} · ${esc(String(item.type || '').toUpperCase())} · CUE ${esc(item.cue_order)}</div><div class="pdf-cs-source">${esc(item.source_text || item.cue_en || '')}</div>${item.heard_as ? `<div class="pdf-preview-box pdf-hear-box"><b>HEAR IT AS</b><span>${esc(item.heard_as)}</span></div>` : ''}${item.explanation_pt ? `<div class="pdf-readonly-block"><b>Explicação</b><p>${esc(item.explanation_pt)}</p></div>` : ''}<div class="pdf-edit-block"><b>Nota para o aluno</b>${editText(`${prefix}.items.${index}.learner_note`, item.learner_note || '', {rows:2,label:'Nota para o aluno'})}</div></article>`).join('')}</div>`;
  }

  function renderConnectedSpeechPractice(content, sourceContent, prefix='connected_speech_practice') {
    const items = Array.isArray(content.items) ? content.items : [];
    const sourceItems = Array.isArray(sourceContent?.items) ? sourceContent.items : [];
    if (!items.length) return '<div class="pdf-empty">Sem prática de Connected Speech para este kit.</div>';
    return `<div class="pdf-cs-list">${items.map((item,index) => { const source = sourceItems.find(row => Number(row.sequence_order) === Number(item.sequence_order)) || {}; const steps = Array.isArray(item.drill_steps) ? item.drill_steps : []; return `<article class="pdf-cs-block"><div class="pdf-cs-kicker">PRACTICE ${index + 1} · CS ${esc(item.sequence_order)}</div>${source.source_text ? `<div class="pdf-cs-source">${esc(source.source_text)}</div>` : ''}<div class="pdf-readonly-block"><b>LISTEN</b><p>Ouça uma vez sem repetir.</p></div><div class="pdf-readonly-block"><b>NOTICE</b><p>${esc(source.heard_as || source.explanation_pt || '')}</p></div><div class="pdf-edit-block"><b>REPEAT</b><div class="pdf-drill-list">${steps.map((step,stepIndex) => `<div class="pdf-drill-step"><span>${stepIndex + 1}</span>${editText(`${prefix}.items.${index}.drill_steps.${stepIndex}`, step, {rows:1,label:`Drill passo ${stepIndex+1}`})}</div>`).join('')}</div></div><div class="pdf-edit-block"><b>Dica</b>${editText(`${prefix}.items.${index}.practice_tip`, item.practice_tip || '', {rows:2,label:'Dica de prática'})}</div></article>`; }).join('')}</div>`;
  }

  function renderFinalization(content, prefix='finalization') {
    const checklist = Array.isArray(content.checklist) ? content.checklist : [];
    return `${editText(`${prefix}.title`, content.title || '', {className:'pdf-title-editor',rows:1,label:'Título'})}<div class="pdf-edit-block"><b>Checklist</b>${checklist.map((item,index) => `<div class="pdf-preview-box">□ ${editText(`${prefix}.checklist.${index}`, item, {rows:1,label:`Checklist ${index+1}`})}</div>`).join('')}</div><div class="pdf-edit-block"><b>Reflection</b>${editText(`${prefix}.reflection_prompt`, content.reflection_prompt || '', {rows:2,label:'Reflection'})}</div><div class="pdf-edit-block"><b>Next review</b>${editText(`${prefix}.next_review`, content.next_review || '', {rows:2,label:'Next review'})}</div>`;
  }

  function pdfPreview(key, content) {
    if (key !== 'immersion_workbook') return '';
    const sections = [
      paperSection('1. How To Study · GENERATOR', renderHowToStudy(content.how_to_study || {})),
      paperSection('2. Day 5 — Diagnostic', renderDay5Diagnostic(content.day_5_diagnostic || {})),
      paperSection('3. Connected Speech · PDF ONLY', renderConnectedSpeech(content.connected_speech || {})),
      paperSection('4. Connected Speech — Practice', renderConnectedSpeechPractice(content.connected_speech_practice || {}, content.connected_speech || {})),
      paperSection('5. Structures From This Scene', renderStructures(content.structures_from_scene || {})),
      paperSection('6. Activities', renderActivities(content.activities || {})),
      paperSection('7. Finalization', renderFinalization(content.finalization || {})),
    ].join('');
    return `<div class="pdf-render-preview"><div class="pdf-preview-cover"><span>IMMERSIONHUB · PDF ÚNICO · CAPA</span><h3>Immersion Workbook</h3><p>Less time preparing. More time actually practicing.</p><div class="pdf-preview-box"><b>Objetivo</b>${editText('kit_objective', content.kit_objective || '', {rows:2,label:'Objetivo do kit'})}</div></div><div class="pdf-preview-paper">${sections}</div></div>`;
  }

  function bindPdfEditors(root, key) {
    root.querySelectorAll('[data-pdf-path]').forEach(editor => {
      growEditor(editor);
      editor.addEventListener('input', () => growEditor(editor));
      editor.addEventListener('change', () => {
        const path = editor.dataset.pdfPath;
        const value = editor.value;
        setByPath(review.pdfs[key].content, path, value);
        review.pdfs[key].decision = 'pending';
        renderSummary();
        scheduleSave();
      });
    });
  }

  function renderPdfs() {
    const root = $('pdfReviewList');
    root.innerHTML = activePdfKeys().map(key => {
      const row = review.pdfs[key];
      return `<article class="material-review-card ${esc(row.decision)}" data-pdf-card="${esc(key)}"><header><div><span class="mono-label">PDF ÚNICO · PRÉVIA ESTRUTURADA</span><h3>${esc(row.label || key)}</h3></div><span class="review-decision">${decisionLabel(row.decision)}</span></header>${pdfPreview(key, row.content || {})}<div class="review-card-actions"><button type="button" class="btn btn-outline" data-pdf-reject="${esc(key)}">Recusar</button><button type="button" class="btn btn-primary" data-pdf-approve="${esc(key)}">Aprovar</button></div></article>`;
    }).join('');

    root.querySelectorAll('[data-pdf-approve]').forEach(b => b.addEventListener('click', () => setPdfDecision(b.dataset.pdfApprove, 'approved')));
    root.querySelectorAll('[data-pdf-reject]').forEach(b => b.addEventListener('click', () => setPdfDecision(b.dataset.pdfReject, 'rejected')));
    root.querySelectorAll('[data-pdf-card]').forEach(card => bindPdfEditors(card, card.dataset.pdfCard));
  }

  const field = (label,key,value,multi=false) => `<label class="review-field"><span>${esc(label)}</span>${multi ? `<textarea data-card-field="${esc(key)}">${esc(value)}</textarea>` : `<input data-card-field="${esc(key)}" value="${esc(value)}">`}</label>`;

  function highlight(source, marked) {
    const text = String(source || '');
    const mark = String(marked || '');
    if (!mark) return esc(text);
    const index = text.indexOf(mark);
    if (index < 0) return esc(text);
    return `${esc(text.slice(0,index))}<mark>${esc(mark)}</mark>${esc(text.slice(index + mark.length))}`;
  }

  function ankiVisualPreview(card) {
    return `<div class="anki-render-preview"><div class="anki-direction">EN → PT</div><div class="anki-sentence">${highlight(card.highlight_en, card.marked)}</div><div class="anki-divider"></div><div class="anki-sentence anki-translation">${highlight(card.highlight_pt, card.markedPT)}</div><div class="anki-mini-lesson"><span>MINI AULA</span><div class="anki-concept"><small>${esc(String(card.type || '').toUpperCase())}</small><strong>${esc(card.focus || '')}</strong><em>${esc(card.meaning || '')}</em></div><div class="anki-explanation">${esc(card.explanation || '')}</div><div class="anki-example"><span>NEW EXAMPLE</span><b>${esc(card.example_en || '')}</b><small>${esc(card.example_pt || '')}</small></div></div></div>`;
  }

  function renderAnki() {
    const root = $('ankiReviewList');
    const items = review.anki.items || [];
    if (!items.length) {
      root.innerHTML = '<div class="notice">A IA externa não selecionou cards fortes para este kit.</div>';
      return;
    }
    root.innerHTML = items.map((card,index) => `<article class="material-review-card ${esc(card.decision)}" data-card-index="${index}"><header><div><span class="mono-label">ANKI · CUE ${esc(card.cue_order)} · SCORE ${esc(card.score)}</span><h3>${esc(card.focus || card.key || `Card ${index+1}`)}</h3></div><span class="review-decision">${decisionLabel(card.decision)}</span></header><div class="anki-review-layout"><div>${ankiVisualPreview(card)}${card.audio?.media_url ? `<audio controls preload="none" src="${esc(card.audio.media_url)}"></audio>` : ''}</div><div class="review-card-grid">${field('Type','type',card.type)}${field('Focus','focus',card.focus)}${field('Meaning','meaning',card.meaning)}${field('Highlight EN','highlight_en',card.highlight_en)}${field('Marked EN','marked',card.marked)}${field('Highlight PT','highlight_pt',card.highlight_pt)}${field('Marked PT','markedPT',card.markedPT)}${field('Explanation','explanation',card.explanation,true)}${field('Example EN','example_en',card.example_en)}${field('Example PT','example_pt',card.example_pt)}${field('Tags','tags',Array.isArray(card.tags) ? card.tags.join(', ') : card.tags || '')}</div></div><div class="review-card-actions"><button type="button" class="btn btn-outline" data-card-reject="${index}">Recusar</button><button type="button" class="btn btn-primary" data-card-approve="${index}">Aprovar</button></div></article>`).join('');

    root.querySelectorAll('[data-card-approve]').forEach(b => b.addEventListener('click', () => setCardDecision(Number(b.dataset.cardApprove), 'approved', true)));
    root.querySelectorAll('[data-card-reject]').forEach(b => b.addEventListener('click', () => setCardDecision(Number(b.dataset.cardReject), 'rejected', true)));
    root.querySelectorAll('[data-card-index]').forEach(cardEl => {
      const idx = Number(cardEl.dataset.cardIndex);
      cardEl.querySelectorAll('[data-card-field]').forEach(input => input.addEventListener('change', () => {
        const key = input.dataset.cardField;
        review.anki.items[idx][key] = key === 'tags' ? input.value.split(',').map(x => x.trim()).filter(Boolean) : input.value;
        review.anki.items[idx].decision = 'pending';
        renderAnki();
        renderSummary();
        scheduleSave();
      }));
    });
  }

  async function finalize() {
    if (!review) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    $('reviewFinalize').disabled = true;
    try {
      await save();
      const data = await api('/api/materials-review/finalize', {method:'POST', body:'{}'});
      window.location.href = data.next_url || '/materials-final';
    } catch (e) {
      showError(e.message);
      $('reviewFinalize').disabled = false;
    }
  }


  function applyMusicContext() {
    const music = review?.content_type === 'music';
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
    if (eyebrow) eyebrow.textContent = 'ETAPA 12 · REVISÃO HUMANA';
    const stageNumber = document.querySelector('.stage-panel .stage-number');
    if (stageNumber) stageNumber.textContent = '12';
    const hero = document.querySelector('.page-hero p');
    if (hero) hero.textContent = 'Revise os blocos pedagógicos do microtrecho musical e os cards Anki. Connected Speech não faz parte do ramo Music.';
  }

  async function load() {
    try {
      const data = await api('/api/materials-review/state');
      review = data.review;
      applyMusicContext();
      renderAnki();
      renderSummary(data.summary, data.errors);
      showError('');
    } catch (e) {
      showError(e.message);
    }
  }

  document.querySelectorAll('.review-tabs button').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.review-tabs button').forEach(b => b.classList.toggle('active', b === btn));
    $('ankiReviewPanel').hidden = btn.dataset.tab !== 'anki';
  }));

  $('reviewFinalize').addEventListener('click', finalize);
  load();
})();
