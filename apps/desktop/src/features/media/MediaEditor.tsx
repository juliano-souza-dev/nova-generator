import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Captions, Check, Clock3, Pause, Play, Plus, Save, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import { runTrackedTask } from "../tasks/TaskCenter";

type Cue = { id: string; startMs: number; endMs: number; text: string };
type Asset = { id: string; name: string; durationMs?: number | null; sourceStartMs?: number | null; sourceEndMs?: number | null };
const fmt = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0") + "." + String(Math.floor(ms % 1000 / 100));
};

export default function MediaEditor({ projectId, asset, onClose }: { projectId: string; asset: Asset; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(asset.durationMs ?? 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);\n  const [dirty, setDirty] = useState(false);
  const activeCue = useMemo(() => cues.find(c => current >= c.startMs && current <= c.endMs), [cues, current]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [path, stored] = await Promise.all([
          invoke<string>("open_project_media", { projectId, assetId: asset.id }),
          invoke<Cue[]>("load_project_subtitles", { projectId, assetId: asset.id })
        ]);
        if (!alive) return;
        setSrc(convertFileSrc(path));
        setCues(stored);
        setSelected(stored[0]?.id ?? null);
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; video.current?.pause(); };
  }, [projectId, asset.id]);

  function seek(ms: number) {
    const next = Math.max(0, Math.min(ms, duration || ms));
    if (video.current) video.current.currentTime = next / 1000;
    setCurrent(next);
  }
  function addCue() {
    const startMs = Math.max(0, Math.floor(current / 100) * 100);
    const endMs = Math.min(duration || startMs + 2500, startMs + 2500);
    const cue: Cue = { id: `cue-${Date.now()}-${cues.length}`, startMs, endMs: Math.max(startMs + 100, endMs), text: "" };
    setCues(items => [...items, cue].sort((a, b) => a.startMs - b.startMs));
    setSelected(cue.id);
    setSaved(false);
  }
  function updateCue(id: string, patch: Partial<Cue>) {
    setCues(items => items.map(c => c.id === id ? { ...c, ...patch } : c).sort((a, b) => a.startMs - b.startMs));
    setSaved(false);
  }
  async function save() {
    setSaving(true); setError("");
    try {
      await runTrackedTask("export", "Salvar legendas do vídeo", () =>
        invoke("save_project_subtitles", { projectId, assetId: asset.id, cues }));
      setSaved(true);\n      setDirty(false);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  const chosen = cues.find(c => c.id === selected) ?? null;

  return <div className="media-editor-backdrop">
    <section className="media-editor" role="dialog" aria-modal="true" aria-label="Editor de mídia">
      <header className="media-editor-header">
        <button className="media-editor-back" onClick={() => { if (!dirty || window.confirm("Há alterações de legendas não salvas. Fechar mesmo assim?")) onClose(); }}><ArrowLeft size={16}/> Biblioteca</button>
        <div className="media-editor-title"><span className="eyebrow">EDITOR DE MÍDIA</span><strong>{asset.name}</strong></div>
        <div className="media-editor-actions">
          {saved && <span className="media-editor-saved"><Check size={13}/> Salvo</span>}
          <button className="primary-button" onClick={() => void save()} disabled={saving || loading}><Save size={15}/> {saving ? "Salvando..." : "Salvar legendas"}</button>
          <button className="icon-button" title="Fechar editor" onClick={() => { if (!dirty || window.confirm("Há alterações de legendas não salvas. Fechar mesmo assim?")) onClose(); }}><X size={18}/></button>
        </div>
      </header>
      {error && <div className="media-editor-error">{error}</div>}
      <div className="media-editor-main">
        <div className="media-editor-preview">
          {loading ? <div className="media-editor-placeholder">Preparando vídeo...</div> : src ? <>
            <div className="media-editor-video-wrap">
              <video ref={video} src={src} controls playsInline preload="metadata"
                onLoadedMetadata={e => { const ms = e.currentTarget.duration * 1000; setDuration(ms); }}
                onTimeUpdate={e => setCurrent(e.currentTarget.currentTime * 1000)} />
              {activeCue?.text && <div className="media-editor-caption">{activeCue.text}</div>}
            </div>
            <div className="media-editor-transport">
              <button title="Voltar 5 segundos" onClick={() => seek(current - 5000)}><SkipBack size={16}/></button>
              <button title="Reproduzir" onClick={() => void video.current?.play()}><Play size={16}/></button>
              <button title="Pausar" onClick={() => video.current?.pause()}><Pause size={16}/></button>
              <button title="Avançar 5 segundos" onClick={() => seek(current + 5000)}><SkipForward size={16}/></button>
              <span>{fmt(current)} <i>/</i> {fmt(duration)}</span>
            </div>
            <div className="media-editor-timeline">
              <div className="media-editor-ruler"><span>00:00</span><span>{fmt(duration / 2)}</span><span>{fmt(duration)}</span></div>
              <input aria-label="Navegar pelo vídeo" type="range" min="0" max={Math.max(1, duration)} step="50" value={Math.min(current, duration || current)} onChange={e => seek(Number(e.target.value))}/>
              <div className="media-editor-cue-track">
                {cues.map(c => <button key={c.id} title={c.text || "Legenda sem texto"} className={selected === c.id ? "active" : ""} style={{ left: `${duration ? c.startMs / duration * 100 : 0}%`, width: `${duration ? Math.max(1, (c.endMs - c.startMs) / duration * 100) : 1}%` }} onClick={() => { setSelected(c.id); seek(c.startMs); }}/>)}
              </div>
            </div>
          </> : <div className="media-editor-placeholder">Não foi possível abrir o vídeo.</div>}
          <div className="media-editor-next-step"><Captions size={16}/><div><strong>Transcrição e tradução</strong><span>O editor já permite revisar e salvar legendas manualmente. As ações de transcrição automática e tradução serão conectadas na próxima etapa.</span></div></div>
        </div>
        <aside className="media-editor-sidebar">
          <div className="media-editor-sidebar-head"><div><span className="eyebrow">LEGENDAS</span><h3>Faixas de texto <small>{cues.length}</small></h3></div><button className="primary-button" onClick={addCue} disabled={loading}><Plus size={14}/> Nova</button></div>
          {chosen ? <div className="media-editor-cue-form">
            <div className="media-editor-time-fields">
              <label>Início (ms)<input type="number" min="0" value={chosen.startMs} onChange={e => updateCue(chosen.id, { startMs: Math.max(0, Math.min(Number(e.target.value), chosen.endMs - 100)) })}/></label>
              <label>Fim (ms)<input type="number" min="1" value={chosen.endMs} onChange={e => updateCue(chosen.id, { endMs: Math.max(chosen.startMs + 100, Number(e.target.value)) })}/></label>
            </div>
            <label className="media-editor-text-label">Texto da legenda<textarea value={chosen.text} onChange={e => updateCue(chosen.id, { text: e.target.value })} placeholder="Digite o texto desta legenda..."/></label>
            <div className="media-editor-cue-buttons"><button onClick={() => seek(chosen.startMs)}><Clock3 size={13}/> Ir ao início</button><button className="danger" onClick={() => { setCues(items => items.filter(c => c.id !== chosen.id)); setSelected(null); setSaved(false); setDirty(true); }}><Trash2 size={13}/> Excluir</button></div>
          </div> : <div className="media-editor-no-cue"><Captions size={22}/><strong>Nenhuma legenda selecionada</strong><span>Crie uma legenda para começar a montar a faixa de texto.</span></div>}
          <div className="media-editor-cue-list">
            {cues.map(c => <button key={c.id} className={selected === c.id ? "selected" : ""} onClick={() => { setSelected(c.id); seek(c.startMs); }}>
              <span>{fmt(c.startMs)}</span><strong>{c.text || "Legenda sem texto"}</strong>
            </button>)}
          </div>
        </aside>
      </div>
    </section>
  </div>;
}
