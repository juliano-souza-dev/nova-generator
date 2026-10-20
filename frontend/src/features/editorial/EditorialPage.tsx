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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { reconcileCueWords } from "./reconcileCueWords";
import { nudgeTiming, remapWordsToCue, setTimingEdge, validateTimeline } from "./timeline";
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
      translationIncomplete: boolean;
    };

function cueWordText(words: TimelineCue["words"]): string {
  const literal = words.map((word) => word.surface).join("");
  return (literal.includes(" ") ? literal : words.map((word) => word.surface).join(" ")).trim();
}

// Reuse editorial translations instead of asking the editor to retranslate a split.
// Group members share the lead's natural translation, but keep independent timings.
export function cueWordTranslation(words: TimelineCue["words"]): { text: string; complete: boolean } {
  const fragments: string[] = [];
  const visitedGroups = new Set<string>();
  let complete = true;
  for (const word of words) {
    let translationWord = word;
    if (word.semantic_group_id) {
      if (visitedGroups.has(word.semantic_group_id)) continue;
      visitedGroups.add(word.semantic_group_id);
      translationWord =
        words.find(
          (candidate) =>
            candidate.semantic_group_id === word.semantic_group_id &&
            candidate.semantic_group_role === "lead",
        ) ?? word;
    }
    const translation = translationWord.pt?.trim();
    if (translation) fragments.push(translation);
    else complete = false;
  }
  return {
    text: fragments
      .join(" ")
      .replace(/\s+([.,;:!?…%)\]}»”])/g, "$1")
      .replace(/([([{«“])\s+/g, "$1")
      .trim(),
    complete,
  };
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
  const [textDraftCueId, setTextDraftCueId] = useState("");
  const [approvedPt, setApprovedPt] = useState("");
  // A provisional range remains editable before any inserted word is persisted.
  const [draftCueTiming, setDraftCueTiming] = useState<{ start_ms: number; end_ms: number } | null>(null);
  const [wordDraftId, setWordDraftId] = useState<string | undefined>();
  const [wordStart, setWordStart] = useState(0);
  const [wordEnd, setWordEnd] = useState(0);
  const [wordPt, setWordPt] = useState("");
  const [wordSurface, setWordSurface] = useState("");
  // Keep invalid or temporarily unsavable word edits accessible while navigating.
  // This cache is local to the current editorial session, never a server approval.
  const pendingWordDrafts = useRef(new Map<string, {
    start: number;
    end: number;
    pt: string;
    surface: string;
  }>());
  const [pendingDraftVersion, setPendingDraftVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const wordNavigationLock = useRef(false);
  const cueNavigationLock = useRef(false);
  const [showSupportingPanels, setShowSupportingPanels] = useState(true);
  const [showCompactVideo, setShowCompactVideo] = useState(true);
  const [inlineTextEditing, setInlineTextEditing] = useState(false);
  const cueDragBaseline = useRef<TimelineCue | null>(null);
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
  const textDirty = Boolean(
    selectedCue && textDraftCueId === selectedCue.id &&
    (approvedEn !== selectedCue.approved_en || approvedPt !== selectedCue.approved_pt),
  );
  const textReconciliation =
    selectedCue && textDraftCueId === selectedCue.id && approvedEn !== selectedCue.approved_en
      ? reconcileCueWords(approvedEn, selectedCue.words, selectedCue.speech_timing.start_ms)
      : null;
  const hasInsertedWords = Boolean(textReconciliation?.insertedCount);
  const proposedCueTiming = selectedCue
    ? {
        start_ms: selectedCue.speech_timing.start_ms,
        end_ms: Math.max(
          selectedCue.speech_timing.end_ms,
          textReconciliation?.suggestedEndMs ?? selectedCue.speech_timing.end_ms,
        ),
      }
    : { start_ms: 0, end_ms: 1 };
  const activeCueTiming = hasInsertedWords && draftCueTiming
    ? draftCueTiming
    : proposedCueTiming;
  // Preview the same word count and provisional audio intervals as the server.
  const reconciledWords = textReconciliation?.words ?? selectedCue?.words ?? [];
  const visibleWords = hasInsertedWords && draftCueTiming && reconciledWords.length &&
      activeCueTiming.end_ms - activeCueTiming.start_ms >= reconciledWords.length
    ? remapWordsToCue(reconciledWords, proposedCueTiming, activeCueTiming)
    : reconciledWords;
  const selectedWord = visibleWords.find((item) => item.id === selectedWordId);
  const selectedGroupWords = selectedWord?.semantic_group_id
    ? visibleWords.filter(
        (item) => item.semantic_group_id === selectedWord.semantic_group_id,
      )
    : selectedWord
      ? [selectedWord]
      : [];
  const selectedUnitLabel = selectedGroupWords.map((item) => item.surface).join(" ");
  const selectedGroupStartIndex = selectedCue
    ? visibleWords.indexOf(selectedGroupWords[0] ?? selectedWord!)
    : -1;
  const selectedGroupEndIndex = selectedCue
    ? visibleWords.indexOf(selectedGroupWords.at(-1) ?? selectedWord!)
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
  // Word drafts are keyed by word ID. During navigation, never project the
  // previous word's text/IN/OUT onto a different selected word.
  const wordDraftIsCurrent = Boolean(selectedWord && wordDraftId === selectedWord.id);
  const activeWordStart = wordDraftIsCurrent ? wordStart : (selectedWord?.start_ms ?? 0);
  const activeWordEnd = wordDraftIsCurrent ? wordEnd : (selectedWord?.end_ms ?? 0);
  const activeWordSurface = wordDraftIsCurrent ? wordSurface : (selectedWord?.surface.trim() ?? "");
  const activeWordPt = wordDraftIsCurrent ? wordPt : storedWordPt;
  const wordDirty = Boolean(
    selectedWord && (activeWordStart !== selectedWord.start_ms || activeWordEnd !== selectedWord.end_ms),
  );
  const wordTranslationDirty = Boolean(selectedWord && activeWordPt !== storedWordPt);
  const wordSurfaceDirty = Boolean(selectedWord && activeWordSurface !== selectedWord.surface.trim());
  const selectedWordIndex =
    visibleWords.findIndex((word) => word.id === selectedWordId);
  const pendingWordIds = useMemo(
    () => new Set(pendingWordDrafts.current.keys()),
    [pendingDraftVersion],
  );
  const pendingTimingChanges = visibleWords.some((word) => {
    const draft = pendingWordDrafts.current.get(word.id);
    return draft && (draft.start !== word.start_ms || draft.end !== word.end_ms);
  });
  const previewCues = cues.map((cue) =>
    cue.id === selectedCue?.id
      ? {
          ...cue,
          speech_timing: hasInsertedWords ? activeCueTiming : cue.speech_timing,
          subtitle_timing: hasInsertedWords
            ? {
                start_ms: Math.min(cue.subtitle_timing.start_ms, activeCueTiming.start_ms),
                end_ms: Math.max(cue.subtitle_timing.end_ms, activeCueTiming.end_ms),
              }
            : cue.subtitle_timing,
          words: visibleWords.map((word, index) => ({
            ...word,
            surface:
              index === selectedWordIndex && wordSurfaceDirty
                ? (word.surface.match(/^\\s*/)?.[0] ?? "") + activeWordSurface.trim()
                : word.surface,
            start_ms: index === selectedWordIndex
              ? activeWordStart
              : (pendingWordDrafts.current.get(word.id)?.start ?? word.start_ms),
            end_ms: index === selectedWordIndex
              ? activeWordEnd
              : (pendingWordDrafts.current.get(word.id)?.end ?? word.end_ms),
          })),
        }
      : cue,
  );
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
    textDirty || wordDirty || wordTranslationDirty || wordSurfaceDirty || semanticUnitsDirty || timingDirty ||
    Boolean(draftCueTiming);
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
    pendingWordDrafts.current.clear();
    setPendingDraftVersion((value) => value + 1);
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
    setDraftCueTiming(null);
    setTextDraftCueId(selectedCue?.id ?? "");
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
    const pending = selectedWord ? pendingWordDrafts.current.get(selectedWord.id) : undefined;
    setWordDraftId(selectedWord?.id);
    setWordStart(pending?.start ?? selectedWord?.start_ms ?? 0);
    setWordEnd(pending?.end ?? selectedWord?.end_ms ?? 0);
    setWordPt(pending?.pt ?? storedWordPt);
    setWordSurface(pending?.surface ?? selectedWord?.surface.trim() ?? "");
  }, [
    selectedWord?.id,
    selectedWord?.start_ms,
    selectedWord?.end_ms,
    selectedWord?.surface,
    storedWordPt,
  ]);

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
  function rememberCurrentWordDraft() {
    if (!selectedWord) return;
    pendingWordDrafts.current.set(selectedWord.id, {
      start: activeWordStart,
      end: activeWordEnd,
      pt: activeWordPt,
      surface: activeWordSurface,
    });
    setPendingDraftVersion((value) => value + 1);
  }

  async function finishCurrentWordForNavigation(): Promise<string | null> {
    if (!selectedCue || !selectedWord) return null;
    if (hasInsertedWords) {
      rememberCurrentWordDraft();
      return "Palavras novas em rascunho. Salve a cue para confirmar a segmentação.";
    }
    const hasWordEdits = wordDirty || wordTranslationDirty || wordSurfaceDirty;
    if (hasWordEdits) {
      // Keep access to earlier/later words even when the current edit cannot
      // be validated. The draft remains local and visibly pending.
      rememberCurrentWordDraft();
      const saved = await saveChanges(false, false);
      if (!saved)
        return `Ajustes de “${selectedWord.surface.trim()}” ainda não salvos. Rascunho preservado nesta sessão.`;
      pendingWordDrafts.current.delete(selectedWord.id);
      setPendingDraftVersion((value) => value + 1);
    }
    try {
      await studioApi.completeWordTimingReview(selectedCue.id, selectedWord.id, author);
      if (!hasWordEdits) await refreshCues();
    } catch (error) {
      return `“${selectedWord.surface.trim()}” permanece pendente: ${error instanceof Error ? error.message : "revise seus tempos"}.`;
    }
    return null;
  }

  async function selectCue(id: string, focusWordId?: string) {
    if (saving || cueNavigationLock.current || wordNavigationLock.current) return;
    const destination = cues.find((item) => item.id === id);
    if (!destination) return;
    cueNavigationLock.current = true;
    try {
      // Cue-wide drafts cannot silently disappear when moving between cues.
      if (textDirty || timingDirty || semanticUnitsDirty) {
        const saved = await saveChanges(false, false);
        if (!saved) return;
      }
      const warning = selectedWord ? await finishCurrentWordForNavigation() : null;
      playbackEnd.current = null;
      mediaRef.current?.pause();
      setSelectedCueId(destination.id);
      setSelectedWordId(focusWordId);
      setTimelineFocusRequest((value) => value + 1);
      const focusWord = destination.words.find((word) => word.id === focusWordId);
      seek(focusWord?.start_ms ?? destination.speech_timing.start_ms);
      if (warning) setMessage(warning);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível mudar de cue.");
    } finally {
      cueNavigationLock.current = false;
    }
  }
  async function selectWord(id: string, targetCueId?: string) {
    if (targetCueId && targetCueId !== selectedCueId) {
      await selectCue(targetCueId, id);
      return;
    }
    if (saving || wordNavigationLock.current || id === selectedWordId) return;
    const word = visibleWords.find((item) => item.id === id);
    if (!word) return;
    wordNavigationLock.current = true;
    try {
      const warning = selectedWord ? await finishCurrentWordForNavigation() : null;
      playbackEnd.current = null;
      mediaRef.current?.pause();
      setSelectedWordId(word.id);
      seek(word.start_ms);
      setMessage(
        warning ??
        `Editando “${word.surface.trim()}”. Cada palavra possui tempos próprios, inclusive dentro do grupo semântico.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível selecionar a palavra.");
    } finally {
      wordNavigationLock.current = false;
    }
  }
  function moveWord(offset: number) {
    if (!selectedCue || saving || wordNavigationLock.current) return;
    const next = visibleWords[selectedWordIndex + offset];
    if (next) void selectWord(next.id);
  }
  async function leaveWordMode() {
    if (!selectedWord || saving || wordNavigationLock.current) return;
    wordNavigationLock.current = true;
    try {
      const warning = await finishCurrentWordForNavigation();
      setSelectedWordId(undefined);
      if (selectedCue) seek(selectedCue.speech_timing.start_ms);
      setMessage(warning ?? "Modo Cue ativo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível voltar ao cue.");
    } finally {
      wordNavigationLock.current = false;
    }
  }
  function discardChanges() {
    if (saving) return;
    if (selectedWordId) {
      pendingWordDrafts.current.delete(selectedWordId);
      setPendingDraftVersion((value) => value + 1);
    }
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
    setDraftCueTiming(null);
    setMessage("Alterações locais descartadas.");
  }
  function playRange(start: number, end: number) {
    const player = mediaRef.current;
    if (!player) return;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      playbackEnd.current = null;
      player.pause();
      setMessage(
        "A palavra não tem intervalo válido (IN deve ser anterior ao OUT). Ajuste os marcadores para ouvi-la.",
      );
      return;
    }
    // Record this bounded playback before play() dispatches its onPlay event.
    // The onPlay handler must not expand a word preview into an entire cue.
    continuousPlayback.current = false;
    playbackEnd.current = end;
    seek(start);
    if (!player.paused) {
      // An already playing cue must also become a bounded word preview.
      syncPlayback(player);
    }
    void player.play().catch(() => {
      playbackEnd.current = null;
      setMessage("Não foi possível reproduzir o trecho selecionado.");
    });
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
        if (event.shiftKey) openHubPreview(true);
        else if (selectedCue && !saving) void saveChanges(true, true);
        return;
      }
      if (event.key === "Escape" && selectedWord) {
        const target = event.target;
        if (!(target instanceof HTMLElement && target.closest("input, textarea, select"))) {
          event.preventDefault();
          void leaveWordMode();
          return;
        }
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
      if (event.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        moveCue(event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1);
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
    if (!selectedWord && selectedCue && !hasInsertedWords) {
      cueDragBaseline.current = selectedCue;
      if (history.length === 0) setHistory([cues]);
    }
  }

  function updateParentCueTiming(
    baseCue: TimelineCue,
    nextTiming: TimelineCue["speech_timing"],
    recordHistory: boolean,
  ) {
    try {
      const words = remapWordsToCue(baseCue.words, baseCue.speech_timing, nextTiming);
      const next = cues.map((cue) =>
        cue.id === baseCue.id ? { ...cue, speech_timing: nextTiming, words } : cue,
      );
      if (recordHistory) replaceCues(next);
      else setCues(next);
      setMessage("Cue e palavras sincronizadas. Confira os destaques no áudio antes de aprovar.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível ajustar as palavras.");
    }
  }
  // Individual word boundaries are editable independently of semantic groups.
  // Neighbor conflicts are validated at save time, not allowed to freeze a handle.
  function changeSelectedWordEdge(edge: "start" | "end", targetMs: number) {
    if (!selectedCue || !selectedWord || saving) return;
    const cueStart = hasInsertedWords ? activeCueTiming.start_ms : selectedCue.speech_timing.start_ms;
    const cueEnd = hasInsertedWords ? activeCueTiming.end_ms : selectedCue.speech_timing.end_ms;
    const time = Math.round(targetMs);
    if (edge === "start") {
      setWordStart(Math.max(cueStart, Math.min(time, activeWordEnd - 1)));
    } else {
      setWordEnd(Math.min(cueEnd, Math.max(time, activeWordStart + 1)));
    }
  }
  function nudge(edge: "start" | "end", deltaMs: number) {
    if (!selectedCue || saving) return;
    if (selectedWord) {
      changeSelectedWordEdge(edge, (edge === "start" ? activeWordStart : activeWordEnd) + deltaMs);
      return;
    }
    cueDragBaseline.current = null;
    if (hasInsertedWords) {
      setDraftCueTiming(nudgeTiming(activeCueTiming, edge, deltaMs, durationMs));
      return;
    }
    updateParentCueTiming(
      selectedCue,
      nudgeTiming(selectedCue.speech_timing, edge, deltaMs, durationMs),
      true,
    );
  }
  function setActiveEdgeAt(edge: "start" | "end", timeMs: number, recordHistory: boolean) {
    if (!selectedCue || saving) return;
    if (selectedWord) {
      changeSelectedWordEdge(edge, timeMs);
      setMessage(
        `${edge === "start" ? "IN" : "OUT"} da palavra “${selectedWord.surface}” marcado em ${formatTime(timeMs)}.`,
      );
      return;
    }
    if (hasInsertedWords) {
      setDraftCueTiming(setTimingEdge(activeCueTiming, edge, timeMs, durationMs));
      return;
    }
    const baseCue =
      !recordHistory && cueDragBaseline.current?.id === selectedCue.id
        ? cueDragBaseline.current
        : selectedCue;
    if (recordHistory) cueDragBaseline.current = null;
    updateParentCueTiming(
      baseCue,
      setTimingEdge(baseCue.speech_timing, edge, timeMs, durationMs),
      recordHistory,
    );
  }
  function markActiveEdge(edge: "start" | "end") {
    setActiveEdgeAt(edge, playheadMs, true);
  }
  function undo() {
    cueDragBaseline.current = null;
    if (draftCueTiming) {
      setDraftCueTiming(null);
      setMessage("Estimativa restaurada. Você pode ajustar os limites novamente.");
      return;
    }
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
    if (selectedWord) {
      // Clicking "Listen to word" always (re)plays precisely the selected word,
      // even if the video is currently playing a cue or a context preview.
      playRange(activeWordStart, activeWordEnd);
      return;
    }
    if (player.paused) {
      playRange(selectedCue.speech_timing.start_ms, selectedCue.speech_timing.end_ms);
    } else {
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
    // Bounded previews (word or context) already set playbackEnd in playRange.
    // Only direct playback from the native video controls defaults to a cue.
    if (continuousPlayback.current || playbackEnd.current !== null || !selectedCue) return;
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

  async function saveChanges(approve = false, advance = false): Promise<boolean> {
    if (!selectedCue || saving) return false;
    if (textReconciliation?.error) {
      setMessage(textReconciliation.error);
      return false;
    }
    if (wordSurfaceDirty && textDirty) {
      setMessage("Salve a correção da palavra e a edição do texto em etapas separadas.");
      return false;
    }
    if (approve && (!approvedEn || !approvedPt)) {
      setMessage("Preencha os textos em inglês e português antes de aprovar o cue.");
      return false;
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
      return false;
    }
    setSaving(true);
    try {
      if (hasInsertedWords && textDirty) {
        // Commit text, new word identities and timings in one atomic operation.
        // Provisional UI IDs are never sent to the word-level API.
        await studioApi.updateCueText(selectedCue.id, {
          author,
          approved_en: approvedEn,
          approved_pt: approvedPt,
          approve: false,
          proposed_speech_timing: candidate.speech_timing,
          proposed_word_timings: candidate.words.map((word) => ({
            start_ms: word.start_ms,
            end_ms: word.end_ms,
          })),
          proposed_word_translations: candidate.words.map((word, index) =>
            index === selectedWordIndex && wordTranslationDirty
              ? activeWordPt
              : (pendingWordDrafts.current.get(word.id)?.pt ?? word.pt ?? null),
          ),
        });
        const fresh = await refreshCues();
        const freshCue = fresh.find((cue) => cue.id === selectedCue.id);
        if (selectedWordId?.startsWith("editorial-new-")) {
          setSelectedWordId(freshCue?.words[selectedWordIndex]?.id);
        }
        for (const wordId of pendingWordDrafts.current.keys()) {
          if (wordId.startsWith("editorial-new-")) pendingWordDrafts.current.delete(wordId);
        }
        setPendingDraftVersion((value) => value + 1);
        setDraftCueTiming(null);
        setMessage(
          "Novas palavras salvas com tempos provisórios. Ajuste os marcadores " +
          "IN/OUT e confira as traduções antes da aprovação.",
        );
        return true;
      }
      let correctedEnglish = approvedEn;
      if (wordSurfaceDirty && selectedWord) {
        const corrected = await studioApi.updateWordSurface(
          selectedCue.id, selectedWord.id, activeWordSurface, author,
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
      if (wordDirty || pendingTimingChanges) {
        await studioApi.updateWordTiming(selectedCue.id, {
          author,
          timings: candidate.words.map((item) => ({
            id: item.id,
            start_ms: item.start_ms,
            end_ms: item.end_ms,
          })),
        });
        // A multiword timing correction can be committed in one atomic request.
        for (const word of selectedCue.words) {
          const draft = pendingWordDrafts.current.get(word.id);
          if (draft && draft.surface === word.surface.trim() &&
              draft.pt === (word.semantic_group_id
                ? (selectedCue.words.find((member) =>
                    member.semantic_group_id === word.semantic_group_id &&
                    member.semantic_group_role === "lead")?.pt ?? "")
                : (word.pt ?? ""))) {
            pendingWordDrafts.current.delete(word.id);
          }
        }
        setPendingDraftVersion((value) => value + 1);
      }
      if (wordTranslationDirty && selectedWord)
        await studioApi.updateWordTranslation(selectedCue.id, selectedWord.id, activeWordPt, author);
      if (textDirty || approve)
        await studioApi.updateCueText(selectedCue.id, {
          author,
          approved_en: correctedEnglish,
          approved_pt: approvedPt,
          approve,
        });
      // Review each audible word independently, even within a semantic group.
      const nextWord =
        advance && selectedWord && !approve
          ? visibleWords[selectedWordIndex + 1]
          : undefined;
      const nextCueForWord =
        advance && selectedWord && !approve && !nextWord ? cues[selectedCueIndex + 1] : undefined;
      if (advance && selectedWord && !approve) {
        await studioApi.completeWordTimingReview(selectedCue.id, selectedWord.id, author);
      }
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
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar revisão.");
      return false;
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
    const leftTranslation = cueWordTranslation(selectedCue.words.slice(0, index + 1));
    const rightTranslation = cueWordTranslation(selectedCue.words.slice(index + 1));
    setStructureDraft({
      kind: "split",
      afterWordId,
      leftEn: cueWordText(selectedCue.words.slice(0, index + 1)),
      rightEn: cueWordText(selectedCue.words.slice(index + 1)),
      leftPt: leftTranslation.text,
      rightPt: rightTranslation.text,
      leftSpeaker: selectedCue.speaker,
      rightSpeaker: selectedCue.speaker,
      translationIncomplete: !leftTranslation.complete || !rightTranslation.complete,
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
    if (next) void selectCue(next.id);
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
          <div className="editorial-review-shell">
            <nav className="editorial-station-dock" aria-label="Controles da estação editorial">
              <div className="editorial-dock-navigation">
                <button type="button" className="secondary-button"
                  aria-label="Cue anterior" title="Cue anterior (Alt + ←)"
                  disabled={saving || selectedCueIndex <= 0}
                  onClick={() => moveCue(-1)}>
                  <ChevronLeft aria-hidden="true" /> Anterior
                </button>
                <div className="editorial-dock-position" aria-live="polite">
                  <strong>Cue {selectedCue.order} de {cues.length}</strong>
                  <span className={`cue-state cue-state-${cueStatus.toLowerCase().replace(" ", "-")}`}>
                    {cueStatus}{isDirty ? " · Não salvo" : ""}
                  </span>
                </div>
                <button type="button" className="secondary-button"
                  aria-label="Próximo cue" title="Próxima cue (Alt + →)"
                  disabled={saving || selectedCueIndex >= cues.length - 1}
                  onClick={() => moveCue(1)}>
                  Próxima <ChevronRight aria-hidden="true" />
                </button>
              </div>
              <div className="editorial-mode-switch" role="group" aria-label="Modo de edição">
                <button type="button" aria-pressed={!selectedWord}
                  onClick={() => void leaveWordMode()} disabled={!selectedWord || saving}>
                  Cue
                </button>
                <button type="button" aria-pressed={Boolean(selectedWord)}
                  onClick={() => {
                    if (!selectedWord && visibleWords[0]) void selectWord(visibleWords[0].id);
                  }}
                  disabled={Boolean(selectedWord) || visibleWords.length === 0 || saving}>
                  Word
                </button>
              </div>
              <div className="editorial-dock-actions">
                <button type="button" className="secondary-button"
                  aria-label={selectedWord ? "Salvar palavra" : "Salvar alterações"}
                  title="Salvar alterações" disabled={!isDirty || saving}
                  onClick={() => void saveChanges()}>
                  <Save aria-hidden="true" /> Salvar
                </button>
                <button type="button" className="primary-button"
                  aria-label="Aprovar cue" disabled={saving}
                  onClick={() => void saveChanges(true, true)}>
                  <Check aria-hidden="true" /> Aprovar e próxima
                </button>
                <button type="button" className="secondary-button"
                  aria-pressed={showCompactVideo}
                  onClick={() => setShowCompactVideo((value) => !value)}>
                  <Film aria-hidden="true" /> Vídeo
                </button>
                <button type="button" className="secondary-button"
                  aria-expanded={showSupportingPanels}
                  aria-controls="editorial-support-panels"
                  onClick={() => setShowSupportingPanels((value) => !value)}>
                  {showSupportingPanels ? "Ocultar painéis" : "Texto e ferramentas"}
                </button>
              </div>
              <details className="editorial-dock-shortcuts">
                <summary>Atalhos</summary>
                <p>Alt + ←/→: navegar entre cues · Esc: modo Cue · Ctrl + Enter: aprovar e avançar ·
                   Ctrl + Shift + Enter: prévia iHub · Espaço: ouvir · A/S: IN/OUT · G: salvar e próxima</p>
              </details>
            </nav>
            <section className={`editorial-station-stage${showCompactVideo ? "" : " is-video-hidden"}`} aria-label="Área principal da waveform">
              <div className="editorial-station-wave">
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
                    Math.max(selectedCue.speech_timing.start_ms, activeWordStart - 650),
                    Math.min(selectedCue.speech_timing.end_ms, activeWordEnd + 850),
                  );
                }}
                onPreviousWord={() => moveWord(-1)}
                onContinuousPlayToggle={toggleContinuousPlayback}
                onSaveAndNext={() => void saveChanges(false, true)}
                onPlayheadChange={seek}
                onZoomChange={setZoom}
                onSelectCue={selectCue}
                onSelectWord={(wordId, cueId) => void selectWord(wordId, cueId)}
                onSetEdge={markActiveEdge}
                onEdgeDragStart={beginEdgeDrag}
                onEdgeChange={(edge, timeMs) => setActiveEdgeAt(edge, timeMs, false)}
                onNudge={nudge}
                onUndo={undo}
              />
                <div className={`editorial-station-transcript${inlineTextEditing ? " is-editing" : ""}`}
                  aria-label="Texto contextual da cue">
                  {inlineTextEditing ? (
                    <>
                      <label>
                        <span className="eyebrow">Inglês aprovado</span>
                        <textarea aria-label="Inglês rápido" value={approvedEn}
                          onChange={(event) => {
                            setTextDraftCueId(selectedCue.id);
                            setApprovedEn(event.target.value);
                          }} />
                      </label>
                      <label>
                        <span className="eyebrow">Português aprovado</span>
                        <textarea aria-label="Português rápido" value={approvedPt}
                          onChange={(event) => {
                            setTextDraftCueId(selectedCue.id);
                            setApprovedPt(event.target.value);
                          }} />
                      </label>
                    </>
                  ) : (
                    <>
                      <div>
                        <span className="eyebrow">Inglês aprovado</span>
                        <p>{(textDraftCueId === selectedCue.id ? approvedEn : selectedCue.approved_en) ||
                          selectedCue.original_en}</p>
                      </div>
                      <div>
                        <span className="eyebrow">Português aprovado</span>
                        <p>{(textDraftCueId === selectedCue.id ? approvedPt : selectedCue.approved_pt) ||
                          "Tradução pendente"}</p>
                      </div>
                    </>
                  )}
                  <button type="button" className="secondary-button"
                    aria-expanded={inlineTextEditing}
                    onClick={() => setInlineTextEditing((value) => !value)}>
                    {inlineTextEditing ? "Recolher edição" : "Editar texto"}
                  </button>
                </div>
              </div>
              <div className="editorial-compact-video" hidden={!showCompactVideo}>
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
                  onClick={toggleContinuousPlayback}
                >
                  <Play aria-hidden="true" /> Ouvir cena inteira
                </button>
              </div>
            </section>
              </div>
            </section>
            <div id="editorial-support-panels" className="editorial-support-panels"
              hidden={!showSupportingPanels}>
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

          </div>

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
                      As traduções já registradas nas palavras e unidades semânticas foram
                      recuperadas automaticamente. Revise os textos somente se necessário.
                      Os tempos de fala de cada palavra serão preservados.
                    </p>
                    {structureDraft.translationIncomplete && (
                      <p role="status">
                        Algumas palavras ainda não possuem tradução individual ou de grupo.
                        Confira os trechos abaixo antes de confirmar.
                        {selectedCue.approved_pt.trim() && (
                          <> Tradução original da cue: “{selectedCue.approved_pt}”.</>
                        )}
                      </p>
                    )}
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
                    onChange={(event) => {
                      setTextDraftCueId(selectedCue.id);
                      setApprovedEn(event.target.value);
                    }}
                    rows={3}
                  />
                </label>
                <label>
                  <span>Português aprovado</span>
                  <textarea
                    value={approvedPt}
                    onChange={(event) => {
                      setTextDraftCueId(selectedCue.id);
                      setApprovedPt(event.target.value);
                    }}
                    rows={3}
                  />
                </label>
              </div>
              {hasInsertedWords && (
                <div className="cue-timing-alert" aria-label="Ajuste livre da duração provisória">
                  <p>
                    {textReconciliation?.insertedCount} palavra(s) nova(s). Duração calculada
                    pelo ritmo da fala; os tempos ainda não foram conferidos no áudio.
                    Arraste os limites na waveform ou ajuste os milissegundos abaixo.
                  </p>
                  <div className="cue-structure-buttons">
                    <label>
                      IN da cue (ms)
                      <input
                        type="number"
                        aria-label="IN provisório da cue"
                        min={0}
                        max={durationMs}
                        value={activeCueTiming.start_ms}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value))
                            setDraftCueTiming(setTimingEdge(activeCueTiming, "start", value, durationMs));
                        }}
                      />
                    </label>
                    <label>
                      OUT da cue (ms)
                      <input
                        type="number"
                        aria-label="OUT provisório da cue"
                        min={0}
                        max={durationMs}
                        value={activeCueTiming.end_ms}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value))
                            setDraftCueTiming(setTimingEdge(activeCueTiming, "end", value, durationMs));
                        }}
                      />
                    </label>
                    <button type="button" className="secondary-button"
                      onClick={() => setDraftCueTiming(null)}>
                      Restaurar estimativa
                    </button>
                  </div>
                  {activeCueTiming.end_ms > durationMs && (
                    <p role="alert">
                      O tempo sugerido ultrapassa o fim da cena. Ajuste o OUT antes de salvar.
                    </p>
                  )}
                  {cues[selectedCueIndex + 1] &&
                    activeCueTiming.end_ms > cues[selectedCueIndex + 1].speech_timing.start_ms && (
                    <p role="status">
                      A estimativa alcança a próxima cue. Salve como rascunho e ajuste os
                      limites usando o áudio; nenhuma outra cue será deslocada silenciosamente.
                    </p>
                  )}
                </div>
              )}
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
            </article>
            <aside className="panel word-inspector" aria-labelledby="word-inspector-title">
              <span className="eyebrow">Inspetor contextual</span>
              <h2 id="word-inspector-title">
                {selectedWord
                  ? `Palavra “${selectedWord.surface.trim()}”`
                  : "Selecione uma palavra"}
              </h2>
              {selectedWord && (
                <div className="word-mode-status">
                  <span>
                    Palavra {selectedWordIndex + 1} de {visibleWords.length} ·
                    IN {formatTime(activeWordStart)} · OUT {formatTime(activeWordEnd)}
                  </span>
                  <button type="button" className="secondary-button" onClick={leaveWordMode}>
                    Voltar ao cue
                  </button>
                </div>
              )}
              {textReconciliation?.error && (
                <p className="field-error" role="alert">{textReconciliation.error}</p>
              )}
              <ol className="word-list" aria-label="Palavras do cue selecionado">
                {visibleWords.map((item) => (
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
                      {pendingWordIds.has(item.id) && (
                        <span className="word-pending-indicator" aria-label="Rascunho não salvo">
                          Não salvo
                        </span>
                      )}
                      {item.provenance?.word_timing_reviewed === true && (
                        <span className="word-reviewed-indicator" aria-label="Palavra concluída">
                          <Check aria-hidden="true" />
                        </span>
                      )}
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
                        value={activeWordSurface}
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
                            ? "Unidade semântica (somente sentido/tradução)"
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
                        value={activeWordPt}
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
                          selectedGroupEndIndex === visibleWords.length - 1
                        }
                        onClick={() => void groupSelectedWord("next")}
                      >
                        Agrupar próxima
                      </button>
                    </div>
                  </section>
                </div>
              )}
            </aside>
          </div>


            </div>
          {hubPreviewStartMs !== null && matchingMedia && media?.cut_url && (
            <EditorialHubPreview
              mediaUrl={media.cut_url}
              cues={hubPreviewCues}
              initialTimeMs={hubPreviewStartMs}
              onClose={() => setHubPreviewStartMs(null)}
            />
          )}
          </div>
        </>
      )}
    </section>
  );
}
