import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Activity, CheckCircle2, ChevronDown, CircleAlert, Clock3, LoaderCircle, Terminal, X } from "lucide-react";

type TaskKind = "download" | "import" | "trim" | "transcription" | "translation" | "export" | "installation" | "materials";
type TaskStatus = "running" | "completed" | "failed" | "cancelled";
type TaskEvent = { type:"started"|"completed"|"failed"; id:string; kind:TaskKind; title:string; message:string; timestamp:number };
type TaskRecord = { id:string; kind:TaskKind; title:string; status:TaskStatus; progress:number|null; message:string; logs:string[]; updatedAt:number };
type ProgressPayload = { projectId:string; status?:string; stage?:string; percent?:number; message:string };
type SharedQueueStatus = {
 status?:string; operationTitle?:string; current?:string; progress?:number|null;
 progressMode?:string; downloadedBytes?:number; speedBytesPerSecond?:number; error?:string;
};

const EVENT = "nova:task-center";
const clock = () => new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
const labels:Record<TaskKind,string> = {download:"Download",import:"Importação",trim:"Recorte",transcription:"Transcrição",translation:"Tradução",export:"Exportação",installation:"Instalação",materials:"Materiais"};

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
 const activeCount=useMemo(()=>tasks.filter(t=>t.status==="running").length,[tasks]);
 useEffect(()=>{
  const handle=(raw:Event)=>{const event=(raw as CustomEvent<TaskEvent>).detail;if(!event)return;
   setTasks(current=>{
    if(event.type==="started"){const started:TaskRecord={id:event.id,kind:event.kind,title:event.title,status:"running",progress:null,message:event.message,logs:[clock()+"  "+event.message],updatedAt:event.timestamp};return [started,...current].slice(0,15);}
    const status:TaskStatus=event.type==="completed"?"completed":"failed";
    return current.map(task=>task.id!==event.id?task:{...task,status,progress:status==="completed"?100:task.progress,message:event.message,updatedAt:event.timestamp,logs:[...task.logs,clock()+"  "+event.message].slice(-80)});
   });
   if(event.type==="started")setOpen(true);
  };
  window.addEventListener(EVENT,handle);return()=>window.removeEventListener(EVENT,handle);
 },[]);
 useEffect(()=>{
  let disposed=false;
  let activeTaskId:string|null=null;
  let lastMessage="";
  const formatBytes=(value:number)=>value<1024*1024
   ? (value/1024).toFixed(0)+" KB"
   : (value/1024/1024).toFixed(1)+" MB";
  const poll=async()=>{
   try {
    const queue=await invoke<SharedQueueStatus>("shared_dependency_queue_status");
    if(disposed)return;
    const state=queue.status??"idle";
    const active=["queued","installing","running","cancelling"].includes(state);
    const terminal=["completed","error","cancelled"].includes(state);
    if(!active&&!terminal)return;
    if(!active&&!activeTaskId)return;
    if(active&&!activeTaskId){activeTaskId="shared-processing-"+Date.now();lastMessage="";}
    const id=activeTaskId;
    if(!id)return;
    const title=queue.operationTitle||"Preparação de dependências";
    const details=[queue.current||"Processando..."];
    if(typeof queue.downloadedBytes==="number")details.push("Baixado: "+formatBytes(queue.downloadedBytes));
    if(typeof queue.speedBytesPerSecond==="number"&&queue.speedBytesPerSecond>0)details.push(formatBytes(queue.speedBytesPerSecond)+"/s");
    const message=details.join(" · ");
    const error=queue.error?.trim();
    const status:TaskStatus=state==="completed"?"completed":state==="error"?"failed":state==="cancelled"?"cancelled":"running";
    const progress=typeof queue.progress==="number"?Math.max(0,Math.min(100,queue.progress)):null;
    const now=Date.now();
    const logLines:string[]=[];
    if(message!==lastMessage)logLines.push(clock()+"  "+message);
    if(error&&error!==lastMessage)logLines.push(clock()+"  ERRO: "+error);
    lastMessage=message;
    setTasks(current=>{
     const index=current.findIndex(task=>task.id===id);
     if(index<0){
      const created:TaskRecord={id,kind:"installation",title,status,progress,message: error?message+" · "+error:message,logs:logLines.length?logLines:[clock()+"  "+message],updatedAt:now};
      return [created,...current].slice(0,15);
     }
     return current.map((task,i)=>i!==index?task:{
      ...task,title,status,progress:status==="completed"?100:progress,
      message:error?message+" · "+error:message,updatedAt:now,
      logs:[...task.logs,...logLines].slice(-80)
     });
    });
    if(active)setOpen(true);
    if(terminal)activeTaskId=null;
   } catch(error) {
    if(!disposed)console.error("Falha ao acompanhar a fila de processamento:",error);
   }
  };
  void poll();
  const timer=window.setInterval(()=>void poll(),900);
  return()=>{disposed=true;window.clearInterval(timer);};
 },[]);
 useEffect(()=>{
  let disposed=false;let unlisteners:Array<()=>void>=[];
  const update=(kind:TaskKind,progress:number|null,message:string,status?:string)=>{
   const terminal=status==="completed"||status==="done"||progress===100;
   const failed=status==="failed"||status==="error";
   setTasks(current=>{
    const index=current.findIndex(t=>t.kind===kind&&t.status==="running");
    const now=Date.now();
    if(index<0){
     const title:Record<TaskKind,string>={download:"Download de mídia",import:"Importação de mídia",trim:"Recorte de vídeo",transcription:"Transcrição",translation:"Tradução",export:"Exportação",installation:"Instalação de recurso",materials:"Processamento de Materiais"};
     const created:TaskRecord={id:crypto.randomUUID(),kind,title:title[kind],status:failed?"failed":terminal?"completed":"running",progress:progress==null?(terminal?100:null):Math.max(0,Math.min(100,progress)),message,logs:[clock()+"  "+message],updatedAt:now};
     return [created,...current].slice(0,15);
    }
    return current.map((t,i)=>i!==index?t:{...t,status:failed?"failed":terminal?"completed":t.status,progress:terminal?100:progress==null?t.progress:Math.max(0,Math.min(100,progress)),message,updatedAt:now,logs:t.logs[t.logs.length-1]?.endsWith(message)?t.logs:[...t.logs,clock()+"  "+message].slice(-80)});
   });
   setOpen(true);
  };
  Promise.all([
   listen<ProgressPayload>("media-task-progress",e=>{const p=e.payload;update("download",p.percent??null,p.message,p.status);}),
   listen<ProgressPayload>("transcription-progress",e=>{const p=e.payload;update("transcription",p.percent??null,p.message,p.status);}),
   listen<ProgressPayload>("translation-progress",e=>{const p=e.payload;update("translation",p.percent??null,p.message,p.status);}),
   listen<ProgressPayload>("export-progress",e=>{const p=e.payload;update("export",p.percent??null,p.message||"Renderizando mídia...",p.status);}),
   listen<ProgressPayload>("materials-audio-progress",e=>{const p=e.payload;update("materials",p.percent??null,p.message,p.status);})
  ]).then(items=>{if(disposed)items.forEach(fn=>fn());else unlisteners=items;}).catch(error=>console.error("Falha ao acompanhar processamentos:",error));
  return()=>{disposed=true;unlisteners.forEach(fn=>fn());};
 },[]);
 if(typeof window==="undefined")return null;
 const clear=()=>setTasks(current=>current.filter(t=>t.status==="running"));
 return <div className="nova-task-center">
  <button className={"nova-task-trigger"+(activeCount?" is-active":"")} onClick={()=>setOpen(v=>!v)} aria-expanded={open}>
   {activeCount?<LoaderCircle className="nova-spin" size={16}/>:<Activity size={16}/>}<span>Processamentos</span>{activeCount>0&&<b>{activeCount}</b>}
  </button>
  {open&&<section className="nova-task-panel" role="dialog" aria-label="Central de processamento">
   <header className="nova-task-header"><div><span className="nova-task-kicker">NOVA GENERATOR</span><h3>Central de processamento</h3><small>{activeCount?activeCount+" tarefa(s) em andamento":"Acompanhe suas tarefas recentes"}</small></div><button className="nova-task-close" onClick={()=>setOpen(false)} title="Fechar"><X size={17}/></button></header>
   <div className="nova-task-list">{tasks.length===0?<div className="nova-task-empty"><Clock3 size={24}/><b>Nenhuma tarefa recente</b><span>Downloads, instalações, criação de vozes, transcrições, Materiais e exportações aparecerão aqui.</span></div>:
    tasks.map(task=><article className={"nova-task-card task-"+task.status} key={task.id}>
     <div className="nova-task-card-head"><span className="nova-task-icon">{task.status==="running"?<LoaderCircle className="nova-spin" size={15}/>:task.status==="completed"?<CheckCircle2 size={15}/>:<CircleAlert size={15}/>}</span><div><b>{task.title}</b><small>{labels[task.kind]} · {task.status==="running"?"Em andamento":task.status==="completed"?"Concluída":task.status==="cancelled"?"Cancelada":"Falhou"}</small></div>{task.progress!=null&&<strong>{Math.round(task.progress)}%</strong>}</div>
     <div className="nova-task-track"><i className={task.progress==null&&task.status==="running"?"indeterminate":""} style={{width:task.progress==null?(task.status==="completed"?"100%":"28%"):task.progress+"%"}}/></div>
     <p className="nova-task-message">{task.message}</p>
     <details className="nova-task-logs" open={task.status!=="completed"}><summary><Terminal size={13}/> Detalhes e diagnóstico <span>{task.logs.length}</span><ChevronDown className="nova-task-chevron" size={13}/></summary><div>{task.logs.map((line,i)=><p key={task.id+"-"+i}>{line}</p>)}</div></details>
    </article>)}
   </div>
   <footer className="nova-task-footer"><button onClick={clear} disabled={tasks.every(t=>t.status==="running")}>Limpar concluídas</button><span>As tarefas continuam enquanto você trabalha.</span></footer>
  </section>}
 </div>;
}
