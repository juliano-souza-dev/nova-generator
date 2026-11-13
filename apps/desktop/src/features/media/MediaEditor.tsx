import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Captions, Check, Clock3, Download, Film, Languages, Pause, Play, Plus, Save, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import { runTrackedTask } from "../tasks/TaskCenter";
import { downloadExternalTranslationPackage, type ExternalTranslationPackage } from "./translationPackage";

type Cue = { id: string; startMs: number; endMs: number; text: string; words?: { text: string; startMs: number; endMs: number }[] };
type TranscriptResult = { engine: string; model: string; language?: string | null; durationMs: number; cues: Cue[] };
type TranslationCue = { id: string; startMs: number; endMs: number; text: string };
type Asset = { id: string; name: string; durationMs?: number | null; sourceStartMs?: number | null; sourceEndMs?: number | null };
const fmt = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0") + "." + String(Math.floor(ms % 1000 / 100));
};

export default function MediaEditor({ projectId, asset, onClose }: { projectId: string; asset: Asset; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const translationFileInput = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [translations, setTranslations] = useState<TranslationCue[]>([]);
  const [translationDirty, setTranslationDirty] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [preparingExternalPackage, setPreparingExternalPackage] = useState(false);
  const [includeWordTranslations, setIncludeWordTranslations] = useState(true);
  const [includeSemanticUnits, setIncludeSemanticUnits] = useState(true);
  const [translationInfo, setTranslationInfo] = useState("");
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(asset.durationMs ?? 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTrack, setActiveTrack] = useState<"video" | "transcript" | "translation" | "wordbyword">("video");
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
        const [path, stored, storedTranslations] = await Promise.all([
          invoke<string>("open_project_media", { projectId, assetId: asset.id }),
          invoke<Cue[]>("load_project_subtitles", { projectId, assetId: asset.id }),
          invoke<TranslationCue[]>("load_project_translations", { projectId, assetId: asset.id }).catch(() => [] as TranslationCue[])
        ]);
        if (!alive) return;
        setSrc(convertFileSrc(path));
        setCues(stored);
        setTranslations(storedTranslations);
        setSelected(stored[0]?.id ?? null);
        if (stored.length) setActiveTrack("transcript");
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
      await runTrackedTask("export", "Salvar transcrição e tradução", async () => {
        await invoke("save_project_subtitles", { projectId, assetId: asset.id, cues });
        if (translations.length > 0 || translationDirty) {
          await invoke("save_project_translations", { projectId, assetId: asset.id, translations });
        }
      });
      setSaved(true);
      setDirty(false);
      setTranslationDirty(false);
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

  async function translateAll() {
    if (translating || loading || cues.length === 0) return;
    if (translations.length && !window.confirm("Gerar novamente substituirá as traduções atuais. A transcrição original será preservada. Continuar?")) return;
    setTranslating(true); setError(""); setTranslationInfo("");
    try {
      const result = await runTrackedTask("translation", "Traduzir transcrição para PT-BR", () =>
        invoke<TranslationCue[]>("translate_project_subtitles", { projectId, assetId: asset.id, cues }));
      setTranslations(result);
      setTranslationDirty(true); setDirty(true); setSaved(false);
      setTranslationInfo(result.length + " trechos traduzidos para português brasileiro. Revise e salve.");
    } catch (e) { setError(String(e)); }
    finally { setTranslating(false); }
  }

  async function downloadExternalPackage() {
    if (preparingExternalPackage || loading || cues.length === 0) return;
    setPreparingExternalPackage(true); setError("");
    try {
      const pkg = await invoke<ExternalTranslationPackage>("prepare_external_translation_package", {
        projectId, assetId: asset.id, cues, includeWordTranslations, includeSemanticUnits
      });
      downloadExternalTranslationPackage(pkg);
      setTranslationInfo("Pacote editorial 1.3 preparado. Envie o ZIP para a IA externa e importe o output.json retornado.");
    } catch (e) { setError("Não foi possível preparar o pacote externo: " + String(e)); }
    finally { setPreparingExternalPackage(false); }
  }

  function updateTranslation(id: string, text: string) {
    setTranslations(items => items.map(item => item.id === id ? { ...item, text } : item));
    setTranslationDirty(true); setDirty(true); setSaved(false);
  }

  async function importTranslations(file?: File) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const items = Array.isArray(parsed) ? parsed : (parsed.translations ?? parsed.suggestions ?? parsed.cues);
      if (!Array.isArray(items)) throw new Error("O JSON precisa conter uma lista de traduções.");
      const byId = new Map<string, string>();
      for (const item of items) {
        const id = String(item.id ?? item.cue_id ?? "");
        const text = String(item.text ?? item.translation ?? item.approved_pt ?? item.pt ?? "");
        if (!id || !text.trim()) continue;
        byId.set(id, text.trim());
      }
      const imported = cues.filter(cue => byId.has(cue.id)).map(cue => ({
        id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: byId.get(cue.id)!
      }));
      if (!imported.length) throw new Error("Nenhum ID do JSON corresponde aos trechos desta transcrição.");
      if (imported.length !== cues.length) throw new Error("O arquivo contém " + imported.length + " traduções correspondentes para " + cues.length + " trechos. Importe um JSON completo com os mesmos IDs.");
      setTranslations(imported); setTranslationDirty(true); setDirty(true); setSaved(false);
      setTranslationInfo(imported.length + " traduções importadas. Revise e salve.");
    } catch (e) { setError("Falha ao importar JSON: " + String(e)); }
    finally { if (translationFileInput.current) translationFileInput.current.value = ""; }
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

  const trackNames = [
    { id: "video" as const, label: "Video", icon: Film },
    { id: "transcript" as const, label: "Transcrição", icon: Captions },
    { id: "translation" as const, label: "Tradução", icon: Languages },
    { id: "wordbyword" as const, label: "WordByWord", icon: Clock3 }
  ];
  const pct = (ms: number) => duration > 0 ? Math.max(0, Math.min(100, ms / duration * 100)) : 0;

  return <div className="media-editor-backdrop">
    <section className="media-editor media-editor-v2" role="dialog" aria-modal="true" aria-label="Editor de mídia">
      <header className="media-editor-header">
        <button className="media-editor-back" onClick={() => { if (!dirty || window.confirm("Há alterações na transcrição ou tradução não salvas. Fechar mesmo assim?")) onClose(); }}><ArrowLeft size={16}/> Biblioteca</button>
        <div className="media-editor-title"><span className="eyebrow">EDITOR DE MÍDIA</span><strong>{asset.name}</strong></div>
        <div className="media-editor-actions">
          {saved && <span className="media-editor-saved"><Check size={13}/> Salvo</span>}
          <button className="primary-button" onClick={() => void save()} disabled={saving || loading}><Save size={15}/> {saving ? "Salvando..." : "Salvar"}</button>
          <button className="icon-button" title="Fechar editor" onClick={() => { if (!dirty || window.confirm("Há alterações na transcrição ou tradução não salvas. Fechar mesmo assim?")) onClose(); }}><X size={18}/></button>
        </div>
      </header>
      {error && <div className="media-editor-error">{error}</div>}
      <div className="media-editor-main media-editor-main-v2">
        <main className="media-editor-workarea">
          <section className="media-editor-preview-v2">
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
            </> : <div className="media-editor-placeholder">Não foi possível abrir o vídeo.</div>}
          </section>

          <section className="media-editor-timeline-dock">
            <div className="media-editor-timeline-toolbar">
              <div><span className="eyebrow">LINHA DO TEMPO</span><strong>Composição do projeto</strong></div>
              <span className="media-editor-timecode">{fmt(current)} / {fmt(duration)}</span>
            </div>
            <div className="media-editor-ruler-v2">
              <span>00:00</span><span>{fmt(duration / 4)}</span><span>{fmt(duration / 2)}</span><span>{fmt(duration * .75)}</span><span>{fmt(duration)}</span>
            </div>
            <div className="media-editor-tracks">
              {trackNames.map(({ id, label, icon: Icon }) => <div className={`media-editor-track-row ${activeTrack === id ? "is-active" : ""}`} key={id}>
                <button className="media-editor-track-label" onClick={() => { setActiveTrack(id); if (id === "video" || id === "wordbyword") setSelected(null); else if (id === "transcript" && !selected && cues[0]) setSelected(cues[0].id); else if (id === "translation" && !selected && translations[0]) setSelected(translations[0].id); }}>
                  <Icon size={14}/><span>{label}</span>
                </button>
                <div className="media-editor-track-lane" onClick={() => setActiveTrack(id)}>
                  {id === "video" && <button className={`media-editor-track-clip video-clip ${activeTrack === "video" ? "selected" : ""}`} style={{ left: "0%", width: "100%" }} onClick={() => { setActiveTrack("video"); setSelected(null); seek(0); }} title={asset.name}><Film size={12}/><span>{asset.name}</span></button>}
                  {id === "transcript" && cues.map(c => <button key={c.id} className={`media-editor-track-clip transcript-clip ${selected === c.id ? "selected" : ""}`} style={{ left: `${pct(c.startMs)}%`, width: `${Math.max(.7, pct(c.endMs - c.startMs))}%` }} onClick={() => { setActiveTrack("transcript"); setSelected(c.id); seek(c.startMs); }} title={c.text || "Trecho sem texto"}><span>{c.text || "Trecho"}</span></button>)}
                  {id === "translation" && (translations.length ? translations.map(t => <button key={t.id} className={"media-editor-track-clip translation-clip " + (selected === t.id ? "selected" : "")} style={{ left: pct(t.startMs) + "%", width: Math.max(.7, pct(t.endMs - t.startMs)) + "%" }} onClick={() => { setActiveTrack("translation"); setSelected(t.id); seek(t.startMs); }} title={t.text}><span>{t.text}</span></button>) : <span className="media-editor-track-empty">Traduções aparecerão aqui</span>)}
                  {id === "wordbyword" && <span className="media-editor-track-empty">Palavras sincronizadas aparecerão aqui</span>}
                  <div className="media-editor-lane-playhead" style={{ left: `${pct(current)}%` }}/>
                </div>
              </div>)}
            </div>
            <input className="media-editor-scrubber" aria-label="Navegar pela timeline" type="range" min="0" max={Math.max(1, duration)} step="50" value={Math.min(current, duration || current)} onChange={e => seek(Number(e.target.value))}/>
          </section>
        </main>

        <aside className="media-editor-inspector">
          <div className="media-editor-inspector-head">
            <span className="eyebrow">PROPRIEDADES</span>
            <h3>{trackNames.find(t => t.id === activeTrack)?.label}</h3>
            <p>Selecione um elemento na timeline para editar suas propriedades.</p>
          </div>

          {activeTrack === "video" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-card"><Film size={18}/><strong>{asset.name}</strong><span>Mídia de origem do projeto</span></div>
            <div className="media-editor-property"><span>Duração</span><strong>{fmt(duration)}</strong></div>
            <div className="media-editor-property"><span>Posição atual</span><strong>{fmt(current)}</strong></div>
            <div className="media-editor-inspector-note">O clipe original é preservado. Os recortes e posicionamentos da timeline serão configurados como elementos independentes, sem modificar o arquivo-fonte.</div>
          </div>}

          {activeTrack === "transcript" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Transcrição</strong><button className="primary-button" onClick={addCue} disabled={loading}><Plus size={13}/> Novo trecho</button></div>
              {chosen ? <>
                <div className="media-editor-time-fields">
                  <label>Início (ms)<input type="number" min="0" value={chosen.startMs} onChange={e => updateCue(chosen.id, { startMs: Math.max(0, Math.min(Number(e.target.value), chosen.endMs - 100)) })}/></label>
                  <label>Fim (ms)<input type="number" min="1" value={chosen.endMs} onChange={e => updateCue(chosen.id, { endMs: Math.max(chosen.startMs + 100, Number(e.target.value)) })}/></label>
                </div>
                <label className="media-editor-text-label">Texto reconhecido<textarea value={chosen.text} onChange={e => updateCue(chosen.id, { text: e.target.value })} placeholder="Texto da transcrição..."/></label>
                <div className="media-editor-cue-buttons"><button onClick={() => seek(chosen.startMs)}><Clock3 size={13}/> Ir ao início</button><button className="danger" onClick={() => { setCues(items => items.filter(c => c.id !== chosen.id)); setSelected(null); setSaved(false); setDirty(true); }}><Trash2 size={13}/> Excluir trecho</button></div>
                <div className="media-editor-inspector-note">{chosen.words?.length ?? 0} palavras identificadas. A edição deste trecho não altera as faixas de tradução ou WordByWord.</div>
              </> : <div className="media-editor-no-cue"><Captions size={22}/><strong>Nenhum trecho selecionado</strong><span>Selecione um bloco na faixa ou crie um novo trecho.</span></div>}
            </div>
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Gerar transcrição</strong></div>
              <div className="media-editor-transcription-options">
                <label>Modo<select value={transcriptionMode} onChange={e => setTranscriptionMode(e.target.value as "auto" | "cloud" | "local")}><option value="auto">Automático (Groq + fallback)</option><option value="cloud">Nuvem (Groq Whisper)</option><option value="local">Local (Faster-Whisper)</option></select></label>
                <label>Idioma<select value={transcriptionLanguage} onChange={e => setTranscriptionLanguage(e.target.value)}><option value="">Detectar automaticamente</option><option value="pt">Português</option><option value="en">Inglês</option><option value="es">Espanhol</option><option value="fr">Francês</option><option value="de">Alemão</option><option value="it">Italiano</option></select></label>
                {(transcriptionMode === "local" || transcriptionMode === "auto") && <label>Modelo local<select value={transcriptionModel} onChange={e => setTranscriptionModel(e.target.value)}><option value="tiny">Tiny · mais rápido</option><option value="base">Base</option><option value="small">Small · equilibrado</option><option value="medium">Medium</option><option value="large-v3">Large v3 · mais preciso</option></select></label>}
              </div>
              {(transcriptionMode === "local" || transcriptionMode === "auto") && <div className="media-editor-asr-status"><span>{localAsrChecking ? "Verificando mecanismo local..." : localAsrReady ? "Faster-Whisper instalado" : "Faster-Whisper não instalado"}</span>{!localAsrChecking && !localAsrReady && <button onClick={() => void installLocalAsr()} disabled={installingAsr}>{installingAsr ? "Instalando..." : "Instalar suporte local"}</button>}</div>}
              <button className="primary-button media-editor-transcribe-button" onClick={() => void transcribe()} disabled={loading || transcribing || (transcriptionMode === "local" && !localAsrReady)}><Captions size={15}/>{transcribing ? "Transcrevendo..." : "Iniciar transcrição"}</button>
              {transcriptionInfo && <p className="media-editor-transcription-info">{transcriptionInfo}</p>}
            </div>
          </div>}

          {activeTrack === "translation" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Tradução para PT-BR</strong><span className="media-editor-translation-count">{translations.length}/{cues.length}</span></div>
              <p className="media-editor-translation-help">A tradução e as predições editoriais seguem o contrato 1.3. Groq e IA externa recebem a mesma entrada e as mesmas regras.</p>
              <div className="media-editor-contract-options">
                <label><input type="checkbox" checked={includeWordTranslations} onChange={e => setIncludeWordTranslations(e.target.checked)}/> Traduções palavra por palavra</label>
                <label><input type="checkbox" checked={includeSemanticUnits} onChange={e => setIncludeSemanticUnits(e.target.checked)}/> Sugestões de unidades semânticas</label>
              </div>
              <button className="primary-button media-editor-transcribe-button" onClick={() => void translateAll()} disabled={loading || translating || cues.length === 0}><Languages size={15}/>{translating ? "Traduzindo..." : translations.length ? "Gerar tradução novamente" : "Traduzir com Groq"}</button>
              <button className="media-editor-secondary-action" onClick={() => void downloadExternalPackage()} disabled={loading || preparingExternalPackage || cues.length === 0}><Download size={14}/>{preparingExternalPackage ? "Preparando pacote..." : "Baixar pacote para IA externa"}</button>
              <input ref={translationFileInput} type="file" accept=".json,application/json" hidden onChange={e => void importTranslations(e.target.files?.[0])}/>
              <button className="media-editor-secondary-action" onClick={() => translationFileInput.current?.click()} disabled={loading || cues.length === 0}>Importar resultado JSON</button>
              {translationInfo && <p className="media-editor-transcription-info">{translationInfo}</p>}
            </div>
            {chosen ? <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Trecho selecionado</strong><button className="media-editor-inline-link" onClick={() => { setActiveTrack("transcript"); seek(chosen.startMs); }}>Ver original</button></div>
              <div className="media-editor-source-text">{chosen.text}</div>
              <label className="media-editor-text-label">Tradução em português<textarea value={translations.find(t => t.id === chosen.id)?.text ?? ""} onChange={e => {
                const existing = translations.find(t => t.id === chosen.id);
                if (existing) updateTranslation(chosen.id, e.target.value);
                else { setTranslations(items => [...items, { id: chosen.id, startMs: chosen.startMs, endMs: chosen.endMs, text: e.target.value }].sort((a,b) => a.startMs-b.startMs)); setTranslationDirty(true); setDirty(true); setSaved(false); }
              }} placeholder="A tradução deste trecho aparecerá aqui..."/></label>
              <div className="media-editor-inspector-note">Editar esta tradução não modifica o texto reconhecido nem os tempos da transcrição.</div>
            </div> : <div className="media-editor-no-cue"><Languages size={22}/><strong>Nenhum trecho selecionado</strong><span>Selecione um bloco na faixa de tradução ou na transcrição.</span></div>}
          </div>}
          {activeTrack === "wordbyword" && <div className="media-editor-inspector-content"><div className="media-editor-inspector-empty"><Clock3 size={24}/><strong>Faixa WordByWord</strong><span>As palavras serão elementos individuais, com tradução própria e sincronização com a palavra original.</span><small>A edição palavra por palavra ainda não foi conectada.</small></div></div>}
        </aside>
      </div>
    </section>
  </div>;
}
