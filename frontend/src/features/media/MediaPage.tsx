import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, Scissors, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { Project } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./media.css";

const DEFAULT_DURATION_MS = 180_000;
const waveform = [0.18, 0.32, 0.56, 0.78, 0.42, 0.2, 0.66, 0.91, 0.48, 0.29, 0.7, 0.38];

export function MediaPage() {
  const [params, setParams] = useSearchParams();
  const projects = useQuery({
    queryKey: ["projects", "media"],
    queryFn: () => studioApi.projects(),
  });
  const selectedId = params.get("project") ?? "";
  const selected = useMemo(
    () => projects.data?.find((project) => project.id === selectedId) ?? projects.data?.[0],
    [projects.data, selectedId],
  );
  const download = useMutation({
    mutationFn: (project: Project) =>
      studioApi.enqueueJob({
        kind: "download_youtube",
        input: { project_id: project.id },
        idempotency_key: `download-youtube:${project.youtube_video_id ?? project.id}`,
      }),
  });

  useEffect(() => {
    if (selected && selected.id !== selectedId) {
      setParams({ project: selected.id }, { replace: true });
    }
  }, [selected, selectedId, setParams]);

  return (
    <section>
      <PageHeader
        title="Fonte e corte de mídia"
        description="Reaproveite a fonte global e defina o corte exclusivo do projeto antes da transcrição."
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
          <SourceStatus
            project={selected}
            onDownload={() => download.mutate(selected)}
            busy={download.isPending}
          />
          {download.error && (
            <p className="field-error" role="alert">
              {download.error.message}
            </p>
          )}
          {download.data && (
            <p className="media-job" role="status">
              Job {download.data.id} está {download.data.status}.
            </p>
          )}
          <MediaPlayer project={selected} />
          <CutEditor project={selected} />
        </>
      )}
    </section>
  );
}

function SourceStatus({
  project,
  onDownload,
  busy,
}: {
  project: Project;
  onDownload: () => void;
  busy: boolean;
}) {
  const hasSource = Boolean(project.youtube_url && project.youtube_video_id);
  const cacheMessage =
    project.cache_status === "reused"
      ? "Fonte verificada no cache global"
      : project.cache_status === "missing"
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
            <div>
              <dt>Job</dt>
              <dd>{project.job_status}</dd>
            </div>
          </dl>
        )}
      </div>
      {hasSource ? (
        <button
          className="primary-button"
          onClick={onDownload}
          disabled={busy || project.job_status === "queued"}
        >
          <Download aria-hidden="true" />
          {busy
            ? "Enfileirando…"
            : project.cache_status === "reused"
              ? "Verificar fonte"
              : "Baixar fonte"}
        </button>
      ) : (
        <span className="media-warning">
          <AlertTriangle aria-hidden="true" /> Informe a URL no projeto.
        </span>
      )}
    </section>
  );
}

function MediaPlayer({ project }: { project: Project }) {
  return (
    <section className="media-player panel">
      <h2>Player da fonte</h2>
      <video controls preload="metadata" aria-label="Player da fonte de vídeo">
        <track kind="captions" />
      </video>
      <p className="hint">
        O player usa o arquivo do corte quando a API de streaming estiver disponível. O vídeo
        original continua compartilhado no cache global.
      </p>
      {project.youtube_url && (
        <a href={project.youtube_url} target="_blank" rel="noreferrer">
          Abrir referência no YouTube
        </a>
      )}
    </section>
  );
}

function CutEditor({ project }: { project: Project }) {
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(60_000);
  const duration = DEFAULT_DURATION_MS;
  const updateStart = (value: number) => setStartMs(Math.min(Math.max(0, value), endMs - 100));
  const updateEnd = (value: number) => setEndMs(Math.max(Math.min(duration, value), startMs + 100));
  return (
    <section className="cut-editor panel" aria-label="Seleção de corte">
      <div className="cut-heading">
        <div>
          <h2>Seleção de corte</h2>
          <p>Os tempos são do vídeo fonte; somente o MP4 resultante pertence a este projeto.</p>
        </div>
        <Scissors aria-hidden="true" />
      </div>
      <Waveform startMs={startMs} endMs={endMs} durationMs={duration} />
      <div className="cut-controls">
        <label>
          Início (ms)
          <input
            aria-label="Início do corte em milissegundos"
            type="number"
            min="0"
            max={endMs - 100}
            step="100"
            value={startMs}
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
            max={endMs - 100}
            step="100"
            value={startMs}
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
            onChange={(event) => updateEnd(Number(event.target.value))}
          />
        </label>
      </div>
      <p className="hint">
        O job de corte e waveform será enviado depois que a fonte estiver pronta. Projeto:{" "}
        {project.title}.
      </p>
    </section>
  );
}

function Waveform({
  startMs,
  endMs,
  durationMs,
}: {
  startMs: number;
  endMs: number;
  durationMs: number;
}) {
  const start = (startMs / durationMs) * 100;
  const width = ((endMs - startMs) / durationMs) * 100;
  return (
    <svg
      className="source-waveform"
      viewBox="0 0 1200 160"
      role="img"
      aria-label="Waveform da fonte e intervalo selecionado"
    >
      <rect width="1200" height="160" className="wave-bg" />
      <rect x={start * 12} width={width * 12} height="160" className="wave-selection" />
      {Array.from({ length: 96 }, (_, index) => {
        const amplitude = waveform[index % waveform.length] * 62;
        const x = index * 12.5 + 5;
        return (
          <line
            key={index}
            x1={x}
            x2={x}
            y1={80 - amplitude}
            y2={80 + amplitude}
            className="source-wave-bar"
          />
        );
      })}
      <line x1={start * 12} x2={start * 12} y1="0" y2="160" className="cut-handle" />
      <line
        x1={(start + width) * 12}
        x2={(start + width) * 12}
        y1="0"
        y2="160"
        className="cut-handle"
      />
    </svg>
  );
}
