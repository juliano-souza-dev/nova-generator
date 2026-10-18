import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  Merge,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { ShadowingCue, ShadowingPlan } from "./shadowing.types";
import { studioApi } from "../../lib/studio-api";
import "./shadowing.css";

type PreviewPhase = "ready" | "playing" | "pause" | "finished";

const SOURCE_LABELS: Record<ShadowingPlan["origin"], string> = {
  automatic: "Rascunho automático",
  groq: "Proposta da Groq",
  external: "Proposta da IA externa",
  manual: "Revisão manual",
};

export function ShadowingPage() {
  const [params, setParams] = useSearchParams();
  const [activeSceneId, setActiveSceneId] = useState("");
  const [previewIndex, setPreviewIndex] = useState(-1);
  const [phase, setPhase] = useState<PreviewPhase>("ready");
  const [previewError, setPreviewError] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const playerRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects", "shadowing"],
    queryFn: () => studioApi.projects(),
  });
  const projectId = params.get("project") ?? projects.data?.[0]?.id ?? "";
  const plans = useQuery({
    queryKey: ["shadowing", projectId],
    queryFn: () => studioApi.shadowing(projectId),
    enabled: !!projectId,
    retry: false,
  });
  const media = useQuery({
    queryKey: ["project-media", projectId, "shadowing"],
    queryFn: () => studioApi.projectMedia(projectId),
    enabled: !!projectId,
    retry: false,
  });
  const active = plans.data?.find((item) => item.scene_id === activeSceneId) ?? plans.data?.[0];
  const allApproved =
    Boolean(plans.data?.length) && plans.data!.every((item) => item.status === "approved");
  const busy = useRef(false);

  const refreshPlans = () => void client.invalidateQueries({ queryKey: ["shadowing", projectId] });

  const approval = useMutation({
    mutationFn: (plan: ShadowingPlan) =>
      studioApi.approveShadowing(
        projectId,
        plan.scene_id,
        plan.source_sha256,
        plan.plan_sha256,
      ),
    onSuccess: () => {
      setActionNotice("Plano de Shadowing aprovado.");
      refreshPlans();
    },
  });
  const editing = useMutation({
    mutationFn: ({ plan, groups }: { plan: ShadowingPlan; groups: string[][] }) =>
      studioApi.editShadowing(
        projectId,
        plan.scene_id,
        plan.source_sha256,
        plan.plan_sha256,
        groups,
      ),
    onSuccess: () => {
      setActionNotice("Grupos atualizados. Reproduza a nova prévia antes de aprovar.");
      refreshPlans();
    },
  });
  const groq = useMutation({
    mutationFn: (plan: ShadowingPlan) => studioApi.generateShadowing(projectId, plan.scene_id),
    onSuccess: () => {
      setActionNotice("A Groq gerou uma nova proposta. Revise todos os grupos.");
      refreshPlans();
    },
  });
  const importAi = useMutation({
    mutationFn: ({ plan, file }: { plan: ShadowingPlan; file: File }) =>
      studioApi.importShadowing(projectId, plan.scene_id, file),
    onSuccess: () => {
      setActionNotice("Proposta da IA externa importada. Revise os grupos antes de aprovar.");
      refreshPlans();
    },
  });
  const isBusy = editing.isPending || groq.isPending || importAi.isPending || approval.isPending;
  busy.current = isBusy;
  const actionError = editing.error ?? groq.error ?? importAi.error ?? approval.error;

  useEffect(() => {
    setPreviewIndex(-1);
    setPhase("ready");
    setPreviewError("");
    playerRef.current?.pause();
  }, [projectId, active?.scene_id, active?.source_sha256, active?.plan_sha256]);

  useEffect(() => {
    if (phase !== "pause" || !active) return;
    const block = active.blocks[previewIndex];
    if (!block) return;
    const timeout = window.setTimeout(() => {
      const nextIndex = previewIndex + 1;
      if (nextIndex >= active.blocks.length) {
        setPhase("finished");
        return;
      }
      setPreviewIndex(nextIndex);
      const video = playerRef.current;
      if (video) {
        video.currentTime = active.blocks[nextIndex].start_ms / 1000;
        void video.play().then(
          () => setPhase("playing"),
          () => setPreviewError("O navegador bloqueou a reprodução. Inicie a prévia novamente."),
        );
      }
    }, block.pause_duration_ms);
    return () => window.clearTimeout(timeout);
  }, [active, phase, previewIndex]);

  function startPreview() {
    if (!active?.blocks.length || !playerRef.current) return;
    setPreviewError("");
    setPreviewIndex(0);
    playerRef.current.currentTime = active.blocks[0].start_ms / 1000;
    void playerRef.current.play().then(
      () => setPhase("playing"),
      () => setPreviewError("Não foi possível reproduzir o vídeo do projeto."),
    );
  }

  function stopPreview() {
    playerRef.current?.pause();
    setPreviewIndex(-1);
    setPhase("ready");
  }

  function handleProgress() {
    const block = active?.blocks[previewIndex];
    if (phase !== "playing" || !block || !playerRef.current) return;
    if (playerRef.current.currentTime * 1000 >= block.end_ms - 40) {
      playerRef.current.pause();
      setPhase("pause");
    }
  }

  function groups(): string[][] {
    return active?.blocks.map((block) => [...block.cue_ids]) ?? [];
  }

  function changeGroups(next: string[][]) {
    if (!active || busy.current) return;
    setActionNotice("");
    stopPreview();
    editing.mutate({ plan: active, groups: next });
  }

  function mergeWithNext(index: number) {
    if (!active || index >= active.blocks.length - 1) return;
    const next = groups();
    next.splice(index, 2, [...next[index], ...next[index + 1]]);
    changeGroups(next);
  }

  function splitAfter(index: number, cuePosition: number) {
    const next = groups();
    const existing = next[index];
    if (!existing || cuePosition >= existing.length - 1) return;
    next.splice(index, 1, existing.slice(0, cuePosition + 1), existing.slice(cuePosition + 1));
    changeGroups(next);
  }

  function omitBlock(index: number) {
    const next = groups();
    next.splice(index, 1);
    changeGroups(next);
  }

  function includeCue(cue: ShadowingCue) {
    if (!active || !cue.eligible) return;
    const next = groups();
    const order = new Map(active.source_cues.map((item) => [item.id, item.order]));
    const insertAt = next.findIndex((group) => (order.get(group[0]) ?? 0) > cue.order);
    next.splice(insertAt < 0 ? next.length : insertAt, 0, [cue.id]);
    changeGroups(next);
  }

  function canMerge(index: number): boolean {
    if (!active || index >= active.blocks.length - 1) return false;
    const left = active.blocks[index];
    const right = active.blocks[index + 1];
    const first = active.source_cues.findIndex((cue) => cue.id === left.cue_ids.at(-1));
    const second = active.source_cues.findIndex((cue) => cue.id === right.cue_ids[0]);
    return (
      left.speaker === right.speaker &&
      left.speaker !== "Não identificado" &&
      first >= 0 &&
      second === first + 1 &&
      right.start_ms >= left.end_ms &&
      right.start_ms - left.end_ms <= 1000 &&
      right.end_ms - left.start_ms <= 6500 &&
      left.word_count + right.word_count <= 14
    );
  }

  return (
    <section className="shadowing-workspace">
      <PageHeader
        title="Shadowing"
        description="A IA escolhe práticas curtas de um só personagem. Você revisa, junta, separa ou exclui grupos antes de aprovar."
      />
      {projects.isPending && <LoadingState label="Carregando projetos" />}
      {projects.isError && (
        <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />
      )}
      {projects.data?.length === 0 && (
        <EmptyState title="Nenhum projeto encontrado">
          Crie um projeto antes de preparar o Shadowing.
        </EmptyState>
      )}
      {Boolean(projects.data?.length) && (
        <div className="shadowing-controls panel">
          <label>
            Projeto
            <select
              value={projectId}
              onChange={(event) => {
                stopPreview();
                setParams({ project: event.target.value });
                setActiveSceneId("");
                setActionNotice("");
              }}
            >
              {projects.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void plans.refetch()}>
            <RefreshCw aria-hidden="true" /> Atualizar
          </button>
        </div>
      )}
      {plans.isPending && Boolean(projectId) && <LoadingState label="Carregando Shadowing" />}
      {plans.isError && (
        <ErrorState message={plans.error.message} retry={() => void plans.refetch()} />
      )}
      {active && (
        <>
          <div className="shadowing-controls panel">
            <label>
              Cena
              <select
                value={active.scene_id}
                onChange={(event) => {
                  stopPreview();
                  setActiveSceneId(event.target.value);
                  setActionNotice("");
                }}
              >
                {plans.data?.map((item, index) => (
                  <option key={item.scene_id} value={item.scene_id}>
                    Cena {index + 1} · {item.status === "approved" ? "aprovada" : "em revisão"}
                  </option>
                ))}
              </select>
            </label>
            <span className="shadowing-info">
              {active.blocks.length} práticas curtas · {active.excluded_cues.length} cues fora
              · {SOURCE_LABELS[active.origin] ?? "Proposta salva"}
            </span>
          </div>

          <section className="shadowing-ai panel" aria-label="Preparação com IA">
            <div>
              <h2>Montar prática com IA</h2>
              <p>
                A IA seleciona grupos com até 6,5 segundos e 14 palavras, sempre com um só
                personagem. As traduções e os textos aprovados não são modificados.
              </p>
            </div>
            <div className="shadowing-ai-actions">
              <button
                type="button"
                className="primary-button"
                disabled={isBusy}
                onClick={() => {
                  setActionNotice("");
                  stopPreview();
                  groq.mutate(active);
                }}
              >
                <Sparkles aria-hidden="true" />
                {groq.isPending ? "Gerando…" : "Gerar proposta com Groq"}
              </button>
              <a
                className="secondary-button"
                href={studioApi.shadowingPackageUrl(projectId, active.scene_id)}
                download
              >
                <Download aria-hidden="true" /> Baixar pacote para IA externa
              </a>
              <label className="shadowing-import">
                Importar proposta (.json)
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  disabled={isBusy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      setSelectedFileName(file.name);
                      setActionNotice("");
                      stopPreview();
                      importAi.mutate({ plan: active, file });
                    }
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            {selectedFileName && <small role="status">Arquivo: {selectedFileName}</small>}
            {importAi.isPending && <p role="status">Validando a proposta da IA externa…</p>}
            {groq.isPending && <p role="status">A Groq está selecionando as melhores falas…</p>}
            {actionError && <p className="field-error" role="alert">{actionError.message}</p>}
            {actionNotice && <p role="status">{actionNotice}</p>}
          </section>

          <div className="shadowing-stage panel">
            <video
              ref={playerRef}
              src={media.data?.cut_url ?? undefined}
              preload="metadata"
              playsInline
              controls={false}
              onTimeUpdate={handleProgress}
              aria-label="Prévia de shadowing"
            />
            <div className="shadowing-preview-status" aria-live="polite">
              {phase === "pause" && active.blocks[previewIndex] && (
                <>
                  <strong>PAUSA · REPITA EM VOZ ALTA</strong>
                  <p>{active.blocks[previewIndex].en}</p>
                  <small>{active.blocks[previewIndex].pt}</small>
                </>
              )}
              {phase === "finished" && (
                <strong>Prévia concluída. Você pode aprovar o plano.</strong>
              )}
            </div>
            <div className="shadowing-preview-actions">
              <button
                type="button"
                onClick={startPreview}
                disabled={
                  !media.data?.cut_url ||
                  !active.blocks.length ||
                  phase === "playing" ||
                  phase === "pause" ||
                  isBusy
                }
              >
                <Play aria-hidden="true" />{" "}
                {phase === "finished" ? "Repetir prévia" : "Reproduzir prévia completa"}
              </button>
              {(phase === "playing" || phase === "pause") && (
                <button type="button" onClick={stopPreview}>
                  <X aria-hidden="true" /> Parar
                </button>
              )}
              <span>
                {previewIndex < 0
                  ? "Não iniciada"
                  : `Bloco ${previewIndex + 1}/${active.blocks.length}`}
              </span>
              <button
                type="button"
                className="primary-button"
                onClick={() => approval.mutate(active)}
                disabled={
                  active.status === "approved" ||
                  !active.blocks.length ||
                  phase !== "finished" ||
                  isBusy
                }
              >
                <Check aria-hidden="true" />{" "}
                {active.status === "approved" ? "Shadowing aprovado" : "Aprovar Shadowing"}
              </button>
            </div>
            {previewError && <p role="alert">{previewError}</p>}
          </div>

          <section className="shadowing-review" aria-label="Revisar práticas">
            <div className="shadowing-section-heading">
              <h2>Práticas selecionadas</h2>
              <p>Juntar só é permitido entre falas consecutivas do mesmo personagem.</p>
            </div>
            {active.blocks.length === 0 && (
              <p className="panel">
                Nenhuma prática selecionada. Use a IA ou adicione falas curtas da lista abaixo.
              </p>
            )}
            <div className="shadowing-blocks">
              {active.blocks.map((block, index) => (
                <article key={block.id} className="panel shadowing-block">
                  <div className="shadowing-block-heading">
                    <strong>Prática {index + 1} · {block.speaker}</strong>
                    <small>
                      {((block.end_ms - block.start_ms) / 1000).toFixed(1)} s ·{" "}
                      {block.word_count} palavras
                    </small>
                  </div>
                  <p>{block.en}</p>
                  <small>{block.pt}</small>
                  <span>
                    {formatTime(block.start_ms)}–{formatTime(block.end_ms)} · Pausa{" "}
                    {(block.pause_duration_ms / 1000).toFixed(1)} s
                  </span>
                  {block.cue_ids.length > 1 && (
                    <div className="shadowing-cue-pieces">
                      {block.cue_ids.map((cueId, position) => {
                        const cue = active.source_cues.find((item) => item.id === cueId);
                        return (
                          <div key={cueId}>
                            <span>Cue {cue?.order}: {cue?.en}</span>
                            {position < block.cue_ids.length - 1 && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => splitAfter(index, position)}
                                aria-label={`Separar após cue ${cue?.order}`}
                              >
                                <Scissors aria-hidden="true" /> Separar aqui
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="shadowing-block-actions">
                    <button
                      type="button"
                      disabled={isBusy || !canMerge(index)}
                      onClick={() => mergeWithNext(index)}
                      title="Une apenas cues consecutivos da mesma voz, respeitando o limite curto"
                    >
                      <Merge aria-hidden="true" /> Juntar com próxima
                    </button>
                    <button type="button" disabled={isBusy} onClick={() => omitBlock(index)}>
                      <Trash2 aria-hidden="true" /> Excluir grupo
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="shadowing-excluded panel" aria-label="Cues não selecionados">
            <div className="shadowing-section-heading">
              <h2>Cues fora desta prática ({active.excluded_cues.length})</h2>
              <p>
                Excluir um grupo não apaga nada do Editorial. Falas longas precisam ser
                divididas na origem para virar práticas fáceis de repetir.
              </p>
            </div>
            {active.excluded_cues.length === 0 && <p>Todos os cues estão selecionados.</p>}
            <div className="shadowing-excluded-list">
              {active.excluded_cues.map((cue) => (
                <div className="shadowing-excluded-item" key={cue.id}>
                  <div>
                    <strong>Cue {cue.order} · {cue.speaker}</strong>
                    <p>{cue.en}</p>
                    <small>{cue.reason}</small>
                  </div>
                  {cue.eligible ? (
                    <button type="button" disabled={isBusy} onClick={() => includeCue(cue)}>
                      <Undo2 aria-hidden="true" /> Adicionar
                    </button>
                  ) : (
                    <Link to={`/editorial?project=${projectId}`}>Ver no Editorial</Link>
                  )}
                </div>
              ))}
            </div>
          </section>

          {allApproved && (
            <section className="shadowing-next panel">
              <strong>Shadowing aprovado em todas as cenas.</strong>
              <Link className="primary-button" to={`/materials?project=${projectId}`}>
                Avançar para Materiais e Anki
              </Link>
            </section>
          )}
        </>
      )}
    </section>
  );
}

function formatTime(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)} s`;
}
