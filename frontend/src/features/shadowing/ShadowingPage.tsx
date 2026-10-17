import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import type { ShadowingPlan } from "./shadowing.types";
import "./shadowing.css";

type PreviewPhase = "ready" | "playing" | "pause" | "finished";

export function ShadowingPage() {
  const [params, setParams] = useSearchParams();
  const [activeSceneId, setActiveSceneId] = useState("");
  const [previewIndex, setPreviewIndex] = useState(-1);
  const [phase, setPhase] = useState<PreviewPhase>("ready");
  const [previewError, setPreviewError] = useState("");
  const playerRef = useRef<HTMLVideoElement>(null);
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ["projects", "shadowing"], queryFn: () => studioApi.projects() });
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

  const approval = useMutation({
    mutationFn: (plan: ShadowingPlan) =>
      studioApi.approveShadowing(projectId, plan.scene_id, plan.source_sha256),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["shadowing", projectId] }),
  });

  useEffect(() => {
    setPreviewIndex(-1);
    setPhase("ready");
    setPreviewError("");
    playerRef.current?.pause();
  }, [projectId, active?.scene_id, active?.source_sha256]);

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

  function handleProgress() {
    const block = active?.blocks[previewIndex];
    if (phase !== "playing" || !block || !playerRef.current) return;
    if (playerRef.current.currentTime * 1000 >= block.end_ms - 40) {
      playerRef.current.pause();
      setPhase("pause");
    }
  }

  return (
    <section className="shadowing-workspace">
      <PageHeader
        title="Shadowing"
        description="Os blocos e as pausas são pré-produzidos a partir do Editorial aprovado. Ouça, pratique e confirme antes dos materiais."
      />
      {projects.isPending && <LoadingState label="Carregando projetos" />}
      {projects.isError && (
        <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />
      )}
      {projects.data?.length === 0 && <EmptyState title="Nenhum projeto encontrado">Crie um projeto antes de preparar o Shadowing.</EmptyState>}
      {Boolean(projects.data?.length) && (
        <div className="shadowing-controls panel">
          <label>
            Projeto
            <select
              value={projectId}
              onChange={(event) => {
                setParams({ project: event.target.value });
                setActiveSceneId("");
              }}
            >
              {projects.data?.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void plans.refetch()}>
            <RefreshCw aria-hidden="true" /> Atualizar
          </button>
        </div>
      )}
      {plans.isPending && Boolean(projectId) && <LoadingState label="Preparando blocos" />}
      {plans.isError && (
        <ErrorState
          message={plans.error.message}
          retry={() => void plans.refetch()}
        />
      )}
      {active && (
        <>
          <div className="shadowing-controls panel">
            <label>
              Cena
              <select
                value={active.scene_id}
                onChange={(event) => setActiveSceneId(event.target.value)}
              >
                {plans.data?.map((item, index) => (
                  <option key={item.scene_id} value={item.scene_id}>
                    Cena {index + 1} · {item.status === "approved" ? "aprovada" : "aguardando prévia"}
                  </option>
                ))}
              </select>
            </label>
            <span className="shadowing-info">
              {active.blocks.length} blocos · {(active.duration_ms / 1000).toFixed(1)} s de cena
            </span>
          </div>
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
              {phase === "finished" && <strong>Prévia concluída. Você pode aprovar o plano.</strong>}
            </div>
            <div className="shadowing-preview-actions">
              <button
                type="button"
                onClick={startPreview}
                disabled={!media.data?.cut_url || !active.blocks.length || phase === "playing" || phase === "pause"}
              >
                <Play aria-hidden="true" /> {phase === "finished" ? "Repetir prévia" : "Reproduzir prévia completa"}
              </button>
              <span>{previewIndex < 0 ? "Não iniciada" : `Bloco ${previewIndex + 1}/${active.blocks.length}`}</span>
              <button
                type="button"
                className="primary-button"
                onClick={() => approval.mutate(active)}
                disabled={active.status === "approved" || phase !== "finished" || approval.isPending}
              >
                <Check aria-hidden="true" /> {active.status === "approved" ? "Shadowing aprovado" : "Aprovar Shadowing"}
              </button>
            </div>
            {previewError && <p role="alert">{previewError}</p>}
            {approval.isError && <p role="alert">{approval.error.message}</p>}
          </div>
          <div className="shadowing-blocks">
            {active.blocks.map((block, index) => (
              <article key={block.id} className="panel">
                <strong>Bloco {index + 1} · {(block.start_ms / 1000).toFixed(2)}–{(block.end_ms / 1000).toFixed(2)} s</strong>
                <p>{block.en}</p>
                <small>{block.pt}</small>
                <span>Pausa de repetição: {(block.pause_duration_ms / 1000).toFixed(1)} s</span>
              </article>
            ))}
          </div>
          {allApproved && (
            <section className="shadowing-next panel">
              <strong>Shadowing aprovado em todas as cenas.</strong>
              <Link className="primary-button" to={`/materials?project=${projectId}`}>
                Avançar para materiais da IA externa
              </Link>
            </section>
          )}
        </>
      )}
    </section>
  );
}
