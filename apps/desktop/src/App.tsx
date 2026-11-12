import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, Clock3, Copy,
  FolderKanban, Layers3, MoreHorizontal, Plus, Search, Sparkles, Trash2,
  X, LayoutGrid, Clapperboard, FileText, AudioLines
} from "lucide-react";

type ProjectStatus = "in_progress" | "completed";
type Project = {
  id: string;
  name: string;
  status: ProjectStatus;
  stage: string;
  created_at: string;
  updated_at: string;
};
type View = "home" | "project";

const stages = ["Planejamento", "Editorial", "Transcrição", "Tradução", "Materiais", "Exportação"];
const stageIcons = [FileText, Layers3, AudioLines, BookOpen, BookOpen, Clapperboard];

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Agora";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date);
}
function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Agora";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [view, setView] = useState<View>("home");
  const [filter, setFilter] = useState<"all" | ProjectStatus>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshProjects() {
    try {
      const items = await invoke<Project[]>("list_projects");
      setProjects(items);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => { void refreshProjects(); }, []);

  const sorted = useMemo(() => [...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [projects]);
  const inProgress = sorted.filter(p => p.status === "in_progress");
  const completed = sorted.filter(p => p.status === "completed");
  const filtered = sorted.filter(p => (filter === "all" || p.status === filter) && p.name.toLowerCase().includes(search.toLowerCase()));

  async function createProject() {
    const name = projectName.trim();
    if (!name || busy) return;
    setBusy(true); setError("");
    try {
      const project = await invoke<Project>("create_project", { name });
      await refreshProjects();
      setProjectName(""); setCreateOpen(false);
      setActiveProject(project); setView("project");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function duplicateProject(project: Project) {
    try {
      const copy = await invoke<Project>("duplicate_project", { id: project.id });
      await refreshProjects();
      setActiveProject(copy); setView("project");
    } catch (e) { setError(String(e)); }
  }
  async function deleteProject(project: Project) {
    if (!window.confirm("Excluir “" + project.name + "”? Essa ação não poderá ser desfeita.")) return;
    try {
      await invoke("delete_project", { id: project.id });
      if (activeProject?.id === project.id) { setActiveProject(null); setView("home"); }
      await refreshProjects();
    } catch (e) { setError(String(e)); }
  }
  async function updateStage(stage: string) {
    if (!activeProject) return;
    try {
      const updated = await invoke<Project>("update_project_stage", { id: activeProject.id, stage });
      setActiveProject(updated);
      await refreshProjects();
    } catch (e) { setError(String(e)); }
  }
  async function toggleStatus(project: Project) {
    const status: ProjectStatus = project.status === "completed" ? "in_progress" : "completed";
    try {
      const updated = await invoke<Project>("update_project_status", { id: project.id, status });
      if (activeProject?.id === project.id) setActiveProject(updated);
      await refreshProjects();
    } catch (e) { setError(String(e)); }
  }
  function openProject(project: Project) {
    setActiveProject(project); setView("project");
  }

  if (view === "project" && activeProject) {
    const currentStage = Math.max(0, stages.indexOf(activeProject.stage));
    return <div className="workspace-shell">
      <header className="workspace-topbar">
        <button className="back-button" onClick={() => { setView("home"); setActiveProject(null); }}><ArrowLeft size={17}/> <span>Projetos</span></button>
        <div className="workspace-crumb"><span className="crumb-dot"/>{activeProject.name}</div>
        <div className="workspace-top-actions">
          <span className={activeProject.status === "completed" ? "status-pill completed" : "status-pill"}>{activeProject.status === "completed" ? "Concluído" : "Em andamento"}</span>
          <button className="icon-button" title="Duplicar projeto" onClick={() => void duplicateProject(activeProject)}><Copy size={16}/></button>
        </div>
      </header>
      <main className="project-workspace">
        <div className="project-heading">
          <div><div className="eyebrow">ESPAÇO DO PROJETO</div><h1>{activeProject.name}</h1><p>Criado em {dateLabel(activeProject.created_at)} · Última alteração {timeLabel(activeProject.updated_at)}</p></div>
          <button className="complete-button" onClick={() => void toggleStatus(activeProject)}>{activeProject.status === "completed" ? <Clock3 size={16}/> : <Check size={16}/>} {activeProject.status === "completed" ? "Reabrir projeto" : "Marcar como concluído"}</button>
        </div>
        <section className="stage-panel">
          <div className="panel-heading"><div><span className="eyebrow">ACOMPANHAMENTO</span><h2>Etapas do projeto</h2></div><span className="stage-count">{currentStage + 1} de {stages.length}</span></div>
          <div className="stage-track">{stages.map((stage, index) => { const Icon = stageIcons[index]; return <button type="button" className={index < currentStage ? "stage-item done" : index === currentStage ? "stage-item current" : "stage-item"} key={stage} onClick={() => void updateStage(stage)} title={"Definir etapa: " + stage}><div className="stage-icon">{index < currentStage ? <Check size={17}/> : <Icon size={17}/>}</div><span>{stage}</span></button>; })}</div>
          <div className="stage-note"><span className="stage-note-dot"/><div><strong>Etapa atual: {activeProject.stage}</strong><p>O espaço está preparado para receber as ferramentas de produção desta etapa.</p></div></div>
        </section>
        <section className="workspace-empty">
          <div className="empty-orbit"><Sparkles size={24}/></div>
          <h2>Seu espaço de trabalho</h2>
          <p>O projeto está criado e salvo localmente. As ferramentas específicas de criação serão abertas aqui, mantendo o foco no conteúdo e liberando espaço para trabalhar.</p>
        </section>
      </main>
    </div>;
  }

  return <div className="home-shell">
    <header className="home-topbar">
      <div className="brand"><div className="brand-mark"><Sparkles size={18}/></div><div><strong>NOVA<span>GENERATOR</span></strong><small>ESTÚDIO DE CRIAÇÃO</small></div></div>
      <div className="home-top-actions"><span className="local-status"><i/> Ambiente local</span><button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={17}/> Novo projeto</button></div>
    </header>
    <main className="home-content">
      <section className="overview-head">
        <div><div className="eyebrow">SEU ESTÚDIO</div><h1>Projetos</h1><p>Continue de onde parou ou comece uma nova criação.</p></div>
        <div className="overview-count"><span>{projects.length}</span><small>{projects.length === 1 ? "projeto" : "projetos"} no estúdio</small></div>
      </section>

      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}><X size={15}/></button></div>}

      {sorted.length > 0 && <section className="featured-section">
        <div className="section-label"><span>RETOMAR CRIAÇÃO</span><span className="subtle-label">MAIS RECENTE</span></div>
        <button className="featured-project" onClick={() => openProject(sorted[0])}>
          <div className="featured-art"><div className="art-shape shape-one"/><div className="art-shape shape-two"/><Layers3 size={30}/></div>
          <div className="featured-info"><span className="project-kicker">{sorted[0].status === "completed" ? "CONCLUÍDO" : "EM ANDAMENTO"}</span><h2>{sorted[0].name}</h2><p>Última atividade em {timeLabel(sorted[0].updated_at)}</p></div>
          <span className="featured-open">Abrir projeto <ArrowRight size={16}/></span>
        </button>
      </section>}

      <section className="projects-section">
        <div className="projects-toolbar"><div><div className="section-label">SEU TRABALHO</div><h2>Todos os projetos</h2></div><div className="project-controls"><div className="search-box"><Search size={15}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar projeto"/></div></div></div>
        <div className="filter-tabs">
          <button className={filter === "all" ? "filter-tab active" : "filter-tab"} onClick={() => setFilter("all")}>Todos <span>{projects.length}</span></button>
          <button className={filter === "in_progress" ? "filter-tab active" : "filter-tab"} onClick={() => setFilter("in_progress")}>Em andamento <span>{inProgress.length}</span></button>
          <button className={filter === "completed" ? "filter-tab active" : "filter-tab"} onClick={() => setFilter("completed")}>Concluídos <span>{completed.length}</span></button>
        </div>
        {filtered.length > 0 ? <div className="project-grid">{filtered.map(project => <article className="project-card" key={project.id}>
          <button className="project-card-main" onClick={() => openProject(project)}><div className="project-card-art"><FolderKanban size={22}/><span className={project.status === "completed" ? "mini-status completed" : "mini-status"}/></div><div className="project-card-copy"><h3>{project.name}</h3><p>{project.stage} · Atualizado {dateLabel(project.updated_at)}</p></div></button>
          <div className="project-card-footer"><span className={project.status === "completed" ? "status-text completed" : "status-text"}>{project.status === "completed" ? "Concluído" : "Em andamento"}</span><div className="card-actions"><button title="Duplicar" onClick={() => void duplicateProject(project)}><Copy size={15}/></button><button title="Excluir" onClick={() => void deleteProject(project)}><Trash2 size={15}/></button><button title="Abrir" onClick={() => openProject(project)}><ArrowRight size={16}/></button></div></div>
        </article>)}</div> : <div className="empty-projects"><div className="empty-icon"><LayoutGrid size={22}/></div><h3>{search ? "Nenhum projeto encontrado" : filter === "completed" ? "Nenhum projeto concluído" : filter === "in_progress" ? "Nenhum projeto em andamento" : "Seu estúdio está pronto"}</h3><p>{search ? "Tente buscar por outro nome." : "Crie seu primeiro projeto para começar a organizar suas produções."}</p>{!search && filter !== "completed" && <button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={16}/> Criar projeto</button>}</div>}
      </section>
    </main>
    {createOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setCreateOpen(false); }}><form className="create-modal" onSubmit={e => { e.preventDefault(); void createProject(); }}><div className="modal-top"><div className="modal-icon"><Plus size={19}/></div><button type="button" className="icon-button" onClick={() => setCreateOpen(false)}><X size={17}/></button></div><h2>Novo projeto</h2><p>Dê um nome para sua próxima criação. Você poderá organizar as etapas dentro do projeto.</p><label htmlFor="project-name">Nome do projeto</label><input id="project-name" autoFocus value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="Ex.: Microaula sobre phrasal verbs" maxLength={80}/><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>Cancelar</button><button type="submit" className="primary-button" disabled={!projectName.trim() || busy}>{busy ? "Criando..." : "Criar projeto"} <ArrowRight size={16}/></button></div></form></div>}
  </div>;
}
