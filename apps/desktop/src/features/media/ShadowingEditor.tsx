import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Check, CheckCircle2, Circle, Clock3, Merge, Pause, Split, Play, RotateCcw, SkipBack, SkipForward, Trash2, Undo2, X } from "lucide-react";
import "./ShadowingEditor.css";

type Cue = { id: string; startMs: number; endMs: number; text: string };
type Translation = { id: string; text: string };
type Asset = { id: string; name: string };
type ShadowingBlock = { cueIds: string[]; pauseDurationMs: number };
type Props = { projectId: string; asset: Asset; cues: Cue[]; translations: Translation[]; editorialResult: Record<string, any> | null; onClose: () => void };
type StoredPlan = { selectedCueIds: string[]; blocks?: ShadowingBlock[]; sourceSnapshot: Cue[]; sourceSignature?: string; updatedAt: number };
type DemoPhase = "idle" | "playing" | "pause" | "complete";

const DEFAULT_PAUSE_MS = 4000;
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0") + "." + Math.floor(ms % 1000 / 100);
};
const sameSource = (a: Cue[], b: Cue[]) => JSON.stringify(a.map(c => [c.id,c.startMs,c.endMs,c.text])) === JSON.stringify(b.map(c => [c.id,c.startMs,c.endMs,c.text]));
const blockKey = (block: ShadowingBlock) => block.cueIds[0] ?? "";

export default function ShadowingEditor({ projectId, asset, cues, translations, editorialResult, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  const [blocks, setBlocks] = useState<ShadowingBlock[]>(() => cues.map(c => ({ cueIds: [c.id], pauseDurationMs: DEFAULT_PAUSE_MS })));
  const [activeId, setActiveId] = useState(cues[0]?.id ?? "");
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [demoPhase, setDemoPhase] = useState<DemoPhase>("idle");
  const [demoIndex, setDemoIndex] = useState(0);
  const [demoCountdown, setDemoCountdown] = useState(0);
  const [repeatEachBlock, setRepeatEachBlock] = useState(false);
  const [repeatPass, setRepeatPass] = useState(0);
  const activeBlock = blocks.find(b => b.cueIds.includes(activeId)) ?? null;
  const selectedIds = useMemo(() => blocks.flatMap(b => b.cueIds), [blocks]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const excluded = useMemo(() => cues.filter(c => !selectedSet.has(c.id)), [cues, selectedSet]);
  const visibleBlocks = showExcluded ? [] : blocks;
  const pct = (ms: number) => duration > 0 ? Math.max(0, Math.min(100, ms / duration * 100)) : 0;
  const sourceSignature = JSON.stringify([cues.map(c => [c.id,c.startMs,c.endMs,c.text]), translations.map(t => [t.id,t.text]), editorialResult?.suggestions?.map((s: any) => [s.cue_id,s.approved_en,s.approved_pt]) ?? []]);
  const translationFor = (id: string) => {
    const suggestion = editorialResult?.suggestions?.find((s: any) => s.cue_id === id);
    return suggestion?.approved_pt || translations.find(t => t.id === id)?.text || "";
  };
  const cueById = useMemo(() => new Map(cues.map(c => [c.id,c])), [cues]);
  const demoBlock = blocks[demoIndex] ?? null;
  const demoCues = demoBlock?.cueIds.map(id => cueById.get(id)).filter((c): c is Cue => Boolean(c)) ?? [];
  const mergeIndexes = blocks.map((b,i) => mergeSelection.includes(blockKey(b)) ? i : -1).filter(i => i >= 0);
  const canMerge = mergeIndexes.length >= 2
    && mergeIndexes.every((value,index) => index === 0 || value === mergeIndexes[index - 1] + 1)
    && mergeIndexes.every((value,index) => {
      if (index === 0) return true;
      const previous = blocks[mergeIndexes[index - 1]];
      const currentBlock = blocks[value];
      const previousCueIndex = cues.findIndex(c => c.id === previous.cueIds[previous.cueIds.length - 1]);
      const currentCueIndex = cues.findIndex(c => c.id === currentBlock.cueIds[0]);
      return currentCueIndex === previousCueIndex + 1;
    });

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
            const restored = (plan.selectedCueIds ?? []).filter(id => cues.some(c => c.id === id));
            const storedBlocks = Array.isArray(plan.blocks) ? plan.blocks
              .map(b => ({ cueIds: (b.cueIds ?? []).filter(id => restored.includes(id)), pauseDurationMs: Math.min(30000, Math.max(1000, Number(b.pauseDurationMs) || DEFAULT_PAUSE_MS)) }))
              .filter(b => b.cueIds.length > 0) : [];
            const restoredBlocks = storedBlocks.length
              ? storedBlocks
              : restored.map(id => ({ cueIds: [id], pauseDurationMs: DEFAULT_PAUSE_MS }));
            setBlocks(restoredBlocks);
            if (restoredBlocks.length) setActiveId(restoredBlocks[0].cueIds[0]);
          }
        }
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; video.current?.pause(); };
  }, [projectId, asset.id, cues, sourceSignature]);

  useEffect(() => {
    if (demoPhase !== "pause" || !demoBlock) return;
    const durationMs = Math.max(1000, Number(demoBlock.pauseDurationMs) || DEFAULT_PAUSE_MS);
    const deadline = Date.now() + durationMs;
    const render = () => setDemoCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    render();
    const interval = window.setInterval(render, 100);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      if (repeatEachBlock && repeatPass === 0) {
        setRepeatPass(1);
        startDemoBlock(demoIndex);
        return;
      }
      const next = demoIndex + 1;
      if (next >= blocks.length) {
        setDemoPhase("complete");
        setDemoCountdown(0);
        video.current?.pause();
        return;
      }
      setRepeatPass(0);
      startDemoBlock(next);
    }, durationMs);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [demoPhase, demoIndex, demoBlock, blocks.length, repeatEachBlock, repeatPass]);

  function seek(ms: number) {
    const next = Math.max(0, Math.min(ms, duration || ms));
    if (video.current) video.current.currentTime = next / 1000;
    setCurrent(next);
  }
  function choose(block: ShadowingBlock) {
    stopDemo();
    setActiveId(block.cueIds[0] ?? "");
    const first = cueById.get(block.cueIds[0]);
    if (first) seek(first.startMs);
  }
  function startDemoBlock(index: number) {
    const block = blocks[index];
    const first = block ? cueById.get(block.cueIds[0]) : null;
    if (!block || !first || !video.current) return;
    setDemoIndex(index);
    setDemoCountdown(0);
    setDemoPhase("playing");
    seek(first.startMs);
    const player = video.current;
    player.currentTime = first.startMs / 1000;
    void player.play().catch(e => {
      setError("Não foi possível iniciar o teste de Shadowing: " + String(e));
      setDemoPhase("idle");
    });
  }
  function startDemo() {
    if (!blocks.length) return;
    setError("");
    setRepeatPass(0);
    startDemoBlock(0);
  }
  function stopDemo() {
    video.current?.pause();
    setDemoPhase("idle");
    setDemoCountdown(0);
    setRepeatPass(0);
  }
  function onTime(ms: number) {
    setCurrent(ms);
    if (demoPhase === "playing" && demoBlock) {
      const last = cueById.get(demoBlock.cueIds[demoBlock.cueIds.length - 1]);
      if (last && ms >= last.endMs - 45) {
        video.current?.pause();
        if (video.current) video.current.currentTime = last.endMs / 1000;
        setCurrent(last.endMs);
        setDemoPhase("pause");
        return;
      }
    }
    if (demoPhase === "idle" && playing && activeBlock) {
      const last = cueById.get(activeBlock.cueIds[activeBlock.cueIds.length - 1]);
      if (last && ms >= last.endMs) {
        video.current?.pause();
        if (video.current) video.current.currentTime = last.endMs / 1000;
        setCurrent(last.endMs);
      }
    }
  }
  function toggleMerge(key: string) {
    setMergeSelection(current => current.includes(key) ? current.filter(x => x !== key) : [...current, key]);
  }
  function splitBlock(block: ShadowingBlock) {
    if (block.cueIds.length < 2) return;
    const next = blocks.flatMap(item => blockKey(item) === blockKey(block)
      ? item.cueIds.map(id => ({ cueIds: [id], pauseDurationMs: item.pauseDurationMs }))
      : [item]);
    setBlocks(next);
    setMergeSelection([]);
    setSaved(false);
  }
  function updatePauseDuration(seconds: number) {
    if (!activeBlock) return;
    setBlocks(current => current.map(block => blockKey(block) === blockKey(activeBlock)
      ? { ...block, pauseDurationMs: seconds * 1000 }
      : block));
    setSaved(false);
  }
  function mergeBlocks() {
    if (!canMerge) return;
    const firstIndex = mergeIndexes[0];
    const lastIndex = mergeIndexes[mergeIndexes.length - 1];
    const merged = blocks.slice(firstIndex, lastIndex + 1);
    const combined: ShadowingBlock = {
      cueIds: merged.flatMap(b => b.cueIds),
      pauseDurationMs: merged[0]?.pauseDurationMs ?? DEFAULT_PAUSE_MS
    };
    setBlocks(current => [...current.slice(0, firstIndex), combined, ...current.slice(lastIndex + 1)]);
    setActiveId(combined.cueIds[0]);
    setMergeSelection([]);
    setSaved(false);
  }
  function removeBlock(block: ShadowingBlock) {
    const removed = new Set(block.cueIds);
    const next = blocks.filter(item => item !== block);
    setBlocks(next);
    if (removed.has(activeId)) setActiveId(next[0]?.cueIds[0] ?? "");
    setMergeSelection([]);
    setSaved(false);
  }
  function toggleExcluded(id: string) {
    if (selectedSet.has(id)) {
      const next = blocks.flatMap(block => {
        const remaining = block.cueIds.filter(cueId => cueId !== id);
        return remaining.map(cueId => ({ cueIds: [cueId], pauseDurationMs: block.pauseDurationMs }));
      });
      setBlocks(next);
      if (activeId === id) setActiveId(next[0]?.cueIds[0] ?? "");
    } else {
      const next = [...blocks, { cueIds: [id], pauseDurationMs: DEFAULT_PAUSE_MS }]
        .sort((a,b) => (cueById.get(a.cueIds[0])?.startMs ?? 0) - (cueById.get(b.cueIds[0])?.startMs ?? 0));
      setBlocks(next);
      if (!activeId) setActiveId(id);
    }
    setMergeSelection([]);
    setSaved(false);
  }
  async function save() {
    setSaving(true); setError("");
    try {
      await invoke("save_shadowing_selection", { projectId, assetId: asset.id, cues, selectedCueIds: selectedIds, blocks, sourceSignature });
      setSaved(true); setStale(false);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  function playBlock(block = activeBlock) {
    if (!block || !video.current) return;
    stopDemo();
    const first = cueById.get(block.cueIds[0]);
    if (!first) return;
    setActiveId(first.id);
    if (current < first.startMs || current >= (cueById.get(block.cueIds[block.cueIds.length - 1])?.endMs ?? first.endMs)) seek(first.startMs);
    void video.current.play();
  }
  function nextBlock() {
    if (!activeBlock) return;
    const index = blocks.findIndex(b => blockKey(b) === blockKey(activeBlock));
    const next = blocks[index + 1];
    if (next) choose(next);
  }
  function previousBlock() {
    if (!activeBlock) return;
    const index = blocks.findIndex(b => blockKey(b) === blockKey(activeBlock));
    const previous = blocks[index - 1];
    if (previous) choose(previous);
  }

  return <div className="shadowing-backdrop">
    <section className="shadowing-editor" role="dialog" aria-modal="true" aria-label="Preparar Shadowing">
      <header className="shadowing-header">
        <div><span className="eyebrow">NOVA GENERATOR · ETAPA 2</span><h2>Preparar Shadowing</h2><p>{asset.name} · {blocks.length} blocos de prática · {selectedIds.length} falas</p></div>
        <div className="shadowing-header-actions">
          {saved && <span className="shadowing-saved"><CheckCircle2 size={14}/> Seleção salva</span>}
          {demoPhase === "idle" ? <button className="secondary-button" onClick={startDemo} disabled={!loaded || blocks.length === 0}><Play size={14}/> Testar Shadowing</button> : <button className="secondary-button" onClick={stopDemo}><X size={14}/> Parar teste</button>}
          <button className="primary-button" onClick={() => void save()} disabled={saving || !loaded || selectedIds.length === 0}>{saving ? "Salvando..." : "Salvar seleção"}</button>
          <button className="icon-button" title="Fechar" onClick={onClose}><X size={18}/></button>
        </div>
      </header>
      {error && <div className="shadowing-error">{error}</div>}
      {stale && <div className="shadowing-stale">A Editorial foi alterada desde a última seleção. Revise os blocos e salve novamente para atualizar o Shadowing.</div>}
      <div className="shadowing-layout">
        <main className="shadowing-main">
          <div className={"shadowing-video-wrap " + (demoPhase !== "idle" ? "is-demo" : "")}>
            {src ? <video ref={video} src={src} controls={demoPhase === "idle"} playsInline preload="metadata"
              onLoadedMetadata={e => setDuration(e.currentTarget.duration * 1000)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onTimeUpdate={e => onTime(e.currentTarget.currentTime * 1000)}/> : <div className="shadowing-placeholder">{loaded ? "Não foi possível abrir o vídeo." : "Carregando vídeo..."}</div>}
            {demoPhase === "pause" && <div className="shadowing-demo-overlay">
              <span className="eyebrow">SUA VEZ · BLOCO {demoIndex + 1} DE {blocks.length}</span>
              <div className="shadowing-demo-cues">{demoCues.map(c => <p key={c.id}>{c.text}</p>)}</div>
              <strong className="shadowing-demo-countdown">{demoCountdown}</strong>
              <small>Repita em voz alta acompanhando o ritmo e a pronúncia.</small>
            </div>}
            {demoPhase === "complete" && <div className="shadowing-demo-overlay">
              <CheckCircle2 size={30}/><strong>Shadowing concluído!</strong><small>{blocks.length} blocos praticados.</small>
              <button className="primary-button" onClick={startDemo}><RotateCcw size={14}/> Repetir sessão</button>
            </div>}
            {demoPhase === "playing" && <div className="shadowing-demo-status">OUÇA COM ATENÇÃO · BLOCO {demoIndex + 1}/{blocks.length}</div>}
          </div>
          <div className="shadowing-transport">
            <button title="Bloco anterior" onClick={previousBlock} disabled={!activeBlock || demoPhase !== "idle"}><SkipBack size={16}/></button>
            <button title="Reproduzir bloco" onClick={() => playBlock()} disabled={!activeBlock || demoPhase !== "idle"}><Play size={16}/></button>
            <button title="Pausar" onClick={() => video.current?.pause()} disabled={demoPhase !== "idle"}><Pause size={16}/></button>
            <button title="Repetir bloco" onClick={() => activeBlock && playBlock(activeBlock)} disabled={!activeBlock || demoPhase !== "idle"}><RotateCcw size={16}/></button>
            <button title="Próximo bloco" onClick={nextBlock} disabled={!activeBlock || demoPhase !== "idle"}><SkipForward size={16}/></button>
            <span>{clock(current)} / {clock(duration)}</span>
          </div>
          {demoPhase !== "idle" && <div className="shadowing-demo-options">
            <label><input type="checkbox" checked={repeatEachBlock} onChange={e => setRepeatEachBlock(e.target.checked)}/> Repetir cada bloco uma vez</label>
            {demoPhase === "pause" && <span>Próximo trecho em {demoCountdown}s</span>}
          </div>}
          <section className="shadowing-timeline">
            <div className="shadowing-timeline-heading"><div><span className="eyebrow">TIMELINE</span><strong>Blocos da prática</strong></div><span>{blocks.length} incluídos</span></div>
            <div className="shadowing-ruler"><span>00:00</span><span>{clock(duration / 4)}</span><span>{clock(duration / 2)}</span><span>{clock(duration * .75)}</span><span>{clock(duration)}</span></div>
            <div className="shadowing-lane">
              {blocks.map((block,index) => {
                const first = cueById.get(block.cueIds[0]);
                const last = cueById.get(block.cueIds[block.cueIds.length - 1]);
                if (!first || !last) return null;
                return <button key={blockKey(block)} title={block.cueIds.map(id => cueById.get(id)?.text ?? "").join(" / ")}
                  className={"shadowing-clip included " + (activeBlock && blockKey(activeBlock) === blockKey(block) ? "active " : "") + (mergeSelection.includes(blockKey(block)) ? "merge-selected" : "")}
                  style={{left:pct(first.startMs)+"%",width:Math.max(.7,pct(last.endMs-first.startMs))+"%"}}
                  onClick={() => choose(block)} />;
              })}
              <i style={{left:pct(current)+"%"}}/>
            </div>
            <input aria-label="Navegar pelo vídeo" type="range" min="0" max={Math.max(1,duration)} step="50" value={Math.min(current,duration||current)} onChange={e=>seek(Number(e.target.value))}/>
          </section>
        </main>
        <aside className="shadowing-inspector">
          <div className="shadowing-inspector-tabs">
            <button className={!showExcluded?"active":""} onClick={()=>{setShowExcluded(false);setMergeSelection([]);}}>Selecionados ({blocks.length})</button>
            <button className={showExcluded?"active":""} onClick={()=>{setShowExcluded(true);setMergeSelection([]);}}>Fora ({excluded.length})</button>
          </div>
          {!showExcluded && <div className="shadowing-merge-toolbar">
            <span>{mergeSelection.length} blocos marcados</span>
            <button className="secondary-button" onClick={mergeBlocks} disabled={!canMerge}><Merge size={14}/> Mesclar blocos</button>
            {mergeSelection.length >= 2 && !canMerge && <small>Marque blocos consecutivos, sem falas intermediárias excluídas.</small>}
          </div>}
          {activeBlock && !showExcluded && <div className="shadowing-active-card">
            <span className="eyebrow">BLOCO ATUAL · {activeBlock.cueIds.length} {activeBlock.cueIds.length === 1 ? "fala" : "falas"}</span>
            <strong>{activeBlock.cueIds.map(id => cueById.get(id)?.text ?? "").filter(Boolean).join(" ")}</strong>
            {activeBlock.cueIds.map(id => translationFor(id)).filter(Boolean).length > 0 && <p>{activeBlock.cueIds.map(id => translationFor(id)).filter(Boolean).join(" ")}</p>}
            <small><Clock3 size={12}/> {clock(cueById.get(activeBlock.cueIds[0])?.startMs ?? 0)} – {clock(cueById.get(activeBlock.cueIds[activeBlock.cueIds.length - 1])?.endMs ?? 0)}</small>
            <label className="shadowing-pause-setting">Tempo para repetir
              <select value={Math.round(activeBlock.pauseDurationMs/1000)} onChange={e=>updatePauseDuration(Number(e.target.value))}>
                {[2,3,4,5,6,8,10,12,15].map(seconds=><option key={seconds} value={seconds}>{seconds} segundos</option>)}
              </select>
            </label>
            <div className="shadowing-active-actions">
              <button className="primary-button" onClick={() => playBlock(activeBlock)}><Play size={14}/> Ouvir bloco</button>
              <button className="secondary-button" onClick={()=>seek(cueById.get(activeBlock.cueIds[0])?.startMs ?? 0)}>Ir ao início</button>
              {activeBlock.cueIds.length > 1 && <button className="secondary-button" title="Separar este bloco" onClick={()=>splitBlock(activeBlock)}><Split size={14}/> Separar</button>}
            </div>
          </div>}
          <div className="shadowing-block-list">
            {!showExcluded && visibleBlocks.map((block,index) => {
              const first = cueById.get(block.cueIds[0]);
              const last = cueById.get(block.cueIds[block.cueIds.length - 1]);
              const isActive = activeBlock && blockKey(activeBlock) === blockKey(block);
              return <article key={blockKey(block)} className={"shadowing-block "+(isActive?"active":"")}>
                <label className="shadowing-merge-check" title="Marcar para mesclar"><input type="checkbox" checked={mergeSelection.includes(blockKey(block))} onChange={()=>toggleMerge(blockKey(block))}/></label>
                <button className="shadowing-block-main" onClick={()=>choose(block)}>
                  <CheckCircle2 size={16}/>
                  <span><strong>{block.cueIds.map(id => cueById.get(id)?.text ?? "").filter(Boolean).join(" ") || "Bloco sem texto"}</strong><small>Bloco {index+1} · {clock(first?.startMs ?? 0)} – {clock(last?.endMs ?? 0)} · {block.cueIds.length} fala(s)</small></span>
                </button>
                <button className="shadowing-block-action" title="Retirar bloco da prática" onClick={()=>removeBlock(block)}><Trash2 size={15}/></button>
              </article>;
            })}
            {showExcluded && excluded.map(cue=><article key={cue.id} className="shadowing-block">
              <button className="shadowing-block-main" onClick={()=>{setActiveId(cue.id);seek(cue.startMs);}}>
                <Circle size={16}/>
                <span><strong>{cue.text || "Bloco sem texto"}</strong><small>{clock(cue.startMs)} · {clock(cue.endMs)}</small></span>
              </button>
              <button className="shadowing-block-action" title="Restaurar bloco" onClick={()=>toggleExcluded(cue.id)}><Undo2 size={15}/></button>
            </article>)}
            {!showExcluded && !blocks.length && <div className="shadowing-empty">Nenhum bloco selecionado. Restaure falas na aba Fora.</div>}
            {showExcluded && !excluded.length && <div className="shadowing-empty">Nenhuma fala foi retirada.</div>}
          </div>
          <footer className="shadowing-inspector-footer"><span>{blocks.length} blocos · {selectedIds.length} falas na prática</span><button className="primary-button" onClick={()=>void save()} disabled={saving||selectedIds.length===0}>{saving?"Salvando...":<><Check size={14}/> Salvar seleção</>}</button></footer>
        </aside>
      </div>
    </section>
  </div>;
}
