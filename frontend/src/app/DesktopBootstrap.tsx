import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

let prepareRuntimePromise: Promise<void> | null = null;

type SetupProgress = {
  phase: string;
  message: string;
  percent: number;
};

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke<T>(command: string): Promise<T> };
      event: {
        listen<T>(
          event: string,
          handler: (event: { payload: T }) => void,
        ): Promise<() => void>;
      };
    };
  }
}

export function DesktopBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<SetupProgress>({
    phase: "checking",
    message: "Verificando o ambiente...",
    percent: 2,
  });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const tauri = window.__TAURI__;
    if (!tauri) {
      setReady(true);
      return;
    }

    let active = true;
    let unlisten: (() => void) | undefined;

    const prepare = async () => {
      setError(null);
      setReady(false);
      try {
        unlisten = await tauri.event.listen<SetupProgress>(
          "nova-setup-progress",
          (event) => {
            if (active) setProgress(event.payload);
          },
        );
        if (!prepareRuntimePromise) {
          prepareRuntimePromise = tauri.core.invoke<void>("prepare_runtime").catch((cause) => {
            prepareRuntimePromise = null;
            throw cause;
          });
        }
        await prepareRuntimePromise;
        if (active) setReady(true);
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    void prepare();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [attempt]);

  if (ready) return <>{children}</>;
  if (!window.__TAURI__) return <>{children}</>;

  return (
    <main style={styles.page}>
      <section style={styles.panel}>
        <div style={styles.logo}>N</div>
        <p style={styles.eyebrow}>NOVA GENERATOR</p>
        <h1 style={styles.title}>
          {error ? "Não foi possível preparar o aplicativo" : "Preparando seu ambiente"}
        </h1>
        <p style={styles.message}>
          {error
            ? "O Nova Generator encontrou um problema durante a configuração."
            : progress.message}
        </p>
        {error ? (
          <>
            <pre style={styles.error}>{error}</pre>
            <button style={styles.button} onClick={() => setAttempt((value) => value + 1)}>
              Tentar novamente
            </button>
          </>
        ) : (
          <>
            <div style={styles.track}>
              <div style={{ ...styles.fill, width: `${progress.percent}%` }} />
            </div>
            <div style={styles.meta}>
              <span>Configuração inicial e verificações</span>
              <strong>{progress.percent}%</strong>
            </div>
            <p style={styles.note}>
              Na primeira abertura, alguns componentes serão baixados. Isso pode levar alguns
              minutos.
            </p>
          </>
        )}
      </section>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "#0b1020",
    color: "#f8fafc",
    fontFamily: "Inter, Segoe UI, sans-serif",
  },
  panel: {
    width: "min(100%, 520px)",
    padding: 36,
    border: "1px solid #26324a",
    borderRadius: 22,
    background: "#111a2d",
    boxShadow: "0 24px 80px #0006",
  },
  logo: {
    width: 48,
    height: 48,
    display: "grid",
    placeItems: "center",
    borderRadius: 14,
    background: "#6d5dfc",
    fontSize: 26,
    fontWeight: 800,
  },
  eyebrow: {
    margin: "24px 0 8px",
    color: "#9da9c2",
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: 700,
  },
  title: { margin: 0, fontSize: 25, lineHeight: 1.25 },
  message: { margin: "12px 0 26px", color: "#c1cbe0", lineHeight: 1.6 },
  track: { height: 8, overflow: "hidden", borderRadius: 20, background: "#29354e" },
  fill: {
    height: "100%",
    borderRadius: 20,
    background: "#8275ff",
    transition: "width 250ms ease",
  },
  meta: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 12,
    color: "#9da9c2",
    fontSize: 12,
  },
  note: { marginTop: 28, color: "#8492ad", fontSize: 12, lineHeight: 1.6 },
  error: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: 180,
    overflow: "auto",
    color: "#ffb4b4",
    fontSize: 12,
  },
  button: {
    marginTop: 18,
    border: 0,
    borderRadius: 10,
    padding: "12px 18px",
    background: "#7567ff",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
};
