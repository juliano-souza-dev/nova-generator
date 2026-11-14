import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Check, CheckCircle2, Circle, Clock3, Pause, Play, RotateCcw, SkipBack, SkipForward, Trash2, Undo2, X } from "lucide-react";
import "./ShadowingEditor.css";

type Cue = { id: string; startMs: number; endMs: number; text: string };
type Translation = { id: string; text: string };
type Asset = { id: string; name: string };
type Props = { projectId: string; asset: Asset; cues: Cue[]; translations: Translation[]; editorialResult: Record<string, any> | null; onClose: () => void };
type StoredPlan = { selectedCueIds: string[]; sourceSnapshot: Cue[]; sourceSignature?: string; updatedAt: number };

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0") + "." + Math.floor(ms % 1000 / 100);
};
const sameSource = (a: Cue[], b: Cue[]) => JSON.stringify(a.map(c => [c.id,c.startMs,c.endMs,c.text])) === JSON.stringify(b.map(c => [c.id,c.startMs,c.endMs,c.text]));

export default function ShadowingEditor({ projectId, asset, cues, translations, editorialResult, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(cues.map(c => c.id));
  const [activeId, setActiveId] = useState(cues[0]?.id ?? "");
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const active = cues.find(c => c.id === activeId) ?? null;
  const selected = useMemo(() => cues.filter(c => selectedIds.includes(c.id)), [cues, selectedIds]);
  const visible = showExcluded ? cues.filter(c => !selectedIds.includes(c.id)) : cues.filter(c => selectedIds.includes(c.id));
  const pct = (ms: number) => duration > 0 ? Math.max(0, Math.min(100, ms / duration * 100)) : 0;
  const sourceSignature = JSON.stringify([cues.map(c => [c.id,c.startMs,c.endMs,c.text]), translations.map(t => [t.id,t.text]), editorialResult?.suggestions?.map((s: any) => [s.cue_id,s.approved_en,s.approved_pt]) ?? []]);
  const translationFor = (id: string) => {
    const suggestion = editorialResult?.suggestions?.find((s: any) => s.cue_id === id);
    return suggestion?.approved_pt || translations.find(t => t.id === id)?.text || "";
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [path, plan] = await Promise.all([
          invoke<string>("open_project_media", { projectId, assetId: asset.id }),
          invoke<StoredPlan | null>("load_shadowing_selection", { projectId, assetId: asset.id, cues, sourceSignature }).catch(() => null)
        ]);
        if (!alive) return;
        setSrc(convertFileSrc(path));
        if (plan) {
          const fresh = sameSource(plan.sourceSnapshot ?? [], cues) && (!plan.sourceSignature || plan.sourceSignature === sourceSignature);
          setStale(!fresh);
          if (fresh) {
            const restored = plan.selectedCueIds.filter(id => cues.some(c => c.id === id));
            setSelectedIds(restored);
            if (restored.length) setActiveId(restored[0]);
          }
        }
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; video.current?.pause(); };
  }, [projectId, asset.id, cues, sourceSignature]);

  function seek(ms: number) {
    const next = Math.max(0, Math.min(ms, duration || ms));
    if (video.current) video.current.currentTime = next / 1000;
    setCurrent(next);
  }
  function choose(cue: Cue) {
    setActiveId(cue.id);
    seek(cue.startMs);
  }
  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      const next = selectedIds.filter(x => x !== id);
      setSelectedIds(next);
      if (activeId === id) setActiveId(next[0] ?? "");
    } else {
      setSelectedIds([...selectedIds, id]);
      if (!activeId) setActiveId(id);
    }
    setSaved(false);
  }
  async function save() {
    setSaving(true); setError("");
    try {
      await invoke("save_shadowing_selection", { projectId, assetId: asset.id, cues, selectedCueIds: selectedIds, sourceSignature });
      setSaved(true); setStale(false);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  function playBlock() {
    if (!active || !video.current) return;
    if (current < active.startMs || current >= active.endMs) seek(active.startMs);
    void video.current.play();
  }
  function onTime(ms: number) {
    setCurrent(ms);
    if (playing && active && ms >= active.endMs) {
      video.current?.pause();
      if (video.current) video.current.currentTime = active.endMs / 1000;
      setCurrent(active.endMs);
    }
  }
  function nextBlock() {
    if (!active) return;
    const list = selected;
    const index = list.findIndex(c => c.id === active.id);
    const next = list[index + 1];
    if (next) choose(next);
  }
  function previousBlock() {
    if (!active) return;
    const list = selected;
    const index = list.findIndex(c => c.id === active.id);
    const previous = list[index - 1];
    if (previous) choose(previous);
  }

  return <div className="shadowing-backdrop">
    <section className="shadowing-editor" role="dialog" aria-modal="true" aria-label="Preparar Shadowing">
      <header className="shadowing-header">
        <div><span className="eyebrow">NOVA GENERATOR · ETAPA 2</span><h2>Preparar Shadowing</h2><p>{asset.name} · {selectedIds.length} de {cues.length} blocos selecionados</p></div>
        <div className="shadowing-header-actions">
          {saved && <span className="shadowing-saved"><CheckCircle2 size={14}/> Seleção salva</span>}
          <button className="primary-button" onClick={() => void save()} disabled={saving || !loaded || selectedIds.length === 0}>{saving ? "Salvando..." : "Salvar seleção"}</button>
          <button className="icon-button" title="Fechar" onClick={onClose}><X size={18}/></button>
        </div>
      </header>
      {error && <div className="shadowing-error">{error}</div>}
      {stale && <div className="shadowing-stale">A Editorial foi alterada desde a última seleção. Revise os blocos e salve novamente para atualizar o Shadowing.</div>}
      <div className="shadowing-layout">
        <main className="shadowing-main">
          <div className="shadowing-video-wrap">
            {src ? <video ref={video} src={src} controls playsInline preload="metadata"
              onLoadedMetadata={e => setDuration(e.currentTarget.duration * 1000)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onTimeUpdate={e => onTime(e.currentTarget.currentTime * 1000)}/> : <div className="shadowing-placeholder">{loaded ? "Não foi possível abrir o vídeo." : "Carregando vídeo..."}</div>}
          </div>
          <div className="shadowing-transport">
            <button title="Bloco anterior" onClick={previousBlock}><SkipBack size={16}/></button>
            <button title="Reproduzir bloco" onClick={playBlock}><Play size={16}/></button>
            <button title="Pausar" onClick={() => video.current?.pause()}><Pause size={16}/></button>
            <button title="Repetir bloco" onClick={() => { if (active) { seek(active.startMs); void video.current?.play(); } }}><RotateCcw size={16}/></button>
            <button title="Próximo bloco" onClick={nextBlock}><SkipForward size={16}/></button>
            <span>{clock(current)} / {clock(duration)}</span>
          </div>
          <section className="shadowing-timeline">
            <div className="shadowing-timeline-heading"><div><span className="eyebrow">TIMELINE</span><strong>Blocos da transcrição</strong></div><span>{selectedIds.length} incluídos</span></div>
            <div className="shadowing-ruler"><span>00:00</span><span>{clock(duration / 4)}</span><span>{clock(duration / 2)}</span><span>{clock(duration * .75)}</span><span>{clock(duration)}</span></div>
            <div className="shadowing-lane">
              {cues.map(c => <button key={c.id} title={c.text} className={"shadowing-clip " + (selectedIds.includes(c.id) ? "included " : "excluded ") + (activeId === c.id ? "active" : "")}
                style={{left:pct(c.startMs)+"%",width:Math.max(.7,pct(c.endMs-c.startMs))+"%"}}
                onClick={() => choose(c)} />)}
              <i style={{left:pct(current)+"%"}}/>
            </div>
            <input aria-label="Navegar pelo vídeo" type="range" min="0" max={Math.max(1,duration)} step="50" value={Math.min(current,duration||current)} onChange={e=>seek(Number(e.target.value))}/>
          </section>
        </main>
        <aside className="shadowing-inspector">
          <div className="shadowing-inspector-tabs">
            <button className={!showExcluded?"active":""} onClick={()=>setShowExcluded(false)}>Selecionados ({selectedIds.length})</button>
            <button className={showExcluded?"active":""} onClick={()=>setShowExcluded(true)}>Fora ({cues.length-selectedIds.length})</button>
          </div>
          {active && !showExcluded && <div className="shadowing-active-card">
            <span className="eyebrow">BLOCO ATUAL</span><strong>{active.text}</strong>
            {translationFor(active.id) && <p>{translationFor(active.id)}</p>}
            <small><Clock3 size={12}/> {clock(active.startMs)} – {clock(active.endMs)}</small>
            <div className="shadowing-active-actions">
              <button className="primary-button" onClick={playBlock}><Play size={14}/> Ouvir bloco</button>
              <button className="secondary-button" onClick={()=>seek(active.startMs)}>Ir ao início</button>
            </div>
          </div>}
          <div className="shadowing-block-list">
            {visible.map((cue,index)=><article key={cue.id} className={"shadowing-block "+(activeId===cue.id?"active":"")}>
              <button className="shadowing-block-main" onClick={()=>choose(cue)}>
                {selectedIds.includes(cue.id)?<CheckCircle2 size={16}/>:<Circle size={16}/>}
                <span><strong>{cue.text || "Bloco sem texto"}</strong><small>{clock(cue.startMs)} · {clock(cue.endMs)}</small></span>
              </button>
              <button className="shadowing-block-action" title={selectedIds.includes(cue.id)?"Retirar da seleção":"Restaurar bloco"} onClick={()=>toggle(cue.id)}>
                {selectedIds.includes(cue.id)?<Trash2 size={15}/>:<Undo2 size={15}/>}
              </button>
            </article>)}
            {!visible.length && <div className="shadowing-empty">{showExcluded?"Nenhum bloco foi retirado.":"Nenhum bloco selecionado. Restaure itens na aba Fora."}</div>}
          </div>
          <footer className="shadowing-inspector-footer"><span>{selectedIds.length} blocos irão para a prática</span><button className="primary-button" onClick={()=>void save()} disabled={saving||selectedIds.length===0}>{saving?"Salvando...":<><Check size={14}/> Salvar seleção</>}</button></footer>
        </aside>
      </div>
    </section>
  </div>;
}
