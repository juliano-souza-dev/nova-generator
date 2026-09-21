(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const api = async (url, options={}) => {
    const response = await fetch(url, {headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options});
    let data={};
    try { data=await response.json(); } catch (_) {}
    if(!response.ok) throw new Error(typeof data.detail==='string' ? data.detail : `HTTP ${response.status}`);
    return data;
  };
  const fmt = (ms) => {
    const n=Math.max(0,Math.round(Number(ms)||0));
    const h=Math.floor(n/3600000), m=Math.floor((n%3600000)/60000), s=Math.floor((n%60000)/1000), x=n%1000;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(x).padStart(3,'0')}`;
  };
  const icon = (kind) => ({text:'TXT',json:'JSON',audio:'WAV',zip:'ZIP'}[kind] || 'FILE');

  function render(data){
    const stage=data.connected_speech||{};
    $('connectedStageChip').textContent='PRONTO';
    $('connectedStageChip').classList.add('ready');
    $('topState').textContent='Pacote pronto';
    $('connectedStart').textContent=fmt(stage.work_start_ms);
    $('connectedEnd').textContent=fmt(stage.work_end_ms);
    const items=stage.artifacts||[];
    $('connectedArtifacts').innerHTML=items.map(item=>`<a class="external-artifact-card" href="${esc(item.download_url||'#')}" download>
      <span class="artifact-icon ${esc(item.kind||'')}">${icon(item.kind)}</span>
      <span class="artifact-copy"><b>${esc(item.name)}</b><small>${esc(item.description||'')}</small></span>
      <span class="artifact-meta"><small>${esc(item.size_label||'')}</small><b>↓</b></span>
    </a>`).join('');
    const zip=items.find(item=>item.key==='zip');
    if(zip){
      const link=$('connectedDownloadZip');
      link.href=zip.download_url;
      link.classList.remove('is-disabled');
      link.removeAttribute('aria-disabled');
      link.setAttribute('download','');
    }
  }

  async function init(){
    try{
      const data=await api('/api/connected-speech/prepare',{method:'POST'});
      render(data);
    }catch(error){
      $('connectedStageChip').textContent='ERRO';
      $('connectedPrepareError').hidden=false;
      $('connectedPrepareError').textContent=error.message;
      $('topState').textContent='Falha ao preparar';
    }
  }

  init();
})();
