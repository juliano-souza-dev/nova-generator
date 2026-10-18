import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  Merge,
  MoreHorizontal,
  Pause,
  Plus,
  Play,
  RefreshCw,
  Scissors,
  Search,
  Keyboard,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { ShadowingCue, ShadowingPlan } from "./shadowing.types";
import { studioApi } from "../../lib/studio-api";
import "./shadowing.css";

type PreviewPhase = "ready" | "playing" | "paused" | "pause" | "finished";
type UndoEntry = { projectId: string; sceneId: string; source: string; groups: string[][] };
type Toast = { text: string; tone: "success" | "error" | "info"; undo?: boolean };

const SOURCE_LABELS: Record<ShadowingPlan["origin"], string> = {
  automatic: "Rascunho automático",
  groq: "Proposta por IA",
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
  const [toast, setToast] = useState<Toast | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(0);
  const [focusedCueId, setFocusedCueId] = useState("");
  const [cueQuery, setCueQuery] = useState("");
  const [durationFilter, setDurationFilter] = useState("all");
  const [wordFilter, setWordFilter] = useState("all");
  const [usedExpanded, setUsedExpanded] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const undoHistory = useRef<UndoEntry[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generatingGuard = useRef(false);
  const importGuard = useRef(false);
  const playerRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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
  const approvedCount = plans.data?.filter((item) => item.status === "approved").length ?? 0;
  const sceneIndex = Math.max(
    0,
    plans.data?.findIndex((item) => item.scene_id === active?.scene_id) ?? 0,
  );
  const missingSpeakers =
    active?.blocks.some((block) => !block.speaker.trim() || block.speaker === "Não identificado") ??
    false;
  const activeReady = Boolean(active?.blocks.length) && !missingSpeakers && phase === "finished";
  const previewLabel =
    phase === "finished"
      ? "Revisada"
      : phase === "playing" || phase === "pause"
        ? "Reproduzindo"
        : phase === "paused"
          ? "Pausada"
          : "Não iniciada";

  const refreshPlans = () => void client.invalidateQueries({ queryKey: ["shadowing", projectId] });

  const showToast = useCallback((next: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    undoHistory.current = [];
    setHistoryVersion((value) => value + 1);
    setSelectedBlockIndex(0);
    setFocusedCueId("");
    setToolsOpen(false);
    setToast(null);
  }, [projectId, active?.scene_id]);

  const approval = useMutation({
    mutationFn: (plan: ShadowingPlan) =>
      studioApi.approveShadowing(projectId, plan.scene_id, plan.source_sha256, plan.plan_sha256),
    onSuccess: () => {
      showToast({ text: "Shadowing aprovado.", tone: "success" });
      refreshPlans();
    },
    onError: (error) => showToast({ text: error.message, tone: "error" }),
  });
  const editing = useMutation({
    mutationFn: ({
      plan,
      groups,
    }: {
      plan: ShadowingPlan;
      groups: string[][];
      description?: string;
      undo?: boolean;
    }) =>
      studioApi.editShadowing(
        projectId,
        plan.scene_id,
        plan.source_sha256,
        plan.plan_sha256,
        groups,
      ),
    onSuccess: (updated, variables) => {
      client.setQueryData<ShadowingPlan[]>(["shadowing", projectId], (previous) =>
        previous?.map((item) => (item.scene_id === updated.scene_id ? updated : item)),
      );
      if (variables.undo) {
        undoHistory.current.pop();
      } else {
        undoHistory.current = [
          ...undoHistory.current,
          {
            projectId,
            sceneId: variables.plan.scene_id,
            source: variables.plan.source_sha256,
            groups: variables.plan.blocks.map((item) => [...item.cue_ids]),
          },
        ].slice(-30);
      }
      setHistoryVersion((value) => value + 1);
      showToast({
        text: variables.undo
          ? "Última edição desfeita."
          : `${variables.description ?? "Grupos atualizados"}. Reproduza a prévia antes de aprovar.`,
        tone: "success",
        undo: undoHistory.current.length > 0,
      });
      refreshPlans();
    },
    onError: (error) => showToast({ text: error.message, tone: "error" }),
  });
  const groq = useMutation({
    mutationFn: (plan: ShadowingPlan) => studioApi.generateShadowing(projectId, plan.scene_id),
    onSuccess: (updated) => {
      undoHistory.current = [];
      setHistoryVersion((value) => value + 1);
      showToast({
        text: `Proposta gerada: ${updated.blocks.length} grupos. Reproduza a prévia antes de aprovar.`,
        tone: "success",
      });
      refreshPlans();
    },
    onError: (error) =>
      showToast({ text: `Falha ao gerar proposta: ${error.message}`, tone: "error" }),
    onSettled: () => {
      generatingGuard.current = false;
    },
  });
  const importAi = useMutation({
    mutationFn: ({ plan, file }: { plan: ShadowingPlan; file: File }) =>
      studioApi.importShadowing(projectId, plan.scene_id, file),
    onSuccess: (updated) => {
      undoHistory.current = [];
      setHistoryVersion((value) => value + 1);
      showToast({ text: `Proposta importada: ${updated.blocks.length} grupos.`, tone: "success" });
      refreshPlans();
    },
    onError: (error) =>
      showToast({ text: `Erro no JSON importado: ${error.message}`, tone: "error" }),
    onSettled: () => {
      importGuard.current = false;
    },
  });
  const isBusy = editing.isPending || groq.isPending || importAi.isPending || approval.isPending;
  busy.current = isBusy;
  const historyCount = historyVersion >= 0 ? undoHistory.current.length : 0;

  function retryFailedAction() {
    if (isBusy || !active) return;
    if (editing.isError && editing.variables) {
      editing.mutate(editing.variables);
    } else if (groq.isError) {
      if (generatingGuard.current) return;
      generatingGuard.current = true;
      groq.mutate(active);
    } else if (importAi.isError && importAi.variables) {
      if (importGuard.current) return;
      importGuard.current = true;
      importAi.mutate(importAi.variables);
    } else if (approval.isError && approval.variables) {
      approval.mutate(approval.variables);
    }
  }

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

  function togglePreview() {
    if (phase === "playing") {
      playerRef.current?.pause();
      setPhase("paused");
    } else if (phase === "paused" && playerRef.current) {
      void playerRef.current.play().then(
        () => setPhase("playing"),
        () => setPreviewError("Não foi possível retomar a reprodução."),
      );
    } else if (phase !== "pause") {
      startPreview();
    }
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

  function changeGroups(next: string[][], description: string) {
    if (!active || busy.current) return;
    stopPreview();
    editing.mutate({ plan: active, groups: next, description });
  }

  function undoLast() {
    if (!active || busy.current) return;
    const prior = undoHistory.current.at(-1);
    if (
      !prior ||
      prior.projectId !== projectId ||
      prior.sceneId !== active.scene_id ||
      prior.source !== active.source_sha256
    )
      return;
    stopPreview();
    editing.mutate({ plan: active, groups: prior.groups, undo: true });
  }

  function mergeWithNext(index: number) {
    if (!active || index >= active.blocks.length - 1) return;
    const next = groups();
    next.splice(index, 2, [...next[index], ...next[index + 1]]);
    changeGroups(next, "Grupos unidos");
  }

  function splitAfter(index: number, cuePosition: number) {
    const next = groups();
    const existing = next[index];
    if (!existing || cuePosition >= existing.length - 1) return;
    next.splice(index, 1, existing.slice(0, cuePosition + 1), existing.slice(cuePosition + 1));
    changeGroups(next, "Grupo separado");
  }

  function omitBlock(index: number) {
    const next = groups();
    next.splice(index, 1);
    changeGroups(next, "Grupo excluído");
  }

  function includeCue(cue: ShadowingCue) {
    if (!active || !cue.eligible) return;
    const next = groups();
    const order = new Map(active.source_cues.map((item) => [item.id, item.order]));
    const insertAt = next.findIndex((group) => (order.get(group[0]) ?? 0) > cue.order);
    next.splice(insertAt < 0 ? next.length : insertAt, 0, [cue.id]);
    changeGroups(next, "Cue adicionado");
  }

  function removeUsedCue(cueId: string) {
    const next = groups().flatMap((group) => {
      const index = group.indexOf(cueId);
      if (index < 0) return [group];
      return [group.slice(0, index), group.slice(index + 1)].filter((part) => part.length > 0);
    });
    changeGroups(next, "Cue removido da prática");
  }

  function mergeBlockReason(index: number): string | null {
    if (!active || index >= active.blocks.length - 1) return "Não há próxima prática para juntar.";
    const left = active.blocks[index];
    const right = active.blocks[index + 1];
    const first = active.source_cues.findIndex((cue) => cue.id === left.cue_ids.at(-1));
    const second = active.source_cues.findIndex((cue) => cue.id === right.cue_ids[0]);
    if (left.speaker !== right.speaker) return "Os cues têm locutores diferentes.";
    if (first < 0 || second !== first + 1) {
      return "Existe uma cue intermediária; só é possível juntar cues consecutivos.";
    }
    if (right.start_ms < left.end_ms) return "Os cues se sobrepõem no tempo.";
    if (right.start_ms - left.end_ms > 1000) return "O intervalo entre os cues passa de 1 segundo.";
    const durationMs = right.end_ms - left.start_ms;
    if (durationMs > 6500)
      return `A prática combinada teria ${(durationMs / 1000).toFixed(1)} s; o limite é 6,5 s.`;
    const words = left.word_count + right.word_count;
    if (words > 24) return `A prática combinada teria ${words} palavras; o limite manual é 24.`;
    return null;
  }

  const filteredCues =
    active?.excluded_cues.filter((cue) => {
      const normalized = (value: string) =>
        value
          .normalize("NFD")
          .replace(/[\\u0300-\\u036f]/g, "")
          .toLocaleLowerCase("pt-BR");
      const matchesText = normalized(`${cue.en} ${cue.pt} ${cue.speaker}`).includes(
        normalized(cueQuery),
      );
      const duration = cue.end_ms - cue.start_ms;
      const matchesDuration =
        durationFilter === "all" ||
        (durationFilter === "short" && duration <= 2000) ||
        (durationFilter === "medium" && duration > 2000 && duration <= 4000) ||
        (durationFilter === "long" && duration > 4000);
      const words = cue.en.trim().split(/\\s+/).filter(Boolean).length;
      return (
        matchesText &&
        matchesDuration &&
        (wordFilter === "all" ||
          (wordFilter === "short" && words <= 5) ||
          (wordFilter === "long" && words > 5))
      );
    }) ?? [];
  const usedCues =
    active?.source_cues.filter((cue) =>
      active.blocks.some((block) => block.cue_ids.includes(cue.id)),
    ) ?? [];
  const displayedSteps = [
    { id: "project", label: "Projeto", target: "shadowing-project" },
    { id: "scene", label: "Cena", target: "shadowing-scene" },
    { id: "mount", label: "Montar", target: "shadowing-ai" },
    { id: "review", label: "Revisar", target: "shadowing-review" },
    { id: "approve", label: "Aprovar", target: "shadowing-actions" },
  ];
  const currentStep = !projectId
    ? 0
    : !active
      ? 1
      : active.status === "approved"
        ? 4
        : active.origin === "automatic"
          ? 2
          : 3;

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen((value) => !value);
        return;
      }
      if (shortcutsOpen || isBusy || !active) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        if (historyCount) {
          event.preventDefault();
          undoLast();
        }
        return;
      }
      if (
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        target?.closest("button, a, [role='button']")
      )
        return;
      const key = event.key.toLowerCase();
      if (event.code === "Space") {
        if (media.data?.cut_url) {
          event.preventDefault();
          togglePreview();
        }
      } else if (key === "j" || key === "k") {
        if (!active.blocks.length) return;
        event.preventDefault();
        setSelectedBlockIndex((current) => {
          const next = Math.max(
            0,
            Math.min(active.blocks.length - 1, current + (key === "j" ? 1 : -1)),
          );
          document
            .getElementById(`shadowing-block-${next}`)
            ?.scrollIntoView?.({ block: "nearest" });
          return next;
        });
      } else if (key === "delete" && active.blocks[selectedBlockIndex]) {
        event.preventDefault();
        omitBlock(selectedBlockIndex);
      } else if (key === "m" && !mergeBlockReason(selectedBlockIndex)) {
        event.preventDefault();
        mergeWithNext(selectedBlockIndex);
      } else if (key === "a") {
        const cue = active.excluded_cues.find((item) => item.id === focusedCueId && item.eligible);
        if (cue) {
          event.preventDefault();
          includeCue(cue);
        }
      } else if (key === "s") {
        const cueIds = active.blocks[selectedBlockIndex]?.cue_ids ?? [];
        const position = cueIds.indexOf(focusedCueId);
        if (position >= 0 && position < cueIds.length - 1) {
          event.preventDefault();
          splitAfter(selectedBlockIndex, position);
        }
      }
    }
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  });

  return (
    <section className="shadowing-workspace">
      <PageHeader
        title="Shadowing"
        description="A IA escolhe práticas curtas de um só personagem. Você revisa, junta, separa ou exclui grupos antes de aprovar."
      />
      <nav className="shadowing-steps panel" aria-label="Etapas do Shadowing">
        <ol>
          {displayedSteps.map((step, index) => (
            <li key={step.id}>
              <button
                type="button"
                disabled={index > currentStep}
                title={
                  index > currentStep
                    ? "Conclua as etapas anteriores para navegar"
                    : "Ir para " + step.label
                }
                aria-current={index === currentStep ? "step" : undefined}
                className={
                  index < currentStep
                    ? "is-complete"
                    : index === currentStep
                      ? "is-current"
                      : "is-pending"
                }
                onClick={() =>
                  document.getElementById(step.target)?.scrollIntoView?.({
                    behavior: "smooth",
                    block: "start",
                  })
                }
              >
                <span aria-hidden="true">
                  {index < currentStep ? "✓" : index === currentStep ? "●" : "○"}
                </span>
                {step.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="shadowing-steps-right">
          <strong>
            {approvedCount} de {plans.data?.length ?? 0} cenas aprovadas
          </strong>
          <button
            type="button"
            aria-label="Ver atalhos de teclado"
            title="Atalhos de teclado (?)"
            onClick={() => setShortcutsOpen(true)}
          >
            <Keyboard aria-hidden="true" /> ?
          </button>
        </div>
      </nav>
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
        <div className="shadowing-controls panel" id="shadowing-project">
          <label>
            Projeto
            <select
              value={projectId}
              onChange={(event) => {
                stopPreview();
                setParams({ project: event.target.value });
                setActiveSceneId("");
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
      {Boolean(projectId) && plans.data?.length === 0 && (
        <EmptyState title="Este projeto ainda não tem cenas">
          Importe o material e prepare o Editorial para começar o Shadowing.
          <Link to={`/projects`}>Ir para Projetos</Link>
        </EmptyState>
      )}
      {active && (
        <>
          <div className="shadowing-controls panel" id="shadowing-scene">
            <label>
              Cena
              <select
                value={active.scene_id}
                onChange={(event) => {
                  stopPreview();
                  setActiveSceneId(event.target.value);
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
              Cena {sceneIndex + 1} de {plans.data?.length ?? 0} · {active.blocks.length} práticas ·{" "}
              {active.excluded_cues.length} cues disponíveis ·{" "}
              {SOURCE_LABELS[active.origin] ?? "Proposta salva"}
            </span>
            <span
              className={`shadowing-state ${active.status === "approved" ? "is-approved" : "is-review"}`}
            >
              {active.status === "approved" ? "Aprovada" : "Em revisão"}
            </span>
          </div>

          <div className="shadowing-layout">
            <div className="shadowing-video-column">
              <div className="shadowing-stage panel" ref={stageRef} aria-label="Prévia da cena">
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
                {previewError && <p role="alert">{previewError}</p>}
              </div>

              <div id="shadowing-actions" className="shadowing-sticky-actions panel">
                <div className="shadowing-action-group">
                  <button
                    type="button"
                    onClick={togglePreview}
                    disabled={
                      !media.data?.cut_url || !active.blocks.length || phase === "pause" || isBusy
                    }
                    title={
                      !media.data?.cut_url
                        ? "Vídeo da cena indisponível"
                        : !active.blocks.length
                          ? "Adicione uma prática antes da prévia"
                          : isBusy
                            ? "Aguarde a edição em andamento"
                            : "Reproduzir ou pausar a prévia"
                    }
                  >
                    {phase === "playing" ? (
                      <Pause aria-hidden="true" />
                    ) : (
                      <Play aria-hidden="true" />
                    )}
                    {phase === "playing" ? "Pausar" : "Reproduzir prévia"}
                  </button>
                  {(phase === "playing" || phase === "paused" || phase === "pause") && (
                    <button type="button" className="shadowing-stop" onClick={stopPreview}>
                      <X aria-hidden="true" /> Parar
                    </button>
                  )}
                  <span className="shadowing-preview-indicator" role="status">
                    {previewLabel}
                    {previewIndex >= 0
                      ? ` · Bloco ${previewIndex + 1}/${active.blocks.length}`
                      : ""}
                  </span>
                </div>
                <div className="shadowing-action-group">
                  <button
                    type="button"
                    onClick={undoLast}
                    disabled={isBusy || !historyCount}
                    title={
                      historyCount
                        ? `Desfazer última edição (${historyCount} disponível)`
                        : "Nenhuma edição para desfazer"
                    }
                  >
                    <Undo2 aria-hidden="true" /> Desfazer
                  </button>
                  <span
                    className="shadowing-disabled-hint"
                    tabIndex={
                      active.status === "approved" ||
                      !active.blocks.length ||
                      isBusy ||
                      missingSpeakers ||
                      phase !== "finished"
                        ? 0
                        : -1
                    }
                    title={
                      active.status === "approved"
                        ? "Esta cena já foi aprovada"
                        : !active.blocks.length
                          ? "Adicione ao menos uma prática"
                          : isBusy
                            ? "Aguarde a operação em andamento"
                            : missingSpeakers
                              ? "Há práticas sem personagem identificado"
                              : phase !== "finished"
                                ? "Reproduza a prévia completa antes de aprovar"
                                : "Aprovar plano revisado"
                    }
                  >
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => approval.mutate(active)}
                      disabled={active.status === "approved" || isBusy || !activeReady}
                    >
                      <Check aria-hidden="true" />
                      {active.status === "approved" ? "Shadowing aprovado" : "Aprovar Shadowing"}
                    </button>
                  </span>
                </div>
              </div>
            </div>
            <div className="shadowing-content-column">
              <section
                id="shadowing-ai"
                className="shadowing-ai panel"
                aria-label="Preparação com IA"
              >
                <div>
                  <h2>Montar prática com IA</h2>
                  <p>Trechos curtos por personagem, preservando os textos aprovados.</p>
                </div>
                {active.origin === "automatic" && active.blocks.length === 0 && (
                  <p className="shadowing-empty">
                    Sem proposta gerada. Gere uma proposta com IA ou importe um arquivo .json.
                  </p>
                )}
                <div className="shadowing-ai-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={isBusy}
                    onClick={() => {
                      if (generatingGuard.current) return;
                      generatingGuard.current = true;
                      stopPreview();
                      groq.mutate(active);
                    }}
                  >
                    <Sparkles aria-hidden="true" />
                    {groq.isPending ? "Gerando proposta…" : "Gerar proposta com IA"}
                  </button>
                  <div className="shadowing-extra-tools">
                    <button
                      type="button"
                      className="secondary-button"
                      aria-expanded={toolsOpen}
                      aria-controls="shadowing-external-tools"
                      onClick={() => setToolsOpen((value) => !value)}
                    >
                      <MoreHorizontal aria-hidden="true" /> Outras opções
                    </button>
                    {toolsOpen && (
                      <div id="shadowing-external-tools" className="shadowing-extra-menu">
                        <a
                          href={studioApi.shadowingPackageUrl(projectId, active.scene_id)}
                          download
                        >
                          <Download aria-hidden="true" /> Baixar pacote para IA externa
                        </a>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => fileRef.current?.click()}
                        >
                          <Plus aria-hidden="true" /> Importar proposta (.json)
                        </button>
                      </div>
                    )}
                    <input
                      ref={fileRef}
                      className="shadowing-file-input"
                      aria-label="Importar proposta (.json)"
                      type="file"
                      accept=".json,application/json"
                      disabled={isBusy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file || importGuard.current) return;
                        if (!file.name.toLowerCase().endsWith(".json")) {
                          showToast({ text: "Selecione um arquivo JSON (.json).", tone: "error" });
                          return;
                        }
                        importGuard.current = true;
                        setSelectedFileName(file.name);
                        setToolsOpen(false);
                        stopPreview();
                        importAi.mutate({ plan: active, file });
                      }}
                    />
                  </div>
                </div>
                {selectedFileName && (
                  <small className="shadowing-file-label">Arquivo: {selectedFileName}</small>
                )}
                {(importAi.isPending || groq.isPending) && (
                  <p className="shadowing-loading" role="status">
                    <span className="shadowing-spinner" aria-hidden="true" />
                    {groq.isPending
                      ? "Gerando proposta… isso pode levar alguns instantes"
                      : "Validando proposta importada…"}
                  </p>
                )}
              </section>

              <section
                id="shadowing-review"
                className="shadowing-review"
                aria-label="Revisar práticas"
              >
                <div className="shadowing-section-heading">
                  <h2>Práticas selecionadas</h2>
                  <p>
                    A IA propõe até 14 palavras. Na revisão manual, você pode juntar cues
                    consecutivos em até 24 palavras e 6,5 s. Quando ambos estiverem sem locutor, a
                    junção é uma decisão manual.
                  </p>
                </div>
                {active.blocks.length === 0 && (
                  <p className="panel">
                    Nenhuma prática selecionada. Use a IA ou adicione falas curtas da lista abaixo.
                  </p>
                )}
                <div className="shadowing-blocks">
                  {active.blocks.map((block, index) => {
                    const mergeReason = mergeBlockReason(index);
                    return (
                      <article
                        key={block.id}
                        id={`shadowing-block-${index}`}
                        tabIndex={0}
                        aria-label={`Prática ${index + 1}, ${block.speaker}`}
                        aria-current={selectedBlockIndex === index ? "true" : undefined}
                        onFocus={() => setSelectedBlockIndex(index)}
                        onClick={() => setSelectedBlockIndex(index)}
                        className={`panel shadowing-block ${selectedBlockIndex === index ? "is-selected" : ""}`}
                      >
                        <div className="shadowing-block-heading">
                          <strong>
                            Prática {index + 1} ·{" "}
                            {block.speaker === "Não identificado" || !block.speaker.trim() ? (
                              <button
                                type="button"
                                disabled
                                className="shadowing-assign-button"
                                title="Atribuição indisponível aqui. A API atual não permite editar o locutor no Shadowing."
                              >
                                Atribuir personagem
                              </button>
                            ) : (
                              block.speaker
                            )}
                          </strong>
                          <span
                            className={`shadowing-state ${
                              active.status === "approved"
                                ? "is-approved"
                                : block.speaker === "Não identificado" || !block.speaker.trim()
                                  ? "is-missing"
                                  : phase === "finished"
                                    ? "is-ready"
                                    : "is-review"
                            }`}
                          >
                            {active.status === "approved"
                              ? "Aprovada"
                              : block.speaker === "Não identificado" || !block.speaker.trim()
                                ? "Falta personagem"
                                : phase === "finished"
                                  ? "Pronta"
                                  : "Em revisão"}
                          </span>
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
                                  <span
                                    tabIndex={0}
                                    onFocus={() => setFocusedCueId(cueId)}
                                    onClick={() => setFocusedCueId(cueId)}
                                  >
                                    Cue {cue?.order}: {cue?.en}
                                  </span>
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
                          <span
                            className="shadowing-disabled-hint"
                            tabIndex={isBusy || Boolean(mergeReason) ? 0 : -1}
                            title={
                              isBusy
                                ? "Aguarde a operação atual"
                                : (mergeReason ?? "Juntar com a próxima prática")
                            }
                          >
                            <button
                              type="button"
                              disabled={isBusy || Boolean(mergeReason)}
                              onClick={() => mergeWithNext(index)}
                              aria-label="Juntar com próxima"
                            >
                              <Merge aria-hidden="true" /> Juntar com próxima
                            </button>
                          </span>
                          <button
                            type="button"
                            className="shadowing-destructive"
                            disabled={isBusy}
                            title={
                              isBusy
                                ? "Aguarde a operação atual"
                                : "Excluir desta prática. Você poderá desfazer."
                            }
                            onClick={() => omitBlock(index)}
                          >
                            <Trash2 aria-hidden="true" /> Excluir grupo
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section
                className="shadowing-excluded panel"
                id="shadowing-cues"
                aria-label="Cues não selecionados"
              >
                <div className="shadowing-section-heading">
                  <h2>Cues disponíveis</h2>
                  <p>Adicione somente as falas que deseja praticar. O Editorial não é alterado.</p>
                </div>
                <div className="shadowing-cue-filters">
                  <label className="shadowing-search">
                    <Search aria-hidden="true" />
                    <input
                      type="search"
                      placeholder="Buscar frase, tradução ou personagem"
                      aria-label="Buscar cues"
                      value={cueQuery}
                      onChange={(event) => setCueQuery(event.target.value)}
                    />
                  </label>
                  <label>
                    Duração
                    <select
                      aria-label="Filtrar duração"
                      value={durationFilter}
                      onChange={(event) => setDurationFilter(event.target.value)}
                    >
                      <option value="all">Todas</option>
                      <option value="short">Até 2 s</option>
                      <option value="medium">2–4 s</option>
                      <option value="long">Acima de 4 s</option>
                    </select>
                  </label>
                  <label>
                    Palavras
                    <select
                      aria-label="Filtrar palavras"
                      value={wordFilter}
                      onChange={(event) => setWordFilter(event.target.value)}
                    >
                      <option value="all">Todas</option>
                      <option value="short">Até 5</option>
                      <option value="long">Mais de 5</option>
                    </select>
                  </label>
                </div>
                <p className="shadowing-cue-count" role="status">
                  {filteredCues.length} de {active.excluded_cues.length} cues disponíveis
                </p>
                {active.excluded_cues.length === 0 && (
                  <p className="shadowing-empty">Todos os cues desta cena já estão em práticas.</p>
                )}
                {active.excluded_cues.length > 0 && filteredCues.length === 0 && (
                  <p className="shadowing-empty">Nenhum cue encontrado com esses filtros.</p>
                )}
                <div className="shadowing-excluded-list">
                  {filteredCues.map((cue) => {
                    const duration = (cue.end_ms - cue.start_ms) / 1000;
                    const words = cue.en.trim().split(/\\s+/).filter(Boolean).length;
                    return (
                      <div
                        className="shadowing-excluded-item"
                        key={cue.id}
                        tabIndex={0}
                        onFocus={() => setFocusedCueId(cue.id)}
                        onClick={() => setFocusedCueId(cue.id)}
                      >
                        <div>
                          <strong>
                            Cue {cue.order} ·{" "}
                            {cue.speaker === "Não identificado" || !cue.speaker.trim() ? (
                              <button
                                disabled
                                type="button"
                                className="shadowing-assign-button"
                                title="Atribuição indisponível neste item. A API atual não permite editar o locutor."
                              >
                                Atribuir personagem
                              </button>
                            ) : (
                              cue.speaker
                            )}
                          </strong>
                          <span className="shadowing-cue-chips">
                            <span>
                              {duration.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s
                            </span>
                            <span>
                              {words} {words === 1 ? "palavra" : "palavras"}
                            </span>
                          </span>
                          <p>{cue.en}</p>
                          <small>{cue.pt}</small>
                          {!cue.eligible && (
                            <small className="shadowing-ineligible">{cue.reason}</small>
                          )}
                        </div>
                        {cue.eligible ? (
                          <button type="button" disabled={isBusy} onClick={() => includeCue(cue)}>
                            <Plus aria-hidden="true" /> Adicionar
                          </button>
                        ) : (
                          <Link to={`/editorial?project=${projectId}`}>Ver no Editorial</Link>
                        )}
                      </div>
                    );
                  })}
                </div>
                <details
                  className="shadowing-used"
                  open={usedExpanded}
                  onToggle={(event) => setUsedExpanded(event.currentTarget.open)}
                >
                  <summary>Usados em outras práticas ({usedCues.length})</summary>
                  <div className="shadowing-excluded-list">
                    {usedCues.map((cue) => {
                      const owner = active.blocks.findIndex((block) =>
                        block.cue_ids.includes(cue.id),
                      );
                      return (
                        <div className="shadowing-excluded-item" key={cue.id}>
                          <div>
                            <strong>
                              Cue {cue.order} · {cue.speaker}
                            </strong>
                            <p>{cue.en}</p>
                            <small>Em prática {owner + 1}</small>
                          </div>
                          <button
                            type="button"
                            disabled={isBusy}
                            title="Retirar este cue da prática e devolvê-lo aos disponíveis"
                            onClick={() => removeUsedCue(cue.id)}
                          >
                            <Trash2 aria-hidden="true" /> Remover da prática
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </section>
            </div>
          </div>
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
      {toast && (
        <div
          className={`shadowing-toast is-${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <span>{toast.text}</span>
          {toast.undo && historyCount > 0 && (
            <button type="button" onClick={undoLast} disabled={isBusy}>
              <Undo2 aria-hidden="true" /> Desfazer
            </button>
          )}
          {toast.tone === "error" && (
            <button type="button" onClick={retryFailedAction} disabled={isBusy}>
              <RefreshCw aria-hidden="true" /> Tentar novamente
            </button>
          )}
          <button type="button" onClick={() => setToast(null)} aria-label="Fechar mensagem">
            <X aria-hidden="true" />
          </button>
        </div>
      )}
      {shortcutsOpen && (
        <div className="shadowing-dialog-backdrop" onClick={() => setShortcutsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Atalhos de teclado"
            className="shadowing-shortcuts panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shadowing-dialog-title">
              <h2>Atalhos de teclado</h2>
              <button
                type="button"
                autoFocus
                aria-label="Fechar atalhos"
                onClick={() => setShortcutsOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <dl>
              <dt>Espaço</dt>
              <dd>Reproduzir ou pausar</dd>
              <dt>J / K</dt>
              <dd>Selecionar próxima / anterior prática</dd>
              <dt>A</dt>
              <dd>Adicionar o cue focado</dd>
              <dt>Delete</dt>
              <dd>Excluir prática selecionada</dd>
              <dt>M</dt>
              <dd>Juntar com próxima prática, se permitido</dd>
              <dt>S</dt>
              <dd>Separar após o cue focado, se permitido</dd>
              <dt>Ctrl+Z / Cmd+Z</dt>
              <dd>Desfazer última edição</dd>
              <dt>?</dt>
              <dd>Abrir ou fechar esta ajuda</dd>
            </dl>
          </section>
        </div>
      )}
    </section>
  );
}

function formatTime(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)} s`;
}
