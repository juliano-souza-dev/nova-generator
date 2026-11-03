import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Download, Film, Pause, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { studioApi } from "../../lib/studio-api";
import { durationLabel } from "./caption-timeline";
import {
  chosenDuration,
  MAX_SHADOWING_VIDEO_MS,
  MIN_SHADOWING_VIDEO_MS,
  suggestShadowingClip,
} from "./shadowing-clip";
import { mediaApi, type MediaProject } from "./tiktok-api";

type Phase = "idle" | "listen" | "repeat" | "done";

type Props = {
  project: MediaProject;
  persisted: MediaProject | undefined;
  dirty: boolean;
  saving: boolean;
  onEdit: (change: (current: MediaProject) => MediaProject) => void;
};

export function TikTokShadowingStudio({ project, persisted, dirty, saving, onEdit }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(-1);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [jobId, setJobId] = useState("");
  const [renderId, setRenderId] = useState("");
  const sourceProjects = useQuery({ queryKey: ["projects"], queryFn: () => studioApi.projects() });
  const plans = useQuery({
    queryKey: ["shadowing", project.source_project_id],
    queryFn: () => studioApi.shadowing(project.source_project_id!),
    enabled: Boolean(project.source_project_id),
    retry: false,
  });
  const plan = plans.data?.find((item) => item.scene_id === project.source_scene_id);
  const current = Boolean(
    plan &&
    plan.source_sha256 === project.shadowing_clip?.source_sha256 &&
    plan.plan_sha256 === project.shadowing_clip?.plan_sha256,
  );
  const chosenIds = current ? (project.shadowing_clip?.block_ids ?? []) : [];
  const blocks = plan?.blocks ?? [];
  const chosen = useMemo(
    () => blocks.filter((block) => chosenIds.includes(block.id)),
    // The plan query and persisted selection own these stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, project.shadowing_clip],
  );
  const total = chosenDuration(blocks, chosenIds);
  const validDuration = total >= MIN_SHADOWING_VIDEO_MS && total <= MAX_SHADOWING_VIDEO_MS;
  const sourceReady = Boolean(
    persisted?.source_project_id === project.source_project_id &&
    persisted?.source_scene_id === project.source_scene_id &&
    project.source_scene_id,
  );
  const active = chosen[index];
  const videoUrl = sourceReady ? mediaApi.sourceUrl(project.id) : "";

  const render = useMutation({
    mutationFn: () =>
      mediaApi.render(project.id, project.revision, [], "original", "", "shadowing"),
    onSuccess: (response) => {
      setJobId(response.job_id);
      setRenderId(response.render_id);
      setMessage("Renderização iniciada. Acompanhe o progresso abaixo.");
    },
    onError: (error) => setMessage(error.message),
  });
  const job = useQuery({
    queryKey: ["tiktok-shadowing-render", jobId],
    queryFn: () => studioApi.job(jobId),
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      ["succeeded", "failed", "cancelled"].includes(query.state.data?.status ?? "") ? false : 2500,
  });

  useEffect(() => {
    videoRef.current?.pause();
    setIndex(-1);
    setPhase("idle");
  }, [project.source_project_id, project.source_scene_id, project.shadowing_clip]);

  useEffect(() => {
    if (phase !== "repeat" || !active) return;
    const timeout = window.setTimeout(() => {
      const next = chosen[index + 1];
      if (!next) {
        setPhase("done");
        return;
      }
      setIndex(index + 1);
      const player = videoRef.current;
      if (!player) return;
      player.currentTime = next.start_ms / 1000;
      void player.play().then(
        () => setPhase("listen"),
        () => setMessage("Não foi possível reproduzir o próximo trecho."),
      );
    }, active.pause_duration_ms);
    return () => window.clearTimeout(timeout);
  }, [active, chosen, index, phase]);

  function updateSelection(ids: string[]) {
    videoRef.current?.pause();
    setIndex(-1);
    setPhase("idle");
    if (!plan) return;
    onEdit((old) => ({
      ...old,
      shadowing_clip: {
        source_sha256: plan.source_sha256,
        plan_sha256: plan.plan_sha256,
        block_ids: plan.blocks.filter((block) => ids.includes(block.id)).map((block) => block.id),
      },
    }));
  }

  function start() {
    const first = chosen[0];
    if (!first || !videoRef.current) return;
    setMessage("");
    setIndex(0);
    videoRef.current.currentTime = first.start_ms / 1000;
    void videoRef.current.play().then(
      () => setPhase("listen"),
      () => setMessage("A fonte não carregou. Confira se a cena possui recorte pronto."),
    );
  }

  function onTimeUpdate(player: HTMLVideoElement) {
    if (phase === "listen" && active && player.currentTime * 1000 >= active.end_ms - 35) {
      player.pause();
      setPhase("repeat");
    }
  }

  return (
    <>
      <main className="tm-center tm-shadowing-workbench" aria-label="Montagem do Shadowing TikTok">
        <header className="tm-shadowing-heading">
          <span className="tm-eyebrow">TIKTOK · SHADOWING · 9:16</span>
          <h2>Ouça, imite e pratique</h2>
          <p>
            Escolha trechos do Shadowing já preparado. Cada fala mantém o áudio original e ganha uma
            pausa para repetir.
          </p>
        </header>
        <div className="tm-shadowing-source tm-card">
          <label>
            Projeto do Generator
            <select
              aria-label="Projeto para Shadowing TikTok"
              value={project.source_project_id ?? ""}
              onChange={(event) =>
                onEdit((old) => ({
                  ...old,
                  source_project_id: event.target.value || null,
                  source_scene_id: null,
                  source_youtube_id: null,
                  source_cut_job_id: null,
                  shadowing_clip: null,
                }))
              }
            >
              <option value="">Selecione o projeto</option>
              {sourceProjects.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cena com Shadowing
            <select
              aria-label="Cena para Shadowing TikTok"
              value={project.source_scene_id ?? ""}
              onChange={(event) =>
                onEdit((old) => ({
                  ...old,
                  source_scene_id: event.target.value || null,
                  shadowing_clip: null,
                }))
              }
              disabled={!project.source_project_id || plans.isPending}
            >
              <option value="">Selecione uma cena</option>
              {plans.data?.map((item, itemIndex) => (
                <option key={item.scene_id} value={item.scene_id}>
                  Cena {itemIndex + 1} · {item.blocks.length} práticas ·{" "}
                  {item.status === "approved" ? "aprovada" : "pendente"}
                </option>
              ))}
            </select>
          </label>
          {plans.isError && <p role="alert">{plans.error.message}</p>}
          {plan && plan.status !== "approved" && (
            <p role="alert">
              Aprove primeiro esta cena no{" "}
              <Link to={`/shadowing?project=${project.source_project_id}`}>
                Shadowing do Generator
              </Link>
              .
            </p>
          )}
        </div>
        {plan && (
          <>
            <div className="tm-shadowing-summary">
              <strong>
                {durationLabel(total)} <span>/ 00:35–01:00</span>
              </strong>
              <button type="button" onClick={() => updateSelection(suggestShadowingClip(blocks))}>
                <RefreshCw size={15} /> Sugerir sequência
              </button>
              {current && chosen.length > 0 && !validDuration && (
                <p>Escolha práticas até completar entre 35 e 60 segundos.</p>
              )}
              {!current && project.shadowing_clip && (
                <p role="alert">O Shadowing mudou. Escolha novamente os trechos atualizados.</p>
              )}
            </div>
            <div className="tm-shadowing-list" aria-label="Práticas disponíveis">
              {blocks.map((block, blockIndex) => (
                <label
                  key={block.id}
                  className={chosenIds.includes(block.id) ? "tm-shadowing-selected" : ""}
                >
                  <input
                    type="checkbox"
                    checked={chosenIds.includes(block.id)}
                    onChange={(event) =>
                      updateSelection(
                        event.target.checked
                          ? [...chosenIds, block.id]
                          : chosenIds.filter((id) => id !== block.id),
                      )
                    }
                    disabled={!chosenIds.includes(block.id) && chosenIds.length >= 12}
                  />
                  <span>
                    <small>
                      Prática {blockIndex + 1} · {block.speaker} ·{" "}
                      {durationLabel(block.end_ms - block.start_ms)} +{" "}
                      {durationLabel(block.pause_duration_ms)} pausa
                    </small>
                    <strong>{block.en}</strong>
                    <em>{block.pt}</em>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
      </main>
      <aside className="tm-inspector tm-shadowing-output">
        <section className="tm-card">
          <h2>
            <Play size={17} /> Prévia da prática
          </h2>
          <div
            className={`tm-shadowing-stage ${project.background_mode === "paper" || phase === "repeat" ? "tm-shadowing-solid" : ""} tm-shadowing-${project.background_mode === "paper" ? (project.paper_theme ?? "night") : "night"}`}
          >
            {videoUrl ? (
              <video
                ref={videoRef}
                key={videoUrl}
                src={videoUrl}
                preload="metadata"
                playsInline
                aria-label="Prévia dos trechos de Shadowing"
                onTimeUpdate={(event) => onTimeUpdate(event.currentTarget)}
                onEnded={() => setPhase("done")}
                onError={() => setMessage("O recorte da cena não está disponível para a prévia.")}
              />
            ) : (
              <p>Salve uma cena selecionada para carregar a prévia.</p>
            )}
            {active && (
              <div className="tm-shadowing-subtitle">
                <small>{phase === "repeat" ? "SUA VEZ · REPITA" : "OUÇA E IMITE"}</small>
                <strong>{active.en}</strong>
                <span>{phase === "repeat" ? "Repita em voz alta" : active.pt}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={
              phase === "listen" || phase === "repeat"
                ? () => {
                    videoRef.current?.pause();
                    setPhase("idle");
                    setIndex(-1);
                  }
                : start
            }
            disabled={!videoUrl || !chosen.length}
          >
            {phase === "listen" || phase === "repeat" ? <Pause size={16} /> : <Play size={16} />}
            {phase === "listen" || phase === "repeat" ? "Parar" : "Reproduzir sequência"}
          </button>
          {phase === "repeat" && (
            <p className="tm-small">O áudio está em silêncio para você repetir a frase.</p>
          )}
        </section>
        <section className="tm-card">
          <h2>
            <Film size={18} /> Visual e exportação
          </h2>
          <label>
            Fundo da fala
            <select
              value={project.background_mode ?? "video"}
              onChange={(event) =>
                onEdit((old) => ({
                  ...old,
                  background_mode: event.target.value as "video" | "paper",
                }))
              }
            >
              <option value="video">Vídeo original</option>
              <option value="paper">Fundo didático, com áudio original</option>
            </select>
          </label>
          {project.background_mode === "paper" && (
            <label>
              Cor do fundo
              <select
                value={project.paper_theme ?? "night"}
                onChange={(event) =>
                  onEdit((old) => ({
                    ...old,
                    paper_theme: event.target.value as MediaProject["paper_theme"],
                  }))
                }
              >
                <option value="night">Noturno</option>
                <option value="cream">Claro</option>
                <option value="kraft">Areia</option>
              </select>
            </label>
          )}
          <p className="tm-small">
            MP4 vertical (1080 × 1920), som original nas falas e silêncio nas pausas. O texto
            aprovado permanece intacto.
          </p>
          <button
            type="button"
            className="tm-accent"
            disabled={
              !sourceReady ||
              !plan ||
              plan.status !== "approved" ||
              !current ||
              !validDuration ||
              dirty ||
              saving ||
              render.isPending
            }
            onClick={() => render.mutate()}
          >
            <Check size={16} /> {render.isPending ? "Preparando…" : "Gerar Shadowing MP4"}
          </button>
          {message && <p role="status">{message}</p>}
          {jobId && (
            <p className="tm-small">
              Render: <Link to="/jobs">{job.data?.status ?? "aguardando"}</Link>
              {job.data?.error_message ? ` · ${job.data.error_message}` : ""}
            </p>
          )}
          {job.data?.status === "succeeded" && renderId && (
            <>
              <video
                controls
                src={mediaApi.videoUrl(project.id, renderId)}
                aria-label="Vídeo Shadowing exportado"
              />
              <a
                className="tm-download"
                href={mediaApi.videoUrl(project.id, renderId)}
                download="tiktok-shadowing.mp4"
              >
                <Download size={16} /> Baixar MP4
              </a>
            </>
          )}
          <p className="tm-small">
            Use trechos de terceiros apenas quando tiver autorização para publicá-los.
          </p>
        </section>
      </aside>
    </>
  );
}
