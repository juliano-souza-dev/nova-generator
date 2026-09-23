import { useEffect, useMemo, useState } from "react";
import type { RefObject, PointerEvent } from "react";

type Props = {
  peaks: number[];
  startMs: number;
  endMs: number;
  durationMs: number;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  onReset: () => void;
  failed: boolean;
  onRetry: () => void;
  playerRef: RefObject<HTMLVideoElement | null>;
};
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, "0")}`;

export function SourceWaveEditor({
  peaks,
  startMs,
  endMs,
  durationMs,
  onStartChange,
  onEndChange,
  onReset,
  failed,
  onRetry,
  playerRef,
}: Props) {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(0);
  const [drag, setDrag] = useState<"start" | "end" | null>(null);
  const [error, setError] = useState("");
  const span = durationMs / zoom;
  const left = Math.max(0, Math.min(offset, durationMs - span));
  const seek = (ms: number) => {
    const next = Math.round(Math.max(0, Math.min(durationMs, ms)));
    if (playerRef.current) playerRef.current.currentTime = next / 1000;
    setPlayhead(next);
    if (next < left || next > left + span) setOffset(Math.max(0, next - span / 2));
  };
  const play = () => {
    setError("");
    void playerRef.current
      ?.play()
      .catch(() =>
        setError("Leitura do vídeo indisponível. Aguarde carregar e tente reproduzir novamente."),
      );
  };
  const toggle = () => {
    setPreview(false);
    if (playerRef.current?.paused) play();
    else playerRef.current?.pause();
  };
  const changeZoom = (next: number) => {
    const value = Math.max(1, Math.min(32, next));
    setZoom(value);
    setOffset(Math.max(0, playhead - durationMs / value / 2));
  };
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const update = () => {
      let ms = player.currentTime * 1000;
      if (preview && ms >= endMs) {
        player.pause();
        player.currentTime = endMs / 1000;
        ms = endMs;
        setPreview(false);
      }
      setPlayhead(ms);
      if (!player.paused && (ms < left || ms > left + span)) setOffset(Math.max(0, ms - span / 4));
    };
    const status = () => setPlaying(!player.paused);
    let frame = 0;
    const tick = () => {
      update();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    player.addEventListener("timeupdate", update);
    player.addEventListener("play", status);
    player.addEventListener("pause", status);
    return () => {
      cancelAnimationFrame(frame);
      player.removeEventListener("timeupdate", update);
      player.removeEventListener("play", status);
      player.removeEventListener("pause", status);
    };
  }, [playerRef, preview, endMs, left, span]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      const key = event.key.toLowerCase();
      if (key === " " && event.target instanceof HTMLElement && event.target.closest("button, a"))
        return;
      if (![" ", "i", "o", "arrowleft", "arrowright", "+", "=", "-"].includes(key)) return;
      event.preventDefault();
      if (key === " ") toggle();
      if (key === "i")
        onStartChange(playerRef.current ? playerRef.current.currentTime * 1000 : playhead);
      if (key === "o")
        onEndChange(playerRef.current ? playerRef.current.currentTime * 1000 : playhead);
      if (key === "arrowleft" || key === "arrowright")
        seek(playhead + (key === "arrowleft" ? -1 : 1) * (event.shiftKey ? 100 : 10));
      if (key === "+" || key === "=") changeZoom(zoom * 2);
      if (key === "-") changeZoom(zoom / 2);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const bars = useMemo(() => {
    const first = Math.floor((left / durationMs) * peaks.length);
    const last = Math.ceil(((left + span) / durationMs) * peaks.length);
    const step = Math.max(1, Math.ceil((last - first) / 600));
    const result = [];
    for (let i = first; i < last; i += step)
      result.push({
        ms: (i / peaks.length) * durationMs,
        peak: Math.max(...peaks.slice(i, Math.min(last, i + step))),
      });
    return result;
  }, [peaks, left, span, durationMs]);
  const x = (ms: number) => ((ms - left) / Math.max(1, span)) * 1200;
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.round(
      Math.max(0, Math.min(durationMs, left + ((event.clientX - box.left) / box.width) * span)),
    );
  };
  return (
    <div className="source-wave-editor">
      <div className="cut-toolbar" aria-label="Controles de reprodução">
        <button onClick={toggle}>
          {playing ? "Pausar" : "Reproduzir"} <kbd>Espaço</kbd>
        </button>
        <button
          onClick={() => {
            seek(startMs);
            setPreview(true);
            play();
          }}
        >
          Ouvir seleção
        </button>
        <output aria-label="Posição do vídeo">{clock(playhead)}</output>
      </div>
      <div className="cut-toolbar">
        <button onClick={() => onStartChange(playhead)}>
          Marcar início <kbd>I</kbd>
        </button>
        <button onClick={() => onEndChange(playhead)}>
          Marcar fim <kbd>O</kbd>
        </button>
        <button
          onClick={() => {
            setPreview(false);
            onReset();
          }}
        >
          Restaurar seleção
        </button>
      </div>
      {failed ? (
        <div role="alert">
          Não foi possível carregar o áudio.{" "}
          <button onClick={onRetry}>Tentar carregar waveform</button>
        </div>
      ) : !peaks.length ? (
        <div className="waveform-loading" role="status">
          Preparando waveform…
        </div>
      ) : (
        <div className="wave-display">
          <div className="wave-ruler" aria-hidden="true">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>{clock(left + (span * i) / 6)}</span>
            ))}
          </div>
          <svg
            className="source-waveform interactive"
            viewBox="0 0 1200 200"
            preserveAspectRatio="none"
            role="img"
            aria-label="Waveform da fonte com intervalo de corte"
            onPointerDown={(event) => {
              const target = event.target as SVGElement;
              const edge = target.dataset.edge;
              if (edge === "start" || edge === "end") {
                setDrag(edge);
                event.currentTarget.setPointerCapture(event.pointerId);
              } else {
                setPreview(false);
                seek(position(event));
              }
            }}
            onPointerMove={(event) => {
              if (drag === "start") onStartChange(position(event));
              if (drag === "end") onEndChange(position(event));
            }}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
            onLostPointerCapture={() => setDrag(null)}
          >
            <rect width="1200" height="200" className="wave-bg" />
            {bars.map((bar) => (
              <line
                key={bar.ms}
                x1={x(bar.ms)}
                x2={x(bar.ms)}
                y1={112 - bar.peak * 65}
                y2={112 + bar.peak * 65}
                className="source-wave-bar"
              />
            ))}
            <rect
              x={Math.max(0, x(startMs))}
              y="30"
              width={Math.max(0, Math.min(1200, x(endMs)) - Math.max(0, x(startMs)))}
              height="170"
              className="wave-selection"
            />
            <rect
              width={Math.max(0, Math.min(1200, x(startMs)))}
              height="200"
              className="wave-outside"
            />
            <rect
              x={Math.max(0, x(endMs))}
              width={Math.max(0, 1200 - x(endMs))}
              height="200"
              className="wave-outside"
            />
            {Array.from({ length: 7 }, (_, i) => (
              <g key={i}>
                <line x1={i * 200} x2={i * 200} y1="24" y2="33" stroke="currentColor" />
              </g>
            ))}
            <line x1={x(playhead)} x2={x(playhead)} y1="28" y2="200" className="wave-playhead" />
            {(
              [
                ["start", startMs],
                ["end", endMs],
              ] as const
            ).map(
              ([edge, ms]) =>
                ms >= left &&
                ms <= left + span && (
                  <g key={edge}>
                    <line x1={x(ms)} x2={x(ms)} y1="30" y2="200" className="cut-handle" />
                    <rect
                      data-edge={edge}
                      aria-label={edge === "start" ? "Arrastar início" : "Arrastar fim"}
                      x={Math.max(0, Math.min(1176, x(ms) - 12))}
                      y="30"
                      width="24"
                      height="170"
                      className="wave-handle-hit"
                    />
                    <text
                      x={Math.max(20, Math.min(1180, x(ms)))}
                      y="48"
                      textAnchor="middle"
                      className="wave-edge-label"
                    >
                      {edge === "start" ? "IN" : "OUT"}
                    </text>
                  </g>
                ),
            )}
          </svg>
        </div>
      )}
      <div className="cut-toolbar" aria-label="Zoom e navegação da waveform">
        <button
          onClick={() => changeZoom(zoom / 2)}
          disabled={zoom === 1}
          aria-label="Diminuir zoom"
        >
          −
        </button>
        <output aria-label="Zoom">{zoom}×</output>
        <button
          onClick={() => changeZoom(zoom * 2)}
          disabled={zoom === 32}
          aria-label="Aumentar zoom"
        >
          +
        </button>
        <button onClick={() => setOffset(Math.max(0, left - span / 2))} disabled={left === 0}>
          Trecho anterior
        </button>
        <button
          onClick={() => setOffset(Math.min(durationMs - span, left + span / 2))}
          disabled={left + span >= durationMs}
        >
          Próximo trecho
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setOffset(0);
          }}
        >
          Ver tudo
        </button>
      </div>
      <p className="cut-shortcuts">
        Clique na onda para posicionar o vídeo. Arraste IN/OUT para ajustar o corte. <kbd>←</kbd>{" "}
        <kbd>→</kbd> 0,01 s · <kbd>Shift</kbd> + setas 0,1 s · <kbd>+</kbd> <kbd>−</kbd> zoom
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
