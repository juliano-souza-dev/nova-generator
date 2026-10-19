import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  MonitorPlay,
  RefreshCw,
  Search,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { ApiError } from "../../lib/api";
import { IHubCardPreview } from "./IHubCardPreview";
import type { JobDetail, MaterialCard } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./materials.css";

const ACTIVE_AUDIO_JOB_STATES = new Set(["queued", "running", "retryable"]);

export function MaterialsPage() {
  const [params, setParams] = useSearchParams();
  const [voiceId, setVoiceId] = useState("");
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [audioJobIds, setAudioJobIds] = useState<Record<string, string>>({});
  const [submittingCueIds, setSubmittingCueIds] = useState<string[]>([]);
  const [audioRequestErrors, setAudioRequestErrors] = useState<Record<string, string>>({});
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const audioRequestsInFlight = useRef(new Set<string>());
  const [youtube, setYoutube] = useState("");
  const [directAudioBaseUrl, setDirectAudioBaseUrl] = useState("");
  const [audioDelivery, setAudioDelivery] = useState<"youtube" | "direct">("youtube");
  const [confirmed, setConfirmed] = useState(false);
  const [previewCueId, setPreviewCueId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MaterialStatus | "all">("all");
  const client = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects", "materials"],
    queryFn: () => studioApi.projects(),
  });
  const voices = useQuery({ queryKey: ["voices"], queryFn: studioApi.voices });
  const projectId = params.get("project") ?? projects.data?.[0]?.id ?? "";
  const materialReview = useQuery({
    queryKey: ["materials-ai-review", projectId],
    queryFn: () => studioApi.externalMaterialsReview(projectId),
    enabled: Boolean(projectId),
    retry: false,
  });
  const importMaterial = useMutation({
    mutationFn: (file: File) => studioApi.importExternalMaterials(projectId, file),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["materials-ai-review"] }),
  });
  const approveMaterial = useMutation({
    mutationFn: (sourceSha256: string) =>
      studioApi.approveExternalMaterials(projectId, sourceSha256),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["materials-ai-review"] }),
  });

  const latestGeneration = useQuery({
    queryKey: ["materials-ai-generation", projectId],
    queryFn: () => studioApi.latestPedagogicalGeneration(projectId),
    enabled: Boolean(projectId),
    retry: false,
    refetchInterval: (query) =>
      ["queued", "running", "retryable"].includes(query.state.data?.status ?? "") ? 3000 : false,
  });
  const generatePedagogical = useMutation({
    mutationFn: () => studioApi.generatePedagogicalMaterials(projectId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["materials-ai-generation", projectId] });
    },
  });
  useEffect(() => {
    if (latestGeneration.data?.status === "succeeded") {
      void client.invalidateQueries({ queryKey: ["materials-ai-review", projectId] });
    }
  }, [client, projectId, latestGeneration.data?.status]);
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
  const audioJobEntries = Object.entries(audioJobIds);
  const audioJobQueries = useQueries({
    queries: audioJobEntries.map(([, jobId]) => ({
      queryKey: ["material-audio-job", jobId],
      queryFn: () => studioApi.job(jobId),
      refetchInterval: (query: { state: { data?: JobDetail } }) =>
        ACTIVE_AUDIO_JOB_STATES.has(query.state.data?.status ?? "") ? 3000 : false,
    })),
  });
  const audioJobsByCue: Record<string, JobDetail | undefined> = {};
  const audioJobErrorsByCue: Record<string, string | undefined> = {};
  audioJobEntries.forEach(([cueId], index) => {
    audioJobsByCue[cueId] = audioJobQueries[index]?.data;
    audioJobErrorsByCue[cueId] = audioJobQueries[index]?.error?.message;
  });
  const completedAudioJobs = Object.values(audioJobsByCue)
    .filter((job) => job?.status === "succeeded")
    .map((job) => job!.id)
    .join("|");
  useEffect(() => {
    if (completedAudioJobs) {
      void client.invalidateQueries({ queryKey: ["materials", projectId] });
    }
  }, [client, completedAudioJobs, projectId]);
  const produceComplete = useMutation({
    mutationFn: () => studioApi.generateCompleteMaterials(projectId, voiceId),
    onSuccess: (result) => {
      setExportJobId(result.job_id);
      setYoutube("");
      setConfirmed(false);
      void client.invalidateQueries({ queryKey: ["material-latest-export", projectId] });
    },
  });
  const exportCards = useMutation({
    mutationFn: () => studioApi.exportMaterials(projectId, voiceId),
    onSuccess: (result) => {
      setExportJobId(result.job_id);
      setYoutube("");
      setDirectAudioBaseUrl("");
      setConfirmed(false);
    },
  });
  const publication = useMutation({
    mutationFn: () => studioApi.publishMaterialExport(projectId, activeExportId!, {
      youtube: audioDelivery === "youtube" ? youtube.trim() : "",
      directAudioBaseUrl: audioDelivery === "direct" ? directAudioBaseUrl.trim() : "",
    }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["material-export", projectId] }),
  });
  const selectedVoice = voices.data?.find((voice) => voice.id === voiceId);
  const voiceReferenceError =
    selectedVoice?.reference_ready === false
      ? (selectedVoice.reference_message ?? "A referência da voz não pode ser usada para síntese.")
      : null;
  const cards = materials.data?.cards ?? [];
  const selected = cards.filter((card) => card.included);
  const unprepared = cards.filter((card) => !card.editorial_ready);
  const materialStatus = (card: MaterialCard): MaterialStatus =>
    !card.editorial_ready ? "blocked" : card.audio_ready ? "generated" : "ready";
  const visibleCards = cards.filter((card) => {
    const query = search.trim().toLocaleLowerCase();
    const matchesSearch =
      !query ||
      card.approved_en.toLocaleLowerCase().includes(query) ||
      card.approved_pt.toLocaleLowerCase().includes(query) ||
      String(card.scene_order).includes(query);
    return matchesSearch && (statusFilter === "all" || materialStatus(card) === statusFilter);
  });
  const cardsByScene = visibleCards.reduce<Map<number, MaterialCard[]>>((groups, card) => {
    const group = groups.get(card.scene_order) ?? [];
    group.push(card);
    groups.set(card.scene_order, group);
    return groups;
  }, new Map());
  const sceneGroups = [...cardsByScene.entries()];
  const previewIndex = cards.findIndex((card) => card.cue_id === previewCueId);
  const previewCard = previewIndex >= 0 ? cards[previewIndex] : null;
  const previewPedagogical = materialReview.data?.document?.anki_cards.find(
    (card) => card.cue_id === previewCueId,
  );
  const ready =
    selected.length > 0 && selected.every((card) => card.audio_ready && card.editorial_ready);
  const selectedVisible = visibleCards.filter((card) => card.included);
  const materialGenerationBusy =
    generatePedagogical.isPending ||
    produceComplete.isPending ||
    ["queued", "running", "retryable"].includes(latestGeneration.data?.status ?? "") ||
    (materialReview.data?.status === "approved" &&
      Boolean(exportStatus.data) &&
      ["queued", "running", "retryable"].includes(exportStatus.data!.status));
  const pedagogicalDraft = materialReview.data?.status === "draft";
  const pedagogicalApproved = materialReview.data?.status === "approved";
  const canGenerateMaterial =
    Boolean(projectId) &&
    selected.length > 0 &&
    !materialGenerationBusy &&
    !pedagogicalDraft &&
    (!pedagogicalApproved || (Boolean(voiceId) && !voiceReferenceError));

  const activeAudioCount = Object.values(audioJobsByCue).filter((job) =>
    ACTIVE_AUDIO_JOB_STATES.has(job?.status ?? ""),
  ).length;
  const contextKey = `${projectId}:${voiceId}`;
  const audioContext = useRef(contextKey);
  audioContext.current = contextKey;

  function canPrepareAudio(card: MaterialCard): boolean {
    const jobId = audioJobIds[card.cue_id];
    const job = audioJobsByCue[card.cue_id];
    return (
      materialStatus(card) === "ready" &&
      !submittingCueIds.includes(card.cue_id) &&
      !audioRequestsInFlight.current.has(`${contextKey}:${card.cue_id}`) &&
      (!jobId || job?.status === "failed" || job?.status === "cancelled")
    );
  }

  async function prepareAudio(cueId: string): Promise<void> {
    const requestToken = `${contextKey}:${cueId}`;
    if (
      !projectId ||
      !voiceId ||
      voiceReferenceError ||
      audioRequestsInFlight.current.has(requestToken)
    ) {
      return;
    }
    const job = audioJobsByCue[cueId];
    if (
      audioJobIds[cueId] &&
      (!job || ACTIVE_AUDIO_JOB_STATES.has(job.status) || job.status === "succeeded")
    ) {
      return;
    }
    const requestContext = contextKey;
    audioRequestsInFlight.current.add(requestToken);
    setSubmittingCueIds((current) => [...current, cueId]);
    setAudioRequestErrors((current) => {
      const next = { ...current };
      delete next[cueId];
      return next;
    });
    setAudioJobIds((current) => {
      const next = { ...current };
      delete next[cueId];
      return next;
    });
    setAudioNotice("Enviando solicitação de áudio ao worker…");
    try {
      const result = await studioApi.prepareMaterialAudio(projectId, cueId, voiceId);
      if (audioContext.current !== requestContext) return;
      setAudioJobIds((current) => ({ ...current, [cueId]: result.id }));
      setAudioNotice("Solicitação recebida. Acompanhe o estado da síntese em cada card.");
      void client.invalidateQueries({ queryKey: ["materials", projectId] });
    } catch (error) {
      if (audioContext.current !== requestContext) return;
      const message = error instanceof Error ? error.message : "Não foi possível solicitar o WAV.";
      setAudioRequestErrors((current) => ({ ...current, [cueId]: message }));
      setAudioNotice("Falha ao solicitar um WAV. Consulte o erro no card correspondente.");
    } finally {
      audioRequestsInFlight.current.delete(requestToken);
      if (audioContext.current === requestContext) {
        setSubmittingCueIds((current) => current.filter((id) => id !== cueId));
      }
    }
  }

  function resetAudioTracking() {
    audioRequestsInFlight.current.clear();
    setAudioJobIds({});
    setSubmittingCueIds([]);
    setAudioRequestErrors({});
    setAudioNotice(null);
  }

  function setVisibleIncluded(included: boolean) {
    visibleCards
      .filter((card) => card.included !== included)
      .forEach((card) => select.mutate({ cueId: card.cue_id, included }));
  }

  function prepareSelected() {
    if (!voiceId || voiceReferenceError) return;
    const available = selectedVisible.filter(canPrepareAudio);
    if (!available.length) return;
    setAudioNotice(`Solicitando WAV para ${available.length} cards selecionados…`);
    void Promise.all(available.map((card) => prepareAudio(card.cue_id)));
  }

  useEffect(() => {
    if (!voiceId && voices.data?.length) setVoiceId(voices.data[0].id);
  }, [voiceId, voices.data]);

  return (
    <section>
      <PageHeader
        title="Materiais e Anki"
        description="Prepare os WAVs dos cards aprovados, confira os áudios e exporte o Anki sem depender de conteúdo pedagógico externo."
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
                resetAudioTracking();
                setPreviewCueId(null);
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
                resetAudioTracking();
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
      {project && (
        <section className="materials-export panel" aria-label="Gerar material completo">
          <div>
            <h2>Gerar material</h2>
            <p>
              {pedagogicalApproved
                ? "Conteúdo aprovado. Produzir PDF didático, WAVs ausentes, Anki com explicações, reel e manifesto."
                : pedagogicalDraft
                  ? "Proposta pedagógica pronta. Confira as sete seções e aprove o conteúdo abaixo antes de finalizar."
                  : "A IA produzirá as sete seções pedagógicas, exercícios com respostas e cards Anki enriquecidos. Depois, revise e aprove o resultado."}
            </p>
            <small>
              Os WAVs existentes serão reutilizados. A publicação no iHub continua exigindo a
              confirmação do vídeo no YouTube.
            </small>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={!canGenerateMaterial}
            title={
              pedagogicalDraft
                ? "Revise e aprove a proposta pedagógica abaixo"
                : !selected.length
                  ? "Selecione ao menos um card"
                  : materialGenerationBusy
                    ? "Uma geração já está em andamento"
                    : undefined
            }
            onClick={() =>
              pedagogicalApproved ? produceComplete.mutate() : generatePedagogical.mutate()
            }
          >
            <Download aria-hidden="true" />
            {generatePedagogical.isPending
              ? "Solicitando IA…"
              : produceComplete.isPending
                ? "Enfileirando produção…"
                : "Gerar material"}
          </button>
        </section>
      )}
      {latestGeneration.data && (
        <section className="materials-result panel" aria-live="polite">
          <h3>Conteúdo pedagógico: {latestGeneration.data.status}</h3>
          {["queued", "running", "retryable"].includes(latestGeneration.data.status) && (
            <p>
              A IA está preparando o material. Você pode acompanhar o progresso em{" "}
              <Link to="/jobs">Jobs</Link>.
            </p>
          )}
          {latestGeneration.data.status === "succeeded" && !pedagogicalApproved && (
            <p>Proposta pronta. Revise as seções e aprove para liberar a produção final.</p>
          )}
          {latestGeneration.data.status === "failed" && (
            <p className="field-error" role="alert">
              {latestGeneration.data.error_message ?? "Falha na geração pedagógica."}
            </p>
          )}
        </section>
      )}
      {(generatePedagogical.error || produceComplete.error) && (
        <p className="field-error" role="alert">
          {(generatePedagogical.error ?? produceComplete.error)?.message}
        </p>
      )}
      {voiceReferenceError && (
        <p className="field-error" role="alert">
          {voiceReferenceError} <Link to="/voices">Atualizar voz na Biblioteca</Link>
        </p>
      )}
      {project && (
        <section className="materials-ai-panel panel" aria-label="Materiais da IA externa">
          <div className="materials-ai-heading">
            <div>
              <span className="eyebrow">Preparação pedagógica</span>
              <h2>Conteúdo pedagógico da IA externa</h2>
              <p>
                O contrato inclui sete seções didáticas, exercícios com respostas e cards Anki. Essa
                etapa complementar é independente da síntese de voz e da exportação Anki.
              </p>
            </div>
          </div>
          {materialReview.isError && (
            <p role="alert">
              Conteúdo pedagógico complementar indisponível. A síntese de voz e a exportação Anki
              continuam independentes.
            </p>
          )}
          {!materialReview.isError && (
            <>
              <div className="materials-ai-actions">
                <a
                  className="secondary-button"
                  href={studioApi.externalMaterialsPackageUrl(projectId)}
                  download
                >
                  <Download aria-hidden="true" /> Baixar contrato para IA externa
                </a>
                <label className="materials-ai-import">
                  Importar conteúdo produzido (.json)
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={importMaterial.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) importMaterial.mutate(file);
                      event.target.value = "";
                    }}
                  />
                </label>
                <strong>
                  {materialReview.data?.status === "approved"
                    ? "Material aprovado"
                    : materialReview.data?.status === "draft"
                      ? "Aguardando revisão"
                      : "Aguardando conteúdo"}
                </strong>
              </div>
              {materialReview.data?.document && (
                <div className="materials-ai-review">
                  <h3>{materialReview.data.document.title}</h3>
                  {materialReview.data.document.sections.map((section) => (
                    <article key={section.id}>
                      <h4>{section.title}</h4>
                      {section.paragraphs.map((paragraph, index) => (
                        <p key={index}>{paragraph}</p>
                      ))}
                      {section.exercises.map((exercise, index) => (
                        <div key={index} className="materials-ai-exercise">
                          <strong>{exercise.prompt}</strong>
                          <span>Resposta: {exercise.answer}</span>
                        </div>
                      ))}
                    </article>
                  ))}
                  <h4>Cards Anki gerados ({materialReview.data.document.anki_cards.length})</h4>
                  <div className="materials-ai-cards">
                    {materialReview.data.document.anki_cards.map((card) => (
                      <article key={card.cue_id}>
                        <button
                          type="button"
                          className="material-card-preview-button"
                          disabled={!cards.some((item) => item.cue_id === card.cue_id)}
                          onClick={() => setPreviewCueId(card.cue_id)}
                        >
                          Ver como no iHub
                        </button>
                        <strong>{card.front_en}</strong>
                        <span>{card.back_pt}</span>
                        <small>{card.explanation_pt}</small>
                      </article>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={
                      materialReview.data.status === "approved" || approveMaterial.isPending
                    }
                    onClick={() => approveMaterial.mutate(materialReview.data!.source_sha256)}
                  >
                    Aprovar conteúdo pedagógico
                  </button>
                </div>
              )}
            </>
          )}
          {(importMaterial.error || approveMaterial.error) && (
            <p className="field-error" role="alert">
              {(importMaterial.error ?? approveMaterial.error)?.message}
            </p>
          )}
        </section>
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
      {unprepared.length > 0 && (
        <section className="materials-preparation-warning panel" role="alert">
          <strong>A preparação editorial ainda não está completa.</strong>
          <span>
            {unprepared.length} {unprepared.length === 1 ? "card precisa" : "cards precisam"} de
            tratamento pela Groq ou IA externa antes da validação e da geração de áudio.
          </span>
          <Link className="secondary-button" to={`/editorial?project=${projectId}`}>
            Voltar para a preparação editorial
          </Link>
        </section>
      )}
      {cards.length > 0 && unprepared.length === 0 && (
        <>
          <section className="materials-workbench panel" aria-label="Filtrar cards">
            <label className="materials-search">
              <Search aria-hidden="true" />
              <span className="sr-only">Buscar cards</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar inglês, português ou cena"
              />
            </label>
            <div className="materials-status-filters" aria-label="Filtrar por status">
              {(
                [
                  ["all", "Todos"],
                  ["ready", "Prontos"],
                  ["generated", "Gerados"],
                  ["blocked", "Bloqueados"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={statusFilter === value}
                  className={statusFilter === value ? "is-active" : undefined}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="materials-counter">{selected.length} incluídos no reel</span>
          </section>
          {selectedVisible.length > 0 && (
            <section className="materials-bulk-actions panel" aria-label="Ações em massa">
              <strong>
                {selectedVisible.length} selecionado{selectedVisible.length === 1 ? "" : "s"}
              </strong>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setVisibleIncluded(false)}
              >
                Remover do reel
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  !voiceId || !!voiceReferenceError || !selectedVisible.some(canPrepareAudio)
                }
                onClick={prepareSelected}
              >
                <Volume2 aria-hidden="true" />
                {submittingCueIds.length ? "Enviando WAVs…" : "Preparar selecionados"}
              </button>
            </section>
          )}
          {(audioNotice || activeAudioCount > 0) && (
            <p className="material-audio-feedback panel" role="status">
              {audioNotice ?? "Acompanhe a síntese dos WAVs abaixo."}
              {activeAudioCount > 0 && ` ${activeAudioCount} tarefa(s) em processamento.`}{" "}
              <Link to="/jobs">Ver monitor de jobs</Link>
            </p>
          )}
          <div className="materials-table-wrap panel">
            <table className="materials-table">
              {sceneGroups.length === 1 ? (
                <caption
                  style={{
                    captionSide: "top",
                    padding: "0 0 0.3rem",
                    color: "var(--muted)",
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textAlign: "left",
                    textTransform: "uppercase",
                  }}
                >
                  Cena {sceneGroups[0][0]} · {sceneGroups[0][1].length} cards
                </caption>
              ) : null}
              <thead>
                <tr>
                  <th>Incluir</th>
                  <th>Card EN / PT</th>
                  <th>Destaques e voz</th>
                  <th>Áudio canônico</th>
                  <th>Intervalo do reel</th>
                </tr>
              </thead>
              <tbody>
                {sceneGroups.map(([sceneOrder, sceneCards], index) => (
                  <SceneCardRows
                    key={sceneOrder}
                    sceneOrder={sceneOrder}
                    cards={sceneCards}
                    showHeading={sceneGroups.length > 1 || index > 0}
                    statusOf={materialStatus}
                    voiceName={voices.data?.find((voice) => voice.id === voiceId)?.name ?? "—"}
                    voiceVersion={materials.data?.voice_version}
                    onInclude={(cueId, included) => select.mutate({ cueId, included })}
                    onAudio={(cueId) => void prepareAudio(cueId)}
                    submittingCueIds={submittingCueIds}
                    audioJobsByCue={audioJobsByCue}
                    audioJobErrorsByCue={audioJobErrorsByCue}
                    audioJobIds={audioJobIds}
                    audioRequestErrors={audioRequestErrors}
                    voiceSelected={!!voiceId && !voiceReferenceError}
                    onPreview={setPreviewCueId}
                  />
                ))}
              </tbody>
            </table>
            {visibleCards.length === 0 && (
              <p className="materials-no-results">Nenhum card encontrado.</p>
            )}
          </div>
        </>
      )}
      {(select.error || exportCards.error || publication.error) && (
        <p className="field-error" role="alert">
          {(select.error ?? exportCards.error ?? publication.error)?.message}
        </p>
      )}
      {latestExport.isError &&
        !(latestExport.error instanceof ApiError && latestExport.error.status === 404) && (
          <ErrorState
            message={latestExport.error.message}
            retry={() => void latestExport.refetch()}
          />
        )}
      {cards.length > 0 && unprepared.length === 0 && (
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
            {exportCards.isPending ? "Enfileirando…" : "Gerar pacote Anki"}
          </button>
        </section>
      )}
      {previewCard && (
        <IHubCardPreview
          key={previewCard.cue_id}
          card={{ ...previewCard, pedagogical: previewPedagogical }}
          position={previewIndex + 1}
          total={cards.length}
          onClose={() => setPreviewCueId(null)}
          onPrevious={
            previewIndex > 0 ? () => setPreviewCueId(cards[previewIndex - 1].cue_id) : undefined
          }
          onNext={
            previewIndex < cards.length - 1
              ? () => setPreviewCueId(cards[previewIndex + 1].cue_id)
              : undefined
          }
        />
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
          {exportStatus.data.workbook_url && (
            <a href={exportStatus.data.workbook_url}>Baixar material didático (PDF)</a>
          )}
          {exportStatus.data.apkg_url && <a href={exportStatus.data.apkg_url}>Baixar APKG</a>}
          {exportStatus.data.manifest_url && (
            <a href={exportStatus.data.manifest_url}>Baixar manifesto</a>
          )}
          {exportStatus.data.reel_url && <a href={exportStatus.data.reel_url}>Baixar reel</a>}
          {exportStatus.data.bundle_url && (
            <a href={exportStatus.data.bundle_url}>Baixar pacote completo (ZIP)</a>
          )}
          {exportStatus.data.hub_final_url ? (
            <div>
              <p>{exportStatus.data.youtube_video_id ? `Reel vinculado ao YouTube: ${exportStatus.data.youtube_video_id}` : `Áudios diretos: ${exportStatus.data.direct_audio_base_url ?? "fonte hospedada"}`}</p>
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
              <p>Escolha como a área do aluno reproduzirá cada card. O pacote ZIP já contém os WAVs nomeados card-0001.wav, card-0002.wav e assim por diante.</p>
              <fieldset>
                <legend>Fonte de áudio dos cards</legend>
                <label>
                  <input type="radio" checked={audioDelivery === "youtube"} onChange={() => setAudioDelivery("youtube")} />
                  Reel no YouTube
                </label>
                <label>
                  <input type="radio" checked={audioDelivery === "direct"} onChange={() => setAudioDelivery("direct")} />
                  Arquivos WAV hospedados
                </label>
              </fieldset>
              {audioDelivery === "youtube" ? (
                <label>
                  URL ou ID do reel no YouTube
                  <input value={youtube} onChange={(event) => setYoutube(event.target.value)} required />
                </label>
              ) : (
                <label>
                  URL base da pasta audio hospedada
                  <input value={directAudioBaseUrl} onChange={(event) => setDirectAudioBaseUrl(event.target.value)} placeholder="https://seu-dominio.com/storage/card-audio/kit-123/audio" required />
                </label>
              )}
              <label>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                Confirmo que a fonte escolhida está disponível para o iHub.
              </label>
              <button type="submit" disabled={!(audioDelivery === "youtube" ? youtube.trim() : directAudioBaseUrl.trim()) || !confirmed || publication.isPending}>
                {publication.isPending ? "Publicando…" : "Gerar hub_final.json"}
              </button>
            </form>
          ) : null}
        </section>
      )}
    </section>
  );
}

type MaterialStatus = "blocked" | "ready" | "generated";

const statusDetails: Record<
  MaterialStatus,
  { label: string; icon: typeof CheckCircle2; description: string }
> = {
  blocked: {
    label: "Bloqueado",
    icon: CircleAlert,
    description: "Conclua a preparação editorial do card para gerar o áudio.",
  },
  ready: {
    label: "Pronto",
    icon: Clock3,
    description: "Pronto para gerar o áudio canônico.",
  },
  generated: {
    label: "Gerado",
    icon: CheckCircle2,
    description: "Áudio canônico disponível para validação.",
  },
};

function SceneCardRows({
  sceneOrder,
  cards,
  showHeading,
  statusOf,
  voiceName,
  voiceVersion,
  onInclude,
  onAudio,
  submittingCueIds,
  audioJobsByCue,
  audioJobErrorsByCue,
  audioJobIds,
  audioRequestErrors,
  voiceSelected,
  onPreview,
}: {
  sceneOrder: number;
  cards: MaterialCard[];
  showHeading: boolean;
  statusOf: (card: MaterialCard) => MaterialStatus;
  voiceName: string;
  voiceVersion: number | null | undefined;
  onInclude: (cueId: string, included: boolean) => void;
  onAudio: (cueId: string) => void;
  submittingCueIds: string[];
  audioJobsByCue: Record<string, JobDetail | undefined>;
  audioJobErrorsByCue: Record<string, string | undefined>;
  audioJobIds: Record<string, string>;
  audioRequestErrors: Record<string, string>;
  voiceSelected: boolean;
  onPreview: (cueId: string) => void;
}) {
  return (
    <>
      {showHeading ? (
        <tr className="materials-scene-heading">
          <th colSpan={5}>
            Cena {sceneOrder} · {cards.length} {cards.length === 1 ? "card" : "cards"}
          </th>
        </tr>
      ) : null}
      {cards.map((card) => (
        <MaterialRow
          key={card.cue_id}
          card={card}
          status={statusOf(card)}
          voiceName={voiceName}
          voiceVersion={voiceVersion}
          onInclude={(included) => onInclude(card.cue_id, included)}
          onAudio={() => onAudio(card.cue_id)}
          audioSubmitting={submittingCueIds.includes(card.cue_id)}
          audioJobId={audioJobIds[card.cue_id]}
          audioJob={audioJobsByCue[card.cue_id]}
          audioJobQueryError={audioJobErrorsByCue[card.cue_id]}
          audioRequestError={audioRequestErrors[card.cue_id]}
          voiceSelected={voiceSelected}
          onPreview={() => onPreview(card.cue_id)}
        />
      ))}
    </>
  );
}

function MaterialRow({
  card,
  status,
  voiceName,
  voiceVersion,
  onInclude,
  onAudio,
  audioSubmitting,
  audioJobId,
  audioJob,
  audioJobQueryError,
  audioRequestError,
  voiceSelected,
  onPreview,
}: {
  card: MaterialCard;
  status: MaterialStatus;
  voiceName: string;
  voiceVersion: number | null | undefined;
  onInclude: (included: boolean) => void;
  onAudio: () => void;
  audioSubmitting: boolean;
  audioJobId?: string;
  audioJob?: JobDetail;
  audioJobQueryError?: string;
  audioRequestError?: string;
  voiceSelected: boolean;
  onPreview: () => void;
}) {
  const audioProcessing =
    !!audioJobId &&
    (!audioJob || ACTIVE_AUDIO_JOB_STATES.has(audioJob.status) || audioJob.status === "succeeded");
  const statusMeta = statusDetails[status];
  const StatusIcon = statusMeta.icon;
  return (
    <tr className={`material-row material-row-${status}`}>
      <td>
        <input
          type="checkbox"
          aria-label={`Incluir card ${card.scene_order}.${card.cue_order}`}
          checked={card.included}
          onChange={(event) => onInclude(event.target.checked)}
        />
      </td>
      <td>
        <HighlightedCueText text={card.approved_en} highlights={card.highlights} />
        <p>{card.approved_pt}</p>
        <small>
          cue {card.cue_order} · fala {formatMs(card.speech_start_ms)}–
          {formatMs(card.speech_end_ms)}
        </small>
        <button
          className="material-card-preview-button"
          type="button"
          title="Ver como no iHub"
          aria-label="Ver como no iHub"
          onClick={onPreview}
        >
          <MonitorPlay aria-hidden="true" />
        </button>
      </td>
      <td>
        <span className={`material-status-badge is-${status}`} title={statusMeta.description}>
          <StatusIcon aria-hidden="true" /> {statusMeta.label}
        </span>
        {status !== "blocked" && card.editorial_ready ? (
          <>
            {card.highlights.length > 0 ? (
              <ul className="material-highlights" aria-label="Destaques pedagógicos">
                {card.highlights.map((highlight) => (
                  <li key={`${highlight.en}:${highlight.pt}`}>
                    <mark>{highlight.en}</mark>
                    <span>{highlight.pt}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="material-ready-note">Preparado · sem expressão agrupada</span>
            )}
            {card.tags.length > 0 && <small>{card.tags.join(", ")}</small>}
          </>
        ) : (
          <span className="material-missing-preparation">Preparação pendente</span>
        )}
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
          <button
            type="button"
            className="primary-button material-audio-action"
            disabled={status === "blocked" || !voiceSelected || audioSubmitting || audioProcessing}
            title={status === "blocked" ? statusMeta.description : undefined}
            onClick={onAudio}
          >
            <Volume2 aria-hidden="true" />
            {audioSubmitting
              ? "Enviando…"
              : audioJob?.status === "queued"
                ? "Na fila"
                : audioJob?.status === "running"
                  ? "Sintetizando…"
                  : audioJob?.status === "retryable"
                    ? "Nova tentativa…"
                    : audioJob?.status === "succeeded"
                      ? "Finalizando…"
                      : audioJobId && !audioJob
                        ? "Consultando…"
                        : audioJob?.status === "failed" || audioJob?.status === "cancelled"
                          ? "Tentar novamente"
                          : "Preparar WAV"}
          </button>
        )}
        {!card.audio_ready && audioJob && ACTIVE_AUDIO_JOB_STATES.has(audioJob.status) && (
          <small className="material-audio-progress" role="status">
            {audioJob.status === "queued"
              ? "Tarefa recebida. Aguardando o worker."
              : audioJob.status === "running"
                ? "Gerando WAV com a voz selecionada…"
                : "Aguardando nova tentativa automática…"}
          </small>
        )}
        {!card.audio_ready && audioJob?.status === "succeeded" && (
          <small className="material-audio-progress" role="status">
            WAV concluído. Atualizando card…
          </small>
        )}
        {audioJobId && audioJobQueryError && (
          <small className="field-error" role="alert">
            Não foi possível consultar o andamento: {audioJobQueryError}.{" "}
            <Link to="/jobs">Abrir monitor</Link>
          </small>
        )}
        {audioRequestError && (
          <small className="field-error" role="alert">
            Não foi possível iniciar a síntese: {audioRequestError}
          </small>
        )}
        {card.audio_error && <small className="field-error">{card.audio_error}</small>}
        {audioJob?.status === "failed" && (
          <small className="field-error" role="alert">
            {audioJob.error_message ?? "Falha ao preparar WAV"}. Prepare este card novamente.
          </small>
        )}
        {audioJob?.status === "cancelled" && (
          <small className="field-error" role="alert">
            Síntese cancelada. Você pode solicitar novamente.
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

function HighlightedCueText({
  text,
  highlights,
}: {
  text: string;
  highlights: MaterialCard["highlights"];
}) {
  const terms = highlights
    .map((highlight) => highlight.en)
    .filter((term) => term.length > 0)
    .sort((left, right) => right.length - left.length);
  if (terms.length === 0) return <strong>{text}</strong>;

  const parts: Array<{ value: string; highlighted: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const match = terms
      .map((term) => ({ term, index: text.indexOf(term, cursor) }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index || right.term.length - left.term.length)[0];
    if (!match) {
      parts.push({ value: text.slice(cursor), highlighted: false });
      break;
    }
    if (match.index > cursor)
      parts.push({ value: text.slice(cursor, match.index), highlighted: false });
    parts.push({ value: match.term, highlighted: true });
    cursor = match.index + match.term.length;
  }
  return (
    <strong className="material-card-text">
      {parts.map((part, index) =>
        part.highlighted ? <mark key={`${part.value}:${index}`}>{part.value}</mark> : part.value,
      )}
    </strong>
  );
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(2)} s`;
}
