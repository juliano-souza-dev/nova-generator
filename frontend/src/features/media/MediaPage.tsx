import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Scissors, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { Project, ProjectMedia } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./media.css";

const ACTIVE = new Set(["queued", "running", "retryable"]);

export function MediaPage() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects", "media"],
    queryFn: () => studioApi.projects(),
  });
  const selectedId = params.get("project") ?? "";
  const selected = useMemo(
    () => projects.data?.find((project) => project.id === selectedId) ?? projects.data?.[0],
    [projects.data, selectedId],
  );
  const media = useQuery({
    queryKey: ["project-media", selected?.id],
    queryFn: () => studioApi.projectMedia(selected!.id),
    enabled: !!selected,
    refetchInterval: (query) =>
      ACTIVE.has(query.state.data?.download_status ?? "") ||
      ACTIVE.has(query.state.data?.ingest_status ?? "")
        ? 3000
        : false,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["project-media", selected?.id] });
    void client.invalidateQueries({ queryKey: ["projects", "media"] });
  };
  const start = useMutation({
    mutationFn: (id: string) => studioApi.startProjectMedia(id),
    onSuccess: refresh,
  });
  const ingest = useMutation({
    mutationFn: (input: { start_ms: number; end_ms: number; language: string }) =>
      studioApi.ingestProjectMedia(selected!.id, input),
    onSuccess: refresh,
  });
  const sourceWaveform = useQuery({
    queryKey: ["source-waveform", selected?.id],
    queryFn: () => studioApi.projectSourceWaveform(selected!.id),
    enabled: Boolean(selected && media.data?.can_cut),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const sourcePlayer = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (selected && selected.id !== selectedId)
      setParams({ project: selected.id }, { replace: true });
  }, [selected, selectedId, setParams]);

  return (
    <section>
      <PageHeader
        title="Fonte e corte de mídia"
        description="Reaproveite a fonte global, extraia um corte e revise a transcrição candidata."
      />
      {projects.isPending && <LoadingState label="Carregando fontes de mídia" />}
      {projects.isError && (
        <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />
      )}
      {projects.data?.length === 0 && (
        <EmptyState title="Nenhum projeto para preparar">
          <Video aria-hidden="true" /> Crie um projeto e informe uma URL do YouTube para começar.
        </EmptyState>
      )}
      {selected && (
        <>
          <label className="media-project-picker">
            Projeto
            <select
              value={selected.id}
              onChange={(event) => setParams({ project: event.target.value })}
            >
              {projects.data?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          {media.isPending && <LoadingState label="Verificando mídia do projeto" />}
          {media.isError && (
            <ErrorState message={media.error.message} retry={() => void media.refetch()} />
          )}
          {media.data && (
            <>
              <SourceStatus
                project={selected}
                media={media.data}
                onStart={() => start.mutate(selected.id)}
                busy={start.isPending}
              />
              {start.error && (
                <p className="field-error" role="alert">
                  {start.error.message}
                </p>
              )}
              <JourneySteps media={media.data} />
              {media.data.source_ready && (
                <MediaPlayer media={media.data} playerRef={sourcePlayer} />
              )}
              {media.data.can_cut && (
                <CutEditor
                  key={selected.id}
                  project={selected}
                  media={media.data}
                  onIngest={(input) => ingest.mutate(input)}
                  busy={ingest.isPending}
                  waveform={sourceWaveform.data?.peaks ?? []}
                  playerRef={sourcePlayer}
                />
              )}
              {ingest.error && (
                <p className="field-error" role="alert">
                  {ingest.error.message}
                </p>
              )}
              {media.data.transcript_candidate && (
                <TranscriptReview projectId={selected.id} media={media.data} />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function SourceStatus({
  project,
  media,
  onStart,
  busy,
}: {
  project: Project;
  media: ProjectMedia;
  onStart: () => void;
  busy: boolean;
}) {
  const hasSource = Boolean(project.youtube_url && project.youtube_video_id);
  const cacheMessage = media.source_ready
    ? "Fonte verificada no cache global"
    : hasSource
      ? "Fonte ainda não está no cache"
      : "Este projeto não tem fonte YouTube";
  return (
    <section className="media-status panel" aria-label="Status da fonte">
      <div>
        <h2>Fonte</h2>
        <p>{cacheMessage}</p>
        {media.duration_ms !== null && <strong>{formatClock(media.duration_ms)} de vídeo</strong>}
        {media.download_error && (
          <p className="field-error" role="alert">
            {media.download_error}
          </p>
        )}
      </div>
      {hasSource ? (
        <button
          className="primary-button"
          onClick={onStart}
          disabled={busy || ACTIVE.has(media.download_status ?? "") || !media.can_start}
        >
          <Download aria-hidden="true" />
          {busy || ACTIVE.has(media.download_status ?? "")
            ? "Preparando fonte…"
            : media.source_ready
              ? "Fonte pronta"
              : media.state === "failed"
                ? "Tentar novamente"
                : "Iniciar processamento"}
        </button>
      ) : (
        <span className="media-warning">
          <AlertTriangle aria-hidden="true" /> Informe a URL no projeto.
        </span>
      )}
    </section>
  );
}

function JourneySteps({ media }: { media: ProjectMedia }) {
  const steps = [
    ["source", "Preparar fonte"],
    ["cut", "Escolher corte"],
    ["cut_and_asr", "Cortar e transcrever"],
    ["review", "Revisar legenda"],
  ] as const;
  const current = steps.findIndex(([key]) => key === media.current_step);
  return (
    <ol className="media-steps" aria-label="Etapas do processamento">
      {steps.map(([key, label], index) => (
        <li
          key={key}
          className={index < current ? "complete" : index === current ? "current" : "pending"}
          aria-current={index === current ? "step" : undefined}
        >
          <span>{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function MediaPlayer({
  media,
  playerRef,
}: {
  media: ProjectMedia;
  playerRef: RefObject<HTMLVideoElement | null>;
}) {
  const url = media.cut_url ?? media.source_url;
  return (
    <section className="media-player panel">
      <h2>{media.cut_url ? "Player do corte" : "Player da fonte"}</h2>
      {url ? (
        <video
          ref={playerRef}
          key={url}
          controls
          preload="metadata"
          src={url}
          aria-label="Player da fonte de vídeo"
        >
          <track kind="captions" />
        </video>
      ) : (
        <p className="hint">Baixe a fonte para habilitar o player.</p>
      )}
      {media.cut_url && media.source_url && (
        <a href={media.source_url} target="_blank" rel="noreferrer">
          Abrir fonte completa
        </a>
      )}
    </section>
  );
}

function CutEditor({
  project,
  media,
  onIngest,
  busy,
  waveform,
  playerRef,
}: {
  project: Project;
  media: ProjectMedia;
  onIngest: (input: { start_ms: number; end_ms: number; language: string }) => void;
  busy: boolean;
  waveform: number[];
  playerRef: RefObject<HTMLVideoElement | null>;
}) {
  const duration = media.duration_ms ?? 0;
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(60_000);
  const [language, setLanguage] = useState("en");
  useEffect(() => {
    if (duration > 0) setEndMs((current) => Math.min(current, duration));
  }, [duration]);
  const updateStart = (value: number) => setStartMs(Math.min(Math.max(0, value), endMs - 100));
  const updateEnd = (value: number) => setEndMs(Math.max(Math.min(duration, value), startMs + 100));
  const ready = media.source_ready && duration >= 100 && endMs > startMs && endMs <= duration;
  return (
    <section className="cut-editor panel" aria-label="Seleção de corte">
      <div className="cut-heading">
        <div>
          <h2>Seleção de corte</h2>
          <p>Os tempos são da fonte verificada; o MP4 resultante pertence a {project.title}.</p>
        </div>
        <Scissors aria-hidden="true" />
      </div>
      <SourceWaveEditor
        peaks={waveform}
        startMs={startMs}
        endMs={endMs}
        durationMs={duration}
        onStartChange={updateStart}
        onEndChange={updateEnd}
        playerRef={playerRef}
      />
      <div className="cut-controls">
        <label>
          Início (segundos)
          <input
            aria-label="Início do corte em segundos"
            type="number"
            min="0"
            max={Math.max(0, (endMs - 100) / 1000)}
            step="0.1"
            value={(startMs / 1000).toFixed(1)}
            disabled={!media.source_ready}
            onChange={(event) => updateStart(Number(event.target.value) * 1000)}
          />
        </label>
        <label>
          Fim (segundos)
          <input
            aria-label="Fim do corte em segundos"
            type="number"
            min={(startMs + 100) / 1000}
            max={duration / 1000}
            step="0.1"
            value={(endMs / 1000).toFixed(1)}
            disabled={!media.source_ready}
            onChange={(event) => updateEnd(Number(event.target.value) * 1000)}
          />
        </label>
        <output aria-label="Duração do corte">{((endMs - startMs) / 1000).toFixed(1)} s</output>
      </div>
      <label className="media-language">
        Idioma da transcrição
        <select value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="en">Inglês</option>
          <option value="pt">Português</option>
        </select>
      </label>
      <button
        className="primary-button"
        disabled={!ready || busy || ACTIVE.has(media.ingest_status ?? "")}
        onClick={() => onIngest({ start_ms: startMs, end_ms: endMs, language })}
      >
        <Scissors aria-hidden="true" />
        {busy ? "Enfileirando…" : "Extrair corte e transcrever"}
      </button>
      {media.ingest_status && (
        <p className="media-job" role="status">
          Corte: {media.ingest_status}
        </p>
      )}
      {media.ingest_error && (
        <p className="field-error" role="alert">
          {media.ingest_error}
        </p>
      )}
      {media.waveform && (
        <CutWaveform peaks={media.waveform.peaks} bucketMs={media.waveform.bucket_ms} />
      )}
    </section>
  );
}

function SourceWaveEditor({
  peaks,
  startMs,
  endMs,
  durationMs,
  onStartChange,
  onEndChange,
  playerRef,
}: {
  peaks: number[];
  startMs: number;
  endMs: number;
  durationMs: number;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  playerRef: RefObject<HTMLVideoElement | null>;
}) {
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const update = () => setPlayheadMs(player.currentTime * 1000);
    player.addEventListener("timeupdate", update);
    return () => player.removeEventListener("timeupdate", update);
  }, [playerRef]);
  const displayed = useMemo(() => {
    if (peaks.length <= 500) return peaks;
    const size = Math.ceil(peaks.length / 500);
    return Array.from({ length: Math.ceil(peaks.length / size) }, (_, index) =>
      Math.max(...peaks.slice(index * size, (index + 1) * size)),
    );
  }, [peaks]);
  const start = durationMs > 0 ? (startMs / durationMs) * 1200 : 0;
  const end = durationMs > 0 ? (endMs / durationMs) * 1200 : 0;
  const playhead = durationMs > 0 ? (playheadMs / durationMs) * 1200 : 0;
  const position = (event: ReactPointerEvent<SVGSVGElement> | ReactMouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(durationMs, ((event.clientX - bounds.left) / bounds.width) * durationMs),
    );
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging === "start") onStartChange(position(event));
    if (dragging === "end") onEndChange(position(event));
  };
  return (
    <div className="source-wave-editor">
      <div className="wave-editor-heading">
        <strong>Arraste os limites sobre o áudio</strong>
        <span>
          {formatClock(startMs)} — {formatClock(endMs)}
        </span>
      </div>
      {displayed.length ? (
        <svg
          className="source-waveform interactive"
          viewBox="0 0 1200 180"
          role="img"
          aria-label="Waveform da fonte com intervalo de corte"
          onPointerMove={move}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
          onPointerDown={(event) => {
            const value = position(event);
            const edge = Math.abs(value - startMs) <= Math.abs(value - endMs) ? "start" : "end";
            setDragging(edge);
            event.currentTarget.setPointerCapture(event.pointerId);
            if (edge === "start") onStartChange(value);
            else onEndChange(value);
          }}
          onDoubleClick={(event) => {
            const value = position(event);
            if (playerRef.current) playerRef.current.currentTime = value / 1000;
            setPlayheadMs(value);
          }}
        >
          <rect width="1200" height="180" className="wave-bg" />
          {displayed.map((peak, index) => {
            const x = (index / Math.max(1, displayed.length - 1)) * 1200;
            return (
              <line
                key={index}
                x1={x}
                x2={x}
                y1={90 - peak * 76}
                y2={90 + peak * 76}
                className="source-wave-bar"
              />
            );
          })}
          <rect
            x={start}
            width={Math.max(0, end - start)}
            height="180"
            className="wave-selection"
          />
          <rect width={start} height="180" className="wave-outside" />
          <rect x={end} width={Math.max(0, 1200 - end)} height="180" className="wave-outside" />
          <line x1={playhead} x2={playhead} y1="0" y2="180" className="wave-playhead" />
          <line x1={start} x2={start} y1="0" y2="180" className="cut-handle" />
          <circle cx={start} cy="18" r="11" className="cut-grip" />
          <line x1={end} x2={end} y1="0" y2="180" className="cut-handle" />
          <circle cx={end} cy="18" r="11" className="cut-grip" />
        </svg>
      ) : (
        <div className="waveform-loading">Gerando waveform da fonte…</div>
      )}
      <p className="wave-help">
        Arraste o início ou o fim. Dê dois cliques para posicionar o vídeo.
      </p>
    </div>
  );
}

function CutWaveform({ peaks, bucketMs }: { peaks: number[]; bucketMs: number }) {
  const displayed =
    peaks.length > 600
      ? peaks.filter((_, index) => index % Math.ceil(peaks.length / 600) === 0)
      : peaks;
  return (
    <div>
      <h3>Waveform do corte</h3>
      <p className="hint">
        {peaks.length} amostras de {bucketMs} ms
      </p>
      <svg
        className="source-waveform"
        viewBox="0 0 1200 160"
        role="img"
        aria-label="Waveform extraída do corte"
      >
        <rect width="1200" height="160" className="wave-bg" />
        {displayed.map((peak, index) => (
          <line
            key={index}
            x1={(index / displayed.length) * 1200}
            x2={(index / displayed.length) * 1200}
            y1={80 - peak * 70}
            y2={80 + peak * 70}
            className="source-wave-bar"
          />
        ))}
      </svg>
    </div>
  );
}

function TranscriptReview({ projectId, media }: { projectId: string; media: ProjectMedia }) {
  const candidate = media.transcript_candidate;
  if (!candidate || !media.can_review) return null;
  return (
    <section className="panel media-transcript">
      <h2>Transcrição candidata</h2>
      <p>
        {candidate.engine} · {candidate.model} · {candidate.language ?? "idioma automático"}
      </p>
      <ol>
        {candidate.cues.map((cue, index) => (
          <li key={`${index}-${cue.start_ms}`}>
            <time>
              {formatMs(cue.start_ms)}–{formatMs(cue.end_ms)}
            </time>
            <span>{cue.text}</span>
          </li>
        ))}
      </ol>
      <Link
        className="primary-button"
        to={media.review_url ?? `/editorial?project=${encodeURIComponent(projectId)}`}
      >
        Revisar legenda
      </Link>
    </section>
  );
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(2)} s`;
}

function formatClock(value: number) {
  const seconds = Math.max(0, value) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}
