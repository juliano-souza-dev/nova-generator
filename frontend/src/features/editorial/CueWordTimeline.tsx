import { Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { Cue, WordTiming } from "../../lib/api.types";
import { timeToPercent, validateTimeline } from "./timeline";

export type TimelineCue = Cue & { words: WordTiming[] };

type Props = {
  cues: TimelineCue[];
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
          className="icon-action"
          onClick={props.onPlayToggle}
          aria-label={props.playing ? "Pausar" : "Reproduzir"}
        >
          {props.playing ? <Pause /> : <Play />}
        </button>
        <button
          className="icon-action"
          onClick={() => props.onZoomChange(Math.max(1, props.zoom - 1))}
          aria-label="Diminuir zoom"
        >
          <ZoomOut />
        </button>
        <output aria-label="Zoom atual">{props.zoom}×</output>
        <button
          className="icon-action"
          onClick={() => props.onZoomChange(Math.min(16, props.zoom + 1))}
          aria-label="Aumentar zoom"
        >
          <ZoomIn />
        </button>
        <button className="secondary-button" onClick={props.onUndo}>
          <RotateCcw /> Desfazer
        </button>
        <span className="timeline-help">
          Espaço reproduz · ←/→ ajusta final · Shift+←/→ ajusta início · Ctrl+Z desfaz
        </span>
      </div>
      <svg
        className="cue-timeline"
        viewBox="0 0 1000 190"
        role="img"
        aria-label="Waveform, cues e tempos das palavras"
        onClick={seek}
      >
        <rect width="1000" height="190" className="timeline-bg" />
        {Array.from({ length: 80 }, (_, index) => (
          <line
            key={index}
            x1={index * 13}
            x2={index * 13}
            y1={20 + (index % 5) * 8}
            y2={170 - (index % 7) * 6}
            className="wave-bar"
          />
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
          y2="175"
          className="playhead"
        />
      </svg>
      <div className="timeline-legend">
        <span>
          <i className="legend-cue" /> Cue
        </span>
        <span>
          <i className="legend-word" /> Palavra
        </span>
        <span>{Math.round(props.playheadMs)} ms</span>
      </div>
      {errors.length > 0 && (
        <div role="alert" className="timeline-errors">
          {errors.join(" ")}
        </div>
      )}
    </section>
  );
}
