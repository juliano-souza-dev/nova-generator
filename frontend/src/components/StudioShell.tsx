import {
  Clapperboard,
  FolderKanban,
  Languages,
  ListChecks,
  LibraryBig,
  Layers3,
  Menu,
  Mic2,
  Sparkles,
  Video,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

const links = [
  { to: "/projects", label: "Projetos", icon: FolderKanban },
  { to: "/editorial", label: "Editorial", icon: Languages },
  { to: "/media", label: "Mídia", icon: Mic2 },
  { to: "/materials", label: "Materiais", icon: LibraryBig },
  { to: "/cards", label: "Cards", icon: Layers3 },
  { to: "/voices", label: "Vozes", icon: Mic2 },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  { to: "/story", label: "História", icon: Clapperboard },
  { to: "/tiktok-media", label: "TikTok Mídia", icon: Video },
];

export function StudioShell({ children }: { children: ReactNode }) {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const mediaStudio = useLocation().pathname === "/tiktok-media";
  return (
    <div className="studio-shell">
      <a className="skip-link" href="#main-content">
        Pular para o conteúdo
      </a>
      <header className="topbar">
        <button
          className="icon-button menu-button"
          aria-label="Abrir navegação"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Menu aria-hidden="true" />
        </button>
        <a className="brand" href="/projects">
          <Sparkles aria-hidden="true" /> Nova Generator
        </a>
        <span className="environment">Estúdio</span>
      </header>
      <div className={`studio-layout ${mediaStudio ? "studio-layout-media" : ""}`}>
        <nav
          className={`sidebar ${isMenuOpen ? "sidebar-open" : ""}`}
          aria-label="Navegação principal"
        >
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}
              onClick={() => setMenuOpen(false)}
              title={label}
            >
              <Icon aria-hidden="true" /> {label}
            </NavLink>
          ))}
        </nav>
        <main id="main-content" className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
