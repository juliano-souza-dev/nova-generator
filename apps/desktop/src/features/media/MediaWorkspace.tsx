import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FileImage, Film, FolderInput, LoaderCircle, Music2, Scissors, Video, X, Play, Clock3 } from "lucide-react";
import "./MediaWorkspace.css";
import { runTrackedTask } from "../tasks/TaskCenter";
import MediaEditor from "./MediaEditor";

type Asset = { id:string; name:string; kind:string; sizeBytes:number; source:string; relativePath:string; durationMs?:number|null; sourceVideoId?:string|null; sourceStartMs?:number|null; sourceEndMs?:number|null };
type Inspection = { videoId:string; url:string; title:string; channel?:string|null; durationMs?:number|null; thumbnail?:string|null; qualities:number[] };
type Cache = { videoId:string; title:string; durationMs?:number|null; reused:boolean };
type Progress = { projectId:string; status:string; percent:number; message:string };
const time = (ms?:number|null) => ms == null ? "--:--" : String(Math.floor(ms/60000)).padStart(2,"0") + ":" + String(Math.floor(ms/1000%60)).padStart(2,"0");
const size = (n:number) => n < 1048576 ? Math.round(n/1024) + " KB" : (n/1048576).toFixed(1) + " MB";

export default function MediaWorkspace({projectId}:{projectId:string}) {
 const [assets,setAssets]=useState<Asset[]>([]),[url,setUrl]=useState(""),[info,setInfo]=useState<Inspection|null>(null),[cache,setCache]=useState<Cache|null>(null);
 const [quality,setQuality]=useState(1080),[start,setStart]=useState(0),[end,setEnd]=useState(0),[busy,setBusy]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[progress,setProgress]=useState<Progress|null>(null);
 const [previewUrl,setPreviewUrl]=useState(""),[trimOpen,setTrimOpen]=useState(false),[editingAsset,setEditingAsset]=useState<Asset|null>(null);
 const videoRef=useRef<HTMLVideoElement|null>(null);
 const durationSeconds=(cache?.durationMs??info?.durationMs??0)/1000;
 const refresh=useCallback(async()=>{try{setAssets(await invoke<Asset[]>("list_project_media",{projectId}));}catch(e){setError(String(e));}},[projectId]);
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{let stop:(()=>void)|undefined;listen<Progress>("media-task-progress",e=>{if(e.payload.projectId===projectId)setProgress(e.payload);}).then(fn=>stop=fn);return()=>stop?.();},[projectId]);
 async function importLocal(){
  setError(""); const selected=await open({multiple:true,directory:false,title:"Importar mídias",filters:[{name:"Mídias",extensions:["mp4","mov","mkv","webm","mp3","wav","m4a","aac","ogg","flac","jpg","jpeg","png","webp","gif"]}]});
  if(!selected)return;setBusy(true);try{const paths=Array.isArray(selected)?selected:[selected];const result=await runTrackedTask("import","Importar mídias",()=>invoke<Asset[]>("import_media_files",{projectId,paths}));setAssets(v=>[...result,...v]);setNotice(result.length+" mídia(s) importada(s).");}catch(e){setError(String(e));}finally{setBusy(false);}
 }
 async function inspectYoutube(){if(!url.trim()||busy)return;setBusy(true);setError("");setInfo(null);setCache(null);setPreviewUrl("");try{const v=await runTrackedTask("download","Consultar vídeo do YouTube",()=>invoke<Inspection>("inspect_youtube",{url}));setInfo(v);setQuality(v.qualities.find(h=>h<=1080)??v.qualities[0]??0);}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function download(){
  if(!info||busy)return;setBusy(true);setError("");setProgress({projectId,status:"running",percent:1,message:"Verificando a biblioteca compartilhada..."});
  try{
   const {cache:c,path}=await runTrackedTask("download","Baixar vídeo original",async()=>{const cache=await invoke<Cache>("prepare_youtube_cache",{projectId,url:info.url,maxHeight:quality});const path=await invoke<string>("authorize_youtube_preview",{videoId:cache.videoId});return {cache,path};});
   setCache(c);setPreviewUrl(convertFileSrc(path));setStart(0);setEnd((c.durationMs??info.durationMs??0)/1000);setTrimOpen(true);
   setNotice(c.reused?"Vídeo original reutilizado da biblioteca compartilhada.":"Download concluído. O original foi preservado.");
  }catch(e){setError(String(e));setProgress({projectId,status:"failed",percent:0,message:String(e)});}finally{setBusy(false);}
 }
 async function createClip(){
  if(!cache||busy)return;setBusy(true);setError("");
  try{
   const asset=await runTrackedTask("trim","Recortar vídeo",()=>invoke<Asset>("trim_youtube_cache",{projectId,videoId:cache.videoId,startMs:Math.round(start*1000),endMs:Math.round(end*1000)}));
   setAssets(v=>[asset,...v]);setNotice("Trecho adicionado ao projeto. O original permanece na biblioteca compartilhada.");
   setTrimOpen(false);setCache(null);setPreviewUrl("");setInfo(null);setUrl("");
   setProgress({projectId,status:"completed",percent:100,message:"Importação concluída."});
  }catch(e){setError(String(e));}finally{setBusy(false);}
 }
 function markStart(){const current=videoRef.current?.currentTime;if(current!=null)setStart(Math.min(current,Math.max(0,end-.3)));}
 function markEnd(){const current=videoRef.current?.currentTime;if(current!=null)setEnd(Math.max(current,start+.3));}
 function closeTrim(){videoRef.current?.pause();setTrimOpen(false);}
 return <section className="media-workspace">
  <div className="media-section-heading"><div><span className="eyebrow">BIBLIOTECA DO PROJETO</span><h2>Mídias</h2><p>Importe arquivos locais ou baixe um vídeo para selecionar um trecho.</p></div><button className="primary-button" onClick={()=>void importLocal()} disabled={busy}><FolderInput size={16}/> Importar mídias</button></div>
  {error&&<div className="media-feedback error">{error}<button onClick={()=>setError("")}><X size={14}/></button></div>}
  {notice&&<div className="media-feedback success"><CheckCircle2 size={15}/>{notice}<button onClick={()=>setNotice("")}><X size={14}/></button></div>}
  <div className="media-youtube-panel">
   <div className="media-panel-title"><span className="media-icon"><Video size={17}/></span><div><strong>Importar do YouTube</strong><small>O vídeo original fica na biblioteca compartilhada do Shared Runtime.</small></div></div>
   <div className="youtube-url-row"><input value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void inspectYoutube();}} placeholder="Cole o link do YouTube"/><button className="secondary-button" disabled={!url.trim()||busy} onClick={()=>void inspectYoutube()}>Consultar vídeo</button></div>
   {info&&!cache&&<div className="youtube-inspection">{info.thumbnail&&<img src={info.thumbnail} alt=""/>}<div className="youtube-info"><strong>{info.title}</strong><span>{info.channel??"Canal"} · {time(info.durationMs)}</span></div><label>Qualidade <select value={quality} onChange={e=>setQuality(Number(e.target.value))}><option value={0}>Melhor disponível</option>{info.qualities.map(h=><option key={h} value={h}>{h}p</option>)}</select></label><button className="primary-button" disabled={busy} onClick={()=>void download()}><Video size={15}/> Baixar / reutilizar</button></div>}
   {cache&&!trimOpen&&<div className="trim-ready"><div><strong>{cache.title}</strong><small>Vídeo original disponível para recorte · {time(cache.durationMs)}</small></div><button className="primary-button" onClick={()=>setTrimOpen(true)}><Scissors size={15}/> Abrir recorte</button></div>}
   {progress?.status==="running"&&<div className="media-progress"><div><LoaderCircle className="spin" size={14}/><span>{progress.message}</span><b>Em andamento</b></div><i><span style={{width:progress.percent+"%"}}/></i></div>}
  </div>
  <div className="media-library-heading"><div><span className="eyebrow">ARQUIVOS VINCULADOS</span><h3>Conteúdo do projeto <small>{assets.length}</small></h3></div></div>
  {!assets.length?<div className="media-empty"><div><Film size={23}/></div><strong>Nenhuma mídia neste projeto</strong><span>Importe um arquivo local ou consulte um vídeo do YouTube.</span></div>:<div className="media-asset-list">{assets.map(a=><article className="media-asset" key={a.id}><span className="media-asset-icon">{a.kind==="video"?<Film size={17}/>:a.kind==="audio"?<Music2 size={17}/>:<FileImage size={17}/>}</span><div className="media-asset-info"><strong>{a.name}</strong><small>{a.kind.toUpperCase()} · {size(a.sizeBytes)} · {a.source==="youtube"?"YouTube":"Arquivo local"}</small>{a.sourceVideoId&&<small>Trecho {time(a.sourceStartMs)}–{time(a.sourceEndMs)} · ID {a.sourceVideoId}</small>}</div><span className="media-asset-state"><CheckCircle2 size={14}/> Importada</span>{a.kind==="video"&&<button className="media-asset-open" onClick={()=>setEditingAsset(a)}><Play size={14}/> Abrir editor</button>}</article>)}</div>}
  {editingAsset&&<MediaEditor projectId={projectId} asset={editingAsset} onClose={()=>setEditingAsset(null)}/>}
  {trimOpen&&cache&&<div className="trim-modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)closeTrim();}}>
   <section className="trim-modal" role="dialog" aria-modal="true" aria-labelledby="trim-modal-title">
    <header className="trim-modal-header"><div><span className="eyebrow">EDIÇÃO DO VÍDEO ORIGINAL</span><h2 id="trim-modal-title">Escolha o trecho</h2><p>{cache.title}</p></div><button className="icon-button" title="Fechar recorte" onClick={closeTrim}><X size={18}/></button></header>
    <div className="trim-modal-body">
     <div className="trim-preview-column"><video ref={videoRef} src={previewUrl} controls playsInline preload="metadata" onLoadedMetadata={e=>{e.currentTarget.currentTime=start;}} onTimeUpdate={e=>{if(e.currentTarget.currentTime>=end&&!e.currentTarget.paused)e.currentTarget.pause();}}/><div className="trim-preview-hint"><Play size={14}/> Assista ao vídeo e marque os pontos usando o tempo atual do player.</div></div>
     <div className="trim-controls-column">
      <div className="trim-duration-card"><span>DURAÇÃO DO ORIGINAL</span><strong>{time(cache.durationMs??info?.durationMs)}</strong></div>
      <div className="trim-point"><div className="trim-point-heading"><label htmlFor="trim-start">Início do trecho</label><button type="button" onClick={markStart}>Marcar posição atual</button></div><input id="trim-start" type="number" min="0" max={durationSeconds} step=".1" value={start} onChange={e=>setStart(Math.max(0,Math.min(Number(e.target.value),end-.3)))}/></div>
      <div className="trim-point"><div className="trim-point-heading"><label htmlFor="trim-end">Fim do trecho</label><button type="button" onClick={markEnd}>Marcar posição atual</button></div><input id="trim-end" type="number" min="0" max={durationSeconds} step=".1" value={end} onChange={e=>setEnd(Math.max(start+.3,Math.min(Number(e.target.value),durationSeconds||Number(e.target.value))))}/></div>
      <div className="trim-range-modal"><label>Posição inicial<input aria-label="Ajustar início" type="range" min="0" max={durationSeconds} step=".1" value={Math.min(start,durationSeconds)} onChange={e=>setStart(Math.min(Number(e.target.value),end-.3))}/></label><label>Posição final<input aria-label="Ajustar fim" type="range" min="0" max={durationSeconds} step=".1" value={Math.min(end,durationSeconds)} onChange={e=>setEnd(Math.max(Number(e.target.value),start+.3))}/></label></div>
      <div className="trim-selected-duration"><Clock3 size={15}/><span>Duração selecionada</span><strong>{time((end-start)*1000)}</strong></div>
      {error&&<div className="media-feedback error">{error}</div>}
     </div>
    </div>
    <footer className="trim-modal-actions"><button className="secondary-button" onClick={closeTrim}>Voltar</button><button className="primary-button" disabled={busy||end-start<.3||end>durationSeconds&&durationSeconds>0} onClick={()=>void createClip()}>{busy?<LoaderCircle className="spin" size={15}/>:<Scissors size={15}/>} {busy?"Criando trecho...":"Confirmar recorte"}</button></footer>
   </section>
  </div>}
 </section>;
}
