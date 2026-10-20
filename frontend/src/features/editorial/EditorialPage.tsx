import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Film,
  MonitorPlay,
  Merge,
  Split,
  Play,
  Save,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  EditorialAssistance,
  EditorialAssistantStatus,
  EditorialSemanticUnit,
  Project,
  ProjectMedia,
  Scene,
} from "../../lib/api.types";
import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import { CueWordTimeline, type TimelineCue } from "./CueWordTimeline";
import { EditorialHubPreview } from "./EditorialHubPreview";
import { nudgeTiming, setTimingEdge, validateTimeline } from "./timeline";
import "./timeline.css";
import "./editorial-workspace.css";

type StructureDraft =
  | {
      kind: "merge";
      count: number;
      startIndex: number;
      en: string;
      pt: string;
      speaker: string;
      confirmedSameSpeaker: boolean;
    }
  | {
      kind: "split";
      afterWordId: string;
      leftEn: string;
      rightEn: string;
      leftPt: string;
      rightPt: string;
      leftSpeaker: string;
      rightSpeaker: string;
    };

function cueWordText(words: TimelineCue["words"]): string {
  const literal = words.map((word) => word.surface).join("");
  return (literal.includes(" ") ? literal : words.map((word) => word.surface).join(" ")).trim();
}

type EditorialImportDropzoneProps = {
  disabled: boolean;
  onImport: (files: File[]) => void;
};

function EditorialImportDropzone({ disabled, onImport }: EditorialImportDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const receiveFiles = (files: FileList | null) => {
    if (!files || disabled || files.length === 0) return;
    onImport(Array.from(files));
  };

  return (
    <label
      className={`editorial-import-dropzone${dragging ? " is-dragging" : ""}`}
      aria-label="Importar retorno editorial"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !disabled) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        receiveFiles(event.dataTransfer.files);
      }}
    >
      <Upload aria-hidden="true" />
      <span>
        <strong>Arraste os JSONs ou um ZIP aqui</strong>
        <small>Selecione todos os blocos juntos para validar e importar em uma só etapa.</small>
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json,application/zip,.zip"
        multiple
        disabled={disabled}
        tabIndex={-1}
        onChange={(event) => {
          receiveFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </label>
  );
}

const formatTime = (timeMs: number) => {
  const seconds = Math.max(0, timeMs) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};

function semanticUnitsFromCue(cue: TimelineCue | undefined): EditorialSemanticUnit[] {
  if (!cue) return [];
  const groups = new Map<string, EditorialSemanticUnit>();
  for (const word of cue.words) {
    if (!word.semantic_group_id) continue;
    const unit = groups.get(word.semantic_group_id) ?? { word_ids: [], pt: "" };
    unit.word_ids.push(word.id);
    if (word.semantic_group_role === "lead") unit.pt = word.pt ?? "";
    groups.set(word.semantic_group_id, unit);
  }
  return [...groups.values()];
}

function cueNeedsEditorialTreatment(cue: TimelineCue): boolean {
  return (
    !cue.approved_en.trim() ||
    !cue.approved_pt.trim() ||
    cue.provenance?.editorial_preparation !== "complete" ||
    cue.words.some((word) => word.semantic_group_role !== "member" && !word.pt?.trim())
  );
}

function assistanceCoversPendingCues(
  assistance: EditorialAssistance | undefined,
  cues: TimelineCue[],
): boolean {
  const pending = cues.filter(cueNeedsEditorialTreatment);
  if (pending.length === 0) return true;
  if (!assistance) return false;
  return pending.every((cue) => {
    const suggestion = assistance.suggestions.find((item) => item.cue_id === cue.id);
    if (!suggestion?.approved_en.trim() || !suggestion.approved_pt.trim()) return false;
    return (
      suggestion.word_translations.length === cue.words.length &&
      suggestion.word_translations.every(
        (translation, index) =>
          translation.word_id === cue.words[index]?.id && Boolean(translation.pt.trim()),
      )
    );
  });
}

export function EditorialPage() {
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [media, setMedia] = useState<ProjectMedia | null>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const continuousPlayback = useRef(false);
  const playbackEnd = useRef<number | null>(null);
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneId, setSceneId] = useState("");
  const [message, setMessage] = useState("");
  const [cues, setCues] = useState<TimelineCue[]>([]);
  const [history, setHistory] = useState<TimelineCue[][]>([]);
  const [selectedCueId, setSelectedCueId] = useState("");
  const [selectedWordId, setSelectedWordId] = useState<string>();
  const [timelineFocusRequest, setTimelineFocusRequest] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [approvedEn, setApprovedEn] = useState("");
  const [approvedPt, setApprovedPt] = useState("");
  const [wordStart, setWordStart] = useState(0);
  const [wordEnd, setWordEnd] = useState(0);
  const [wordPt, setWordPt] = useState("");
  const [wordSurface, setWordSurface] = useState("");
  const [saving, setSaving] = useState(false);
  const [structureDraft, setStructureDraft] = useState<StructureDraft | null>(null);
  const [startingMedia, setStartingMedia] = useState(false);
  const [mediaReload, setMediaReload] = useState(0);
  const [assistantStatus, setAssistantStatus] = useState<EditorialAssistantStatus>();
  const [assistance, setAssistance] = useState<EditorialAssistance>();
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMessage, setAssistantMessage] = useState("");
  const [hubPreviewStartMs, setHubPreviewStartMs] = useState<number | null>(null);
  const [assistantFallbackRequired, setAssistantFallbackRequired] = useState(false);
  const [assistantStatusFailed, setAssistantStatusFailed] = useState(false);
  const [showPreparationTools, setShowPreparationTools] = useState(false);
  const [semanticDraftUnits, setSemanticDraftUnits] = useState<EditorialSemanticUnit[] | null>(
    null,
  );
  const author = "local-editor";

  const project = projects.find((item) => item.id === projectId);
  const selectedScene = scenes.find((item) => item.id === sceneId);
  const durationMs = selectedScene?.duration_ms ?? media?.duration_ms ?? 1;
  const matchingMedia = Boolean(
    media?.ingest_job_id && media.ingest_job_id === selectedScene?.provenance.ingest_job_id,
  );
  const selectedCueIndex = cues.findIndex((cue) => cue.id === selectedCueId);
  const selectedCue = cues[selectedCueIndex];
  const selectedWord = selectedCue?.words.find((item) => item.id === selectedWordId);
  const selectedGroupWords = selectedWord?.semantic_group_id
    ? (selectedCue?.words.filter(
        (item) => item.semantic_group_id === selectedWord.semantic_group_id,
      ) ?? [])
    : selectedWord
      ? [selectedWord]
      : [];
  const selectedUnitLabel = selectedGroupWords.map((item) => item.surface).join(" ");
  const selectedGroupStartIndex = selectedCue
    ? selectedCue.words.indexOf(selectedGroupWords[0] ?? selectedWord!)
    : -1;
  const selectedGroupEndIndex = selectedCue
    ? selectedCue.words.indexOf(selectedGroupWords.at(-1) ?? selectedWord!)
    : -1;
  const storedWordPt =
    selectedGroupWords.find((item) => item.semantic_group_role === "lead")?.pt ??
    selectedWord?.pt ??
    "";
  const selectedSuggestion = assistance?.suggestions.find((item) => item.cue_id === selectedCueId);
  const pendingTreatmentCount = cues.filter(cueNeedsEditorialTreatment).length;
  const assistanceComplete = assistanceCoversPendingCues(assistance, cues);
  const editorialGateReady = pendingTreatmentCount === 0 || assistanceComplete;
  const storedSemanticUnits = semanticUnitsFromCue(selectedCue);
  const visibleSemanticUnits = semanticDraftUnits ?? storedSemanticUnits;
  const semanticUnitsDirty = Boolean(
    semanticDraftUnits &&
    JSON.stringify(semanticDraftUnits) !== JSON.stringify(storedSemanticUnits),
  );
  const approvedCount = cues.filter((cue) => cue.provenance?.approval === "approved").length;
  const allCuesApproved = cues.length > 0 && approvedCount === cues.length;
  const textDirty = Boolean(
    selectedCue &&
    (approvedEn !== selectedCue.approved_en || approvedPt !== selectedCue.approved_pt),
  );
  const wordDirty = Boolean(
    selectedWord && (wordStart !== selectedWord.start_ms || wordEnd !== selectedWord.end_ms),
  );
  const wordTranslationDirty = Boolean(selectedWord && wordPt !== storedWordPt);
  const wordSurfaceDirty = Boolean(selectedWord && wordSurface !== selectedWord.surface.trim());
  const selectedWordIndex =
    selectedCue?.words.findIndex((word) => word.id === selectedWordId) ?? -1;
  const previewCues = selectedWord
    ? cues.map((cue) =>
        cue.id === selectedCue.id
          ? {
              ...cue,
              words: cue.words.map((word, index) => ({
                ...word,
                surface:
                  index === selectedWordIndex && wordSurfaceDirty
                    ? (word.surface.match(/^\s*/)?.[0] ?? "") + wordSurface.trim()
                    : word.surface,
                start_ms: index === selectedWordIndex ? wordStart : word.start_ms,
                end_ms: index === selectedWordIndex ? wordEnd : word.end_ms,
              })),
            }
          : cue,
      )
    : cues;
  const hubPreviewCues = previewCues.map((cue) =>
    cue.id === selectedCue?.id
      ? {
          ...cue,
          approved_en:
            wordSurfaceDirty && !textDirty
              ? cue.words.map((word) => word.surface).join("") +
                String(cue.provenance?.editorial_preparation_trailing ?? "")
              : approvedEn,
          approved_pt: approvedPt,
        }
      : cue,
  );
  const timingDirty = history.length > 0;
  const isDirty =
    textDirty || wordDirty || wordTranslationDirty || wordSurfaceDirty || semanticUnitsDirty || timingDirty;
  const cueStatus = selectedCue?.provenance?.approval === "approved" ? "Aprovado" : "Pendente";

  useEffect(() => {
    void studioApi
      .projects()
      .then(setProjects)
      .catch((error: Error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    void studioApi
      .editorialAssistantStatus()
      .then((status) => {
        setAssistantStatus(status);
        setAssistantStatusFailed(false);
      })
      .catch(() => {
        setAssistantStatusFailed(true);
      });
  }, []);
  useEffect(() => {
    setScenes([]);
    setSceneId("");
    setCues([]);
    setSelectedCueId("");
    setMedia(null);
    if (!projectId) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    async function loadReview() {
      try {
        const currentMedia = await studioApi.projectMedia(projectId);
        if (cancelled) return;
        setMedia(currentMedia);
        if (!currentMedia.can_review) {
          setMessage("");
          if (currentMedia.state === "source_processing" || currentMedia.state === "asr_processing")
            refreshTimer = setTimeout(() => void loadReview(), 2000);
          return;
        }
        const context = await studioApi.openEditorialReview(projectId);
        if (cancelled) return;
        setScenes([context.scene]);
        setSceneId(context.scene.id);
        setMessage("");
      } catch {
        if (!cancelled)
          setMessage("Não foi possível carregar a etapa atual. Tente novamente ou abra Mídia.");
      }
    }
    void loadReview();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [projectId, mediaReload]);
  useEffect(() => {
    setCues([]);
    setSelectedCueId("");
    setHistory([]);
    setAssistance(undefined);
    setAssistantMessage("");
    setAssistantFallbackRequired(false);
    if (!sceneId) return;
    let cancelled = false;
    void studioApi
      .editorialCues(sceneId)
      .then((items) => {
        if (cancelled) return;
        setCues(items);
        setSelectedCueId(items[0]?.id ?? "");
        setPlayheadMs(items[0]?.speech_timing.start_ms ?? 0);
      })
      .catch((error: Error) => {
        if (!cancelled) setMessage(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sceneId]);
  useEffect(() => {
    setApprovedEn(selectedCue?.approved_en ?? "");
    setApprovedPt(selectedCue?.approved_pt ?? "");
  }, [selectedCue?.id, selectedCue?.approved_en, selectedCue?.approved_pt]);
  useEffect(() => {
    if (!selectedCue || !selectedSuggestion || !assistanceComplete) return;
    setApprovedEn(selectedCue.approved_en || selectedSuggestion.approved_en);
    setApprovedPt(selectedCue.approved_pt || selectedSuggestion.approved_pt);
  }, [assistanceComplete, selectedCue, selectedSuggestion]);
  useEffect(() => {
    setSemanticDraftUnits(null);
  }, [selectedCue?.id, selectedCue?.revision]);
  useEffect(() => {
    setStructureDraft(null);
  }, [selectedCue?.id, selectedCue?.revision, sceneId]);
  useEffect(() => {
    setWordStart(selectedWord?.start_ms ?? 0);
    setWordEnd(selectedWord?.end_ms ?? 0);
    setWordPt(storedWordPt);
    setWordSurface(selectedWord?.surface.trim() ?? "");
  }, [selectedWord, storedWordPt]);

  const refreshCues = useCallback(async (): Promise<TimelineCue[]> => {
    if (!sceneId) return [];
    const refreshed = await studioApi.editorialCues(sceneId);
    setCues(refreshed);
    setHistory([]);
    return refreshed;
  }, [sceneId]);
  const startEditorialAssistance = useCallback(async () => {
    if (!sceneId || assistantBusy) return;
    setAssistantBusy(true);
    setAssistantMessage("Groq: preparando as sugestões da cena…");
    try {
      const started = await studioApi.startEditorialAssistance(sceneId);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const job = await studioApi.job(started.job_id);
        if (job.status === "succeeded") {
          const output = job.output as EditorialAssistance | null;
          if (!output || !Array.isArray(output.suggestions))
            throw new Error("A Groq terminou sem devolver sugestões válidas.");
          if (!assistanceCoversPendingCues(output, cues))
            throw new Error("A Groq não preencheu todos os textos em inglês e português da cena.");
          setAssistance(output);
          await refreshCues();
          setAssistantFallbackRequired(false);
          setAssistantMessage(
            `${output.suggestions.length} cues tratados. A revisão editorial está liberada.`,
          );
          return;
        }
        if (job.status === "failed" || job.status === "cancelled")
          throw new Error(job.error_message || "A Groq não concluiu o processamento.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("A Groq ainda não concluiu. Consulte Jobs ou use a IA externa.");
    } catch (error) {
      setAssistantFallbackRequired(true);
      setAssistantMessage(
        `${error instanceof Error ? error.message : "Falha na Groq."} Exporte o pacote e importe o retorno da IA externa.`,
      );
    } finally {
      setAssistantBusy(false);
    }
  }, [assistantBusy, cues, refreshCues, sceneId]);
  async function importExternalResult(files: File[]) {
    if (!sceneId || assistantBusy) return;
    setAssistantBusy(true);
    setAssistantMessage(`Validando ${files.length} arquivo(s) da IA externa…`);
    try {
      const result =
        files.length === 1 && files[0].name.toLowerCase().endsWith(".json")
          ? await studioApi.importExternalEditorialResult(sceneId, files[0])
          : await studioApi.importExternalEditorialResults(sceneId, files);
      setAssistance(result);
      const refreshed = await refreshCues();
      const remaining = refreshed.filter(cueNeedsEditorialTreatment).length;
      setAssistantFallbackRequired(remaining > 0);
      setAssistantMessage(
        remaining > 0
          ? `${result.suggestions.length} cues processadas. Restam ${remaining}; envie os blocos que faltam.`
          : "Todos os blocos foram validados. A revisão editorial está liberada.",
      );
    } catch (error) {
      setAssistantMessage(
        error instanceof Error ? error.message : "O retorno externo não passou na validação.",
      );
    } finally {
      setAssistantBusy(false);
    }
  }
  useEffect(() => {
    if (!sceneId || cues.length === 0 || pendingTreatmentCount === 0 || !assistantStatus) return;
    setAssistantFallbackRequired(true);
    setAssistantMessage(
      assistantStatus.groq_configured
        ? "Escolha Groq para processar a cena aqui ou use uma IA externa em blocos de texto."
        : "Groq não está configurada. Use uma IA externa em blocos de texto.",
    );
  }, [assistantStatus, cues.length, pendingTreatmentCount, sceneId]);
  function seek(timeMs: number) {
    const bounded = Math.max(0, Math.min(timeMs, durationMs));
    setPlayheadMs(bounded);
    if (mediaRef.current) mediaRef.current.currentTime = bounded / 1000;
  }
  function selectCue(id: string) {
    if (saving) return;
    if (id === selectedCueId) {
      setTimelineFocusRequest((value) => value + 1);
      return;
    }
    if (id !== selectedCueId && isDirty) {
      setMessage("Salve ou desfaça as alterações antes de trocar de cue.");
      return;
    }
    mediaRef.current?.pause();
    playbackEnd.current = null;
    setSelectedCueId(id);
    setSelectedWordId(undefined);
    setTimelineFocusRequest((value) => value + 1);
    const cue = cues.find((item) => item.id === id);
    if (cue) seek(cue.speech_timing.start_ms);
  }
  function selectWord(id: string) {
    if (saving || id === selectedWordId) return;
    if (wordDirty || wordTranslationDirty || wordSurfaceDirty) {
      setMessage("Salve ou descarte a edição da palavra antes de selecionar outra.");
      return;
    }
    const word = selectedCue?.words.find((item) => item.id === id);
    if (word) {
      setSelectedWordId(id);
      seek(word.start_ms);
      const group = word.semantic_group_id
        ? (selectedCue?.words.filter((item) => item.semantic_group_id === word.semantic_group_id) ??
          [])
        : [word];
      setMessage(
        `Editando “${group.map((item) => item.surface).join(" ")}”. Espaço ouve somente esta unidade.`,
      );
    }
  }
  function moveWord(offset: number) {
    if (!selectedCue || wordDirty || wordTranslationDirty || wordSurfaceDirty) {
      if (wordDirty || wordTranslationDirty)
        setMessage("Salve ou descarte o ajuste antes de trocar de palavra.");
      return;
    }
    const next = selectedCue.words[selectedWordIndex + offset];
    if (next) selectWord(next.id);
  }
  function leaveWordMode() {
    if (wordDirty || wordTranslationDirty) {
      setMessage("Salve ou descarte o ajuste da palavra antes de voltar ao cue.");
      return;
    }
    setSelectedWordId(undefined);
    if (selectedCue) seek(selectedCue.speech_timing.start_ms);
    setMessage("");
  }
  function discardChanges() {
    if (saving) return;
    const original = history[0]?.find((cue) => cue.id === selectedCueId) ?? selectedCue;
    if (history[0]) setCues(history[0]);
    setHistory([]);
    setApprovedEn(original?.approved_en ?? "");
    setApprovedPt(original?.approved_pt ?? "");
    const word = original?.words.find((item) => item.id === selectedWordId);
    setWordStart(word?.start_ms ?? 0);
    setWordEnd(word?.end_ms ?? 0);
    const originalGroup = word?.semantic_group_id
      ? (original?.words.filter((item) => item.semantic_group_id === word.semantic_group_id) ?? [])
      : word
        ? [word]
        : [];
    setWordPt(
      originalGroup.find((item) => item.semantic_group_role === "lead")?.pt ?? word?.pt ?? "",
    );
    setWordSurface(word?.surface.trim() ?? "");
    setSemanticDraftUnits(null);
    setMessage("Alterações locais descartadas.");
  }
  function playRange(start: number, end: number) {
    const player = mediaRef.current;
    if (!player || end <= start) return;
    continuousPlayback.current = false;
    seek(start);
    playbackEnd.current = end;
    void player.play().catch(() => setMessage("Não foi possível reproduzir o corte."));
  }
  function syncPlayback(player: HTMLVideoElement) {
    if (playbackEnd.current !== null && player.currentTime * 1000 >= playbackEnd.current) {
      const end = playbackEnd.current;
      playbackEnd.current = null;
      player.pause();
      player.currentTime = end / 1000;
    }
    setPlayheadMs(player.currentTime * 1000);
  }
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const tick = () => {
      if (mediaRef.current) syncPlayback(mediaRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Enter" &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.repeat
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openHubPreview(event.shiftKey);
        return;
      }
      if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (isDirty) void saveChanges();
        return;
      }
      const target = event.target;
      if (
        event.key === "Enter" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.repeat &&
        selectedWord &&
        !saving &&
        !(target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
        void saveChanges(false, true);
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        moveCue(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  function openHubPreview(fromStart = false) {
    if (!selectedCue || !matchingMedia || !media?.cut_url) {
      setMessage("A prévia do iHub será liberada quando o corte da cena estiver disponível.");
      return;
    }
    mediaRef.current?.pause();
    playbackEnd.current = null;
    setHubPreviewStartMs(fromStart ? 0 : selectedCue.speech_timing.start_ms);
  }
  function replaceCues(next: TimelineCue[]) {
    setHistory((value) => [...value, cues]);
    setCues(next);
  }
  function beginEdgeDrag() {
    if (!selectedWord && selectedCue && history.length === 0) setHistory([cues]);
  }
  function nudge(edge: "start" | "end", deltaMs: number) {
    if (!selectedCue || saving) return;
    if (selectedWord) {
      const prior = selectedCue.words[selectedWordIndex - 1];
      const next = selectedCue.words[selectedWordIndex + 1];
      if (edge === "start") {
        const minimum = Math.max(selectedCue.speech_timing.start_ms, prior?.end_ms ?? 0);
        setWordStart(Math.max(minimum, Math.min(wordStart + deltaMs, wordEnd - 1)));
      } else {
        const maximum = Math.min(selectedCue.speech_timing.end_ms, next?.start_ms ?? durationMs);
        setWordEnd(Math.min(maximum, Math.max(wordEnd + deltaMs, wordStart + 1)));
      }
      return;
    }
    replaceCues(
      cues.map((cue) =>
        cue.id !== selectedCue.id
          ? cue
          : { ...cue, speech_timing: nudgeTiming(cue.speech_timing, edge, deltaMs, durationMs) },
      ),
    );
  }
  function setActiveEdgeAt(edge: "start" | "end", timeMs: number, recordHistory: boolean) {
    if (!selectedCue || saving) return;
    if (selectedWord) {
      const prior = selectedCue.words[selectedWordIndex - 1];
      const next = selectedCue.words[selectedWordIndex + 1];
      if (edge === "start") {
        const minimum = Math.max(selectedCue.speech_timing.start_ms, prior?.end_ms ?? 0);
        setWordStart(Math.max(minimum, Math.min(Math.round(timeMs), wordEnd - 1)));
      } else {
        const maximum = Math.min(selectedCue.speech_timing.end_ms, next?.start_ms ?? durationMs);
        setWordEnd(Math.min(maximum, Math.max(Math.round(timeMs), wordStart + 1)));
      }
      setMessage(
        `${edge === "start" ? "IN" : "OUT"} da palavra “${selectedWord.surface}” marcado em ${formatTime(timeMs)}.`,
      );
      return;
    }
    const next = cues.map((cue) =>
      cue.id !== selectedCue.id
        ? cue
        : {
            ...cue,
            speech_timing: setTimingEdge(cue.speech_timing, edge, timeMs, durationMs),
          },
    );
    if (recordHistory) replaceCues(next);
    else setCues(next);
    setMessage(`${edge === "start" ? "Início" : "Fim"} do cue marcado em ${formatTime(timeMs)}.`);
  }
  function markActiveEdge(edge: "start" | "end") {
    setActiveEdgeAt(edge, playheadMs, true);
  }
  function undo() {
    if (wordDirty && selectedWord) {
      setWordStart(selectedWord.start_ms);
      setWordEnd(selectedWord.end_ms);
      setMessage("Ajuste da palavra desfeito.");
      return;
    }
    const prior = history.at(-1);
    if (!prior) return;
    setCues(prior);
    setHistory((value) => value.slice(0, -1));
  }
  function togglePlayback() {
    const player = mediaRef.current;
    if (!player || !selectedCue) return;
    if (player.paused)
      playRange(
        selectedWord ? wordStart : selectedCue.speech_timing.start_ms,
        selectedWord ? wordEnd : selectedCue.speech_timing.end_ms,
      );
    else {
      playbackEnd.current = null;
      player.pause();
    }
  }
  function toggleContinuousPlayback() {
    const player = mediaRef.current;
    if (!player) return;
    playbackEnd.current = null;
    if (player.paused) {
      continuousPlayback.current = true;
      void player.play().catch(() => setMessage("Não foi possível reproduzir a cena."));
    } else {
      continuousPlayback.current = false;
      player.pause();
    }
  }

  function playSelectedCueFromPlayer(player: HTMLVideoElement) {
    if (continuousPlayback.current || !selectedCue) return;
    const start = selectedCue.speech_timing.start_ms;
    const end = selectedCue.speech_timing.end_ms;
    if (player.currentTime * 1000 < start || player.currentTime * 1000 >= end)
      player.currentTime = start / 1000;
    playbackEnd.current = end;
  }
  async function fitCueToWords() {
    if (!selectedCue || saving || isDirty) {
      setMessage("Salve ou descarte as edições antes de ajustar os tempos.");
      return;
    }
    setSaving(true);
    try {
      await studioApi.fitCueToWords(selectedCue.id, author);
      await refreshCues();
      setMessage("Limites da cue ajustados às palavras. Confira e aprove novamente.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível ajustar a cue.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmWordTranslation() {
    if (!selectedCue || !selectedWord || saving || !wordPt.trim() || wordSurfaceDirty) {
      setMessage("Salve a correção da palavra antes de confirmar sua tradução.");
      return;
    }
    setSaving(true);
    try {
      await studioApi.updateWordTranslation(
        selectedCue.id,
        selectedWord.id,
        wordPt,
        author,
      );
      await refreshCues();
      setMessage("Tradução revisada. Agora você pode aprovar a cue.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível revisar a tradução.");
    } finally {
      setSaving(false);
    }
  }

  async function saveChanges(approve = false, advance = false) {
    if (!selectedCue || saving) return;
    if (wordSurfaceDirty && textDirty) {
      setMessage("Salve a correção da palavra e a edição do texto em etapas separadas.");
      return;
    }
    if (approve && (!approvedEn || !approvedPt)) {
      setMessage("Preencha os textos em inglês e português antes de aprovar o cue.");
      return;
    }
    const candidate = previewCues.find((cue) => cue.id === selectedCue.id) ?? selectedCue;
    const errors = validateTimeline([candidate]);
    if (
      candidate.words.some(
        (word) => !Number.isInteger(word.start_ms) || !Number.isInteger(word.end_ms),
      )
    )
      errors.push("Use milissegundos inteiros nos tempos da palavra.");
    if (errors.length) {
      setMessage(errors[0]);
      return;
    }
    setSaving(true);
    try {
      let correctedEnglish = approvedEn;
      if (wordSurfaceDirty && selectedWord) {
        const corrected = await studioApi.updateWordSurface(
          selectedCue.id, selectedWord.id, wordSurface, author,
        );
        correctedEnglish = corrected.approved_en;
        setApprovedEn(correctedEnglish);
      }
      const originalCue = history[0]?.find((cue) => cue.id === selectedCue.id) ?? selectedCue;
      const expandedCue =
        candidate.speech_timing.end_ms - candidate.speech_timing.start_ms >
        originalCue.speech_timing.end_ms - originalCue.speech_timing.start_ms;
      if (semanticUnitsDirty && semanticDraftUnits)
        await studioApi.replaceSemanticUnits(
          selectedCue.id,
          selectedCue.revision,
          semanticDraftUnits,
          author,
        );
      if (timingDirty)
        await studioApi.updateCueTiming(selectedCue.id, {
          author,
          speech_timing: selectedCue.speech_timing,
          subtitle_timing: selectedCue.subtitle_timing,
        });
      if (wordDirty && selectedWord)
        await studioApi.updateWordTiming(selectedCue.id, {
          author,
          timings: selectedCue.words.map((item, index) => ({
            id: item.id,
            start_ms: index === selectedWordIndex ? wordStart : item.start_ms,
            end_ms: index === selectedWordIndex ? wordEnd : item.end_ms,
          })),
        });
      if (wordTranslationDirty && selectedWord)
        await studioApi.updateWordTranslation(selectedCue.id, selectedWord.id, wordPt, author);
      if (textDirty || approve)
        await studioApi.updateCueText(selectedCue.id, {
          author,
          approved_en: correctedEnglish,
          approved_pt: approvedPt,
          approve,
        });
      const nextWord =
        advance && selectedWord && !approve
          ? selectedCue.words[selectedGroupEndIndex + 1]
          : undefined;
      const nextCueForWord =
        advance && selectedWord && !approve && !nextWord ? cues[selectedCueIndex + 1] : undefined;
      const refreshed = await refreshCues();
      const currentIndex = refreshed.findIndex((cue) => cue.id === selectedCue.id);
      let nextCue = advance && (!selectedWord || approve) ? refreshed[currentIndex + 1] : undefined;
      if (nextCue && expandedCue) {
        await studioApi.realignCue(nextCue.id, candidate.speech_timing.end_ms + 10, author);
        const realigned = await refreshCues();
        nextCue = realigned.find((cue) => cue.id === nextCue?.id);
      }
      if (nextWord) {
        setSelectedWordId(nextWord.id);
        seek(nextWord.start_ms);
      } else if (nextCueForWord) {
        const freshCue = refreshed.find((cue) => cue.id === nextCueForWord.id);
        const firstWord = freshCue?.words[0];
        if (freshCue && firstWord) {
          setSelectedCueId(freshCue.id);
          setSelectedWordId(firstWord.id);
          seek(firstWord.start_ms);
        }
      } else if (nextCue) {
        setSelectedCueId(nextCue.id);
        setSelectedWordId(undefined);
        seek(nextCue.speech_timing.start_ms);
      }
      setMessage(
        approve
          ? `Cue ${selectedCue.order} aprovado.`
          : advance && selectedWord && (nextWord || nextCueForWord)
            ? `Palavra “${selectedWord.surface}” salva. Próxima palavra aberta.`
            : nextCue
              ? `Cue ${selectedCue.order} salva. Próxima cue aberta.`
              : "Alterações salvas.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar revisão.");
    } finally {
      setSaving(false);
    }
  }
  async function groupSelectedWord(direction: "previous" | "next") {
    if (!selectedCue || !selectedWord || saving) return;
    if (semanticUnitsDirty) {
      setMessage("Salve ou descarte as unidades sugeridas antes de agrupar manualmente.");
      return;
    }
    if (!wordPt.trim()) {
      setMessage("Digite a tradução natural do grupo antes de agrupar.");
      return;
    }
    setSaving(true);
    try {
      await studioApi.groupWordTranslation(
        selectedCue.id,
        selectedWord.id,
        direction,
        wordPt,
        author,
      );
      await refreshCues();
      setMessage("Unidade semântica agrupada. Os tempos individuais foram preservados.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível agrupar as palavras.");
    } finally {
      setSaving(false);
    }
  }
  async function ungroupSelectedWord() {
    if (!selectedCue || !selectedWord || saving) return;
    if (semanticUnitsDirty) {
      setMessage("Salve ou descarte as unidades sugeridas antes de desfazer grupos.");
      return;
    }
    setSaving(true);
    try {
      await studioApi.ungroupWordTranslation(selectedCue.id, selectedWord.id, author);
      await refreshCues();
      setMessage("Grupo desfeito. Revise as traduções individuais.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível desfazer o grupo.");
    } finally {
      setSaving(false);
    }
  }
  function applySuggestedSemanticUnit(unit: EditorialSemanticUnit) {
    if (!selectedCue || saving) return;
    const positions = unit.word_ids.map((wordId) =>
      selectedCue.words.findIndex((word) => word.id === wordId),
    );
    if (
      positions.some((position) => position < 0) ||
      positions.some((position, index) => position !== positions[0] + index)
    ) {
      setMessage("A unidade sugerida não corresponde mais às palavras atuais deste cue.");
      return;
    }
    const ids = new Set(unit.word_ids);
    const remaining = visibleSemanticUnits.filter(
      (current) => !current.word_ids.some((wordId) => ids.has(wordId)),
    );
    setSemanticDraftUnits(
      [...remaining, unit].sort((left, right) => {
        const leftIndex = selectedCue.words.findIndex((word) => word.id === left.word_ids[0]);
        const rightIndex = selectedCue.words.findIndex((word) => word.id === right.word_ids[0]);
        return leftIndex - rightIndex;
      }),
    );
    setMessage("Unidade aplicada ao rascunho. Salve para persistir; a cue não foi aprovada.");
  }
  function suggestedUnitLabel(unit: EditorialSemanticUnit) {
    if (!selectedCue) return "";
    return unit.word_ids
      .map((wordId) => selectedCue.words.find((word) => word.id === wordId)?.surface ?? "?")
      .join(" ");
  }
  function playSuggestedUnit(unit: EditorialSemanticUnit) {
    if (!selectedCue) return;
    const words = unit.word_ids
      .map((wordId) => selectedCue.words.find((word) => word.id === wordId))
      .filter((word) => word !== undefined);
    if (words.length === unit.word_ids.length)
      playRange(words[0].start_ms, words.at(-1)?.end_ms ?? words[0].end_ms);
  }
  function beginMerge(direction: "previous" | "next") {
    const startIndex = selectedCueIndex - (direction === "previous" ? 1 : 0);
    if (!selectedCue || saving || isDirty || startIndex < 0 || startIndex + 1 >= cues.length)
      return;
    const parts = cues.slice(startIndex, startIndex + 2);
    setStructureDraft({
      kind: "merge",
      count: 2,
      startIndex,
      speaker: parts.find((cue) => cue.speaker.trim())?.speaker ?? "",
      confirmedSameSpeaker: false,
      en: parts.map((cue) => cue.approved_en || cue.original_en).join(" ").trim(),
      pt: parts.map((cue) => cue.approved_pt).join(" ").trim(),
    });
  }
  function changeMergeCount(count: number) {
    if (structureDraft?.kind !== "merge") return;
    const startIndex = structureDraft.startIndex;
    const parts = cues.slice(startIndex, startIndex + count);
    setStructureDraft({
      kind: "merge",
      count,
      startIndex,
      speaker: parts.find((cue) => cue.speaker.trim())?.speaker ?? "",
      confirmedSameSpeaker: false,
      en: parts.map((cue) => cue.approved_en || cue.original_en).join(" ").trim(),
      pt: parts.map((cue) => cue.approved_pt).join(" ").trim(),
    });
  }
  function changeSplitBoundary(afterWordId: string) {
    if (!selectedCue) return;
    const index = selectedCue.words.findIndex((word) => word.id === afterWordId);
    if (index < 0 || index >= selectedCue.words.length - 1) return;
    setStructureDraft({
      kind: "split",
      afterWordId,
      leftEn: cueWordText(selectedCue.words.slice(0, index + 1)),
      rightEn: cueWordText(selectedCue.words.slice(index + 1)),
      leftPt: "",
      rightPt: "",
      leftSpeaker: selectedCue.speaker,
      rightSpeaker: selectedCue.speaker,
    });
  }
  async function applyStructure() {
    if (!selectedCue || !structureDraft || isDirty || saving) return;
    setSaving(true);
    try {
      let focusId: string;
      if (structureDraft.kind === "merge") {
        const selected = cues.slice(
          structureDraft.startIndex,
          structureDraft.startIndex + structureDraft.count,
        );
        if (selected.length !== structureDraft.count) throw new Error("Seleção inválida.");
        const knownSpeakers = new Set(
          selected.map((cue) => cue.speaker.trim().toLowerCase()).filter(Boolean),
        );
        if (knownSpeakers.size > 1 && !structureDraft.confirmedSameSpeaker) {
          throw new Error(
            "As cues têm interlocutores diferentes. Confirme que são a mesma voz antes de unir.",
          );
        }
        if (!structureDraft.en.trim() || !structureDraft.pt.trim())
          throw new Error("Preencha o inglês e o português da cue unificada.");
        const merged = await studioApi.mergeEditorialCues(
          selected.map((cue) => cue.id),
          {
            author,
            speaker: structureDraft.speaker,
            confirm_same_speaker: structureDraft.confirmedSameSpeaker,
            text: {
              original_en: selected.map((cue) => cue.original_en).join(" "),
              approved_en: structureDraft.en,
              approved_pt: structureDraft.pt,
            },
          },
        );
        focusId = merged.id;
      } else {
        if (
          !structureDraft.leftEn.trim() ||
          !structureDraft.rightEn.trim() ||
          !structureDraft.leftPt.trim() ||
          !structureDraft.rightPt.trim()
        ) {
          throw new Error("Preencha inglês e português das duas partes antes de dividir.");
        }
        const parts = await studioApi.splitEditorialCue(selectedCue.id, {
          author,
          after_word_id: structureDraft.afterWordId,
          first: {
            original_en: structureDraft.leftEn,
            approved_en: structureDraft.leftEn,
            approved_pt: structureDraft.leftPt,
          },
          second: {
            original_en: structureDraft.rightEn,
            approved_en: structureDraft.rightEn,
            approved_pt: structureDraft.rightPt,
          },
          first_speaker: structureDraft.leftSpeaker,
          second_speaker: structureDraft.rightSpeaker,
        });
        focusId = parts[0].id;
      }
      const action = structureDraft.kind === "merge" ? "unificadas" : "dividida";
      const refreshed = await refreshCues();
      setSelectedCueId(focusId);
      setSelectedWordId(undefined);
      setStructureDraft(null);
      setAssistance(undefined);
      const focused = refreshed.find((cue) => cue.id === focusId);
      if (focused) seek(focused.speech_timing.start_ms);
      setMessage(
        `Cues ${action} com sucesso. Revise o resultado e aprove novamente antes de gerar os materiais.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível alterar as cues.");
    } finally {
      setSaving(false);
    }
  }

  function moveCue(offset: number) {
    const next = cues[selectedCueIndex + offset];
    if (next) selectCue(next.id);
  }
  async function startMediaProcessing() {
    if (!projectId || startingMedia) return;
    setStartingMedia(true);
    try {
      setMedia(await studioApi.startProjectMedia(projectId));
      setMessage("Processamento iniciado. Esta tela será atualizada automaticamente.");
      setMediaReload((value) => value + 1);
    } catch {
      setMessage("Não foi possível iniciar o processamento. Abra Mídia para ver os detalhes.");
    } finally {
      setStartingMedia(false);
    }
  }
  return (
    <section className="editorial-workstation">
      <PageHeader
        title="Revisão editorial"
        description="Ouça, compare e aprove cada cue sem perder o contexto do corte."
      />
      <header className="review-context" aria-label="Contexto da revisão">
        <label>
          <span>Projeto</span>
          <select
            value={projectId}
            onChange={(event) => {
              if (isDirty) setMessage("Salve ou desfaça as alterações antes de trocar de projeto.");
              else setProjectId(event.target.value);
            }}
          >
            <option value="">Selecione um projeto</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Cena</span>
          <select
            value={sceneId}
            onChange={(event) => {
              if (isDirty) setMessage("Salve ou desfaça as alterações antes de trocar de cena.");
              else setSceneId(event.target.value);
            }}
            disabled={!projectId || scenes.length === 0}
          >
            {scenes.length === 0 && <option value="">Nenhuma cena disponível</option>}
            {scenes.map((item) => (
              <option key={item.id} value={item.id}>
                Cena {item.order}
              </option>
            ))}
          </select>
        </label>
        <div
          className="review-progress"
          aria-label={`${approvedCount} de ${cues.length} cues aprovados`}
        >
          <span>{project?.title ?? "Escolha a produção"}</span>
          <strong>
            {cues.length ? `${approvedCount} de ${cues.length} aprovados` : "Sem revisão ativa"}
          </strong>
          <progress max={Math.max(cues.length, 1)} value={approvedCount} />
          {cues.length > 0 && (
            <span className={`review-preparation ${editorialGateReady ? "ready" : "pending"}`}>
              {editorialGateReady ? "Preparação de IA completa" : "Preparação de IA pendente"}
            </span>
          )}
        </div>
      </header>
      {message && (
        <p className="review-message" role="status">
          {message}
        </p>
      )}
      {!projectId && (
        <div className="editorial-empty panel">
          <Film aria-hidden="true" />
          <h2>Escolha um projeto para revisar</h2>
          <p>Projetos com corte transcrito aparecem aqui com seus cues e palavras sincronizados.</p>
        </div>
      )}
      {projectId && !selectedCue && (
        <div className="editorial-empty panel" role="status">
          <Clock3 aria-hidden="true" />
          {media?.state === "source_validated" && (
            <>
              <h2>Vídeo validado</h2>
              <p>O download ainda não foi iniciado.</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void startMediaProcessing()}
                disabled={startingMedia}
              >
                {startingMedia ? "Iniciando…" : "Iniciar processamento"}
              </button>
            </>
          )}
          {media?.state === "source_processing" && (
            <>
              <h2>Baixando o vídeo</h2>
              <p>O download está em andamento. O estado será atualizado automaticamente.</p>
            </>
          )}
          {media?.state === "cut_required" && (
            <>
              <h2>Vídeo pronto para recorte</h2>
              <p>Escolha o início e o fim do trecho antes de transcrever.</p>
              <Link className="primary-button" to={`/media?project=${projectId}`}>
                Abrir recorte
              </Link>
            </>
          )}
          {media?.state === "asr_processing" && (
            <>
              <h2>Transcrevendo o corte</h2>
              <p>
                A transcrição está em andamento. Esta tela verifica o resultado automaticamente.
              </p>
            </>
          )}
          {media?.state === "failed" && (
            <>
              <h2>O processamento encontrou um problema</h2>
              <p>
                {media.download_error ?? media.ingest_error ?? "Consulte os detalhes da mídia."}
              </p>
              <Link className="primary-button" to={`/media?project=${projectId}`}>
                Ver detalhes e tentar novamente
              </Link>
            </>
          )}
          {!media && (
            <>
              <h2>Verificando a produção</h2>
              <p>Carregando a etapa atual…</p>
            </>
          )}
        </div>
      )}
      {selectedCue && !editorialGateReady && (
        <section className="editorial-preparation-gate panel" aria-live="polite">
          <Bot aria-hidden="true" />
          <div>
            <span className="eyebrow">Preparação editorial obrigatória</span>
            <h2>{assistantBusy ? "Tratando a cena com a Groq" : "A cena ainda possui lacunas"}</h2>
            <p>
              A revisão será liberada somente quando todos os cues tiverem inglês, português e
              traduções contextuais para o word-by-word.
            </p>
            {assistantMessage && <p className="assistant-message">{assistantMessage}</p>}
            {assistantStatusFailed && (
              <p className="assistant-message">
                Não foi possível consultar a Groq. Use o pacote para IA externa.
              </p>
            )}
            {(assistantFallbackRequired || assistantStatusFailed) && (
              <div className="editorial-preparation-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={assistantBusy || !assistantStatus?.groq_configured}
                  title={
                    assistantStatus?.groq_configured
                      ? undefined
                      : "Configure GROQ_API_KEY para usar a Groq neste computador."
                  }
                  onClick={() => void startEditorialAssistance()}
                >
                  <Bot aria-hidden="true" /> Processar com Groq
                </button>
                <a
                  className="primary-button"
                  href={studioApi.externalEditorialPackageUrl(sceneId)}
                  download
                >
                  <Download aria-hidden="true" /> Baixar blocos de texto para IA externa
                </a>
                <EditorialImportDropzone
                  disabled={assistantBusy}
                  onImport={(files) => void importExternalResult(files)}
                />
              </div>
            )}
          </div>
        </section>
      )}
      {selectedCue && editorialGateReady && (
        <>
          <div className="review-overview">
            <nav className="review-cue-list panel" aria-label="Lista de cues">
              <h2>
                Cues <span>{cues.length}</span>
              </h2>
              <ol>
                {cues.map((cue) => {
                  const status = cue.provenance?.approval === "approved" ? "approved" : "pending";
                  return (
                  <li key={cue.id} data-status={status}>
                    <button
                      type="button"
                      aria-current={cue.id === selectedCueId ? "true" : undefined}
                      onClick={() => selectCue(cue.id)}
                      onKeyDown={(event) => {
                        if (event.key !== " ") return;
                        event.preventDefault();
                        if (cue.id !== selectedCueId) {
                          selectCue(cue.id);
                          return;
                        }
                        setTimelineFocusRequest((value) => value + 1);
                        togglePlayback();
                      }}
                      disabled={saving}
                    >
                      <span className="review-cue-number">{cue.order}</span>
                      <span className="review-cue-copy">
                        <strong>{cue.approved_en || cue.original_en}</strong>
                        <small className="review-cue-status">
                          <i aria-hidden="true" />
                          {formatTime(cue.speech_timing.start_ms)} ·{" "}
                          {status === "approved" ? "Aprovado" : "Pendente"}
                        </small>
                      </span>
                    </button>
                  </li>
                  );
                })}
              </ol>
            </nav>
            <section className="review-player panel" aria-labelledby="cut-player-title">
              <div className="player-copy">
                <span className="eyebrow">Corte da cena {selectedScene?.order}</span>
                <h2 id="cut-player-title">{project?.title}</h2>
                <p>
                  Cue {selectedCue.order} · {formatTime(selectedCue.speech_timing.start_ms)}–
                  {formatTime(selectedCue.speech_timing.end_ms)}
                </p>
              </div>
              {matchingMedia && media?.cut_url ? (
                <video
                  ref={mediaRef}
                  src={media.cut_url}
                  controls
                  preload="metadata"
                  aria-label="Player do corte da cena"
                  onPlay={(event) => {
                    playSelectedCueFromPlayer(event.currentTarget);
                    setPlaying(true);
                  }}
                  onPause={() => {
                    continuousPlayback.current = false;
                    setPlaying(false);
                  }}
                  onTimeUpdate={(event) => syncPlayback(event.currentTarget)}
                  onEnded={() => setPlaying(false)}
                />
              ) : (
                <div className="player-unavailable" role="status">
                  Prévia do corte indisponível
                </div>
              )}
              <div className="review-listen-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!matchingMedia || !media?.cut_url}
                  onClick={() => openHubPreview()}
                >
                  <MonitorPlay aria-hidden="true" /> Prévia no iHub
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!matchingMedia || !media?.cut_url}
                  onClick={() =>
                    playRange(selectedCue.speech_timing.start_ms, selectedCue.speech_timing.end_ms)
                  }
                >
                  <Play aria-hidden="true" /> Ouvir cue
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!matchingMedia || !media?.cut_url}
                  onClick={toggleContinuousPlayback}
                >
                  <Play aria-hidden="true" /> Ouvir cena inteira
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!selectedWord || !matchingMedia || !media?.cut_url}
                  onClick={() => playRange(wordStart, wordEnd)}
                >
                  <Play aria-hidden="true" /> Ouvir palavra
                </button>
              </div>
            </section>
          </div>
          <nav className="cue-navigation cue-navigation-primary" aria-label="Navegação entre cues">
            <button
              type="button"
              className="secondary-button"
              onClick={() => moveCue(-1)}
              disabled={selectedCueIndex <= 0}
            >
              <ChevronLeft aria-hidden="true" /> Anterior
            </button>
            <div>
              <strong>Cue {selectedCue.order} de {cues.length}</strong>
              <span className={`cue-state cue-state-${cueStatus.toLowerCase().replace(" ", "-")}`}>
                {cueStatus}
              </span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => moveCue(1)}
              disabled={selectedCueIndex >= cues.length - 1}
            >
              Próxima <ChevronRight aria-hidden="true" />
            </button>
          </nav>
          {allCuesApproved && (
            <section className="editorial-next-stage panel" aria-label="Próxima etapa">
              <div>
                <span className="eyebrow">Revisão concluída</span>
                <h2>Próxima etapa: preparar o shadowing</h2>
                <p>
                  Escolha a voz e gere os áudios canônicos dos cards para praticar repetição e
                  montar os materiais do projeto.
                </p>
              </div>
              <Link className="primary-button" to={`/shadowing?project=${projectId}`}>
                Preparar shadowing
              </Link>
            </section>
          )}
          <p className="review-keyboard-hints">
            <kbd>Ctrl Enter</kbd> prévia iHub · <kbd>Ctrl Shift Enter</kbd> desde o início ·{" "}
            <kbd>Espaço</kbd> cue · <kbd>Shift Espaço</kbd> cena · <kbd>A</kbd> IN · <kbd>S</kbd>
            OUT · <kbd>Enter</kbd> salvar palavra + próxima · <kbd>G</kbd> salvar + próxima ·{" "}
            <kbd>←/→</kbd> cursor
          </p>
          <nav className="cue-navigation cue-navigation-secondary" aria-label="Navegação entre cues">
            <button
              type="button"
              className="secondary-button"
              onClick={() => moveCue(-1)}
              disabled={selectedCueIndex <= 0}
            >
              <ChevronLeft aria-hidden="true" /> Cue anterior
            </button>
            <div>
              <strong>Cue {selectedCue.order}</strong>
              <span className={`cue-state cue-state-${cueStatus.toLowerCase().replace(" ", "-")}`}>
                {cueStatus}
              </span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => moveCue(1)}
              disabled={selectedCueIndex >= cues.length - 1}
            >
              Próximo cue <ChevronRight aria-hidden="true" />
            </button>
          </nav>
          <div className="editorial-grid">
            <article className="panel cue-editor">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Texto do cue</span>
                  <h2>Compare inglês e português</h2>
                </div>
                {isDirty && <span className="unsaved-badge">Alterações não salvas</span>}
              </div>
              <section className="cue-structure" aria-label="Organização de cues">
                <div className="cue-structure-buttons">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => beginMerge("next")}
                    disabled={saving || isDirty || selectedCueIndex >= cues.length - 1}
                  >
                    <Merge aria-hidden="true" /> Unir com próximas
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => beginMerge("previous")}
                    disabled={saving || isDirty || selectedCueIndex === 0}
                  >
                    <Merge aria-hidden="true" /> Unir com anterior
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving || isDirty || selectedCue.words.length < 2}
                    onClick={() => {
                      const preferred = Math.min(
                        Math.max(0, selectedWordIndex),
                        selectedCue.words.length - 2,
                      );
                      changeSplitBoundary(selectedCue.words[preferred].id);
                    }}
                  >
                    <Split aria-hidden="true" /> Dividir por palavra
                  </button>
                </div>
                {isDirty && (
                  <p>Salve ou descarte as alterações em andamento para reorganizar as cues.</p>
                )}
                {structureDraft?.kind === "merge" && (
                  <div className="cue-structure-editor">
                    <h3>Unir cues consecutivas</h3>
                    <label>
                      Quantas cues, incluindo a atual?
                      <select
                        aria-label="Quantidade de cues para unir"
                        value={structureDraft.count}
                        onChange={(event) => changeMergeCount(Number(event.target.value))}
                      >
                        {Array.from(
                          { length: Math.min(12, cues.length - structureDraft.startIndex) - 1 },
                          (_, index) => index + 2,
                        ).map((count) => (
                          <option key={count} value={count}>{count}</option>
                        ))}
                      </select>
                    </label>
                    <p>
                      Intervalo: {formatTime(
                        cues[structureDraft.startIndex]?.speech_timing.start_ms ?? 0,
                      )} até{" "}
                      {formatTime(
                        cues[structureDraft.startIndex + structureDraft.count - 1]?.speech_timing.end_ms ??
                          selectedCue.speech_timing.end_ms,
                      )}. As palavras e seus tempos serão preservados.
                    </p>
                    <label>
                      Interlocutor da fala unificada
                      <input
                        aria-label="Interlocutor da cue unificada"
                        value={structureDraft.speaker}
                        onChange={(event) =>
                          setStructureDraft({ ...structureDraft, speaker: event.target.value })
                        }
                      />
                    </label>
                    {new Set(
                      cues.slice(structureDraft.startIndex, structureDraft.startIndex + structureDraft.count)
                        .map((cue) => cue.speaker.trim().toLowerCase()).filter(Boolean),
                    ).size > 1 && (
                      <label className="cue-structure-confirm">
                        <input
                          type="checkbox"
                          checked={structureDraft.confirmedSameSpeaker}
                          onChange={(event) =>
                            setStructureDraft({
                              ...structureDraft,
                              confirmedSameSpeaker: event.target.checked,
                            })
                          }
                        />
                        Confirmei no vídeo que estas falas são da mesma pessoa. A IA pode ter
                        atribuído nomes diferentes.
                      </label>
                    )}
                    <label>
                      Inglês unificado
                      <textarea
                        aria-label="Inglês unificado"
                        rows={3}
                        value={structureDraft.en}
                        onChange={(event) =>
                          setStructureDraft({ ...structureDraft, en: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Português unificado
                      <textarea
                        aria-label="Português unificado"
                        rows={3}
                        value={structureDraft.pt}
                        onChange={(event) =>
                          setStructureDraft({ ...structureDraft, pt: event.target.value })
                        }
                      />
                    </label>
                    <div className="cue-structure-actions">
                      <button type="button" className="secondary-button" onClick={() => setStructureDraft(null)}>
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={saving}
                        onClick={() => void applyStructure()}
                      >
                        Confirmar união
                      </button>
                    </div>
                  </div>
                )}
                {structureDraft?.kind === "split" && (
                  <div className="cue-structure-editor">
                    <h3>Dividir a cue</h3>
                    <label>
                      Dividir depois da palavra
                      <select
                        aria-label="Palavra onde dividir"
                        value={structureDraft.afterWordId}
                        onChange={(event) => changeSplitBoundary(event.target.value)}
                      >
                        {selectedCue.words.slice(0, -1).map((word, index) => (
                          <option key={word.id} value={word.id}>
                            {index + 1}. {word.surface.trim()} ({formatTime(word.end_ms)})
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>
                      Cada parte terá seus próprios textos, interlocutor e tempo de fala.
                      Preencha as duas traduções antes de confirmar.
                    </p>
                    <div className="cue-structure-halves">
                      {(["left", "right"] as const).map((side) => (
                        <div key={side}>
                          <h4>{side === "left" ? "Primeira parte" : "Segunda parte"}</h4>
                          <label>
                            Interlocutor
                            <input
                              aria-label={side === "left" ? "Interlocutor da primeira parte" : "Interlocutor da segunda parte"}
                              value={side === "left" ? structureDraft.leftSpeaker : structureDraft.rightSpeaker}
                              onChange={(event) =>
                                setStructureDraft({
                                  ...structureDraft,
                                  [side === "left" ? "leftSpeaker" : "rightSpeaker"]: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Inglês
                            <textarea
                              aria-label={side === "left" ? "Inglês da primeira parte" : "Inglês da segunda parte"}
                              rows={2}
                              value={side === "left" ? structureDraft.leftEn : structureDraft.rightEn}
                              onChange={(event) =>
                                setStructureDraft({
                                  ...structureDraft,
                                  [side === "left" ? "leftEn" : "rightEn"]: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Português
                            <textarea
                              aria-label={side === "left" ? "Português da primeira parte" : "Português da segunda parte"}
                              rows={2}
                              value={side === "left" ? structureDraft.leftPt : structureDraft.rightPt}
                              onChange={(event) =>
                                setStructureDraft({
                                  ...structureDraft,
                                  [side === "left" ? "leftPt" : "rightPt"]: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                    <div className="cue-structure-actions">
                      <button type="button" className="secondary-button" onClick={() => setStructureDraft(null)}>
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={saving}
                        onClick={() => void applyStructure()}
                      >
                        Confirmar divisão
                      </button>
                    </div>
                  </div>
                )}
              </section>
              {!showPreparationTools && (
                <button
                  type="button"
                  className="preparation-source-toggle"
                  onClick={() => setShowPreparationTools(true)}
                >
                  Trocar fonte de preparação
                </button>
              )}
              {showPreparationTools && (
                <section
                  className="editorial-assistance"
                  aria-labelledby="editorial-assistance-title"
                >
                <div className="editorial-assistance-heading">
                  <div>
                    <span className="eyebrow">Preparação editorial</span>
                    <h3 id="editorial-assistance-title">Groq ou IA externa</h3>
                  </div>
                  <span className="assistant-provider-state">
                    {assistantStatus?.groq_configured
                      ? `Groq · ${assistantStatus.groq_model}`
                      : "Groq não configurada"}
                  </span>
                </div>
                <div className="editorial-assistance-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!assistantStatus?.groq_configured || assistantBusy}
                    onClick={() => void startEditorialAssistance()}
                  >
                    <Bot aria-hidden="true" /> {assistantBusy ? "Processando…" : "Sugerir com Groq"}
                  </button>
                  <a
                    className="secondary-button"
                    href={studioApi.externalEditorialPackageUrl(sceneId)}
                    download
                  >
                    <Download aria-hidden="true" /> Blocos de texto para IA externa
                  </a>
                  <EditorialImportDropzone
                    disabled={assistantBusy}
                    onImport={(file) => void importExternalResult(file)}
                  />
                </div>
                {assistantMessage && <p className="assistant-message">{assistantMessage}</p>}
                {selectedSuggestion && (
                  <div className="assistant-suggestion">
                    <div className="assistant-suggestion-copy">
                      <strong>{selectedSuggestion.approved_en}</strong>
                      <span>{selectedSuggestion.approved_pt}</span>
                      {selectedSuggestion.notes && <small>{selectedSuggestion.notes}</small>}
                      {(selectedSuggestion.semantic_units ?? []).length > 0 && (
                        <section
                          className="assistant-semantic-units"
                          aria-label="Unidades sugeridas"
                        >
                          <strong>Unidades sugeridas</strong>
                          <ul>
                            {selectedSuggestion.semantic_units.map((unit) => (
                              <li key={unit.word_ids.join(":")}>
                                <span>
                                  <b>{suggestedUnitLabel(unit)}</b> → {unit.pt}
                                </span>
                                <div>
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={() => playSuggestedUnit(unit)}
                                  >
                                    <Play aria-hidden="true" /> Ouvir
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    disabled={saving}
                                    onClick={() => applySuggestedSemanticUnit(unit)}
                                  >
                                    Aplicar grupo
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </div>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={saving}
                      onClick={() => {
                        setApprovedEn(selectedSuggestion.approved_en);
                        setApprovedPt(selectedSuggestion.approved_pt);
                        setMessage(
                          "Sugestão aplicada como rascunho. Revise antes de salvar ou aprovar.",
                        );
                      }}
                    >
                      Aplicar texto como rascunho
                    </button>
                  </div>
                )}
                {assistance && Object.keys(assistance.rate_limits).length > 0 && (
                  <details className="assistant-limits">
                    <summary>Limites informados pela Groq</summary>
                    <dl>
                      {Object.entries(assistance.rate_limits).map(([name, value]) => (
                        <div key={name}>
                          <dt>{name.replace("x-ratelimit-", "")}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
                  <button
                    type="button"
                    className="preparation-source-dismiss"
                    onClick={() => setShowPreparationTools(false)}
                  >
                    Ocultar opções
                  </button>
                </section>
              )}
              <div className="asr-reference">
                <span>Transcrição original</span>
                <p>{selectedCue.original_en}</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || Boolean(approvedEn)}
                  onClick={() => setApprovedEn(selectedCue.original_en)}
                >
                  Usar transcrição no inglês
                </button>
              </div>
              <div className="language-fields">
                <label>
                  <span>Inglês aprovado</span>
                  <textarea
                    value={approvedEn}
                    onChange={(event) => setApprovedEn(event.target.value)}
                    rows={3}
                  />
                </label>
                <label>
                  <span>Português aprovado</span>
                  <textarea
                    value={approvedPt}
                    onChange={(event) => setApprovedPt(event.target.value)}
                    rows={3}
                  />
                </label>
              </div>
              <div className="cue-text-actions" aria-label="Ações do texto do cue">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={discardChanges}
                  disabled={!isDirty || saving}
                >
                  <Undo2 aria-hidden="true" /> Descartar texto
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void saveChanges()}
                  disabled={!isDirty || saving}
                >
                  <Save aria-hidden="true" /> Salvar texto
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveChanges(true, true)}
                  disabled={saving}
                >
                  <Check aria-hidden="true" /> Aprovar e ir para a próxima
                </button>
              </div>

              {selectedCue.words.some(
                (word) =>
                  word.start_ms < selectedCue.speech_timing.start_ms ||
                  word.end_ms > selectedCue.speech_timing.end_ms,
              ) && (
                <div className="cue-timing-alert" role="status">
                  <p>Há palavras fora dos limites da cue. Você pode revisar os tempos
                    independentemente da sugestão da IA.</p>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving || isDirty}
                    onClick={() => void fitCueToWords()}
                  >
                    Ajustar limites às palavras
                  </button>
                </div>
              )}
              <details className="technical-details">
                <summary>Ajuste fino da fala do cue</summary>
                <div className="timing-controls">
                  <span>Início {selectedCue.speech_timing.start_ms} ms</span>
                  <button
                    type="button"
                    onClick={() => nudge("start", -25)}
                    aria-label="Antecipar início do cue em 25 milissegundos"
                  >
                    −25
                  </button>
                  <button
                    type="button"
                    onClick={() => nudge("start", 25)}
                    aria-label="Atrasar início do cue em 25 milissegundos"
                  >
                    +25
                  </button>
                  <span>Fim {selectedCue.speech_timing.end_ms} ms</span>
                  <button
                    type="button"
                    onClick={() => nudge("end", -25)}
                    aria-label="Antecipar fim do cue em 25 milissegundos"
                  >
                    −25
                  </button>
                  <button
                    type="button"
                    onClick={() => nudge("end", 25)}
                    aria-label="Atrasar fim do cue em 25 milissegundos"
                  >
                    +25
                  </button>
                </div>
              </details>
            </article>
            <aside className="panel word-inspector" aria-labelledby="word-inspector-title">
              <span className="eyebrow">Inspetor contextual</span>
              <h2 id="word-inspector-title">
                {selectedWord
                  ? selectedGroupWords.length > 1
                    ? `Unidade “${selectedUnitLabel}”`
                    : `Palavra “${selectedWord.surface}”`
                  : "Selecione uma palavra"}
              </h2>
              {selectedWord && (
                <div className="word-mode-status">
                  <span>
                    Palavra {selectedWordIndex + 1} de {selectedCue.words.length}
                  </span>
                  <button type="button" className="secondary-button" onClick={leaveWordMode}>
                    Voltar ao cue
                  </button>
                </div>
              )}
              <ol className="word-list" aria-label="Palavras do cue selecionado">
                {selectedCue.words.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`word-row${item.id === selectedWordId ? " selected" : ""}${
                        selectedWord?.semantic_group_id &&
                        item.semantic_group_id === selectedWord.semantic_group_id
                          ? " grouped"
                          : ""
                      }${
                        semanticDraftUnits?.some((unit) => unit.word_ids.includes(item.id))
                          ? " semantic-draft"
                          : ""
                      }`}
                      onClick={() => selectWord(item.id)}
                      aria-pressed={item.id === selectedWordId}
                    >
                      <strong>{item.surface}</strong>
                      <span>
                        {item.semantic_group_role === "lead" && item.pt
                          ? `${item.pt} · `
                          : item.semantic_group_role === "member"
                            ? "↳ mesmo grupo · "
                            : ""}
                        {formatTime(item.start_ms)}–{formatTime(item.end_ms)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {selectedWord && (
                <div className="word-timing-editor">
                  <section className="word-surface-editor" aria-label="Correção do inglês da palavra">
                    <label>
                      <span>Palavra em inglês (corrigir transcrição da IA)</span>
                      <input
                        type="text"
                        aria-label="Corrigir palavra em inglês"
                        value={wordSurface}
                        onChange={(event) => setWordSurface(event.target.value)}
                      />
                    </label>
                    <p>A correção atualiza o inglês da cue, a timeline e os próximos
                      materiais gerados. O ID e o tempo da palavra são preservados.</p>
                    {selectedWord.provenance?.translation_review_required === true && (
                      <div className="word-review-warning">
                        <strong>Tradução precisa de confirmação</strong>
                        <p>Confira o português após a correção do inglês.</p>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={saving || wordSurfaceDirty || !wordPt.trim()}
                          onClick={() => void confirmWordTranslation()}
                        >
                          Confirmar tradução
                        </button>
                      </div>
                    )}
                  </section>
                  <section className="semantic-unit-editor" aria-label="Unidade semântica">
                    <div className="semantic-unit-heading">
                      <div>
                        <span className="eyebrow">
                          {selectedGroupWords.length > 1
                            ? "Unidade semântica"
                            : "Tradução da palavra"}
                        </span>
                        <strong>{selectedUnitLabel}</strong>
                      </div>
                      {selectedGroupWords.length > 1 && (
                        <span className="semantic-group-badge">
                          {selectedGroupWords.length} palavras
                        </span>
                      )}
                    </div>
                    <label>
                      <span>Tradução natural da unidade</span>
                      <input
                        type="text"
                        value={wordPt}
                        onChange={(event) => setWordPt(event.target.value)}
                        placeholder="Ex.: Posso ajudar?"
                      />
                    </label>
                    <p>
                      Traduza a expressão completa pelo sentido. Exemplo: “Can I help?” → “Posso
                      ajudar?”.
                    </p>
                    <div className="semantic-unit-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={saving || semanticUnitsDirty || selectedGroupStartIndex === 0}
                        onClick={() => void groupSelectedWord("previous")}
                      >
                        Agrupar anterior
                      </button>
                      {selectedGroupWords.length > 1 && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={saving || semanticUnitsDirty}
                          onClick={() => void ungroupSelectedWord()}
                        >
                          Desfazer grupo
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          saving ||
                          semanticUnitsDirty ||
                          selectedGroupEndIndex === selectedCue.words.length - 1
                        }
                        onClick={() => void groupSelectedWord("next")}
                      >
                        Agrupar próxima
                      </button>
                    </div>
                  </section>
                  <div className="word-timing-fields">
                    <label>
                      <span>IN (ms)</span>
                      <input
                        type="number"
                        min={selectedCue.speech_timing.start_ms}
                        max={wordEnd - 1}
                        step={1}
                        value={wordStart}
                        onChange={(event) => setWordStart(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      <span>OUT (ms)</span>
                      <input
                        type="number"
                        min={wordStart + 1}
                        max={selectedCue.speech_timing.end_ms}
                        step={1}
                        value={wordEnd}
                        onChange={(event) => setWordEnd(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <p className="word-duration">
                    Duração <strong>{Math.max(0, wordEnd - wordStart)} ms</strong>
                  </p>
                  <p className="word-timing-guidance">
                    Para sincronizar a legenda, use a timeline abaixo: ouça com contexto,
                    marque o início e o fim da palavra e clique em “Salvar e próxima”.
                    O tempo da cue não será alterado.
                  </p>
                </div>
              )}
            </aside>
          </div>
          <footer className="review-actions" aria-label="Ações da revisão">
            <div>
              <strong>
                {selectedWord
                  ? `Palavra ${selectedWordIndex + 1} de ${selectedCue.words.length} · Cue ${selectedCue.order}`
                  : `Cue ${selectedCue.order} de ${cues.length}`}
              </strong>
              <span>{isDirty ? "Há alterações não salvas" : cueStatus}</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={discardChanges}
              disabled={!isDirty || saving}
            >
              <Undo2 aria-hidden="true" /> Descartar
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void saveChanges()}
              disabled={!isDirty || saving}
            >
              <Save aria-hidden="true" /> {selectedWord ? "Salvar palavra" : "Salvar alterações"}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void saveChanges(true, true)}
              disabled={saving}
            >
              <Check aria-hidden="true" /> Aprovar cue
            </button>
          </footer>
          <CueWordTimeline
            cues={previewCues}
            waveform={matchingMedia ? media?.waveform : null}
            durationMs={durationMs}
            playheadMs={playheadMs}
            playing={playing}
            zoom={zoom}
            focusRequest={timelineFocusRequest}
            selectedCueId={selectedCueId}
            selectedWordId={selectedWordId}
            onPlayToggle={togglePlayback}
            onPlayContext={() => {
              if (!selectedCue || !selectedWord) return;
              playRange(
                Math.max(selectedCue.speech_timing.start_ms, wordStart - 650),
                Math.min(selectedCue.speech_timing.end_ms, wordEnd + 850),
              );
            }}
            onPreviousWord={() => moveWord(-1)}
            onContinuousPlayToggle={toggleContinuousPlayback}
            onSaveAndNext={() => void saveChanges(false, true)}
            onPlayheadChange={seek}
            onZoomChange={setZoom}
            onSelectCue={selectCue}
            onSelectWord={selectWord}
            onSetEdge={markActiveEdge}
            onEdgeDragStart={beginEdgeDrag}
            onEdgeChange={(edge, timeMs) => setActiveEdgeAt(edge, timeMs, false)}
            onNudge={nudge}
            onUndo={undo}
          />
          {hubPreviewStartMs !== null && matchingMedia && media?.cut_url && (
            <EditorialHubPreview
              mediaUrl={media.cut_url}
              cues={hubPreviewCues}
              initialTimeMs={hubPreviewStartMs}
              onClose={() => setHubPreviewStartMs(null)}
            />
          )}
        </>
      )}
    </section>
  );
}
