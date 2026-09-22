import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Scissors, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const download = useMutation({
    mutationFn: (id: string) => studioApi.downloadProjectMedia(id),
    onSuccess: refresh,
  });
  const ingest = useMutation({
    mutationFn: (input: { start_ms: number; end_ms: number; language: string }) =>
      studioApi.ingestProjectMedia(selected!.id, input),
    onSuccess: refresh,
  });

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
                onDownload={() => download.mutate(selected.id)}
                busy={download.isPending}
              />
              {download.error && (
                <p className="field-error" role="alert">
                  {download.error.message}
                </p>
              )}
              <MediaPlayer media={media.data} />
              <CutEditor
                key={selected.id}
                project={selected}
                media={media.data}
                onIngest={(input) => ingest.mutate(input)}
                busy={ingest.isPending}
              />
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
  onDownload,
  busy,
}: {
  project: Project;
  media: ProjectMedia;
  onDownload: () => void;
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
        {project.youtube_video_id && (
          <dl>
            <div>
              <dt>Vídeo</dt>
              <dd>{project.youtube_video_id}</dd>
            </div>
            {media.duration_ms !== null && (
              <div>
                <dt>Duração</dt>
                <dd>{formatMs(media.duration_ms)}</dd>
              </div>
            )}
            {media.download_status && (
              <div>
                <dt>Download</dt>
                <dd>{media.download_status}</dd>
              </div>
            )}
          </dl>
        )}
        {media.download_error && (
          <p className="field-error" role="alert">
            {media.download_error}
          </p>
        )}
      </div>
      {hasSource ? (
        <button
          className="primary-button"
          onClick={onDownload}
          disabled={busy || ACTIVE.has(media.download_status ?? "")}
        >
          <Download aria-hidden="true" />
          {busy ? "Enfileirando…" : media.source_ready ? "Verificar fonte" : "Baixar fonte"}
        </button>
      ) : (
        <span className="media-warning">
          <AlertTriangle aria-hidden="true" /> Informe a URL no projeto.
        </span>
      )}
    </section>
  );
}

function MediaPlayer({ media }: { media: ProjectMedia }) {
  const url = media.cut_url ?? media.source_url;
  return (
    <section className="media-player panel">
      <h2>{media.cut_url ? "Player do corte" : "Player da fonte"}</h2>
      {url ? (
        <video
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
}: {
  project: Project;
  media: ProjectMedia;
  onIngest: (input: { start_ms: number; end_ms: number; language: string }) => void;
  busy: boolean;
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
      <SourceRange startMs={startMs} endMs={endMs} durationMs={duration} />
      <div className="cut-controls">
        <label>
          Início (ms)
          <input
            aria-label="Início do corte em milissegundos"
            type="number"
            min="0"
            max={Math.max(0, endMs - 100)}
            step="100"
            value={startMs}
            disabled={!media.source_ready}
            onChange={(event) => updateStart(Number(event.target.value))}
          />
        </label>
        <label>
          Fim (ms)
          <input
            aria-label="Fim do corte em milissegundos"
            type="number"
            min={startMs + 100}
            max={duration}
            step="100"
            value={endMs}
            disabled={!media.source_ready}
            onChange={(event) => updateEnd(Number(event.target.value))}
          />
        </label>
        <output aria-label="Duração do corte">{((endMs - startMs) / 1000).toFixed(1)} s</output>
      </div>
      <div
        className="range-stack"
        aria-label="Handles do corte. Use as setas para ajustar em 100 milissegundos."
      >
        <label>
          Handle de início
          <input
            aria-label="Handle de início"
            type="range"
            min="0"
            max={Math.max(0, endMs - 100)}
            step="100"
            value={startMs}
            disabled={!media.source_ready}
            onChange={(event) => updateStart(Number(event.target.value))}
          />
        </label>
        <label>
          Handle de fim
          <input
            aria-label="Handle de fim"
            type="range"
            min={startMs + 100}
            max={duration}
            step="100"
            value={endMs}
            disabled={!media.source_ready}
            onChange={(event) => updateEnd(Number(event.target.value))}
          />
        </label>
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

function SourceRange({
  startMs,
  endMs,
  durationMs,
}: {
  startMs: number;
  endMs: number;
  durationMs: number;
}) {
  const start = durationMs > 0 ? (startMs / durationMs) * 1200 : 0;
  const end = durationMs > 0 ? (endMs / durationMs) * 1200 : 0;
  return (
    <svg
      className="source-waveform"
      viewBox="0 0 1200 160"
      role="img"
      aria-label="Intervalo selecionado na fonte"
    >
      <rect width="1200" height="160" className="wave-bg" />
      <rect x={start} width={Math.max(0, end - start)} height="160" className="wave-selection" />
      <line x1={start} x2={start} y1="0" y2="160" className="cut-handle" />
      <line x1={end} x2={end} y1="0" y2="160" className="cut-handle" />
    </svg>
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
  if (!candidate || !media.ingest_job_id) return null;
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
        to={`/editorial?project=${encodeURIComponent(projectId)}&ingest_job=${encodeURIComponent(media.ingest_job_id)}`}
      >
        Revisar no Editorial
      </Link>
    </section>
  );
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(2)} s`;
}
