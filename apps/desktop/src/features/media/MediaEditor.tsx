import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Captions, Check, Clock3, Pause, Play, Plus, Save, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import { runTrackedTask } from "../tasks/TaskCenter";

type Cue = { id: string; startMs: number; endMs: number; text: string; words?: { text: string; startMs: number; endMs: number }[] };
type TranscriptResult = { engine: string; model: string; language?: string | null; durationMs: number; cues: Cue[] };
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
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [transcriptionMode, setTranscriptionMode] = useState<"auto" | "cloud" | "local">("auto");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [transcriptionModel, setTranscriptionModel] = useState("small");
  const [transcribing, setTranscribing] = useState(false);
  const [localAsrReady, setLocalAsrReady] = useState(false);
  const [localAsrChecking, setLocalAsrChecking] = useState(true);
  const [installingAsr, setInstallingAsr] = useState(false);
  const [transcriptionInfo, setTranscriptionInfo] = useState("");
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
    setDirty(true);
  }
  function updateCue(id: string, patch: Partial<Cue>) {
    setCues(items => items.map(c => c.id === id ? { ...c, ...patch } : c).sort((a, b) => a.startMs - b.startMs));
    setSaved(false);
    setDirty(true);
  }
  async function save() {
    setSaving(true); setError("");
    try {
      await runTrackedTask("export", "Salvar legendas do vídeo", () =>
        invoke("save_project_subtitles", { projectId, assetId: asset.id, cues }));
      setSaved(true);
      setDirty(false);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  async function transcribe() {
    if (transcribing || loading) return;
    setTranscribing(true); setError(""); setTranscriptionInfo("");
    try {
      const result = await runTrackedTask("transcription", "Transcrever vídeo", () =>
        invoke<TranscriptResult>("transcribe_media", {
          projectId, assetId: asset.id, mode: transcriptionMode,
          language: transcriptionLanguage || null, localModel: transcriptionModel
        }));
      const next = result.cues.map(c => ({ ...c, words: c.words ?? [] }));
      setCues(next);
      setSelected(next[0]?.id ?? null);
      setSaved(false); setDirty(true);
      setTranscriptionInfo(`${next.length} legendas geradas por ${result.engine === "groq" ? "Groq Whisper" : "Faster-Whisper"}${result.language ? ` · idioma detectado: ${result.language}` : ""}. Revise e salve as legendas.`);
    } catch (e) { setError(String(e)); }
    finally { setTranscribing(false); }
  }

  async function installLocalAsr() {
    setInstallingAsr(true); setError("");
    try {
      const message = await runTrackedTask("installation", "Instalar transcrição local", () =>
        invoke<string>("install_local_asr"));
      setLocalAsrReady(await invoke<boolean>("check_local_asr"));
      setTranscriptionInfo(message);
    } catch (e) { setError(String(e)); }
    finally { setInstallingAsr(false); }
  }

  useEffect(() => {
    let alive = true;
    invoke<boolean>("check_local_asr").then(value => { if (alive) setLocalAsrReady(value); })
      .catch(() => { if (alive) setLocalAsrReady(false); })
      .finally(() => { if (alive) setLocalAsrChecking(false); });
    return () => { alive = false; };
  }, []);

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
          <div className="media-editor-transcription">
            <div className="media-editor-transcription-heading"><Captions size={16}/><div><strong>Transcrever mídia</strong><span>Gere legendas com marcação de tempo e revise antes de salvar.</span></div></div>
            <div className="media-editor-transcription-options">
              <label>Modo
                <select value={transcriptionMode} onChange={e => setTranscriptionMode(e.target.value as "auto" | "cloud" | "local")}>
                  <option value="auto">Automático (Groq + fallback local)</option>
                  <option value="cloud">Nuvem (Groq Whisper)</option>
                  <option value="local">Local (Faster-Whisper)</option>
                </select>
              </label>
              <label>Idioma
                <select value={transcriptionLanguage} onChange={e => setTranscriptionLanguage(e.target.value)}>
                  <option value="">Detectar automaticamente</option>
                  <option value="pt">Português</option><option value="en">Inglês</option>
                  <option value="es">Espanhol</option><option value="fr">Francês</option>
                  <option value="de">Alemão</option><option value="it">Italiano</option>
                </select>
              </label>
              {(transcriptionMode === "local" || transcriptionMode === "auto") && <label>Modelo local
                <select value={transcriptionModel} onChange={e => setTranscriptionModel(e.target.value)}>
                  <option value="tiny">Tiny · mais rápido</option><option value="base">Base</option>
                  <option value="small">Small · equilibrado</option><option value="medium">Medium</option>
                  <option value="large-v3">Large v3 · mais preciso</option>
                </select>
              </label>}
            </div>
            {(transcriptionMode === "local" || transcriptionMode === "auto") && <div className="media-editor-asr-status">
              <span>{localAsrChecking ? "Verificando mecanismo local..." : localAsrReady ? "Faster-Whisper instalado" : "Faster-Whisper não instalado"}</span>
              {!localAsrChecking && !localAsrReady && <button onClick={() => void installLocalAsr()} disabled={installingAsr}>{installingAsr ? "Instalando..." : "Instalar suporte local"}</button>}
            </div>}
            <button className="primary-button media-editor-transcribe-button" onClick={() => void transcribe()} disabled={loading || transcribing || (transcriptionMode === "local" && !localAsrReady)}>
              <Captions size={15}/>{transcribing ? "Transcrevendo..." : "Iniciar transcrição"}
            </button>
            {transcriptionInfo && <p className="media-editor-transcription-info">{transcriptionInfo}</p>}
          </div>
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
