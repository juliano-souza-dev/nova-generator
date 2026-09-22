import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { Job } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./jobs.css";

const ACTIVE = new Set(["queued", "running", "retryable"]);

export function JobsPage() {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const client = useQueryClient();
  const jobs = useQuery({
    queryKey: ["jobs", offset],
    queryFn: () => studioApi.jobs(offset),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => ACTIVE.has(job.status)) ? 5000 : false,
  });
  const detail = useQuery({
    queryKey: ["job", selected],
    queryFn: () => studioApi.job(selected!),
    enabled: !!selected,
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ["jobs"] });
  const cancel = useMutation({ mutationFn: studioApi.cancelJob, onSuccess: refresh });
  const retry = useMutation({ mutationFn: studioApi.retryJob, onSuccess: refresh });
  const actionError = cancel.error ?? retry.error;
  const limit = jobs.data?.limit ?? 25;

  return (
    <section>
      <PageHeader
        title="Monitor de jobs"
        description="Acompanhe processamento, falhas e recuperação. Jobs ativos são atualizados a cada 5 segundos."
        actions={
          <button className="primary-button" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
            Atualizar
          </button>
        }
      />
      {jobs.isPending && <LoadingState label="Carregando jobs" />}
      {jobs.isError && <ErrorState message={jobs.error.message} retry={refresh} />}
      {actionError && (
        <p className="field-error" role="alert">
          {actionError.message}
        </p>
      )}
      {jobs.data?.items.length === 0 && (
        <EmptyState title="Nenhum job encontrado">
          Os próximos trabalhos aparecerão aqui.
        </EmptyState>
      )}
      {jobs.data && jobs.data.items.length > 0 && (
        <>
          <div className="jobs-table-wrap panel">
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Estado</th>
                  <th>Etapa</th>
                  <th>Progresso</th>
                  <th>Duração</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.items.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    selected={selected === job.id}
                    onSelect={setSelected}
                    onCancel={() => cancel.mutate(job.id)}
                    onRetry={() => retry.mutate(job.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="jobs-pagination" aria-label="Paginação de jobs">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              Anterior
            </button>
            <span>
              {offset + 1}–{Math.min(offset + limit, jobs.data.total)} de {jobs.data.total}
            </span>
            <button
              disabled={offset + limit >= jobs.data.total}
              onClick={() => setOffset(offset + limit)}
            >
              Próximo
            </button>
          </nav>
        </>
      )}
      {selected && (
        <JobDrawer
          job={detail.data}
          loading={detail.isPending}
          error={detail.error?.message}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
  onCancel,
  onRetry,
}: {
  job: Job;
  selected: boolean;
  onSelect: (id: string) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  return (
    <tr className={selected ? "job-selected" : ""}>
      <td>
        <button className="job-link" onClick={() => onSelect(job.id)}>
          {job.kind ?? "job"}
          <small>{job.id}</small>
        </button>
      </td>
      <td>
        <span className={`job-status status-${job.status}`}>{job.status}</span>
      </td>
      <td>
        {job.status === "running"
          ? "Executando"
          : job.status === "queued"
            ? "Aguardando worker"
            : "Concluído"}
      </td>
      <td>
        {job.status === "succeeded" ? "100%" : job.status === "running" ? "Em andamento" : "—"}
      </td>
      <td>{duration(job)}</td>
      <td className="job-actions">
        {job.can_cancel && (
          <button aria-label={`Cancelar ${job.kind}`} onClick={onCancel}>
            Cancelar
          </button>
        )}
        {job.can_retry && (
          <button aria-label={`Repetir ${job.kind}`} onClick={onRetry}>
            Repetir
          </button>
        )}
      </td>
    </tr>
  );
}

function JobDrawer({
  job,
  loading,
  error,
  onClose,
}: {
  job?: import("../../lib/api.types").JobDetail;
  loading: boolean;
  error?: string;
  onClose: () => void;
}) {
  return (
    <aside className="job-drawer panel" aria-label="Detalhes do job">
      <button className="drawer-close" onClick={onClose} aria-label="Fechar detalhes">
        <X aria-hidden="true" />
      </button>
      {loading && <LoadingState label="Carregando detalhes" />}
      {error && <ErrorState message={error} />}
      {job && (
        <>
          <h2>{job.kind}</h2>
          <p>
            <span className={`job-status status-${job.status}`}>{job.status}</span> · tentativa{" "}
            {job.attempt}/{job.max_attempts}
          </p>
          {job.error_message && (
            <p className="job-error">
              <CircleAlert aria-hidden="true" />
              {job.error_message}
            </p>
          )}
          <h3>Eventos</h3>
          <ol className="job-events">
            {job.events.map((event) => (
              <li key={`${event.type}-${event.occurred_at}`}>
                <time>{formatDate(event.occurred_at)}</time>
                {event.message}
              </li>
            ))}
          </ol>
          <a href={`/api/jobs/${job.id}`} target="_blank" rel="noreferrer">
            Abrir log/snapshot JSON
          </a>
        </>
      )}
    </aside>
  );
}

function duration(job: Job) {
  const start = job.started_at ?? job.created_at;
  const end = job.finished_at ?? (ACTIVE.has(job.status) ? new Date().toISOString() : null);
  return start && end
    ? `${Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000))} s`
    : "—";
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(
    new Date(value),
  );
}
