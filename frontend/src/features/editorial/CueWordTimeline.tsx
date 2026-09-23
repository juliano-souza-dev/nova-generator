import { Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
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
  onPlayheadChange: (timeMs: number) => void;
  onZoomChange: (zoom: number) => void;
  onSelectCue: (id: string) => void;
  onSelectWord: (id: string) => void;
  onNudge: (edge: "start" | "end", deltaMs: number) => void;
  onUndo: () => void;
};

export function CueWordTimeline(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const errors = useMemo(() => validateTimeline(props.cues), [props.cues]);
  const visibleDuration = props.durationMs / props.zoom;
  const windowStart = Math.max(
    0,
    Math.min(props.playheadMs - visibleDuration / 2, props.durationMs - visibleDuration),
  );
  const pct = (time: number) => timeToPercent(time - windowStart, visibleDuration);
  const timeLabel = (time: number) => `${(Math.max(0, time) / 1000).toFixed(2)} s`;
  const ticks = Array.from({ length: 6 }, (_, index) => ({
    x: index * 200,
    label: timeLabel(windowStart + (visibleDuration * index) / 5),
  }));
  const waveBars = useMemo(() => {
    if (props.waveform === undefined) {
      return Array.from({ length: 80 }, (_, index) => ({
        x: index * 13,
        y1: 20 + (index % 5) * 8,
        y2: 170 - (index % 7) * 6,
      }));
    }
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
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key === " ") {
        event.preventDefault();
        props.onPlayToggle();
      }
      if (event.key === "Escape") root.current?.focus();
      if (event.key === "z" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        props.onUndo();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        props.onNudge(event.shiftKey ? "start" : "end", -25);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        props.onNudge(event.shiftKey ? "start" : "end", 25);
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
      tabIndex={-1}
    >
      <div className="timeline-toolbar">
        <button
          className="transport-action"
          type="button"
          onClick={props.onPlayToggle}
          aria-label={props.playing ? "Pausar" : "Reproduzir"}
        >
          {props.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {props.playing ? "Pausar" : "Reproduzir"}
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
            onClick={() => props.onZoomChange(Math.min(16, props.zoom + 1))}
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
            Espaço: reproduzir · Setas: ajustar fim · Shift + setas: ajustar início · Ctrl + Z:
            desfazer
          </span>
        </details>
      </div>
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
              <text x={tick.x + 6} y="15" className="timeline-tick">
                {tick.label}
              </text>
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
                <rect
                  key={word.id}
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
