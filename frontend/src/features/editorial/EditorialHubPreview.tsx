import { Pause, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WordTiming } from "../../lib/api.types";
import type { TimelineCue } from "./CueWordTimeline";
import { activePreviewCue, timedLiteralPieces } from "./hub-preview-timeline";

export type SubtitleMode = "en" | "pt" | "dual";

type Props = {
  mediaUrl: string;
  cues: TimelineCue[];
  initialTimeMs: number;
  onClose: () => void;
};

function portugueseTimings(cue: TimelineCue): WordTiming[] {
  const groups = new Map<string, WordTiming[]>();
  for (const word of cue.words) {
    if (word.semantic_group_id) {
      const group = groups.get(word.semantic_group_id) ?? [];
      group.push(word);
      groups.set(word.semantic_group_id, group);
    }
  }
  const emitted = new Set<string>();
  return cue.words.flatMap((word) => {
    if (!word.semantic_group_id) {
      return word.pt ? [{ ...word, surface: word.pt }] : [];
    }
    if (emitted.has(word.semantic_group_id)) return [];
    emitted.add(word.semantic_group_id);
    const group = groups.get(word.semantic_group_id) ?? [word];
    const lead = group.find((item) => item.semantic_group_role === "lead") ?? group[0];
    return lead.pt
      ? [{ ...lead, surface: lead.pt, start_ms: group[0].start_ms, end_ms: group.at(-1)!.end_ms }]
      : [];
  });
}

function CaptionLine({
  text,
  words,
  currentMs,
}: {
  text: string;
  words: WordTiming[];
  currentMs: number;
}) {
  const pieces = useMemo(() => timedLiteralPieces(text, words), [text, words]);
  return pieces.map((piece, index) => {
    const active =
      piece.startMs !== undefined &&
      piece.endMs !== undefined &&
      currentMs >= piece.startMs &&
      currentMs < piece.endMs;
    return piece.startMs === undefined ? (
      piece.text
    ) : (
      <span key={`${index}-${piece.startMs}`} className={active ? "is-active" : ""}>
        {piece.text}
      </span>
    );
  });
}

export function EditorialHubPreview({ mediaUrl, cues, initialTimeMs, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const [currentMs, setCurrentMs] = useState(initialTimeMs);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<SubtitleMode>("dual");
  const cue = activePreviewCue(cues, currentMs);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = initialTimeMs / 1000;
    void video.play().catch(() => setPlaying(false));
  }, [initialTimeMs]);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const video = videoRef.current;
      if (video) setCurrentMs(Math.round(video.currentTime * 1000));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [playing]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  const close = () => {
    videoRef.current?.pause();
    onClose();
  };
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };
  const ptWords = cue ? portugueseTimings(cue) : [];

  return (
    <div
      className="hub-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        className="hub-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hub-preview-title"
      >
        <header>
          <div>
            <span className="eyebrow">Prévia fiel do iHub</span>
            <h2 id="hub-preview-title">Vídeo e legendas sincronizadas</h2>
          </div>
          <button
            type="button"
            className="hub-preview-close"
            aria-label="Fechar prévia"
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="hub-preview-stage">
          <video
            ref={videoRef}
            src={mediaUrl}
            controls
            autoPlay
            preload="auto"
            aria-label="Prévia do vídeo no iHub"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) =>
              setCurrentMs(Math.round(event.currentTarget.currentTime * 1000))
            }
          />
          {cue && (
            <div className={`hub-preview-subtitles mode-${mode}`} aria-live="off">
              {cue.speaker && <div className="hub-preview-speaker">{cue.speaker}</div>}
              <div className="hub-preview-en">
                <CaptionLine
                  text={cue.approved_en || cue.original_en}
                  words={cue.words}
                  currentMs={currentMs}
                />
              </div>
              <div className="hub-preview-pt">
                <CaptionLine text={cue.approved_pt} words={ptWords} currentMs={currentMs} />
              </div>
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={toggle}>
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {playing ? "Pausar" : "Reproduzir"}
          </button>
          <div className="hub-preview-modes" role="group" aria-label="Idioma da legenda">
            {(["pt", "en", "dual"] as const).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {item === "dual" ? "Dual" : item.toUpperCase()}
              </button>
            ))}
          </div>
          <span>
            <kbd>Esc</kbd> fechar
          </span>
        </footer>
      </section>
    </div>
  );
}
