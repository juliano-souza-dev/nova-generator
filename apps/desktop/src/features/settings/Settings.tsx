import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, AudioLines, Check, ChevronRight, Cloud, Download, KeyRound, RefreshCw, Settings2, ShieldCheck, Volume2, WandSparkles } from "lucide-react";
import "./Settings.css";

type Dependency = { id: string; required: boolean; version?: string | null; installed: boolean; path?: string | null };
type Provider = { id: string; name: string; endpoint: string; model: string; authorized_apps: string[]; updated_at: number };
type Voice = { id: string; name: string; duration_seconds?: number; model_id?: string };
type Queue = { status?: string; progress?: number | null; current?: string; completed?: number; total?: number; results?: Array<{id?:string;status?:string;message?:string}> };
type CatalogProvider = { id: string; name: string; endpoint: string; defaultModel: string; models?: string[]; keyUrl?: string };
type Snapshot = { root: string; dependencies: Dependency[]; providers: Provider[]; providerCatalog: { providers: CatalogProvider[] }; voices: { default_voice_id?: string | null; voices?: Voice[] }; queue: Queue };

type Tab = "dependencies" | "voices" | "providers";

export default function Settings({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("voices");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providerId, setProviderId] = useState("groq");
  const [providerName, setProviderName] = useState("Groq");
  const [endpoint, setEndpoint] = useState("https://api.groq.com/openai/v1");
  const [model, setModel] = useState("llama-3.3-70b-versatile");
  const [apiKey, setApiKey] = useState("");
  const [voiceMode, setVoiceMode] = useState<"clone" | "design">("clone");
  const [voiceName, setVoiceName] = useState("");
  const [voiceInstruction, setVoiceInstruction] = useState("");
  const [voiceAudio, setVoiceAudio] = useState<File | null>(null);
  const [voiceReferenceText, setVoiceReferenceText] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await invoke<Snapshot>("get_shared_settings");
      setSnapshot(data);
      setError("");
    } catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const queue = snapshot?.queue;
  const queueActive = queue?.status === "queued" || queue?.status === "installing" || queue?.status === "running" || queue?.status === "cancelling";
  useEffect(() => {
    if (!queueActive) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await invoke<Queue>("shared_dependency_queue_status");
        setSnapshot(current => current ? { ...current, queue: next } : current);
        if (next.status === "completed" || next.status === "error" || next.status === "cancelled") await refresh();
      } catch { /* the next poll retries */ }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [queueActive, refresh]);

  const selectedCatalog = useMemo(() => snapshot?.providerCatalog.providers.find(item => item.id === providerId), [snapshot, providerId]);
  function selectProvider(id: string) {
    setProviderId(id);
    const item = snapshot?.providerCatalog.providers.find(provider => provider.id === id);
    if (!item) return;
    setProviderName(item.name);
    setEndpoint(item.endpoint);
    setModel(item.defaultModel);
    setApiKey("");
  }

  async function synchronize() {
    setBusy(true); setError(""); setNotice("");
    try {
      await invoke("synchronize_shared_dependencies");
      setNotice("Sincronização iniciada. O Nova está preparando as dependências necessárias.");
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  async function saveProvider() {
    setBusy(true); setError(""); setNotice("");
    try {
      await invoke("save_shared_api_provider", { provider: providerId, name: providerName, endpoint, model });
      if (apiKey.trim()) await invoke("save_shared_api_key", { provider: providerId, secret: apiKey.trim() });
      await invoke("authorize_shared_api_provider", { provider: providerId });
      setApiKey("");
      setNotice("Provedor salvo e autorizado para uso no Nova Generator.");
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  async function createVoice() {
    if (!voiceName.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (voiceMode === "design") {
        if (!voiceInstruction.trim()) throw new Error("Descreva a voz que deseja criar.");
        await invoke("create_shared_voice_design_profile", { name: voiceName.trim(), instruct: voiceInstruction.trim() });
      } else {
        if (!voiceAudio) throw new Error("Selecione um áudio de referência.");
        if (!voiceReferenceText.trim()) throw new Error("Informe a transcrição exata do áudio.");
        if (voiceAudio.size > 100 * 1024 * 1024) throw new Error("O áudio excede o limite de 100 MB.");
        const audioBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("Não foi possível ler o áudio selecionado."));
          reader.readAsDataURL(voiceAudio);
        });
        await invoke("create_shared_voice_profile", { name: voiceName.trim(), filename: voiceAudio.name, audioBase64, referenceText: voiceReferenceText.trim() });
      }
      setSnapshot(current => current ? { ...current, queue: { status: "running", current: "Preparando perfil de voz..." } } : current);
      setNotice("Preparação da voz iniciada. O perfil aparecerá na biblioteca quando estiver pronto.");
      setVoiceName(""); setVoiceInstruction(""); setVoiceReferenceText(""); setVoiceAudio(null);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  async function setDefaultVoice(id: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await invoke("set_shared_default_voice", { voiceId: id });
      setNotice("Voz padrão atualizada.");
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const voices = snapshot?.voices.voices ?? [];
  const defaultVoice = snapshot?.voices.default_voice_id ?? "";

  return <div className="settings-shell">
    <header className="settings-heading">
      <div className="settings-heading-main"><button className="settings-back" onClick={onBack}><ArrowLeft size={16}/> Voltar aos projetos</button><div className="eyebrow">AMBIENTE DO NOVA</div><h1>Configurações</h1><p>Gerencie os recursos locais, as vozes e os serviços de inteligência artificial.</p></div>
      <button className="settings-refresh" onClick={() => void refresh()} title="Atualizar"><RefreshCw size={16}/></button>
    </header>

    <nav className="settings-tabs">
      <button className={tab === "voices" ? "settings-tab active" : "settings-tab"} onClick={() => setTab("voices")}><AudioLines size={16}/> Biblioteca de vozes</button>
      <button className={tab === "dependencies" ? "settings-tab active" : "settings-tab"} onClick={() => setTab("dependencies")}><Download size={16}/> Biblioteca de dependências</button>
      <button className={tab === "providers" ? "settings-tab active" : "settings-tab"} onClick={() => setTab("providers")}><Cloud size={16}/> Provedores de API</button>
    </nav>

    {error && <div className="settings-alert error">{error}</div>}
    {notice && <div className="settings-alert success">{notice}</div>}

    {tab === "dependencies" && <section className="settings-panel">
      <div className="settings-panel-head"><div><span className="eyebrow">RECURSOS DO SISTEMA</span><h2>Biblioteca de dependências</h2><p>O Nova compara as necessidades declaradas em libs-example.json com o ambiente instalado.</p></div><button className="primary-button" onClick={() => void synchronize()} disabled={busy || queueActive}><RefreshCw size={15}/>{queueActive ? "Sincronizando..." : "Sincronizar dependências"}</button></div>
      {queueActive && <div className="sync-progress"><div className="sync-progress-top"><strong>{queue?.current || "Preparando ambiente..."}</strong><span>{queue?.progress == null ? "Em andamento" : `${queue.progress}%`}</span></div><div className="sync-progress-track"><i style={{width: queue?.progress == null ? "35%" : `${queue.progress}%`}}/></div></div>}
      <div className="dependency-list">{(snapshot?.dependencies ?? []).map(dep => <article className="dependency-row" key={dep.id}><div className="dependency-icon"><Settings2 size={17}/></div><div className="dependency-copy"><strong>{dep.id}</strong><span>{dep.required ? "Necessária para o funcionamento" : "Opcional"}{dep.version ? ` · ${dep.version}` : ""}</span>{dep.path && <small>{dep.path}</small>}</div><span className={dep.installed ? "resource-status ready" : "resource-status pending"}>{dep.installed ? <><Check size={13}/> Instalada</> : "Pendente"}</span></article>)}</div>
      <div className="settings-footnote">Diretório compartilhado: <code>{snapshot?.root ?? "Detectando..."}</code></div>
    </section>}

    {tab === "voices" && <section className="settings-panel">
      <div className="settings-panel-head"><div><span className="eyebrow">SÍNTESE DE ÁUDIO</span><h2>Biblioteca de vozes</h2><p>Perfis preparados pelo Qwen3-TTS e disponibilizados aos módulos do Nova.</p></div><span className="settings-count">{voices.length} {voices.length === 1 ? "voz" : "vozes"}</span></div>
      <div className="voice-create"><div className="voice-create-head"><div><strong>Adicionar perfil de voz</strong><span>Crie uma voz por clonagem de áudio ou por descrição.</span></div><div className="voice-mode-tabs"><button className={voiceMode === "clone" ? "active" : ""} onClick={() => setVoiceMode("clone")}>Clonar voz</button><button className={voiceMode === "design" ? "active" : ""} onClick={() => setVoiceMode("design")}>Voice Design</button></div></div><div className="voice-create-fields"><label>Nome do perfil</label><input value={voiceName} onChange={e => setVoiceName(e.target.value)} placeholder="Ex.: Minha voz em inglês"/>{voiceMode === "clone" ? <><label>Áudio de referência (10 a 200 segundos)</label><input type="file" accept=".mp3,.wav,.m4a,.flac,.ogg,.aac,.wma,audio/*" onChange={e => setVoiceAudio(e.target.files?.[0] ?? null)}/><label>Transcrição exata do áudio</label><textarea rows={3} value={voiceReferenceText} onChange={e => setVoiceReferenceText(e.target.value)} placeholder="Digite exatamente o que é falado no áudio."/></> : <><label>Descrição da voz</label><textarea rows={3} value={voiceInstruction} onChange={e => setVoiceInstruction(e.target.value)} placeholder="Descreva idioma, timbre, ritmo, idade vocal percebida e estilo de fala."/></>}</div><button className="primary-button voice-create-button" onClick={() => void createVoice()} disabled={busy || !voiceName.trim()}><WandSparkles size={15}/>{busy ? "Preparando..." : "Preparar perfil"}</button></div>{voices.length ? <div className="voice-list">{voices.map(voice => <article className="voice-row" key={voice.id}><div className="voice-avatar"><Volume2 size={18}/></div><div className="voice-copy"><strong>{voice.name}</strong><span>{voice.model_id?.includes("VoiceDesign") ? "Voice Design" : "Clonagem de voz"}{voice.duration_seconds ? ` · ${Math.round(voice.duration_seconds)}s de referência` : ""}</span></div>{defaultVoice === voice.id ? <span className="default-voice"><Check size={13}/> Padrão</span> : <button className="text-action" onClick={() => void setDefaultVoice(voice.id)} disabled={busy}>Definir como padrão</button>}</article>)}</div> : <div className="settings-empty"><AudioLines size={24}/><strong>Nenhuma voz preparada</strong><span>Sincronize as dependências de áudio para preparar e adicionar perfis à biblioteca.</span></div>}
    </section>}

    {tab === "providers" && <section className="settings-panel">
      <div className="settings-panel-head"><div><span className="eyebrow">INTELIGÊNCIA ARTIFICIAL</span><h2>Provedores de API</h2><p>Configure endpoints, modelos e credenciais usados pelos módulos do Nova.</p></div><span className="settings-count">{snapshot?.providers.length ?? 0} configurados</span></div>
      <div className="provider-layout">
        <div className="provider-list">{(snapshot?.providers ?? []).map(provider => <article className="provider-row" key={provider.id}><div className="provider-logo"><Cloud size={17}/></div><div className="provider-copy"><strong>{provider.name}</strong><span>{provider.model}</span><small>{provider.endpoint}</small></div>{provider.authorized_apps.includes("nova-generator") ? <span className="default-voice"><ShieldCheck size={13}/> Autorizado</span> : <span className="resource-status pending">Não autorizado</span>}</article>)}{!snapshot?.providers.length && <div className="settings-empty compact">Nenhum provedor configurado.</div>}</div>
        <div className="provider-form">
          <div className="form-title"><KeyRound size={16}/> Configurar provedor</div>
          <label>Serviço</label><select value={providerId} onChange={e => selectProvider(e.target.value)}>{(snapshot?.providerCatalog.providers ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <label>Nome de exibição</label><input value={providerName} onChange={e => setProviderName(e.target.value)}/>
          <label>Endpoint</label><input value={endpoint} onChange={e => setEndpoint(e.target.value)}/>
          <label>Modelo</label><input list="provider-models" value={model} onChange={e => setModel(e.target.value)}/><datalist id="provider-models">{(selectedCatalog?.models ?? []).map(item => <option key={item} value={item}/>)}</datalist>
          <label>Chave de API</label><input type="password" autoComplete="off" placeholder="Cole sua chave de API" value={apiKey} onChange={e => setApiKey(e.target.value)}/>
          <button className="primary-button provider-save" onClick={() => void saveProvider()} disabled={busy || !providerName.trim() || !endpoint.trim() || !model.trim()}><Check size={15}/> Salvar e autorizar no Nova</button>
          {selectedCatalog?.keyUrl && <a href={selectedCatalog.keyUrl} target="_blank" rel="noreferrer">Obter chave de API <ChevronRight size={13}/></a>}
        </div>
      </div>
      <p className="settings-footnote">As chaves são armazenadas pelo gerenciador seguro do sistema operacional. Elas não são exibidas novamente nesta tela.</p>
    </section>}
  </div>;
}
