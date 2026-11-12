import { Activity, BookOpen, FolderKanban, Layers3, Settings2, Sparkles } from "lucide-react";
const navigation = [
  { label: "Visão geral", icon: Activity, active: true },
  { label: "Projetos", icon: FolderKanban, active: false },
  { label: "Materiais", icon: BookOpen, active: false },
  { label: "Biblioteca", icon: Layers3, active: false },
  { label: "Configurações", icon: Settings2, active: false }
];
const modules = [
  { title: "Projetos", description: "Criação, organização e ciclo de vida dos projetos.", icon: FolderKanban },
  { title: "Editorial", description: "Roteiros, cues, falantes e edição de conteúdo.", icon: Layers3 },
  { title: "Transcrição e tradução", description: "Processamento de áudio, texto e contexto.", icon: Activity },
  { title: "Materiais de estudo", description: "Shadowing, Anki e documentos de aprendizagem.", icon: BookOpen }
];
export default function App() {
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkles size={19}/></div><div><strong>NOVA<span>GENERATOR</span></strong><small>ENGLISH CONTENT STUDIO</small></div></div><div className="nav-caption">WORKSPACE</div><nav>{navigation.map(({label,icon:Icon,active})=><button className={active?"nav-item active":"nav-item"} key={label}><Icon size={17}/><span>{label}</span></button>)}</nav><div className="sidebar-footer"><span className="status-dot"/> Ambiente local</div></aside><main className="main-area"><header className="topbar"><span>Workspace <i>/</i> Visão geral</span><span className="runtime-status">NOVA GENERATOR <b>0.1.0</b></span></header><section className="content"><div className="eyebrow"><Sparkles size={13}/> CONTENT CREATION WORKSPACE</div><h1>Seu espaço de <em>criação.</em></h1><p className="intro">Uma base modular para transformar conteúdo em experiências de aprendizagem.</p><div className="welcome-panel"><div className="welcome-icon"><Layers3 size={22}/></div><div><h2>Fundação inicial pronta</h2><p>Estamos preparando os módulos do Nova Generator. Cada capacidade terá seu próprio espaço, regras e ciclo de evolução.</p></div><span className="version-tag">PHASE 01</span></div><div className="section-heading"><div><span className="eyebrow">ESTRUTURA DO PRODUTO</span><h2>Áreas de trabalho</h2></div></div><div className="module-grid">{modules.map(({title,description,icon:Icon})=><article className="module-card" key={title}><Icon size={19}/><h3>{title}</h3><p>{description}</p><span>Planejado</span></article>)}</div></section></main></div>;
}
