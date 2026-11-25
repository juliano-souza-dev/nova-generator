import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Activity, CheckCircle2, ChevronDown, CircleAlert, Clock3, LoaderCircle, Terminal, X, XCircle } from "lucide-react";

type TaskKind = "download" | "import" | "trim" | "transcription" | "translation" | "export" | "installation" | "materials" | "dependencies";
type TaskStatus = "running" | "completed" | "failed" | "cancelled";
type TaskEvent = { type:"started"|"completed"|"failed"; id:string; kind:TaskKind; title:string; message:string; timestamp:number };
type TaskRecord = { id:string; kind:TaskKind; title:string; status:TaskStatus; progress:number|null; message:string; logs:string[]; updatedAt:number };
type ProgressPayload = { projectId:string; status?:string; stage?:string; percent?:number; message:string };
type ResourceProgressPayload = { resourceId:string; status?:"running"|"completed"|"failed"; percent?:number; message:string };
type DependencyQueuePayload = { status?:string; progress?:number|null; current?:string; completed?:number; total?:number; downloadedBytes?:number; speedBytesPerSecond?:number; error?:string|null; failedDependencies?:string[]; results?:Array<{id?:string;status?:string;message?:string;path?:string}> };
const formatBytes = (bytes:number) => { if(bytes < 1024) return `${bytes} B`; const units=["KB","MB","GB","TB"]; let value=bytes/1024; let index=0; while(value>=1024 && index<units.length-1){value/=1024;index++;} return `${value.toFixed(1)} ${units[index]}`; };

const EVENT = "nova:task-center";
const clock = () => new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
const labels:Record<TaskKind,string> = {download:"Download",import:"Importação",trim:"Recorte",transcription:"Transcrição",translation:"Tradução",export:"Exportação",installation:"Instalação",materials:"Materiais",dependencies:"Biblioteca de dependências"};

export function publishTaskEvent(event:TaskEvent) {
  window.dispatchEvent(new CustomEvent<TaskEvent>(EVENT,{detail:event}));
}
export async function runTrackedTask<T>(kind:TaskKind,title:string,action:()=>Promise<T>):Promise<T> {
  const id=crypto.randomUUID();
  publishTaskEvent({type:"started",id,kind,title,message:"Preparando tarefa...",timestamp:Date.now()});
  try { const result=await action(); publishTaskEvent({type:"completed",id,kind,title,message:"Tarefa concluída com sucesso.",timestamp:Date.now()}); return result; }
  catch(error) { publishTaskEvent({type:"failed",id,kind,title,message:error instanceof Error?error.message:String(error),timestamp:Date.now()}); throw error; }
}

export default function TaskCenter() {
 const [tasks,setTasks]=useState<TaskRecord[]>([]);
 const [open,setOpen]=useState(false);
 const activeEventKinds=useRef(new Set<TaskKind>());
 const activeCount=useMemo(()=>tasks.filter(t=>t.status==="running").length,[tasks]);
 useEffect(()=>{
  const handle=(raw:Event)=>{const event=(raw as CustomEvent<TaskEvent>).detail;if(!event)return;
   setTasks(current=>{
    if(event.type==="started"){const started:TaskRecord={id:event.id,kind:event.kind,title:event.title,status:"running",progress:null,message:event.message,logs:[clock()+"  "+event.message],updatedAt:event.timestamp};return [started,...current].slice(0,15);}
    const status:TaskStatus=event.type==="completed"?"completed":"failed";
    return current.map(task=>task.id!==event.id?task:{...task,status,progress:status==="completed"?100:task.progress,message:event.message,updatedAt:event.timestamp,logs:[...task.logs,clock()+"  "+event.message].slice(-80)});
   });
   if(event.type==="started"){activeEventKinds.current.add(event.kind);setOpen(true);}
   else activeEventKinds.current.delete(event.kind);
  };
  window.addEventListener(EVENT,handle);return()=>window.removeEventListener(EVENT,handle);
 },[]);
 useEffect(()=>{
  let disposed=false;let unlisteners:Array<()=>void>=[];
  const update=(kind:TaskKind,progress:number|null,message:string,status?:string)=>{
   const terminal=status==="completed"||status==="done"||progress===100;
   const failed=status==="failed"||status==="error";
   if(!activeEventKinds.current.has(kind)&&!terminal&&!failed){activeEventKinds.current.add(kind);setOpen(true);}
   if(terminal||failed)activeEventKinds.current.delete(kind);
   setTasks(current=>{
    const index=current.findIndex(t=>t.kind===kind&&t.status==="running");
    const now=Date.now();
    if(index<0){
     const title:Record<TaskKind,string>={download:"Download de mídia",import:"Importação de mídia",trim:"Recorte de vídeo",transcription:"Transcrição",translation:"Tradução",export:"Exportação",installation:"Instalação de recurso",materials:"Processamento de Materiais",dependencies:"Biblioteca de dependências"};
     const created:TaskRecord={id:crypto.randomUUID(),kind,title:title[kind],status:failed?"failed":terminal?"completed":"running",progress:progress==null?(terminal?100:null):Math.max(0,Math.min(100,progress)),message,logs:[clock()+"  "+message],updatedAt:now};
     return [created,...current].slice(0,15);
    }
    return current.map((t,i)=>i!==index?t:{...t,status:failed?"failed":terminal?"completed":t.status,progress:terminal?100:progress==null?t.progress:Math.max(0,Math.min(100,progress)),message,updatedAt:now,logs:t.logs[t.logs.length-1]?.endsWith(message)?t.logs:[...t.logs,clock()+"  "+message].slice(-80)});
   });
  };
  Promise.all([
   listen<ProgressPayload>("media-task-progress",e=>{const p=e.payload;update("download",p.percent??null,p.message,p.status);}),
   listen<ProgressPayload>("transcription-progress",e=>{const p=e.payload;update("transcription",p.percent??null,p.message,p.status);}),
   listen<ProgressPayload>("translation-progress",e=>{const p=e.payload;update("translation",p.percent??null,p.message,p.status);}),
   listen<ProgressPayload>("export-progress",e=>{const p=e.payload;update("export",p.percent??null,p.message||"Renderizando mídia...",p.status);})
   ,listen<ResourceProgressPayload>("resource-install-progress",e=>{const p=e.payload;update("installation",p.percent??null,(p.resourceId==="ffmpeg"?"FFmpeg + FFprobe":p.resourceId)+": "+p.message,p.status);})
  ]).then(items=>{if(disposed)items.forEach(fn=>fn());else unlisteners=items;}).catch(error=>console.error("Falha ao acompanhar processamentos:",error));
  return()=>{disposed=true;unlisteners.forEach(fn=>fn());};
 },[]);
 useEffect(()=>{
  let disposed=false;
  let timeout:number|undefined;
  let inFlight=false;
  let terminalHandled=false;
  let wasActive=false;
  const poll=async()=>{
   if(inFlight||disposed)return;
   inFlight=true;
   try{
    const payload=await invoke<DependencyQueuePayload>("shared_dependency_queue_status");
    if(disposed)return;
    const rawStatus=payload.status??"idle";
    const active=["queued","installing","cancelling"].includes(rawStatus);
    if(rawStatus==="idle"){wasActive=false;return;}
    if(active&&!wasActive)setOpen(true);
    wasActive=active;
    if(!active&&terminalHandled)return;
    if(active)terminalHandled=false;
    else terminalHandled=true;
    const status:TaskStatus=active?"running":rawStatus==="completed"?"completed":rawStatus==="cancelled"?"cancelled":"failed";
    const progress=typeof payload.progress==="number"&&Number.isFinite(payload.progress)?Math.max(0,Math.min(100,payload.progress)):status==="completed"?100:null;
    const details=[payload.current||"Preparando a biblioteca de dependências"];
    if(typeof payload.completed==="number"&&typeof payload.total==="number"&&payload.total>0)details.push(`${payload.completed}/${payload.total} dependências`);
    if(typeof payload.downloadedBytes==="number")details.push(`${formatBytes(payload.downloadedBytes)} baixados`);
    if(typeof payload.speedBytesPerSecond==="number"&&payload.speedBytesPerSecond>0)details.push(`${formatBytes(payload.speedBytesPerSecond)}/s`);
    const message=details.join(" · ");
    const now=Date.now();
    setTasks(current=>{
     const id="shared-dependencies";
     const previous=current.find(task=>task.id===id);
     const logs=previous?.logs??[];
     const progressLog=logs[logs.length-1]?.endsWith(message)?[]:[clock()+"  "+message];
     const resultLogs=(payload.results??[])
      .filter(result=>result.status==="error")
      .map(result=>{const dependencyId=result.id??"dependência desconhecida";const detail=result.message??"O instalador não forneceu detalhes do erro.";return "FALHA ["+dependencyId+"]\n"+detail;});
     const failureLog=payload.error?.trim()?[`DIAGNÓSTICO COMPLETO\n${payload.error.trim()}`]:[];
     const additions=[...progressLog,...resultLogs,...failureLog].filter(line=>!logs.includes(line));
     const nextLogs=[...logs,...additions].slice(-80);
     const task:TaskRecord={id,kind:"dependencies",title:"Biblioteca de dependências",status,progress,message,logs:nextLogs,updatedAt:now};
     return [task,...current.filter(item=>item.id!==id)].slice(0,15);
    });
   }catch(error){
    console.error("Falha ao consultar a fila de dependências:",error);
   }finally{
    inFlight=false;
    if(!disposed)timeout=window.setTimeout(poll,1000);
   }
  };
  void poll();
  return()=>{disposed=true;if(timeout!==undefined)window.clearTimeout(timeout);};
 },[]);
 if(typeof window==="undefined")return null;
 const clear=()=>setTasks(current=>current.filter(t=>t.status==="running"));
 return <div className="nova-task-center">
  <button className={"nova-task-trigger"+(activeCount?" is-active":"")} onClick={()=>setOpen(v=>!v)} aria-expanded={open}>
   {activeCount?<LoaderCircle className="nova-spin" size={16}/>:<Activity size={16}/>}<span>Processamentos</span>{activeCount>0&&<b>{activeCount}</b>}
  </button>
  {open&&<section className="nova-task-panel" role="dialog" aria-label="Central de processamento">
   <header className="nova-task-header"><div><span className="nova-task-kicker">NOVA GENERATOR</span><h3>Central de processamento</h3><small>{activeCount?activeCount+" tarefa(s) em andamento":"Acompanhe suas tarefas recentes"}</small></div><button className="nova-task-close" onClick={()=>setOpen(false)} title="Fechar"><X size={17}/></button></header>
   <div className="nova-task-list">{tasks.length===0?<div className="nova-task-empty"><Clock3 size={24}/><b>Nenhuma tarefa recente</b><span>Downloads, transcrições, traduções, Materiais e exportações aparecerão aqui.</span></div>:
    tasks.map(task=><article className={"nova-task-card task-"+task.status} key={task.id}>
     <div className="nova-task-card-head"><span className="nova-task-icon">{task.status==="running"?<LoaderCircle className="nova-spin" size={15}/>:task.status==="completed"?<CheckCircle2 size={15}/>:task.status==="cancelled"?<XCircle size={15}/>:<CircleAlert size={15}/>}</span><div><b>{task.title}</b><small>{labels[task.kind]} · {task.status==="running"?"Em andamento":task.status==="completed"?"Concluída":task.status==="cancelled"?"Cancelada":"Falhou"}</small></div>{task.progress!=null&&<strong>{Math.round(task.progress)}%</strong>}</div>
     <div className="nova-task-track"><i className={task.progress==null&&task.status==="running"?"indeterminate":""} style={{width:task.progress==null?(task.status==="completed"?"100%":"28%"):task.progress+"%"}}/></div>
     <p className="nova-task-message">{task.message}</p>
     <details className="nova-task-logs" open={task.status!=="completed"}><summary><Terminal size={13}/> Detalhes e diagnóstico <span>{task.logs.length}</span><ChevronDown className="nova-task-chevron" size={13}/></summary><div>{task.logs.map((line,i)=><p key={task.id+"-"+i}>{line}</p>)}</div></details>
    </article>)}
   </div>
   <footer className="nova-task-footer"><button onClick={clear} disabled={tasks.every(t=>t.status==="running")}>Limpar concluídas</button><span>As tarefas continuam enquanto você trabalha.</span></footer>
  </section>}
 </div>;
}
