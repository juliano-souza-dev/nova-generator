import { AlertCircle, LoaderCircle } from "lucide-react";
import { type ReactNode } from "react";

export function LoadingState({ label = "Carregando dados" }: { label?: string }) {
  return <div className="state-card" role="status"><LoaderCircle className="spin" aria-hidden="true" /> {label}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state-card state-error" role="alert"><AlertCircle aria-hidden="true" /><div><strong>Não foi possível carregar esta área.</strong><p>{message}</p>{retry && <button onClick={retry}>Tentar novamente</button>}</div></div>;
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="state-card"><div><strong>{title}</strong><p>{children}</p></div></div>;
}
