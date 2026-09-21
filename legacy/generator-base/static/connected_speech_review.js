(() => {
  const $ = (id) => document.getElementById(id);
  let review = null;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const api = async (url, options={}) => {
    const response = await fetch(url, {headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options});
    let data={}; try { data=await response.json(); } catch (_) {}
    if(!response.ok) throw new Error(typeof data.detail==='string' ? data.detail : `HTTP ${response.status}`);
    return data;
  };
  const fmt = (ms) => {
    const n=Math.max(0,Math.round(Number(ms)||0));
    const m=Math.floor(n/60000), s=Math.floor((n%60000)/1000), x=n%1000;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(x).padStart(3,'0')}`;
  };

  function render(data) {
    review = data.review || data;
    const total = Number(review.total || 0), approved=Number(review.approved||0), rejected=Number(review.rejected||0), pending=Number(review.pending||0);
    $('csProgress').textContent = `${approved+rejected}/${total}`;
    $('csApproved').textContent = approved;
    $('csRejected').textContent = rejected;
    $('csPending').textContent = pending;
    $('csReviewList').innerHTML = (review.items || []).map((item) => `<button class="cs-review-list-item ${esc(item.decision||'pending')} ${Number(item.sequenceOrder)===Number(review.current_sequence_order)?'active':''}" data-sequence="${Number(item.sequenceOrder)}" type="button"><span>#${String(item.sequenceOrder).padStart(2,'0')}</span><b>${esc(item.type)}</b><small>${esc(item.source_text)}</small><i>${item.decision==='approved'?'✓':item.decision==='rejected'?'×':'·'}</i></button>`).join('');
    document.querySelectorAll('[data-sequence]').forEach((button) => button.addEventListener('click', () => load(Number(button.dataset.sequence))));

    const current = review.current;
    const empty = !current;
    $('csReviewEmpty').hidden = !empty;
    $('csReviewContent').hidden = empty;
    $('csReviewComplete').hidden = !review.completed;
    if (review.completed) {
      $('topState').textContent = 'Conferência concluída';
      $('csCompleteSummary').textContent = `${approved} aprovados · ${rejected} recusados · ${total} itens.`;
    }
    if (empty) {
      $('csTitle').textContent = 'Conferência concluída';
      $('csStatusChip').textContent = 'SEM ITENS';
      $('csStatusChip').classList.add('ready');
      return;
    }

    $('csTitle').textContent = `#${String(current.sequenceOrder).padStart(2,'0')} · ${current.type}`;
    $('csSubtitle').textContent = `Cue ${current.cue_order}${current.speaker ? ` · ${current.speaker}` : ''}`;
    $('csType').textContent = current.type;
    $('csCue').textContent = String(current.cue_order);
    $('csTime').textContent = `${fmt(current.start_ms)} → ${fmt(current.end_ms)}`;
    $('csConfidence').textContent = `${Math.round(Number(current.confidence||0)*100)}%`;
    $('csSourceText').textContent = current.source_text || '—';
    $('csHeardAs').textContent = current.heard_as || '—';
    $('csExplanation').textContent = current.explanation_pt || '—';
    $('csCueEn').textContent = current.cue_en || '—';
    $('csCuePt').textContent = current.cue_pt || '—';
    const decision = current.decision || 'pending';
    $('csStatusChip').textContent = decision === 'approved' ? 'APROVADO' : decision === 'rejected' ? 'RECUSADO' : 'PENDENTE';
    $('csStatusChip').classList.toggle('ready', decision === 'approved');
    $('csApprove').classList.toggle('is-selected', decision === 'approved');
    $('csReject').classList.toggle('is-selected', decision === 'rejected');
    $('csReviewMessage').textContent = decision === 'pending' ? 'Aprove ou recuse este item.' : `Decisão atual: ${decision === 'approved' ? 'aprovado' : 'recusado'}. Você pode alterar.`;
  }

  async function load(sequence) {
    try { render(await api(`/api/connected-speech/review${sequence ? `?sequence_order=${sequence}` : ''}`)); }
    catch (error) { $('csReviewMessage').textContent = error.message; }
  }

  async function decide(decision) {
    const current = review?.current;
    if (!current) return;
    $('csApprove').disabled = true; $('csReject').disabled = true;
    $('csReviewMessage').textContent = decision === 'approved' ? 'Salvando aprovação…' : 'Salvando recusa…';
    try {
      const data = await api('/api/connected-speech/review/decision', {method:'POST', body:JSON.stringify({sequence_order:Number(current.sequenceOrder), decision})});
      render(data);
    } catch (error) {
      $('csReviewMessage').textContent = error.message;
    } finally {
      $('csApprove').disabled = false; $('csReject').disabled = false;
    }
  }

  $('csApprove').addEventListener('click', () => decide('approved'));
  $('csReject').addEventListener('click', () => decide('rejected'));
  load();
})();
