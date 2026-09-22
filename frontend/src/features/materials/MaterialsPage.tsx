import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { ApiError } from "../../lib/api";
import type { MaterialCard } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./materials.css";

export function MaterialsPage() {
  const [params, setParams] = useSearchParams();
  const [voiceId, setVoiceId] = useState("");
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [audioJobIds, setAudioJobIds] = useState<Record<string, string>>({});
  const [youtube, setYoutube] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const client = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects", "materials"],
    queryFn: () => studioApi.projects(),
  });
  const voices = useQuery({ queryKey: ["voices"], queryFn: studioApi.voices });
  const projectId = params.get("project") ?? projects.data?.[0]?.id ?? "";
  const project = useMemo(
    () => projects.data?.find((item) => item.id === projectId),
    [projects.data, projectId],
  );
  const materials = useQuery({
    queryKey: ["materials", projectId, voiceId],
    queryFn: () => studioApi.materials(projectId, voiceId || undefined),
    enabled: !!projectId,
    refetchInterval: (query) =>
      query.state.data?.cards.some((card) => !card.audio_ready) ? 5000 : false,
  });
  const latestExport = useQuery({
    queryKey: ["material-latest-export", projectId],
    queryFn: () => studioApi.latestMaterialExport(projectId),
    enabled: !!projectId,
    retry: false,
  });
  const activeExportId = exportJobId ?? latestExport.data?.job_id ?? null;
  const exportStatus = useQuery({
    queryKey: ["material-export", projectId, activeExportId],
    queryFn: () => studioApi.materialExport(projectId, activeExportId!),
    enabled: !!projectId && !!activeExportId,
    refetchInterval: (query) =>
      ["queued", "running", "retryable"].includes(query.state.data?.status ?? "") ? 3000 : false,
  });
  const select = useMutation({
    mutationFn: ({ cueId, included }: { cueId: string; included: boolean }) =>
      studioApi.updateMaterial(projectId, cueId, included),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["materials", projectId] }),
  });
  const audio = useMutation({
    mutationFn: (cueId: string) => studioApi.prepareMaterialAudio(projectId, cueId, voiceId),
    onSuccess: (job, cueId) => {
      setAudioJobIds((current) => ({ ...current, [cueId]: job.id }));
      void client.invalidateQueries({ queryKey: ["materials", projectId] });
    },
  });
  const exportCards = useMutation({
    mutationFn: () => studioApi.exportMaterials(projectId, voiceId),
    onSuccess: (result) => {
      setExportJobId(result.job_id);
      setYoutube("");
      setConfirmed(false);
    },
  });
  const publication = useMutation({
    mutationFn: () => studioApi.publishMaterialExport(projectId, activeExportId!, youtube.trim()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["material-export", projectId] }),
  });
  const cards = materials.data?.cards ?? [];
  const selected = cards.filter((card) => card.included);
  const ready = selected.length > 0 && selected.every((card) => card.audio_ready);

  useEffect(() => {
    if (!voiceId && voices.data?.length) setVoiceId(voices.data[0].id);
  }, [voiceId, voices.data]);

  return (
    <section>
      <PageHeader
        title="Materiais e Anki"
        description="Revise os cards aprovados, ouça o WAV canônico e exporte o pacote com o manifesto do reel."
      />
      {projects.isPending && <LoadingState label="Carregando projetos" />}
      {projects.isError && (
        <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />
      )}
      {projects.data?.length === 0 && (
        <EmptyState title="Nenhum projeto disponível">
          Crie um projeto com cues aprovadas para preparar cards.
        </EmptyState>
      )}
      {project && (
        <div className="materials-controls panel">
          <label>
            Projeto
            <select
              value={projectId}
              onChange={(event) => {
                setParams({ project: event.target.value });
                setExportJobId(null);
                setAudioJobIds({});
              }}
            >
              {projects.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Perfil de voz
            <select
              value={voiceId}
              onChange={(event) => {
                setVoiceId(event.target.value);
                setExportJobId(null);
                setAudioJobIds({});
              }}
            >
              {voices.data?.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} · v{voice.version}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void materials.refetch()}>
            <RefreshCw aria-hidden="true" /> Atualizar
          </button>
        </div>
      )}
      {voices.isError && (
        <ErrorState message={voices.error.message} retry={() => void voices.refetch()} />
      )}
      {materials.isPending && project && <LoadingState label="Carregando cards" />}
      {materials.isError && (
        <ErrorState message={materials.error.message} retry={() => void materials.refetch()} />
      )}
      {materials.data && cards.length === 0 && (
        <EmptyState title="Sem cards aprovados">
          Revise as cues no Editorial antes da exportação.
        </EmptyState>
      )}
      {cards.length > 0 && (
        <div className="materials-table-wrap panel">
          <table className="materials-table">
            <thead>
              <tr>
                <th>Incluir</th>
                <th>Card EN / PT</th>
                <th>Tags e voz</th>
                <th>Áudio canônico</th>
                <th>Intervalo do reel</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <MaterialRow
                  key={card.cue_id}
                  card={card}
                  voiceName={voices.data?.find((voice) => voice.id === voiceId)?.name ?? "—"}
                  voiceVersion={materials.data?.voice_version}
                  onInclude={(included) => select.mutate({ cueId: card.cue_id, included })}
                  onAudio={() => audio.mutate(card.cue_id)}
                  audioBusy={audio.isPending}
                  audioJobId={audioJobIds[card.cue_id]}
                  voiceSelected={!!voiceId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(select.error || audio.error || exportCards.error || publication.error) && (
        <p className="field-error" role="alert">
          {(select.error ?? audio.error ?? exportCards.error ?? publication.error)?.message}
        </p>
      )}
      {latestExport.isError &&
        !(latestExport.error instanceof ApiError && latestExport.error.status === 404) && (
          <ErrorState
            message={latestExport.error.message}
            retry={() => void latestExport.refetch()}
          />
        )}
      {cards.length > 0 && (
        <section className="materials-export panel" aria-label="Exportação Anki">
          <div>
            <h2>Exportar Anki</h2>
            <p>
              {selected.length} de {cards.length} cards incluídos ·{" "}
              {selected.filter((card) => card.audio_ready).length} WAVs prontos
            </p>
          </div>
          <button
            className="primary-button"
            disabled={!voiceId || !ready || exportCards.isPending}
            onClick={() => exportCards.mutate()}
          >
            <Download aria-hidden="true" />{" "}
            {exportCards.isPending ? "Enfileirando…" : "Exportar APKG"}
          </button>
        </section>
      )}
      {exportStatus.data && (
        <section className="materials-result panel" aria-live="polite">
          <h2>Exportação {exportStatus.data.status}</h2>
          {exportStatus.data.status === "failed" && (
            <p role="alert">
              {exportStatus.data.error_message ?? "A exportação falhou."} Reprocesse o card afetado
              e tente novamente.
            </p>
          )}
          {exportStatus.data.apkg_url && <a href={exportStatus.data.apkg_url}>Baixar APKG</a>}
          {exportStatus.data.manifest_url && (
            <a href={exportStatus.data.manifest_url}>Baixar manifesto</a>
          )}
          {exportStatus.data.reel_url && <a href={exportStatus.data.reel_url}>Baixar reel</a>}
          {exportStatus.data.hub_final_url ? (
            <div>
              <p>Reel vinculado ao YouTube: {exportStatus.data.youtube_video_id}</p>
              <a href={exportStatus.data.hub_final_url}>Baixar hub_final.json</a>
            </div>
          ) : exportStatus.data.status === "succeeded" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                publication.mutate();
              }}
            >
              <h3>Publicar no iHub</h3>
              <p>Faça o upload manual do reel no YouTube e informe a URL ou o ID do vídeo.</p>
              <label>
                URL ou ID do reel no YouTube
                <input
                  value={youtube}
                  onChange={(event) => setYoutube(event.target.value)}
                  required
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Confirmo que fiz o upload do reel e conferi o vídeo informado.
              </label>
              <button
                type="submit"
                disabled={!youtube.trim() || !confirmed || publication.isPending}
              >
                {publication.isPending ? "Publicando…" : "Gerar hub_final.json"}
              </button>
            </form>
          ) : null}
        </section>
      )}
    </section>
  );
}

function MaterialRow({
  card,
  voiceName,
  voiceVersion,
  onInclude,
  onAudio,
  audioBusy,
  audioJobId,
  voiceSelected,
}: {
  card: MaterialCard;
  voiceName: string;
  voiceVersion: number | null | undefined;
  onInclude: (included: boolean) => void;
  onAudio: () => void;
  audioBusy: boolean;
  audioJobId?: string;
  voiceSelected: boolean;
}) {
  const audioJob = useQuery({
    queryKey: ["material-audio-job", audioJobId],
    queryFn: () => studioApi.job(audioJobId!),
    enabled: !!audioJobId && !card.audio_ready,
    refetchInterval: (query) =>
      ["queued", "running", "retryable"].includes(query.state.data?.status ?? "") ? 3000 : false,
  });
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          aria-label={`Incluir card ${card.scene_order}.${card.cue_order}`}
          checked={card.included}
          onChange={(event) => onInclude(event.target.checked)}
        />
      </td>
      <td>
        <strong>{card.approved_en}</strong>
        <p>{card.approved_pt}</p>
        <small>
          Cena {card.scene_order} · cue {card.cue_order} · fala {formatMs(card.speech_start_ms)}–
          {formatMs(card.speech_end_ms)}
        </small>
      </td>
      <td>
        {card.tags.length ? card.tags.join(", ") : "Sem tags"}
        <small>
          {voiceName}
          {voiceVersion ? ` · v${voiceVersion}` : ""}
        </small>
      </td>
      <td>
        {card.audio_ready && card.audio_url ? (
          <audio
            controls
            preload="none"
            src={card.audio_url}
            aria-label={`Áudio do card ${card.scene_order}.${card.cue_order}`}
          />
        ) : (
          <button type="button" disabled={!voiceSelected || audioBusy} onClick={onAudio}>
            <Volume2 aria-hidden="true" /> Preparar WAV
          </button>
        )}
        {card.audio_error && <small className="field-error">{card.audio_error}</small>}
        {audioJob.data?.status === "failed" && (
          <small className="field-error" role="alert">
            {audioJob.data.error_message ?? "Falha ao preparar WAV"}. Prepare este card novamente.
          </small>
        )}
      </td>
      <td>
        {card.reel_start_ms !== null && card.reel_end_ms !== null
          ? `${formatMs(card.reel_start_ms)}–${formatMs(card.reel_end_ms)}`
          : "Após preparar WAV"}
      </td>
    </tr>
  );
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(2)} s`;
}
