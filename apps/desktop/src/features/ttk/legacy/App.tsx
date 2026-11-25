import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { desktopApi, isDesktopRuntime } from "./services/desktop-api";
import EditorWorkspace, { supportedLucideIconNames } from "./EditorWorkspace";
import type { MediaAsset, Project } from "./shared/types";
import { useTranscription } from "./features/transcription/useTranscription";
import { useGroqSettings } from "./features/groq/useGroqSettings";
import { useYoutubeImport } from "./features/youtube/useYoutubeImport";
import { validateSceneSpec, type SceneSpec } from "./shared/scene-spec";
import { buildSceneSpecProjectData, getSceneSpecMediaSources } from "./features/scene-spec/project-import";
import { Clapperboard, LayoutGrid, Film, GraduationCap, Settings2, Plus, Search, FolderOpen, FolderPlus, Clock3, Video, Sparkles, Play, X, ArrowUpRight, Upload, Youtube, CheckCircle2, LoaderCircle, ShieldCheck, Link2, Download, Undo2, Redo2, ArrowLeft, FileJson, Info } from "lucide-react"

const formatDuration = (n?:number|null) => !n ? "Duração não informada" : Math.floor(n/60000)+":"+String(Math.floor(n/1000)%60).padStart(2,"0");
const formatTimecode = (n:number) => Math.floor(n/60000)+":"+String(Math.floor(n/1000)%60).padStart(2,"0")+"."+String(Math.floor(n%1000)).padStart(3,"0");

export default function App({ embeddedProjectId, onBack }: { embeddedProjectId: string; onBack?: () => void }) {
  const [projects,setProjects] = useState<Project[]>([]);
  const [name,setName] = useState("");
  const [search,setSearch] = useState("");
  const [creating,setCreating] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [activeProject,setActiveProject] = useState<Project|null>(null);
  const [view,setView] = useState<"workspace"|"project">("project");
  const [assets,setAssets] = useState<MediaAsset[]>([]);
  const [mediaModal,setMediaModal] = useState(false);
  const [mediaTab,setMediaTab] = useState<"local"|"youtube">("local");
  const [notice,setNotice] = useState("");
  const {
    youtubeUrl, setYoutubeUrl, youtubeInfo, setYoutubeInfo, quality, setQuality,
    progress, setProgress, youtubeCache, setYoutubeCache, trimStartMs, setTrimStartMs,
    trimEndMs, setTrimEndMs, trimBusy, trimVideoRef, outputRatio, setOutputRatio, frameMode, setFrameMode, frameColor, setFrameColor,
    inspectYoutube, downloadYoutube, confirmYoutubeTrim
  } = useYoutubeImport({ project: activeProject, setAssets, setBusy, setError, setNotice, setMediaModal });
  const sceneSpecProjectInput = useRef<HTMLInputElement|null>(null);
  const {
    groqSettingsOpen, setGroqSettingsOpen,
    groqModel, groqMaxChars, setGroqMaxChars, groqMaxCues, setGroqMaxCues,
    groqDelay, setGroqDelay, groqLanguage, setGroqLanguage, groqSettingsBusy,
    groqSettingsMessage, openGroqSettings, saveAndTestGroq
  } = useGroqSettings();
  const {
    transcriptionAssetId, setTranscriptionAssetId,
    transcriptionContext, setTranscriptionContext,
    transcriptionMode, setTranscriptionMode, transcriptionLanguage, setTranscriptionLanguage,
    transcriptionModel, setTranscriptionModel, transcriptionBusy, transcriptionProgress, setTranscriptionProgress,
    localAsrInstalled, localAsrChecking, localAsrInstalling, transcriptionMessage, setTranscriptionMessage,
    installLocalTranscription, transcribeSelectedMedia,
    transcriptionResult, transcriptionTranslations, translationBusy, alignmentBusy, externalPackageBusy, externalSourceHash, transcriptionInserted, openTranscriptionForClip, loadExistingTranscript, translateTranscription, alignTranscriptionWords, downloadExternalPackage, importExternalTranslation, insertTranscription, updateTranscriptionCue
  } = useTranscription(activeProject, assets);

  async function refresh() {
    if (!isDesktopRuntime) return;
    try { setProjects(await desktopApi.listProjects()); }
    catch (e) { setError(String(e)); }
  }
  useEffect(()=>{
    let cancelled=false;
    async function openEmbeddedProject(){
      if(!isDesktopRuntime) return;
      try {
        const opened=await desktopApi.openProject(embeddedProjectId);
        const projectAssets=await desktopApi.listProjectAssets(opened.id);
        if(cancelled) return;
        setProjects([opened]);
        setActiveProject(opened);
        setAssets(projectAssets);
        setView("project");
      } catch(e){ if(!cancelled) setError(String(e)); }
    }
    void openEmbeddedProject();
    return ()=>{cancelled=true;};
  },[embeddedProjectId]);
  useEffect(()=>{
    let disposed=false;
    let unlisten:(()=>void)|undefined;
    void desktopApi.subscribeToYoutubeProgress(progressEvent=>{
      if(progressEvent.projectId===activeProject?.id) setProgress(progressEvent);
    }).then(fn=>{ if(disposed) fn(); else unlisten=fn; });
    return ()=>{disposed=true;unlisten?.();};
  },[activeProject?.id]);

  useEffect(()=>{
    let disposed=false;
    let unlisten:(()=>void)|undefined;
    void desktopApi.subscribeToTranscriptionProgress(event=>{
      if(event.projectId===activeProject?.id) setTranscriptionProgress(event);
    }).then(fn=>{ if(disposed) fn(); else unlisten=fn; });
    return ()=>{disposed=true;unlisten?.();};
  },[activeProject?.id]);

  async function refreshAssets(project:Project) {
    if(!isDesktopRuntime) return;
    try { setAssets(await desktopApi.listProjectAssets(project.id)); }
    catch(e) { setError(String(e)); }
  }
  async function selectProject(project:Project) {
    setBusy(true); setError("");
    try {
      const opened=await desktopApi.openProject(project.id);
      setActiveProject(opened); setNotice("");
      window.localStorage.setItem("ttk-creator:last-open-project",opened.id);
      await refreshAssets(opened);
      setView("project");
    } catch(e){ setError(String(e)); }
    finally { setBusy(false); }
  }
  function returnToWorkspace(){ return; }
  async function importLocalFiles() {
    if(!activeProject) return;
    setBusy(true); setError("");
    try {
      const selected=await open({multiple:true,directory:false,title:"Importar mídia",filters:[{name:"Arquivos de mídia",extensions:["mp4","mov","m4v","mkv","webm","avi","mp3","wav","m4a","aac","flac","ogg","opus","png","jpg","jpeg","webp","gif","bmp"]}]});
      if(!selected) return;
      const paths=Array.isArray(selected)?selected:[selected];
      const imported=await desktopApi.importMediaFiles(activeProject.id,paths);
      setAssets(current=>[...imported,...current]); setNotice(imported.length+" arquivo(s) importado(s)."); setMediaModal(false);
    } catch(e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function createProject(e:FormEvent) {
    e.preventDefault();
    if (!name.trim() || !isDesktopRuntime) return;
    setBusy(true); setError("");
    try {
      const project = await desktopApi.createProject(name.trim());
      setProjects(p=>[project,...p]); setName(""); setCreating(false); setActiveProject(project); setAssets([]);
      window.localStorage.setItem("ttk-creator:last-open-project",project.id); setView("project");
    } catch(e) { setError(String(e)); }
    finally { setBusy(false); }
  }


  async function importSceneSpecProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !isDesktopRuntime) return;
    setBusy(true); setError(""); setNotice("");
    let createdProject: Project | null = null;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!validateSceneSpec(parsed)) throw new Error("Arquivo inválido. Selecione um Scene Spec versão 1.0 com cenas e blocos válidos.");
      const spec: SceneSpec = parsed;
      const unsupportedIcons = [...new Set(spec.scenes.flatMap(scene => scene.blocks.map(block => block.iconName).filter((name): name is string => !!name && !supportedLucideIconNames.includes(name))))];
      if (unsupportedIcons.length) throw new Error("O arquivo usa ícones que não existem na biblioteca atual do FrameLab: " + unsupportedIcons.join(", "));
      if (spec.project?.aspectRatio && spec.project.aspectRatio !== "9:16") {
        throw new Error('Este editor ainda trabalha com canvas vertical 9:16. Ajuste project.aspectRatio para "9:16" antes de importar.');
      }
      const projectName = spec.project?.title?.trim() || file.name.replace(/\.json$/i, "") || "Projeto Scene Spec";
      createdProject = await desktopApi.createProject(projectName);
      const projectMediaSources = getSceneSpecMediaSources(spec);
      let importedAssets: MediaAsset[] = [];
      if (projectMediaSources.length) importedAssets = await desktopApi.importMediaFiles(createdProject.id, projectMediaSources);
      const { motion, clips, captionCount, characterRefs } = buildSceneSpecProjectData(spec, importedAssets);

      window.localStorage.setItem("ttk-creator:motion:" + createdProject.id, JSON.stringify(motion));
      window.localStorage.setItem("ttk-creator:timeline:" + createdProject.id, JSON.stringify(clips));
      window.localStorage.setItem("ttk-creator:groups:" + createdProject.id, JSON.stringify([]));
      window.localStorage.setItem("ttk-creator:session:" + createdProject.id, JSON.stringify({ playheadMs: 0, timelineZoom: 100, activeTool: "text", savedAt: Date.now() }));
      window.localStorage.setItem("ttk-creator:scene-spec:" + createdProject.id, JSON.stringify(spec));
      const refreshedAssets = await desktopApi.listProjectAssets(createdProject.id);
      setProjects(current => [createdProject!, ...current]);
      setActiveProject(createdProject);
      setAssets(refreshedAssets);
      window.localStorage.setItem("ttk-creator:last-open-project", createdProject.id);
      setView("project");
      const audioCount = clips.length;
      setNotice("Projeto criado pelo Scene Spec: " + spec.scenes.length + " cenas, " + motion.length + " elementos gráficos, " + captionCount + " legendas e " + audioCount + " faixa(s) de áudio." + (characterRefs ? " " + characterRefs + " mídia(s) de personagem foram importadas para a biblioteca, mas ainda não são exibidas como camada sobre o vídeo." : ""));
    } catch (error) {
      if (createdProject) {
        setProjects(current => [createdProject!, ...current]);
        setActiveProject(createdProject);
        try { setAssets(await desktopApi.listProjectAssets(createdProject.id)); } catch { setAssets([]); }
        window.localStorage.setItem("ttk-creator:last-open-project", createdProject.id);
        setView("project");
      }
      setError("Não foi possível criar o projeto a partir do Scene Spec: " + (error instanceof Error ? error.message : String(error)));
    } finally { setBusy(false); }
  }


  const visible = projects.filter(p=>p.name.toLowerCase().includes(search.toLowerCase()));
  return <><main className={"shell " + (view === "project" ? "project-shell" : "")}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Clapperboard size={21}/></div><div><b>FRAME<span>LAB</span></b><small>CREATOR STUDIO</small></div></div>
      <label className="side-label">WORKSPACE</label>
      {!embeddedProjectId && <><button className={"nav "+(view==="workspace"?"active":"")} onClick={returnToWorkspace}><LayoutGrid size={17}/> Visão geral</button>
      <button className={"nav "+(view==="workspace"?"":"active")} onClick={returnToWorkspace}><Film size={17}/> Meus projetos</button></>}
      <div className="side-rule"/>
      <label className="side-label">COMECE POR AQUI</label>
      <div className="tip-card"><div className="tip-icon"><GraduationCap size={19}/></div><b>Conteúdo que ensina</b><p>Crie vídeos com cenas, narração e legendas sincronizadas.</p><button onClick={()=>setCreating(true)}>Criar projeto <ArrowUpRight size={14}/></button></div>
      <div className="profile"><div className="avatar">J</div><div><b>Seu estúdio</b><small>Ambiente local</small></div><Settings2 size={17}/></div>
    </aside>
    <section className="main">
      <header className="topbar"><div className="topbar-location">{embeddedProjectId ? <button className="secondary-action back-to-projects ttk-home-back" onClick={onBack} title="Voltar para a página inicial do Nova Generator" aria-label="Voltar para a página inicial do Nova Generator"><ArrowLeft size={17}/></button> : <>{view==="project"&&<button className="secondary-action back-to-projects" onClick={returnToWorkspace} title="Voltar para a página de projetos"><ArrowLeft size={15}/> Projetos</button>}<span>Workspace</span> <span>/</span> <b>{view==="project"&&activeProject?activeProject.name:"Visão geral"}</b></>}</div><div className="top-right"><button className="secondary-action" disabled={busy} onClick={()=>sceneSpecProjectInput.current?.click()} title="Criar um projeto novo a partir de um Scene Spec JSON"><FileJson size={14}/> Criar via JSON</button><input ref={sceneSpecProjectInput} type="file" accept=".json,application/json" style={{display:"none"}} onChange={event=>void importSceneSpecProject(event)}/><button className="secondary-action groq-settings-trigger" onClick={()=>void openGroqSettings()}><Settings2 size={14}/> Groq</button><small><i/> Salvamento automático ativo</small>{view==="project"&&<><button className="secondary-action" disabled title="Histórico de desfazer ainda não disponível"><Undo2 size={15}/> Desfazer</button><button className="secondary-action" disabled title="Histórico de refazer ainda não disponível"><Redo2 size={15}/> Refazer</button></>}</div></header>
      <div className={"content " + (view === "project" ? "project-content" : "")}>
        {view==="workspace" ? <>
        <section className="hero"><div><label className="eyebrow"><Sparkles size={13}/> SEU PRÓXIMO VÍDEO COMEÇA AQUI</label><h1>Boas ideias merecem<br/><em>uma boa edição.</em></h1><p>Seu espaço para transformar ideias em vídeos que prendem a atenção.</p></div><div className="hero-visual"><div className="preview-art"><div className="rec">REC <i/></div><div className="play"><Play size={22} fill="currentColor"/></div><strong>IDEIA <span>EM MOVIMENTO.</span></strong><div className="scrub">00:18 <div><i/><i/><i/><i/><i/></div> 00:55</div></div><div className="float-tag"><Sparkles size={13}/> MAKE IT MATTER</div></div></section>
        <section className="stats"><div><span className="stat-icon purple"><Film size={17}/></span><label>PROJETOS<strong>{String(projects.length).padStart(2,"0")}</strong></label></div><div><span className="stat-icon orange"><Clock3 size={17}/></span><label>FORMATO PADRÃO<strong>9:16 <small>VERTICAL</small></strong></label></div><div><span className="stat-icon green"><Video size={17}/></span><label>SEU ESTÚDIO<strong>LOCAL <small>WINDOWS</small></strong></label></div></section>
        <section className="projects"><div className="section-head"><div><label className="eyebrow muted">BIBLIOTECA</label><h2>Seus projetos</h2></div><label className="search"><Search size={15}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar projeto..."/></label></div>
          {error && !mediaModal && <div className="error">{error}</div>}
          {notice && !mediaModal && <div className="notice"><CheckCircle2 size={15}/>{notice}</div>}
          {visible.length ? <div className="project-grid">{visible.map(p=><article className={"project "+(activeProject?.id===p.id?"selected":"")} key={p.id} role="button" tabIndex={0} aria-disabled={busy} onClick={()=>{if(!busy)void selectProject(p);}} onKeyDown={e=>{if(!busy&&(e.key==="Enter"||e.key===" ")){e.preventDefault();void selectProject(p);}}}><div className="thumb"><div className="thumb-grid"/><div className="thumb-play"><Play size={16} fill="currentColor"/></div><small>9:16</small></div><div className="project-meta"><div><b>{p.name}</b><small>Atualizado em {new Date(Number(p.updatedAt)).toLocaleDateString("pt-BR")}</small></div><span className="project-open-label">Abrir projeto <ArrowUpRight size={13}/></span></div></article>)}</div> :
          <div className="empty"><div className="empty-icon"><FolderOpen size={27}/><i><Plus size={13}/></i></div><b>{search?"Nenhum projeto encontrado":"Seu primeiro projeto começa aqui"}</b><p>{search?"Tente buscar por outro nome.":"Crie um espaço para reunir vídeos, áudios, cenas e ideias."}</p>{!search&&<button className="primary" onClick={()=>setCreating(true)}><FolderPlus size={16}/> Criar meu primeiro projeto</button>}</div>}
        </section>
        </> : activeProject ? <>
        {error&&!mediaModal&&<div className="error editor-error">{error}</div>}
        {notice&&<div className="notice"><CheckCircle2 size={15}/>{notice}</div>}
        <EditorWorkspace projectId={activeProject.id} assets={assets} onAddMedia={()=>{setMediaTab("local");setMediaModal(true);}} onStartTranscription={openTranscriptionForClip} transcription={{transcriptionAssetId,setTranscriptionAssetId,transcriptionContext,setTranscriptionContext,transcriptionMessage,setTranscriptionMessage,transcriptionMode,setTranscriptionMode,transcriptionLanguage,setTranscriptionLanguage,transcriptionModel,setTranscriptionModel,transcriptionBusy,transcriptionProgress,setTranscriptionProgress,localAsrInstalled,localAsrChecking,localAsrInstalling,installLocalTranscription,transcribeSelectedMedia,transcriptionResult,transcriptionTranslations,translationBusy,alignmentBusy,externalPackageBusy,externalSourceHash,transcriptionInserted,openTranscriptionForClip,loadExistingTranscript,translateTranscription,alignTranscriptionWords,downloadExternalPackage,importExternalTranslation,insertTranscription,updateTranscriptionCue}}/>
        </> : null}
        <footer>FRAME LAB · FEITO PARA IDEIAS EM MOVIMENTO <span>EARLY ACCESS · 0.2.0</span></footer>
      </div>
    </section>
    {creating&&<div className="backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setCreating(false);}}><form className="modal" onSubmit={createProject}><button type="button" className="close" onClick={()=>setCreating(false)}><X size={18}/></button><div className="modal-icon"><FolderPlus size={21}/></div><label className="eyebrow muted">NOVO PROJETO</label><h2>Vamos dar forma à ideia?</h2><p>Seu projeto será salvo no computador e poderá ser aberto novamente quando quiser.</p><label className="field-label" htmlFor="project-name">Nome do projeto</label><input id="project-name" autoFocus maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Inglês em 1 minuto"/><div className="canvas-info"><span>Canvas vertical</span><b>1080 × 1920 · 30 FPS</b></div><button className="primary submit" disabled={!name.trim()||busy}>{busy?"Criando...":"Criar projeto"} <ArrowUpRight size={16}/></button></form></div>}
    {mediaModal&&activeProject&&<div className="backdrop media-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setMediaModal(false);}}><section className="media-modal">
      <button type="button" className="close" onClick={()=>!busy&&setMediaModal(false)}><X size={18}/></button><label className="eyebrow muted">ADICIONAR À BIBLIOTECA</label><h2>Importar mídia</h2><p className="media-modal-subtitle">Destino: <strong>{activeProject.name}</strong></p>
      <div className="media-tabs"><button className={mediaTab==="local"?"active":""} onClick={()=>{setMediaTab("local");setError("");}}><FolderOpen size={15}/> Arquivos locais</button><button className={mediaTab==="youtube"?"active":""} onClick={()=>{setMediaTab("youtube");setError("");}}><Youtube size={15}/> YouTube</button></div>
      {mediaTab==="local" ? <div><div className="dropzone"><div className="dropzone-icon"><Upload size={23}/></div><b>Traga seus arquivos para o projeto</b><p>Selecione vídeos, imagens e áudios do computador.</p><button className="primary" disabled={busy} onClick={()=>void importLocalFiles()}>{busy?<LoaderCircle className="spin" size={15}/>:<FolderOpen size={15}/>} Selecionar arquivos</button><small>Até 100 arquivos por importação</small></div><div className="supported-formats"><b>FORMATOS ACEITOS</b><span>Vídeo: MP4, MOV, MKV, WebM, AVI</span><span>Áudio: MP3, WAV, M4A, AAC, FLAC, OGG</span><span>Imagem: PNG, JPG, WebP, GIF, BMP</span></div></div> :
      <div className="youtube-import"><label className="field-label" htmlFor="youtube-url">Link do vídeo</label><div className="youtube-input"><Link2 size={16}/><input id="youtube-url" value={youtubeUrl} onChange={e=>{setYoutubeUrl(e.target.value);setYoutubeInfo(null);}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void inspectYoutube();}}} placeholder="Cole aqui o link do YouTube"/></div><button className="inspect-button" disabled={!youtubeUrl.trim()||busy} onClick={()=>void inspectYoutube()}>{busy&&!progress?<LoaderCircle className="spin" size={15}/>:<Search size={15}/>} Inspecionar vídeo</button>
      {youtubeInfo&&<div className="youtube-preview">{youtubeInfo.thumbnail?<img src={youtubeInfo.thumbnail} alt="Miniatura do vídeo"/>:<div className="youtube-thumb-placeholder"><Youtube size={28}/></div>}<div className="youtube-details"><b>{youtubeInfo.title}</b><span>{youtubeInfo.channel||"Canal não identificado"}</span><small>{formatDuration(youtubeInfo.durationMs)} · ID {youtubeInfo.videoId}</small></div></div>}
      {youtubeInfo&&<div className="quality-row"><label className="field-label" htmlFor="quality-select">Qualidade máxima</label><select id="quality-select" value={quality} onChange={e=>setQuality(Number(e.target.value))}><option value={0}>Melhor disponível</option>{youtubeInfo.qualities.map(q=><option key={q.height} value={q.height}>{q.label}</option>)}</select></div>}
      {progress&&<div className="download-progress"><div className="progress-heading"><b>Baixando vídeo...</b><span>{progress.percent==null?"Preparando":Math.round(progress.percent)+"%"}</span></div><div className="progress-track"><i style={{width:Math.max(0,Math.min(100,progress.percent??0))+"%"}}/></div><small>{progress.speed||"Aguardando dados"} {progress.eta?"· Restante: "+progress.eta:""}</small></div>}
      <div className="youtube-note"><Youtube size={13}/> Importe somente vídeos que você tenha autorização para baixar e reutilizar.</div></div>}
      {error&&<div className="error modal-error">{error}</div>}
      <div className="modal-footer"><button className="cancel-button" disabled={busy} onClick={()=>setMediaModal(false)}>Cancelar</button>{mediaTab==="youtube"&&youtubeInfo&&<button className="primary" disabled={busy} onClick={()=>void downloadYoutube()}>{busy?<><LoaderCircle className="spin" size={15}/> Baixando...</>:<><Download size={15}/> Baixar e escolher trecho</>}</button>}</div>
    </section></div>}

    {youtubeCache&&activeProject&&<div className="backdrop youtube-trim-backdrop">
      <section className="youtube-trim-dialog" role="dialog" aria-modal="true" aria-labelledby="youtube-trim-title">
        <header className="youtube-trim-header">
          <div><label className="eyebrow muted">PREPARAÇÃO DO VÍDEO</label><h2 id="youtube-trim-title">Ajuste o trecho e o formato</h2><p>{youtubeCache.title}</p></div>
          <button className="close" type="button" disabled={trimBusy} onClick={()=>setYoutubeCache(null)}><X size={18}/></button>
        </header>
        <div className={"youtube-format-preview " + (frameMode==="blur"?"blur-background":"")} style={{aspectRatio:"9 / 16",backgroundColor:frameMode==="color"?frameColor:"#000000"}}>
          {frameMode==="blur"&&<video className="youtube-format-preview-background" src={convertFileSrc(youtubeCache.filePath)} muted playsInline preload="metadata" aria-hidden="true"/>}
          <video ref={trimVideoRef} className="youtube-trim-preview" src={convertFileSrc(youtubeCache.filePath)} controls preload="metadata"
            onPlay={event=>{const bg=event.currentTarget.parentElement?.querySelector(".youtube-format-preview-background") as HTMLVideoElement|null;if(bg){bg.currentTime=event.currentTarget.currentTime;void bg.play().catch(()=>{});}}}
            onPause={event=>{const bg=event.currentTarget.parentElement?.querySelector(".youtube-format-preview-background") as HTMLVideoElement|null;bg?.pause();}}
            onSeeking={event=>{const bg=event.currentTarget.parentElement?.querySelector(".youtube-format-preview-background") as HTMLVideoElement|null;if(bg)bg.currentTime=event.currentTarget.currentTime;}}
            onTimeUpdate={event=>{const ms=event.currentTarget.currentTime*1000;if(ms<trimStartMs||ms>trimEndMs)event.currentTarget.pause();const bg=event.currentTarget.parentElement?.querySelector(".youtube-format-preview-background") as HTMLVideoElement|null;if(bg&&Math.abs(bg.currentTime-event.currentTarget.currentTime)>.2)bg.currentTime=event.currentTarget.currentTime;}}
            onLoadedMetadata={event=>{event.currentTarget.currentTime=trimStartMs/1000;const bg=event.currentTarget.parentElement?.querySelector(".youtube-format-preview-background") as HTMLVideoElement|null;if(bg)bg.currentTime=trimStartMs/1000;}} />
        </div>
        <section className="youtube-format-panel">
          <div><label className="eyebrow muted">FORMATO DE SAÍDA</label><h3>Prepare para a plataforma</h3><p>Escolha o formato antes de abrir o editor. A cena original será preservada, sem cortes.</p></div>
          <div className="youtube-format-options"><button type="button" className="selected" aria-pressed="true">9:16 · Vertical</button></div>
          {outputRatio!=="original"&&<div className="youtube-frame-options">
            <label>Como preencher o espaço
              <select value={frameMode} onChange={event=>setFrameMode(event.target.value as "blur"|"contain"|"color")}>
                <option value="blur">Fundo desfocado (recomendado)</option>
                <option value="contain">Fundo preto</option>
                <option value="color">Escolher cor de fundo</option>
              </select>
            </label>
            {frameMode==="color"&&<label className="youtube-color-picker">Cor <input type="color" value={frameColor} onChange={event=>setFrameColor(event.target.value)}/></label>}
          </div>}
          <small className="youtube-format-hint">O editor do TTK trabalha em 9:16 (1080 × 1920). Outros formatos exigem a adaptação do canvas e da exportação completa, por isso não são oferecidos aqui para evitar cortes inesperados.</small>
        </section>
        <div className="youtube-trim-time"><span>INÍCIO <b>{formatTimecode(trimStartMs)}</b></span><span>FIM <b>{formatTimecode(trimEndMs)}</b></span><span>DURAÇÃO <b>{formatTimecode(Math.max(0,trimEndMs-trimStartMs))}</b></span></div>
        <div className="youtube-trim-range">
          <label>Início do trecho <input type="range" min={0} max={Math.max(300,(youtubeCache.durationMs??trimEndMs))} step={100} value={trimStartMs}
            onChange={event=>{const value=Number(event.target.value);setTrimStartMs(Math.min(value,trimEndMs-300));if(trimVideoRef.current)trimVideoRef.current.currentTime=value/1000;}} /></label>
          <label>Fim do trecho <input type="range" min={Math.min(trimStartMs+300,youtubeCache.durationMs??trimEndMs)} max={youtubeCache.durationMs??trimEndMs} step={100} value={trimEndMs}
            onChange={event=>setTrimEndMs(Math.max(trimStartMs+300,Number(event.target.value)))} /></label>
        </div>
        <div className="youtube-trim-timeline"><div className="youtube-trim-track"><i style={{left:((trimStartMs/Math.max(1,youtubeCache.durationMs??trimEndMs))*100)+"%",width:((Math.max(0,trimEndMs-trimStartMs)/Math.max(1,youtubeCache.durationMs??trimEndMs))*100)+"%"}}/></div><small>Arraste os controles para definir o início e o fim. O original não será alterado.</small></div>
        <div className="youtube-cache-note"><Info size={14}/> Original guardado temporariamente. O prazo de 7 dias é renovado quando você tentar baixar este mesmo vídeo novamente.</div>
        {error&&<div className="error modal-error">{error}</div>}
        <div className="modal-footer"><button className="cancel-button" disabled={trimBusy} onClick={()=>setYoutubeCache(null)}>Deixar para depois</button><button className="primary" disabled={trimBusy||trimEndMs-trimStartMs<300} onClick={()=>void confirmYoutubeTrim()}>{trimBusy?<><LoaderCircle className="spin" size={15}/> Preparando vídeo...</>:<><CheckCircle2 size={15}/> Confirmar e preparar vídeo</>}</button></div>
      </section>
    </div>}
    {groqSettingsOpen&&<div className="backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!groqSettingsBusy)setGroqSettingsOpen(false);}}><section className="groq-settings-modal">
      <button type="button" className="close" onClick={()=>!groqSettingsBusy&&setGroqSettingsOpen(false)}><X size={18}/></button>
      <label className="eyebrow muted"><Settings2 size={13}/> INTELIGÊNCIA ARTIFICIAL</label><h2>Configurações da Groq</h2>
      <p>A credencial e o modelo são gerenciados pelo Shared Runtime Manager. O TTK utiliza a configuração local autorizada e não precisa manter o Shared aberto.</p>
      <label className="field-label" htmlFor="groq-model">Modelo Groq · definido no Shared Runtime</label><input id="groq-model" value={groqModel} readOnly aria-readonly="true" placeholder="Aguardando configuração do Shared Runtime"/>
      <div className="groq-settings-grid">
        <label><span>Máx. caracteres por lote</span><input type="number" min={1000} max={18000} value={groqMaxChars} onChange={e=>setGroqMaxChars(Number(e.target.value))}/></label>
        <label><span>Máx. legendas por lote</span><input type="number" min={1} max={60} value={groqMaxCues} onChange={e=>setGroqMaxCues(Number(e.target.value))}/></label>
        <label><span>Intervalo entre lotes (ms)</span><input type="number" min={0} max={15000} step={100} value={groqDelay} onChange={e=>setGroqDelay(Number(e.target.value))}/></label>
        <label><span>Idioma de destino</span><input value={groqLanguage} onChange={e=>setGroqLanguage(e.target.value)}/></label>
      </div>
      <div className="groq-free-note"><ShieldCheck size={15}/> Perfil conservador recomendado para conta gratuita: 7.000 caracteres, 25 legendas e 1,8 segundo entre lotes. A API ainda pode aplicar limites variáveis por modelo.</div>
      {groqSettingsMessage&&<div className="groq-settings-message" role="status">{groqSettingsMessage}</div>}
      <div className="modal-footer"><button className="cancel-button" disabled={groqSettingsBusy} onClick={()=>setGroqSettingsOpen(false)}>Fechar</button><button className="primary" disabled={groqSettingsBusy||!groqModel.trim()} onClick={()=>void saveAndTestGroq()}>{groqSettingsBusy?<><LoaderCircle className="spin" size={14}/> Salvando...</>:<><CheckCircle2 size={14}/> Salvar preferências e testar</>}</button></div>
    </section></div>}
    {!isDesktopRuntime&&<div className="browser-warning">Prévia no navegador. Execute pelo Tauri para importar arquivos no computador.</div>}
  </main>;
}
