import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Crosshair, Pause, Play, Save, X, ZoomIn, ZoomOut } from "lucide-react";
import "./SubtitleTimingAdjuster.css";

export type SubtitleTimingWord = { text: string; startMs: number; endMs: number; [key: string]: unknown };
export type SubtitleTimingCue = {
  id: string;
  text: string;
  translation?: string;
  startMs: number;
  endMs: number;
  words?: SubtitleTimingWord[];
  [key: string]: unknown;
};

type Props = {
  title?: string;
  videoUrl: string;
  durationMs: number;
  videoOffsetMs?: number;
  cues: SubtitleTimingCue[];
  selectedCueId?: string | null;
  onCancel: () => void;
  onSave: (cues: SubtitleTimingCue[]) => Promise<void> | void;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatTime = (value: number) => {
  const ms = Math.max(0, Math.round(value));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
const parseTime = (value: string) => {
  const raw = value.trim();
  if (/^\\d+(?:\\.\\d+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw) * 1000));
  const match = raw.match(/^(\\d+):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3}))?$/);
  if (!match) throw new Error("Use HH:MM:SS.mmm ou informe o tempo em segundos.");
  const [, h, m, s, fraction = "0"] = match;
  if (Number(m) > 59 || Number(s) > 59) throw new Error("Timecode inválido.");
  return ((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000) + Number(fraction.padEnd(3, "0"));
};
const remapWords = (words: SubtitleTimingWord[] | undefined, fromStart: number, fromEnd: number, toStart: number, toEnd: number) => {
  if (!words?.length) return words;
  const oldSpan = Math.max(1, fromEnd - fromStart);
  const newSpan = Math.max(1, toEnd - toStart);
  let previousEnd = toStart;
  return words.map((word, index) => {
    const project = (time: number) => toStart + Math.round(clamp(time - fromStart, 0, oldSpan) * newSpan / oldSpan);
    const remaining = words.length - index - 1;
    const startMs = Math.max(previousEnd, Math.min(project(word.startMs), toEnd - remaining - 1));
    const endMs = Math.max(startMs + 1, Math.min(project(word.endMs), toEnd - remaining));
    previousEnd = endMs;
    return { ...word, startMs, endMs };
  });
};

export default function SubtitleTimingAdjuster({
  title = "Ajustar sincronização das legendas",
  videoUrl,
  durationMs,
  videoOffsetMs = 0,
  cues,
  selectedCueId,
  onCancel,
  onSave,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const [draft, setDraft] = useState<SubtitleTimingCue[]>(() => cues.map(cue => ({ ...cue, words: cue.words?.map(word => ({ ...word })) })));
  const [activeId, setActiveId] = useState<string | null>(selectedCueId ?? cues[0]?.id ?? null);
  const [playhead, setPlayhead] = useState(0);
  const [activeEdge, setActiveEdge] = useState<"start" | "end">("start");
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [waveMessage, setWaveMessage] = useState("Carregando forma de onda...");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const sorted = useMemo(() => [...draft].sort((a, b) => a.startMs - b.startMs), [draft]);
  const active = draft.find(cue => cue.id === activeId) ?? sorted[0] ?? null;
  const visibleDuration = Math.max(1, durationMs / zoom);
  const viewEnd = Math.min(durationMs, viewStart + visibleDuration);
  const rangeStart = active?.startMs ?? 0;
  const rangeEnd = active?.endMs ?? 1;

  useEffect(() => {
    setStartText(formatTime(rangeStart));
    setEndText(formatTime(rangeEnd));
  }, [activeId, rangeStart, rangeEnd]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setCanvasWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const seek = useCallback((localMs: number) => {
    const safe = clamp(localMs, 0, durationMs);
    setPlayhead(safe);
    if (videoRef.current) videoRef.current.currentTime = (videoOffsetMs + safe) / 1000;
  }, [durationMs, videoOffsetMs]);

  const setRange = useCallback((start: number, end: number) => {
    if (!active) return;
    const nextStart = clamp(Math.round(start), 0, Math.max(0, durationMs - 1));
    const nextEnd = clamp(Math.round(end), nextStart + 1, Math.max(nextStart + 1, durationMs));
    setDraft(items => items.map(cue => cue.id !== active.id ? cue : ({
      ...cue,
      startMs: nextStart,
      endMs: nextEnd,
      words: remapWords(cue.words, cue.startMs, cue.endMs, nextStart, nextEnd),
    })));
    setError("");
  }, [active, durationMs]);

  const centerCue = useCallback(() => {
    if (!active) return;
    const span = durationMs / zoom;
    setViewStart(clamp((active.startMs + active.endMs) / 2 - span / 2, 0, Math.max(0, durationMs - span)));
  }, [active, durationMs, zoom]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => setPlayhead(clamp(video.currentTime * 1000 - videoOffsetMs, 0, durationMs));
    video.addEventListener("timeupdate", update);
    video.addEventListener("seeked", update);
    video.addEventListener("loadedmetadata", update);
    video.playbackRate = speed;
    return () => {
      video.removeEventListener("timeupdate", update);
      video.removeEventListener("seeked", update);
      video.removeEventListener("loadedmetadata", update);
    };
  }, [videoOffsetMs, durationMs, speed]);

  useEffect(() => {
    let cancelled = false;
    let context: AudioContext | null = null;
    (async () => {
      try {
        const response = await fetch(videoUrl);
        const size = Number(response.headers.get("content-length") || 0);
        if (size > 120 * 1024 * 1024) {
          setWaveMessage("Arquivo grande demais para gerar a forma de onda no navegador. Os controles de tempo continuam disponíveis.");
          return;
        }
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        context = new AudioContext();
        const audio = await context.decodeAudioData(bytes.slice(0));
        if (cancelled) return;
        const channel = audio.getChannelData(0);
        const bins = 1800;
        const samplesPerBin = Math.max(1, Math.floor(channel.length / bins));
        const next: number[] = [];
        for (let i = 0; i < bins; i++) {
          let peak = 0;
          const end = Math.min(channel.length, (i + 1) * samplesPerBin);
          for (let j = i * samplesPerBin; j < end; j += 4) peak = Math.max(peak, Math.abs(channel[j] || 0));
          next.push(peak);
        }
        setPeaks(next);
        setWaveMessage("Forma de onda carregada");
      } catch {
        if (!cancelled) setWaveMessage("Forma de onda indisponível neste formato. Ajuste pelos controles de tempo e pelo vídeo.");
      } finally {
        await context?.close().catch(() => undefined);
      }
    })();
    return () => { cancelled = true; void context?.close().catch(() => undefined); };
  }, [videoUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const height = 150;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, height);
    ctx.fillStyle = "#0b1420";
    ctx.fillRect(0, 0, rect.width, height);
    const mid = height / 2;
    ctx.strokeStyle = "rgba(139,160,184,.18)";
    for (let i = 1; i < 8; i++) {
      const x = rect.width * i / 8;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    const total = Math.max(1, viewEnd - viewStart);
    if (peaks.length) {
      ctx.strokeStyle = "#6386a8";
      ctx.beginPath();
      for (let x = 0; x < rect.width; x++) {
        const time = viewStart + x / rect.width * total;
        const index = clamp(Math.floor(time / Math.max(1, durationMs) * peaks.length), 0, peaks.length - 1);
        const amp = (peaks[index] || 0) * 55;
        ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp);
      }
      ctx.stroke();
    }
    const xAt = (time: number) => (time - viewStart) / total * rect.width;
    const sx = xAt(rangeStart), ex = xAt(rangeEnd);
    ctx.fillStyle = "rgba(43,208,157,.16)";
    ctx.fillRect(clamp(sx, 0, rect.width), 0, Math.max(0, clamp(ex, 0, rect.width) - clamp(sx, 0, rect.width)), height);
    const marker = (x: number, color: string, label: string) => {
      if (x < 0 || x > rect.width) return;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillStyle = color; ctx.fillRect(clamp(x - 17, 0, rect.width - 34), 5, 34, 20);
      ctx.fillStyle = "#061019"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
      ctx.fillText(label, clamp(x, 17, rect.width - 17), 19);
    };
    marker(sx, "#32d6a0", "IN");
    marker(ex, "#f0b35a", "OUT");
    const px = xAt(playhead);
    if (px >= 0 && px <= rect.width) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, height); ctx.stroke();
    }
  }, [peaks, durationMs, viewStart, viewEnd, rangeStart, rangeEnd, playhead, canvasWidth]);

  useEffect(() => {
    if (!active) return;
    if (zoom > 1) centerCue();
    seek(active.startMs);
  // Initial positioning follows cue selection, not every drag update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    const onResize = () => {
      const canvas = canvasRef.current;
      if (canvas) canvas.dispatchEvent(new Event("resize"));
      setZoom(value => value);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!active || !videoRef.current) return;
    videoRef.current.playbackRate = speed;
  }, [speed, activeId]);

  useEffect(() => {
    if (!busy) return;
    const stop = () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); };
    return stop;
  }, [busy]);

  const playCue = async () => {
    if (!active || !videoRef.current) return;
    const video = videoRef.current;
    video.pause();
    video.currentTime = (videoOffsetMs + active.startMs) / 1000;
    try { await video.play(); } catch { return; }
    const token = { cancelled: false };
    const tick = () => {
      if (token.cancelled || !videoRef.current) return;
      const local = video.currentTime * 1000 - videoOffsetMs;
      setPlayhead(clamp(local, 0, durationMs));
      if (local >= active.endMs || video.ended) {
        video.pause();
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  const markIn = () => setRange(Math.min(playhead, rangeEnd - 1), rangeEnd);
  const markOut = () => setRange(rangeStart, Math.max(rangeStart + 1, playhead));
  const nudge = (direction: number, amount: number) => {
    if (!active) return;
    if (dragRef.current === "end") setRange(rangeStart, rangeEnd + direction * amount);
    else setRange(rangeStart + direction * amount, rangeEnd);
  };
  const onWavePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const total = Math.max(1, viewEnd - viewStart);
    const startX = (rangeStart - viewStart) / total * rect.width;
    const endX = (rangeEnd - viewStart) / total * rect.width;
    const nearStart = Math.abs(x - startX) <= 18;
    const nearEnd = Math.abs(x - endX) <= 18;
    const edge = nearStart ? "start" : nearEnd ? "end" : null;
    if (edge) {
      dragRef.current = edge;
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    seek(viewStart + x / rect.width * total);
  };
  const onWavePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const total = Math.max(1, viewEnd - viewStart);
    const time = viewStart + clamp(event.clientX - rect.left, 0, rect.width) / rect.width * total;
    if (dragRef.current === "start") setRange(Math.min(time, rangeEnd - 1), rangeEnd);
    else setRange(rangeStart, Math.max(rangeStart + 1, time));
    seek(time);
  };
  const onWavePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  };

  useEffect(() => {
    if (!active) return;
    const handleKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "VIDEO"].includes(target.tagName))) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (event.shiftKey) {
          const video = videoRef.current;
          if (video?.paused) void video.play().catch(() => undefined);
          else video?.pause();
        } else if (videoRef.current?.paused) void playCue();
        else videoRef.current?.pause();
      } else if (event.code === "KeyA") { event.preventDefault(); markIn(); }
      else if (event.code === "KeyS") { event.preventDefault(); markOut(); }
      else if (event.code === "KeyG") { event.preventDefault(); void save(); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        nudge(event.key === "ArrowRight" ? 1 : -1, event.altKey ? 1 : event.shiftKey ? 100 : 10);
      }
    };
    window.addEventListener("keydown", handleKeys);
    return () => window.removeEventListener("keydown", handleKeys);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playhead, rangeStart, rangeEnd, draft, busy]);

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await onSave(sorted);
      setMessage("Sincronização salva e persistida.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeInput = (edge: "start" | "end", value: string) => {
    try {
      const time = parseTime(value);
      if (edge === "start") setRange(Math.min(time, rangeEnd - 1), rangeEnd);
      else setRange(rangeStart, Math.max(rangeStart + 1, time));
    } catch (e) { setError(String(e)); }
  };

  return <div className="subtitle-timing-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="subtitle-timing-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="subtitle-timing-header">
        <div><span className="subtitle-timing-kicker">EDITOR ESPECIALIZADO</span><h2>{title}</h2><p>Ajuste cada cue ouvindo o trecho e conferindo o texto sobre o vídeo.</p></div>
        <button type="button" className="subtitle-timing-icon" onClick={onCancel} disabled={busy} title="Fechar"><X size={18}/></button>
      </header>
      <div className="subtitle-timing-layout">
        <aside className="subtitle-timing-sidebar">
          <div className="subtitle-timing-sidebar-head"><strong>Todas as cues</strong><span>{sorted.length}</span></div>
          <div className="subtitle-timing-cue-list">{sorted.map((cue, index) => <button key={cue.id} type="button" className={cue.id === activeId ? "active" : ""} onClick={() => setActiveId(cue.id)}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{cue.text || "Cue sem texto"}</strong><small>{formatTime(cue.startMs)} → {formatTime(cue.endMs)}</small></span></button>)}</div>
        </aside>
        <main className="subtitle-timing-main">
          <div className="subtitle-timing-video-wrap">
            <video ref={videoRef} src={videoUrl} controls playsInline preload="metadata" onLoadedMetadata={() => seek(active?.startMs ?? 0)} onTimeUpdate={event => setPlayhead(clamp(event.currentTarget.currentTime * 1000 - videoOffsetMs, 0, durationMs))}/>
            {active && playhead >= active.startMs && playhead < active.endMs && <div className="subtitle-timing-overlay"><strong>{active.text}</strong>{active.translation && <span>{active.translation}</span>}</div>}
          </div>
          {active && <div className="subtitle-timing-cue-text"><strong>{active.text}</strong>{active.translation && <span>{active.translation}</span>}</div>}
          <div className="subtitle-timing-wave-tools">
            <label><span>ZOOM</span><input type="range" min="1" max="8" step="1" value={zoom} onChange={event => setZoom(Number(event.target.value))}/><b>{zoom}×</b></label>
            <button type="button" onClick={centerCue}><Crosshair size={14}/> Centralizar cue</button>
            <label className="subtitle-timing-speed">Velocidade<select value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.25}>0,25×</option><option value={0.35}>0,35×</option><option value={0.5}>0,50×</option><option value={0.65}>0,65×</option><option value={0.75}>0,75×</option><option value={0.85}>0,85×</option><option value={1}>1×</option><option value={1.1}>1,10×</option><option value={1.25}>1,25×</option></select></label>
          </div>
          <div className="subtitle-timing-wave-heading"><span>FORMA DE ONDA · IN / OUT</span><strong>{formatTime(playhead)}</strong></div>
          <canvas ref={canvasRef} className="subtitle-timing-wave" onPointerDown={onWavePointerDown} onPointerMove={onWavePointerMove} onPointerUp={onWavePointerUp} onPointerCancel={onWavePointerUp}/>
          <div className="subtitle-timing-wave-status">{waveMessage}</div>
          <div className="subtitle-timing-time-fields">
            <label><span>IN</span><input value={formatTime(rangeStart)} onChange={event => changeInput("start", event.target.value)} onBlur={event => { try { event.target.value = formatTime(parseTime(event.target.value)); } catch { /* keep invalid text visible */ } }}/></label>
            <span className="subtitle-timing-arrow">→</span>
            <label><span>OUT</span><input value={formatTime(rangeEnd)} onChange={event => changeInput("end", event.target.value)}/></label>
            <strong>{((rangeEnd - rangeStart) / 1000).toFixed(3)}s</strong>
          </div>
          <div className="subtitle-timing-actions">
            <button type="button" onClick={markIn}>Marcar IN aqui <kbd>A</kbd></button>
            <button type="button" onClick={markOut}>Marcar OUT aqui <kbd>S</kbd></button>
            <button type="button" onClick={() => void playCue()}><Play size={13}/> Reproduzir cue <kbd>Space</kbd></button>
            <button type="button" onClick={() => { if (videoRef.current) { videoRef.current.currentTime = videoOffsetMs / 1000; void videoRef.current.play().catch(() => undefined); } }}>Reproduzir mídia <kbd>Shift+Space</kbd></button>
          </div>
          <div className="subtitle-timing-shortcuts">← / → ±10 ms · Shift ±100 ms · Alt ±1 ms · G salvar · Arraste as alças IN/OUT</div>
          {error && <div className="subtitle-timing-error" role="alert">{error}</div>}
          {message && <div className="subtitle-timing-success" role="status"><Check size={14}/>{message}</div>}
        </main>
      </div>
      <footer className="subtitle-timing-footer"><button type="button" className="subtitle-timing-cancel" onClick={onCancel} disabled={busy}>Cancelar</button><button type="button" className="subtitle-timing-save" onClick={() => void save()} disabled={busy || !sorted.length}>{busy ? "Salvando..." : <><Save size={15}/> Salvar todos os tempos <kbd>G</kbd></>}</button></footer>
    </section>
  </div>;
}
