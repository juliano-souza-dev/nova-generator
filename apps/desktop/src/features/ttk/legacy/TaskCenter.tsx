import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity, CheckCircle2, ChevronDown, CircleAlert, Clock3, LoaderCircle, Terminal, X } from "lucide-react";
import { isDesktopRuntime, type TranscriptionProgress } from "./services/desktop-api";
import type { DownloadProgress } from "./shared/types";
import { TASK_CENTER_EVENT, type TaskEvent, type TaskKind, type TaskStatus } from "./services/task-center";

type TaskRecord = {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  progress: number | null;
  message: string;
  logs: string[];
  updatedAt: number;
};

function clock() {
  return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function TaskCenter() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  useEffect(()=>{openRef.current=open;},[open]);
  const activeCount = useMemo(() => tasks.filter(task => task.status === "running").length, [tasks]);

  useEffect(() => {
    const handleTaskEvent = (raw: Event) => {
      const event = (raw as CustomEvent<TaskEvent>).detail;
      if (!event) return;
      setTasks(current => {
        if (event.type === "started") {
          const newTask: TaskRecord = { id: event.id, kind: event.kind, title: event.title, status: "running", progress: null, message: event.message, logs: [clock() + "  " + event.message], updatedAt: event.timestamp };
          return [newTask, ...current].slice(0, 15);
        }
        return current.map(task => task.id !== event.id ? task : {
          ...task,
          status: event.type === "completed" ? "completed" : "failed",
          progress: event.type === "completed" ? 100 : task.progress,
          message: event.message,
          updatedAt: event.timestamp,
          logs: [...task.logs, clock() + "  " + event.message].slice(-80),
        });
      });
      if (event.type === "started") setOpen(true);
    };
    window.addEventListener(TASK_CENTER_EVENT, handleTaskEvent);
    return () => window.removeEventListener(TASK_CENTER_EVENT, handleTaskEvent);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime) return;
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    const updateRunningTask = (kind: TaskKind, progress: number | null, message: string, logKey?: string, done = false) => {
      setTasks(current => {
        const index = current.findIndex(task => task.kind === kind && task.status === "running");
        const now = Date.now();
        if (index < 0) {
          const title: Record<TaskKind,string> = { download:"Download de mídia", trim:"Recorte de vídeo", export:"Exportação de vídeo", transcription:"Transcrição", installation:"Instalação de dependência" };
          const created: TaskRecord = { id: crypto.randomUUID(), kind, title: title[kind], status: done ? "completed" : "running", progress: progress == null ? (done ? 100 : null) : Math.max(0,Math.min(100,progress)), message, logs:[clock()+"  "+message], updatedAt:now };
          return [created,...current].slice(0,15);
        }
        const task=current[index];
        const logs=message && (logKey ? !task.logs.some(line=>line.endsWith("  "+logKey)) : task.message!==message) ? [...task.logs,clock()+"  "+(logKey||message)].slice(-80) : task.logs;
        return current.map((item,itemIndex)=>itemIndex!==index?item:{...item,status:done?"completed":item.status,progress:done?100:progress==null?item.progress:Math.max(0,Math.min(100,progress)),message:message||item.message,logs,updatedAt:now});
      });
      if (!openRef.current) setOpen(true);
    };
    Promise.all([
      listen<DownloadProgress>("youtube-download-progress", event => {
        const value = event.payload;
        const message = [value.status === "completed" ? "Download finalizado." : "Baixando vídeo...", value.speed, value.eta ? "Restante: " + value.eta : ""].filter(Boolean).join(" · ");
        const logKey = value.percent != null ? "Download em " + Math.floor(value.percent / 10) * 10 + "%" : message;
        updateRunningTask("download", value.percent ?? null, message, logKey, value.status === "completed" || value.percent === 100);
      }),
      listen<{ percent: number }>("export-progress", event => {
        const percent = Math.max(0, Math.min(100, event.payload.percent));
        updateRunningTask("export", percent, percent >= 100 ? "Exportação concluída." : "Renderizando vídeo...", "Renderização em " + Math.floor(percent / 10) * 10 + "%", percent >= 100);
      }),
      listen<TranscriptionProgress>("transcription-progress", event => {
        const value = event.payload;
        updateRunningTask("transcription", value.percent, value.message, value.message, value.percent >= 100);
      }),
    ]).then(items => {
      if (disposed) items.forEach(unlisten => unlisten());
      else unlisteners = items;
    }).catch(error => {
      console.error("Não foi possível acompanhar as tarefas:", error);
    });
    return () => {
      disposed = true;
      unlisteners.forEach(unlisten => unlisten());
    };
  }, []);

  const clearFinished = () => setTasks(current => current.filter(task => task.status === "running"));
  if (!isDesktopRuntime) return null;

  return (
    <div className="task-center-root">
      <button className={"task-center-trigger" + (activeCount ? " has-active" : "")} onClick={() => setOpen(value => !value)} aria-expanded={open}>
        {activeCount ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}
        <span>Processamentos</span>
        {activeCount > 0 && <b>{activeCount}</b>}
      </button>
      {open && <section className="task-center-panel" role="dialog" aria-label="Central de processamento">
        <header className="task-center-header">
          <div><span className="task-center-kicker">FRAMELAB</span><h3>Central de processamento</h3><small>{activeCount ? activeCount + " tarefa(s) em andamento" : "Acompanhe suas tarefas recentes"}</small></div>
          <button className="task-center-close" onClick={() => setOpen(false)} title="Fechar"><X size={17}/></button>
        </header>
        <div className="task-center-list">
          {tasks.length === 0 ? <div className="task-center-empty"><Clock3 size={23}/><b>Nenhuma tarefa recente</b><span>Downloads, transcrições e exportações aparecerão aqui.</span></div> :
            tasks.map(task => <article className={"task-card task-" + task.status} key={task.id}>
              <div className="task-card-heading">
                <span className="task-card-icon">{task.status === "running" ? <LoaderCircle className="spin" size={15}/> : task.status === "completed" ? <CheckCircle2 size={15}/> : <CircleAlert size={15}/>}</span>
                <div><b>{task.title}</b><small>{task.status === "running" ? "Em andamento" : task.status === "completed" ? "Concluída" : "Falhou"}</small></div>
                {task.progress != null && <strong>{Math.round(task.progress)}%</strong>}
              </div>
              <div className="task-progress-track"><i className={task.progress == null && task.status === "running" ? "indeterminate" : ""} style={{ width: task.progress == null ? (task.status === "completed" ? "100%" : "28%") : task.progress + "%" }}/></div>
              <p className="task-card-message">{task.message}</p>
              <details className="task-logs" open={task.status === "running"}>
                <summary><Terminal size={13}/> Logs da tarefa <span>{task.logs.length}</span><ChevronDown className="task-log-chevron" size={13}/></summary>
                <div className="task-log-list">{task.logs.map((line, index) => <div key={task.id + "-" + index}>{line}</div>)}</div>
              </details>
            </article>)
          }
        </div>
        <footer className="task-center-footer">
          <button onClick={clearFinished} disabled={tasks.every(task => task.status === "running")}>Limpar concluídas</button>
          <span>As tarefas continuam enquanto você usa o editor.</span>
        </footer>
      </section>}
    </div>
  );
}
