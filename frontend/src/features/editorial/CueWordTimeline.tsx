import { Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Cue, WordTiming } from "../../lib/api.types";
import { timeToPercent, validateTimeline } from "./timeline";

export type TimelineCue = Cue & { words: WordTiming[] };

type Props = {
  cues: TimelineCue[];
  waveform?: { bucket_ms: number; peaks: number[] } | null;
  durationMs: number;
  playheadMs: number;
  playing: boolean;
  zoom: number;
  selectedCueId?: string;
  selectedWordId?: string;
  onPlayToggle: () => void;
  onContinuousPlayToggle: () => void;
  onSaveAndNext: () => void;
  onPlayheadChange: (timeMs: number) => void;
  onZoomChange: (zoom: number) => void;
  onSelectCue: (id: string) => void;
  onSelectWord: (id: string) => void;
  onSetEdge: (edge: "start" | "end") => void;
  onNudge: (edge: "start" | "end", deltaMs: number) => void;
  onUndo: () => void;
};

export function CueWordTimeline(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const errors = useMemo(() => validateTimeline(props.cues), [props.cues]);
  const [viewStart, setViewStart] = useState(0);
  const selectedCue = props.cues.find((cue) => cue.id === props.selectedCueId);
  const selectedWord = selectedCue?.words.find((word) => word.id === props.selectedWordId);
  const activeLabel = selectedWord ? "palavra" : "cue";
  const visibleDuration = Math.max(1, props.durationMs) / Math.max(1, props.zoom);
  const windowStart = Math.max(0, Math.min(viewStart, props.durationMs - visibleDuration));
  const pct = (time: number) => timeToPercent(time - windowStart, visibleDuration);
  const timeLabel = (time: number) => `${(Math.max(0, time) / 1000).toFixed(2)} s`;
  const ticks = Array.from({ length: 6 }, (_, index) => ({
    x: index * 200,
    label: timeLabel(windowStart + (visibleDuration * index) / 5),
  }));
  const waveBars = useMemo(() => {
    const waveform = props.waveform;
    if (!waveform?.peaks.length || waveform.bucket_ms <= 0) return [];
    return Array.from({ length: 160 }, (_, index) => {
      const start = Math.floor(
        (windowStart + (index * visibleDuration) / 160) / waveform.bucket_ms,
      );
      const end = Math.ceil(
        (windowStart + ((index + 1) * visibleDuration) / 160) / waveform.bucket_ms,
      );
      const peak = Math.max(0, ...waveform.peaks.slice(start, Math.max(start + 1, end)));
      return { x: index * 6.25, y1: 95 - peak * 75, y2: 95 + peak * 75 };
    });
  }, [props.waveform, visibleDuration, windowStart]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === " " && target?.closest("button, a, summary")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== "z") return;
      if (event.key === " ") {
        event.preventDefault();
        if (event.shiftKey) props.onContinuousPlayToggle();
        else props.onPlayToggle();
      }
      if (["a", "i"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        props.onSetEdge("start");
      }
      if (["s", "o"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        props.onSetEdge("end");
      }
      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        props.onSaveAndNext();
      }
      if (event.key === "Escape") root.current?.focus();
      if (event.key === "z" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        props.onUndo();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        props.onPlayheadChange(props.playheadMs - (event.altKey ? 1 : event.shiftKey ? 100 : 10));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        props.onPlayheadChange(props.playheadMs + (event.altKey ? 1 : event.shiftKey ? 100 : 10));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);
  function seek(event: React.MouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    props.onPlayheadChange(
      windowStart + ((event.clientX - bounds.left) / bounds.width) * visibleDuration,
    );
  }
  return (
    <section
      className="timeline-panel"
      aria-label="Timeline de cues e palavras"
      ref={root}
      tabIndex={0}
    >
      <div className="timeline-toolbar">
        <button
          className="transport-action"
          type="button"
          onClick={props.onPlayToggle}
          aria-label={props.playing ? `Pausar ${activeLabel}` : `Reproduzir ${activeLabel}`}
        >
          {props.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {props.playing ? `Pausar ${activeLabel}` : `Reproduzir ${activeLabel}`}
        </button>
        <div className="zoom-controls" aria-label="Zoom da timeline">
          <button
            className="icon-action"
            type="button"
            onClick={() => props.onZoomChange(Math.max(1, props.zoom - 1))}
            aria-label="Diminuir zoom"
          >
            <ZoomOut aria-hidden="true" />
          </button>
          <output aria-label="Zoom atual">Zoom {props.zoom}×</output>
          <button
            className="icon-action"
            type="button"
            onClick={() => props.onZoomChange(Math.min(64, props.zoom + 1))}
            aria-label="Aumentar zoom"
          >
            <ZoomIn aria-hidden="true" />
          </button>
        </div>
        <button className="secondary-button" type="button" onClick={props.onUndo}>
          <RotateCcw aria-hidden="true" /> Desfazer ajuste
        </button>
        <details className="shortcut-help">
          <summary>Atalhos</summary>
          <span>
            Espaço: cue · Shift + Espaço: cena · A: IN · S: OUT · G: salvar + próxima · Setas:
            playhead 10 ms · Shift: 100 ms · Alt: 1 ms
          </span>
        </details>
      </div>
      <div className="cue-boundary-controls" aria-label={`Limites da ${activeLabel} selecionada`}>
        <span className="active-edit-scope">Editando {activeLabel}</span>
        <strong>IN</strong>
        <button
          type="button"
          className="secondary-button"
          onClick={() => props.onNudge("start", -25)}
          aria-label={`Aumentar ${activeLabel} antecipando o início em 25 milissegundos`}
        >
          −25 ms
        </button>
        <button
          className="secondary-button cue-edge-button"
          type="button"
          onClick={() => props.onSetEdge("start")}
        >
          <kbd>A</kbd> Marcar IN
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => props.onNudge("start", 25)}
          aria-label={`Encurtar ${activeLabel} atrasando o início em 25 milissegundos`}
        >
          +25 ms
        </button>
        <span className="cue-boundary-divider" aria-hidden="true" />
        <strong>OUT</strong>
        <button
          type="button"
          className="secondary-button"
          onClick={() => props.onNudge("end", -25)}
          aria-label={`Encurtar ${activeLabel} antecipando o fim em 25 milissegundos`}
        >
          −25 ms
        </button>
        <button
          className="secondary-button cue-edge-button"
          type="button"
          onClick={() => props.onSetEdge("end")}
        >
          <kbd>S</kbd> Marcar OUT
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => props.onNudge("end", 25)}
          aria-label={`Aumentar ${activeLabel} atrasando o fim em 25 milissegundos`}
        >
          +25 ms
        </button>
      </div>
      <div className="timeline-focus-controls">
        <button
          type="button"
          className="secondary-button"
          disabled={!props.selectedCueId}
          onClick={() => {
            if (!selectedCue) return;
            const range = selectedWord ?? selectedCue.speech_timing;
            const start = range.start_ms;
            const end = range.end_ms;
            const length = Math.max(100, end - start);
            const zoom = Math.max(1, Math.min(64, Math.floor(props.durationMs / (length * 1.5))));
            props.onZoomChange(zoom);
            setViewStart(Math.max(0, start - length * 0.25));
          }}
        >
          Focar {activeLabel}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            props.onZoomChange(1);
            setViewStart(0);
          }}
        >
          Ver tudo
        </button>
        <span>
          Espaço: cue · Shift + Espaço: cena · A/S: IN/OUT · G: salvar + próxima · ←/→: cursor 10 ms
          · Shift: 100 ms · Alt: 1 ms
        </span>
      </div>
      <div className="editorial-timeline-ruler" aria-label="Intervalo visível">
        {ticks.map((tick) => (
          <span key={tick.x}>{tick.label}</span>
        ))}
      </div>
      {waveBars.length === 0 && (
        <p className="editorial-waveform-missing">Waveform indisponível para este corte.</p>
      )}
      <div className="timeline-viewport">
        <svg
          className="cue-timeline"
          viewBox="0 0 1000 210"
          role="img"
          aria-label="Waveform, cues e tempos das palavras"
          onClick={seek}
        >
          <rect width="1000" height="210" className="timeline-bg" />
          {ticks.map((tick) => (
            <g key={tick.x}>
              <line x1={tick.x} x2={tick.x} y1="20" y2="195" className="timeline-gridline" />
            </g>
          ))}
          {waveBars.map((bar, index) => (
            <line key={index} x1={bar.x} x2={bar.x} y1={bar.y1} y2={bar.y2} className="wave-bar" />
          ))}
          {props.cues.map((cue) => (
            <g key={cue.id}>
              <rect
                x={pct(cue.speech_timing.start_ms) * 10}
                width={Math.max(
                  2,
                  (pct(cue.speech_timing.end_ms) - pct(cue.speech_timing.start_ms)) * 10,
                )}
                y="42"
                height="46"
                rx="4"
                className={cue.id === props.selectedCueId ? "cue-block cue-selected" : "cue-block"}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onSelectCue(cue.id);
                }}
              />
              <text x={pct(cue.speech_timing.start_ms) * 10 + 5} y="67" className="cue-label">
                {cue.order}
              </text>
              {cue.words.map((word) => (
                <g key={word.id}>
                  <rect
                    x={pct(word.start_ms) * 10}
                    width={Math.max(2, (pct(word.end_ms) - pct(word.start_ms)) * 10)}
                    y="112"
                    height="30"
                    rx="3"
                    className={
                      word.id === props.selectedWordId ? "word-block word-selected" : "word-block"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onSelectCue(cue.id);
                      props.onSelectWord(word.id);
                    }}
                  >
                    <title>{word.surface}</title>
                  </rect>
                  <foreignObject
                    x={pct(word.start_ms) * 10 + 3}
                    y="114"
                    width={Math.max(0, (pct(word.end_ms) - pct(word.start_ms)) * 10 - 6)}
                    height="26"
                    pointerEvents="none"
                  >
                    <div className="timeline-word-label">{word.surface}</div>
                  </foreignObject>
                </g>
              ))}
            </g>
          ))}
          <line
            x1={pct(props.playheadMs) * 10}
            x2={pct(props.playheadMs) * 10}
            y1="15"
            y2="195"
            className="playhead"
          />
        </svg>
      </div>
      {props.zoom > 1 && (
        <label className="editorial-timeline-pan">
          Navegar no áudio
          <input
            type="range"
            min={0}
            max={Math.max(0, props.durationMs - visibleDuration)}
            step={1}
            value={windowStart}
            onChange={(event) => setViewStart(Number(event.target.value))}
          />
        </label>
      )}
      <div className="timeline-legend">
        <div>
          <span>
            <i className="legend-cue" /> Cue
          </span>
          <span>
            <i className="legend-word" /> Palavra
          </span>
          <span>
            <i className="legend-playhead" /> Reprodução
          </span>
        </div>
        <strong>{timeLabel(props.playheadMs)}</strong>
      </div>
      {errors.length > 0 && (
        <div role="alert" className="timeline-errors">
          {errors.join(" ")}
        </div>
      )}
    </section>
  );
}
