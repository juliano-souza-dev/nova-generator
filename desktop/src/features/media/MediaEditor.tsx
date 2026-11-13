import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Captions, Check, Clock3, Download, Film, Languages, Pause, Play, Plus, Save, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import { runTrackedTask } from "../tasks/TaskCenter";
import { downloadExternalTranslationPackage, type ExternalTranslationPackage } from "./translationPackage";

type Cue = { id: string; startMs: number; endMs: number; text: string; language?: string | null; wordAlignment?: string | null; wordAlignmentHash?: string | null; words?: { text: string; startMs: number; endMs: number }[] };
type AlignmentProgress = { projectId: string; assetId: string; completed: number; total: number; message: string };
type AlignmentResult = { aligned: number; skipped: number; total: number; language?: string | null };
type TranscriptResult = { engine: string; model: string; language?: string | null; durationMs: number; cues: Cue[] };
type TranslationCue = { id: string; startMs: number; endMs: number; text: string };
type Asset = { id: string; name: string; durationMs?: number | null; sourceStartMs?: number | null; sourceEndMs?: number | null };
function renderEditorialEnglish(suggestion: any, fallback: string, currentMs: number) {
  const text = String(suggestion?.approved_en || fallback || "");
  const words = Array.isArray(suggestion?.word_translations) ? suggestion.word_translations : [];
  const matches = [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
  if (!words.length || matches.length !== words.length) return text;

  const getWordBounds = (word: any) => ({
    start: Number(word.start_ms ?? word.startMs),
    end: Number(word.end_ms ?? word.endMs)
  });
  let activeIndex = words.findIndex((word: any) => {
    const { start, end } = getWordBounds(word);
    return Number.isFinite(start) && Number.isFinite(end) && currentMs >= start && currentMs <= end;
  });
  // WhisperX may leave tiny gaps between adjacent word intervals. Bridge only
  // a narrow boundary window so those words do not disappear between frames.
  if (activeIndex < 0) {
    let nearestDistance = 36;
    words.forEach((word: any, index: number) => {
      const { start, end } = getWordBounds(word);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const distance = currentMs < start ? start - currentMs : currentMs - end;
      if (distance >= 0 && distance < nearestDistance) {
        nearestDistance = distance;
        activeIndex = index;
      }
    });
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    const start = match.index ?? cursor;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<span key={String(words[index]?.word_id ?? index)} style={index === activeIndex ? {
      color: "#f4cf72",
      fontWeight: 900,
      textShadow: "0 0 12px rgba(244,207,114,.28)"
    } : undefined}>{match[0]}</span>);
    cursor = start + match[0].length;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const fmt = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0") + "." + String(Math.floor(ms % 1000 / 100));
};

export default function MediaEditor({ projectId, asset, onClose }: { projectId: string; asset: Asset; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const translationFileInput = useRef<HTMLInputElement>(null);
  const timelineDragMoved = useRef(false);
  const [src, setSrc] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [translations, setTranslations] = useState<TranslationCue[]>([]);
  const [editorialResult, setEditorialResult] = useState<Record<string, any> | null>(null);
  const [translationDirty, setTranslationDirty] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [preparingExternalPackage, setPreparingExternalPackage] = useState(false);
  const [includeWordTranslations, setIncludeWordTranslations] = useState(true);
  const [includeSemanticUnits, setIncludeSemanticUnits] = useState(true);
  const [translationInfo, setTranslationInfo] = useState("");
  const [translationStream, setTranslationStream] = useState<{ cueId: string; text: string } | null>(null);
  const [current, setCurrent] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(asset.durationMs ?? 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTrack, setActiveTrack] = useState<"video" | "transcript" | "translation" | "wordbyword">("video");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [transcriptionMode, setTranscriptionMode] = useState<"auto" | "cloud" | "local">("auto");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [transcriptionModel, setTranscriptionModel] = useState("small");
  const [transcribing, setTranscribing] = useState(false);
  const [aligning, setAligning] = useState(false);
  const [alignmentInfo, setAlignmentInfo] = useState("");
  const [localAsrReady, setLocalAsrReady] = useState(false);
  const [localAsrChecking, setLocalAsrChecking] = useState(true);
  const [installingAsr, setInstallingAsr] = useState(false);
  const [transcriptionInfo, setTranscriptionInfo] = useState("");
  const activeCue = useMemo(() => cues.find(c => current >= c.startMs && current <= c.endMs), [cues, current]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [path, stored, storedTranslations] = await Promise.all([
          invoke<string>("open_project_media", { projectId, assetId: asset.id }),
          invoke<Cue[]>("load_project_subtitles", { projectId, assetId: asset.id }),
          invoke<TranslationCue[]>("load_project_translations", { projectId, assetId: asset.id }).catch(() => [] as TranslationCue[])
        ]);
        const storedEditorial = await invoke<Record<string, any> | null>("load_project_editorial_result", { projectId, assetId: asset.id, cues: stored }).catch(() => null);
        if (!alive) return;
        setSrc(convertFileSrc(path));
        setCues(stored);
        setTranslations(storedTranslations);
        setEditorialResult(storedEditorial);
        if (storedEditorial?.predictions) {
          setIncludeWordTranslations(Boolean(storedEditorial.predictions.word_translations));
          setIncludeSemanticUnits(Boolean(storedEditorial.predictions.semantic_units));
        }
        setSelected(stored[0]?.id ?? null);
        if (stored.length) setActiveTrack("transcript");
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; video.current?.pause(); };
  }, [projectId, asset.id]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; assetId: string; cueId: string; delta: string }>("translation-stream", event => {
      const payload = event.payload;
      if (payload.projectId !== projectId || payload.assetId !== asset.id) return;
      setTranslationStream(current => current?.cueId === payload.cueId
        ? { cueId: payload.cueId, text: (current.text + payload.delta).slice(-6000) }
        : { cueId: payload.cueId, text: payload.delta });
    }).then(stop => {
      if (alive) unlisten = stop;
      else stop();
    }).catch(error => console.error("Falha ao acompanhar streaming da tradução:", error));
    return () => { alive = false; unlisten?.(); };
  }, [projectId, asset.id]);

  function seek(ms: number) {
    const next = Math.max(0, Math.min(ms, duration || ms));
    if (video.current) video.current.currentTime = next / 1000;
    setCurrent(next);
  }
  function addCue() {
    const startMs = Math.max(0, Math.floor(current / 100) * 100);
    const endMs = Math.min(duration || startMs + 2500, startMs + 2500);
    const cue: Cue = { id: `cue-${Date.now()}-${cues.length}`, startMs, endMs: Math.max(startMs + 100, endMs), text: "" };
    setCues(items => [...items, cue].sort((a, b) => a.startMs - b.startMs));
    setEditorialResult(null);
    setSelected(cue.id);
    setSaved(false);
    setDirty(true);
  }
  function updateCue(id: string, patch: Partial<Cue>) {
    const invalidatesAlignment = "text" in patch || "startMs" in patch || "endMs" in patch;
    setCues(items => items.map(c => c.id === id ? { ...c, ...patch, ...(invalidatesAlignment ? { words: [], wordAlignment: null, wordAlignmentHash: null } : {}) } : c).sort((a, b) => a.startMs - b.startMs));
    setEditorialResult(null);
    setSaved(false);
    setDirty(true);
  }
  function applyTimelineCueTiming(cueId: string, startMs: number, endMs: number, mode: "move" | "start" | "end", deltaMs: number) {
    const target = cues.find(item => item.id === cueId);
    if (!target) return;
    const nextStart = Math.max(0, Math.round(startMs));
    const nextEnd = Math.min(duration || endMs, Math.round(endMs));
    if (nextEnd - nextStart < 100) return;

    const shiftWord = (word: { text: string; startMs: number; endMs: number }) => ({
      ...word, startMs: word.startMs + deltaMs, endMs: word.endMs + deltaMs
    });
    setCues(items => items.map(item => {
      if (item.id !== cueId) return item;
      let words = item.words ?? [];
      if (mode === "move") words = words.map(shiftWord);
      else if (words.length) {
        words = words.map((word, index) => ({
          ...word,
          ...(mode === "start" && index === 0 ? { startMs: nextStart } : {}),
          ...(mode === "end" && index === words.length - 1 ? { endMs: nextEnd } : {})
        }));
      }
      return { ...item, startMs: nextStart, endMs: nextEnd, words };
    }).sort((a, b) => a.startMs - b.startMs));

    setTranslations(items => items.map(item => item.id === cueId
      ? { ...item, startMs: nextStart, endMs: nextEnd }
      : item));
    setEditorialResult(result => {
      if (!result) return result;
      return {
        ...result,
        approval: "draft",
        suggestions: (result.suggestions ?? []).map((suggestion: any) => {
          if (suggestion.cue_id !== cueId) return suggestion;
          const wordTranslations = (suggestion.word_translations ?? []).map((word: any, index: number, all: any[]) => ({
            ...word,
            ...(mode === "move" ? {
              start_ms: Number(word.start_ms ?? word.startMs) + deltaMs,
              end_ms: Number(word.end_ms ?? word.endMs) + deltaMs
            } : {}),
            ...(mode === "start" && index === 0 ? { start_ms: nextStart } : {}),
            ...(mode === "end" && index === all.length - 1 ? { end_ms: nextEnd } : {})
          }));
          return { ...suggestion, start_ms: nextStart, end_ms: nextEnd, word_translations: wordTranslations };
        })
      };
    });
    setSaved(false);
    setDirty(true);
    setTranslationDirty(true);
  }

  function beginCueDrag(event: ReactPointerEvent<HTMLButtonElement>, cue: Cue, mode: "move" | "start" | "end") {
    if (saving || aligning || !duration) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget.closest("button") as HTMLButtonElement | null;
    const lane = target?.parentElement;
    if (!target || !lane) return;
    const laneWidth = lane.getBoundingClientRect().width;
    if (!laneWidth) return;
    const initialX = event.clientX;
    const initialStart = cue.startMs;
    const initialEnd = cue.endMs;
    let lastStart = initialStart;
    let lastEnd = initialEnd;
    timelineDragMoved.current = false;
    target.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const deltaMs = (moveEvent.clientX - initialX) / laneWidth * duration;
      if (Math.abs(moveEvent.clientX - initialX) > 3) timelineDragMoved.current = true;
      const neighborBefore = cues.filter(item => item.id !== cue.id && item.endMs <= initialStart).sort((a, b) => b.endMs - a.endMs)[0];
      const neighborAfter = cues.filter(item => item.id !== cue.id && item.startMs >= initialEnd).sort((a, b) => a.startMs - b.startMs)[0];
      let nextStart = initialStart;
      let nextEnd = initialEnd;
      if (mode === "move") {
        const clampedDelta = Math.max((neighborBefore?.endMs ?? 0) - initialStart, Math.min((neighborAfter?.startMs ?? duration) - initialEnd, deltaMs));
        nextStart = initialStart + clampedDelta;
        nextEnd = initialEnd + clampedDelta;
      } else if (mode === "start") {
        nextStart = Math.max(neighborBefore?.endMs ?? 0, Math.min(initialEnd - 100, initialStart + deltaMs));
      } else {
        nextEnd = Math.min(neighborAfter?.startMs ?? duration, Math.max(initialStart + 100, initialEnd + deltaMs));
      }
      const incrementalDelta = mode === "move" ? nextStart - lastStart : mode === "start" ? nextStart - lastStart : nextEnd - lastEnd;
      lastStart = nextStart;
      lastEnd = nextEnd;
      applyTimelineCueTiming(cue.id, nextStart, nextEnd, mode, incrementalDelta);
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp, { once: true });
    target.addEventListener("pointercancel", onUp, { once: true });
  }

  async function splitCueAtWord(wordIndex: number) {
    if (!chosen || !chosen.words || wordIndex <= 0 || wordIndex >= chosen.words.length || saving || aligning) return;
    const before = chosen.words[wordIndex - 1];
    const after = chosen.words[wordIndex];
    const rawSplitMs = Math.round((before.endMs + after.startMs) / 2);
    const splitMs = Math.max(chosen.startMs + 1, Math.min(chosen.endMs - 1, rawSplitMs));
    if (!Number.isFinite(splitMs) || splitMs <= chosen.startMs || splitMs >= chosen.endMs) {
      setError("Não foi possível dividir este trecho: os tempos das palavras não permitem criar dois segmentos válidos.");
      return;
    }

    const firstWords = chosen.words.slice(0, wordIndex);
    const secondWords = chosen.words.slice(wordIndex);
    const firstText = firstWords.map(word => word.text.trim()).filter(Boolean).join(" ");
    const secondText = secondWords.map(word => word.text.trim()).filter(Boolean).join(" ");
    if (!firstText || !secondText) {
      setError("Não foi possível dividir: um dos lados ficaria sem texto. Confira o alinhamento das palavras.");
      return;
    }

    const hadTranslation = translations.some(item => item.id === chosen.id);
    try {
      if (editorialResult) {
        await invoke("clear_project_editorial_result", { projectId, assetId: asset.id });
      }
    } catch (e) {
      setError("Não foi possível invalidar o resultado editorial anterior. O trecho não foi dividido: " + String(e));
      return;
    }

    const secondCue: Cue = {
      ...chosen,
      id: `cue-${Date.now()}-${cues.length}-split`,
      startMs: splitMs,
      text: secondText,
      words: secondWords
    };
    const firstCue: Cue = {
      ...chosen,
      endMs: splitMs,
      text: firstText,
      words: firstWords
    };

    setCues(items => items.flatMap(item => item.id === chosen.id ? [firstCue, secondCue] : [item]).sort((a, b) => a.startMs - b.startMs));
    // A tradução do trecho original não pode ser repartida automaticamente sem
    // alterar o sentido. Mantemos as demais traduções e solicitamos nova tradução
    // apenas para os segmentos resultantes na próxima geração.
    setTranslations(items => items.filter(item => item.id !== chosen.id));
    setTranslationDirty(true);
    setEditorialResult(null);
    setSelected(secondCue.id);
    setCurrent(splitMs);
    if (video.current) video.current.currentTime = splitMs / 1000;
    setSaved(false);
    setDirty(true);
    setError("");
    setTranslationInfo(hadTranslation
      ? "Trecho dividido. A tradução anterior desse trecho foi removida para evitar uma associação incorreta. Gere novamente a tradução para os dois novos trechos."
      : "Trecho dividido. Os tempos das palavras foram preservados.");
  }

  async function save(): Promise<boolean> {
    setSaving(true); setError("");
    try {
      await runTrackedTask("export", "Salvar transcrição e tradução", async () => {
        await invoke("save_project_subtitles", { projectId, assetId: asset.id, cues });
        if (editorialResult?.approval === "draft") {
          const approved = { ...editorialResult, suggestions: (editorialResult.suggestions ?? []).map((item: any) => ({
            ...item, approved_pt: translations.find(t => t.id === item.cue_id)?.text ?? item.approved_pt
          })) };
          await invoke("save_project_editorial_result", { projectId, assetId: asset.id, result: approved, cues, includeWordTranslations, includeSemanticUnits });
          setEditorialResult(approved);
        }
        if (translations.length > 0 || translationDirty) {
          await invoke("save_project_translations", { projectId, assetId: asset.id, translations });
        }
      });
      setSaved(true);
      setDirty(false);
      setTranslationDirty(false);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally { setSaving(false); }
  }
  async function transcribe() {
    if (transcribing || loading) return;
    setTranscribing(true); setError(""); setTranscriptionInfo("");
    try {
      const result = await runTrackedTask("transcription", "Transcrever vídeo", () =>
        invoke<TranscriptResult>("transcribe_media", {
          projectId, assetId: asset.id, mode: transcriptionMode,
          language: transcriptionLanguage || null, localModel: transcriptionModel
        }));
      const next = result.cues.map(c => ({ ...c, language: result.language ?? (transcriptionLanguage || null), wordAlignment: null, wordAlignmentHash: null, words: c.words ?? [] }));
      setCues(next);
      setTranslations([]);
      setEditorialResult(null);
      setSelected(next[0]?.id ?? null);
      setSaved(false); setDirty(true); setTranslationDirty(false);
      setTranscriptionInfo(`${next.length} legendas geradas por ${result.engine === "groq" ? "Groq Whisper" : "Faster-Whisper"}${result.language ? ` · idioma detectado: ${result.language}` : ""}. Salvando automaticamente...`);
      // Uma nova transcrição invalida traduções e predições vinculadas à versão anterior.
      await invoke("save_project_subtitles", { projectId, assetId: asset.id, cues: next });
      await invoke("save_project_translations", { projectId, assetId: asset.id, translations: [] });
      await invoke("clear_project_editorial_result", { projectId, assetId: asset.id });
      setSaved(true); setDirty(false);
      setTranscriptionInfo(`${next.length} legendas geradas e salvas no projeto por ${result.engine === "groq" ? "Groq Whisper" : "Faster-Whisper"}${result.language ? ` · idioma detectado: ${result.language}` : ""}.`);
    } catch (e) { setError(String(e)); }
    finally { setTranscribing(false); }
  }

  async function alignWords() {
    if (aligning || saving || loading || cues.length === 0) return;
    if (dirty || translationDirty) {
      setAlignmentInfo("Salvando as alterações da transcrição e da tradução...");
      const didSave = await save();
      if (!didSave) {
        setAlignmentInfo("Não foi possível salvar as alterações. Corrija o erro e tente alinhar novamente.");
        return;
      }
    }
    const missingLanguage = cues.some(c => c.wordAlignment !== "whisperx" && !(c.language || transcriptionLanguage) && Boolean(c.text.trim()));
    if (missingLanguage) {
      setError("O idioma da fala não está registrado nesta transcrição. Selecione o idioma no campo Idioma antes de alinhar as palavras.");
      setActiveTrack("transcript");
      return;
    }
    setAligning(true); setError(""); setAlignmentInfo("Iniciando o WhisperX...");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<AlignmentProgress>("alignment-progress", event => {
        const progress = event.payload;
        if (progress.projectId === projectId && progress.assetId === asset.id) {
          setAlignmentInfo(progress.message + " (" + progress.completed + "/" + progress.total + ")");
        }
      });
      const result = await runTrackedTask("transcription", "Alinhar palavras com WhisperX", () =>
        invoke<AlignmentResult>("align_project_subtitles", {
          projectId, assetId: asset.id, language: transcriptionLanguage || null
        }));
      const stored = await invoke<Cue[]>("load_project_subtitles", { projectId, assetId: asset.id });
      setCues(stored);
      setSaved(true); setDirty(false);
      setAlignmentInfo(result.aligned
        ? result.aligned + " blocos alinhados e salvos; " + result.skipped + " já estavam concluídos."
        : "Todos os blocos já possuíam alinhamento. Nenhum processamento repetido.");
    } catch (e) {
      setError(String(e));
      setAlignmentInfo("O alinhamento foi interrompido. Os blocos concluídos anteriormente continuam salvos.");
      try {
        const stored = await invoke<Cue[]>("load_project_subtitles", { projectId, assetId: asset.id });
        setCues(stored);
        setSaved(true); setDirty(false);
      } catch { /* Preserve the current editor state if reload fails. */ }
    } finally {
      unlisten?.();
      setAligning(false);
    }
  }

  async function translateAll() {
    if (translating || loading || cues.length === 0) return;
    if (translations.length && !window.confirm("Gerar novamente substituirá as traduções atuais. A transcrição original será preservada. Continuar?")) return;
    setTranslating(true); setError(""); setTranslationInfo(""); setTranslationStream(null);
    try {
      const result = await runTrackedTask("translation", "Traduzir transcrição para PT-BR", () =>
        invoke<TranslationCue[]>("translate_project_subtitles", { projectId, assetId: asset.id, cues, includeWordTranslations, includeSemanticUnits }));
      setTranslations(result);
      setEditorialResult(await invoke<Record<string, any> | null>("load_project_editorial_result", { projectId, assetId: asset.id, cues }));
      setTranslationDirty(true); setDirty(true); setSaved(false);
      setTranslationInfo("Tradução concluída. Salvando automaticamente...");
      // O backend já persiste o rascunho editorial; aqui persistimos também a faixa PT-BR.
      await invoke("save_project_subtitles", { projectId, assetId: asset.id, cues });
      await invoke("save_project_translations", { projectId, assetId: asset.id, translations: result });
      setTranslationDirty(false); setDirty(false); setSaved(true);
      setTranslationInfo(result.length + " trechos traduzidos e salvos no projeto. O rascunho editorial permanece disponível para revisão.");
    } catch (e) { setError(String(e)); }
    finally { setTranslating(false); }
  }

  async function approveEditorial() {
    if (!editorialResult || editorialResult.approval !== "draft") return;
    if (dirty || translationDirty) {
      setError("Salve a transcrição e as traduções antes de aprovar o resultado editorial.");
      return;
    }
    setError("");
    try {
      const approved = await invoke<Record<string, any>>("approve_project_editorial_result", { projectId, assetId: asset.id, cues });
      setEditorialResult(approved);
      setTranslationInfo("Resultado editorial aprovado. A aprovação humana foi registrada no histórico do projeto.");
    } catch (e) { setError("Não foi possível aprovar o resultado editorial: " + String(e)); }
  }

  async function resetEditorialDraft() {
    if (!editorialResult) return;
    if (!window.confirm("Isso remove o resultado editorial salvo, mas mantém a transcrição e as traduções de linha. Continuar?")) return;
    try {
      await invoke("clear_project_editorial_result", { projectId, assetId: asset.id });
      setEditorialResult(null);
      setTranslationInfo("Rascunho editorial removido. Você pode alterar as predições e gerar um novo resultado.");
      setDirty(true); setSaved(false);
    } catch (e) { setError("Não foi possível reconfigurar as predições: " + String(e)); }
  }

  async function downloadExternalPackage() {
    if (preparingExternalPackage || loading || cues.length === 0) return;
    setPreparingExternalPackage(true); setError("");
    try {
      const pkg = await invoke<ExternalTranslationPackage>("prepare_external_translation_package", {
        projectId, assetId: asset.id, cues, includeWordTranslations, includeSemanticUnits
      });
      const saved = await downloadExternalTranslationPackage(pkg);
      setTranslationInfo(saved
        ? "Pacote editorial 1.3 salvo. Envie o ZIP para a IA externa e importe o output.json retornado."
        : "Salvamento cancelado. O pacote não foi gravado.");
    } catch (e) { setError("Não foi possível preparar o pacote externo: " + String(e)); }
    finally { setPreparingExternalPackage(false); }
  }

  function updateTranslation(id: string, text: string) {
    setTranslations(items => items.map(item => item.id === id ? { ...item, text } : item));
    setEditorialResult(current => current ? { ...current, approval: "draft" } : null);
    setTranslationDirty(true); setDirty(true); setSaved(false);
  }

  async function importTranslations(file?: File) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const isEditorialContract = !Array.isArray(parsed) && parsed.contract === "nova-generator-editorial-suggestions/1.3";
      if (!Array.isArray(parsed) && parsed.suggestions && !isEditorialContract) {
        throw new Error("Contrato editorial não reconhecido. Use nova-generator-editorial-suggestions/1.3.");
      }
      if (isEditorialContract) {
        if (parsed.approval !== "draft") throw new Error("O resultado precisa estar em estado draft para revisão humana.");
        if (typeof parsed.source_hash !== "string" || !parsed.source_hash) throw new Error("O JSON não contém o hash da transcrição do pacote. Gere o resultado usando o pacote atual.");
        if (parsed.predictions?.word_translations !== includeWordTranslations || parsed.predictions?.semantic_units !== includeSemanticUnits) {
          throw new Error("As predições do JSON não correspondem às opções selecionadas. Selecione as mesmas opções usadas na geração do pacote.");
        }
      }
      const items = Array.isArray(parsed) ? parsed : (parsed.translations ?? parsed.suggestions ?? parsed.cues);
      if (!Array.isArray(items)) throw new Error("O JSON precisa conter uma lista de traduções.");
      const byId = new Map<string, string>();
      for (const item of items) {
        const id = String(item.id ?? item.cue_id ?? "");
        const text = String(item.text ?? item.translation ?? item.approved_pt ?? item.pt ?? "");
        if (!id || !text.trim()) continue;
        byId.set(id, text.trim());
      }
      const imported = cues.filter(cue => byId.has(cue.id)).map(cue => ({
        id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: byId.get(cue.id)!
      }));
      if (!imported.length) throw new Error("Nenhum ID do JSON corresponde aos trechos desta transcrição.");
      if (imported.length !== cues.length) throw new Error("O arquivo contém " + imported.length + " traduções correspondentes para " + cues.length + " trechos. Importe um JSON completo com os mesmos IDs.");
      setTranslations(imported); if (isEditorialContract) setEditorialResult(parsed); setTranslationDirty(true); setDirty(true); setSaved(false);
      setTranslationInfo(imported.length + " traduções importadas. Revise e salve.");
    } catch (e) { setError("Falha ao importar JSON: " + String(e)); }
    finally { if (translationFileInput.current) translationFileInput.current.value = ""; }
  }

  async function installLocalAsr() {
    setInstallingAsr(true); setError("");
    try {
      const message = await runTrackedTask("installation", "Instalar transcrição local", () =>
        invoke<string>("install_local_asr"));
      setLocalAsrReady(await invoke<boolean>("check_local_asr"));
      setTranscriptionInfo(message);
    } catch (e) { setError(String(e)); }
    finally { setInstallingAsr(false); }
  }

  useEffect(() => {
    let alive = true;
    invoke<boolean>("check_local_asr").then(value => { if (alive) setLocalAsrReady(value); })
      .catch(() => { if (alive) setLocalAsrReady(false); })
      .finally(() => { if (alive) setLocalAsrChecking(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let lastPublished = -1;
    const tick = () => {
      const element = video.current;
      if (!element || element.paused || element.ended) {
        setIsPlaying(false);
        return;
      }
      const timeMs = element.currentTime * 1000;
      // Keep word highlighting synchronized to rendered video frames.
      // The native timeupdate event is too sparse for short spoken words.
      if (Math.abs(timeMs - lastPublished) >= 8) {
        lastPublished = timeMs;
        setCurrent(timeMs);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  const chosen = cues.find(c => c.id === selected) ?? null;
  const selectedEditorialSuggestion = useMemo(() => {
    if (!chosen || !Array.isArray(editorialResult?.suggestions)) return null;
    return editorialResult.suggestions.find((item: any) => item.cue_id === chosen.id) ?? null;
  }, [chosen, editorialResult]);
  const activeEditorialSuggestion = useMemo(() => {
    if (!activeCue || !Array.isArray(editorialResult?.suggestions)) return null;
    return editorialResult.suggestions.find((item: any) => item.cue_id === activeCue.id) ?? null;
  }, [activeCue, editorialResult]);
  const trackNames = [
    { id: "video" as const, label: "Video", icon: Film },
    { id: "transcript" as const, label: "Transcrição", icon: Captions },
    { id: "translation" as const, label: "Tradução", icon: Languages },
    { id: "wordbyword" as const, label: "WordByWord", icon: Clock3 }
  ];
  const pct = (ms: number) => duration > 0 ? Math.max(0, Math.min(100, ms / duration * 100)) : 0;

  return <div className="media-editor-backdrop">
    <section className="media-editor media-editor-v2" role="dialog" aria-modal="true" aria-label="Editor de mídia">
      <header className="media-editor-header">
        <button className="media-editor-back" onClick={() => { if (!aligning && (!dirty || window.confirm("Há alterações na transcrição ou tradução não salvas. Fechar mesmo assim?"))) onClose(); }} disabled={aligning}><ArrowLeft size={16}/> Biblioteca</button>
        <div className="media-editor-title"><span className="eyebrow">EDITOR DE MÍDIA</span><strong>{asset.name}</strong></div>
        <div className="media-editor-actions">
          {saved && <span className="media-editor-saved"><Check size={13}/> Salvo</span>}
          <button className="primary-button" onClick={() => void save()} disabled={saving || loading}><Save size={15}/> {saving ? "Salvando..." : "Salvar"}</button>
          <button className="icon-button" title="Fechar editor" onClick={() => { if (!aligning && (!dirty || window.confirm("Há alterações na transcrição ou tradução não salvas. Fechar mesmo assim?"))) onClose(); }} disabled={aligning}><X size={18}/></button>
        </div>
      </header>
      {error && <div className="media-editor-error">{error}</div>}
      <div className="media-editor-main media-editor-main-v2">
        <main className="media-editor-workarea">
          <section className="media-editor-preview-v2">
            {loading ? <div className="media-editor-placeholder">Preparando vídeo...</div> : src ? <>
              <div className="media-editor-video-wrap">
                <video ref={video} src={src} controls playsInline preload="metadata"
                  onLoadedMetadata={e => { const ms = e.currentTarget.duration * 1000; setDuration(ms); }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onTimeUpdate={e => setCurrent(e.currentTarget.currentTime * 1000)} />
                {activeCue?.text && <div className="media-editor-caption">
                  <div>{renderEditorialEnglish(activeEditorialSuggestion, activeCue.text, current)}</div>
                  {(activeEditorialSuggestion?.approved_pt || translations.find(t => t.id === activeCue.id)?.text) && <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,.28)", fontWeight: 600 }}>
                    {activeEditorialSuggestion?.approved_pt || translations.find(t => t.id === activeCue.id)?.text}
                  </div>}
                </div>}
              </div>
              <div className="media-editor-transport">
                <button title="Voltar 5 segundos" onClick={() => seek(current - 5000)}><SkipBack size={16}/></button>
                <button title="Reproduzir" onClick={() => void video.current?.play()}><Play size={16}/></button>
                <button title="Pausar" onClick={() => video.current?.pause()}><Pause size={16}/></button>
                <button title="Avançar 5 segundos" onClick={() => seek(current + 5000)}><SkipForward size={16}/></button>
                <span>{fmt(current)} <i>/</i> {fmt(duration)}</span>
              </div>
            </> : <div className="media-editor-placeholder">Não foi possível abrir o vídeo.</div>}
          </section>

          <section className="media-editor-timeline-dock">
            <div className="media-editor-timeline-toolbar">
              <div><span className="eyebrow">LINHA DO TEMPO</span><strong>Composição do projeto</strong></div>
              <span className="media-editor-timecode">{fmt(current)} / {fmt(duration)}</span>
            </div>
            <div className="media-editor-ruler-v2">
              <span>00:00</span><span>{fmt(duration / 4)}</span><span>{fmt(duration / 2)}</span><span>{fmt(duration * .75)}</span><span>{fmt(duration)}</span>
            </div>
            <div className="media-editor-tracks">
              {trackNames.map(({ id, label, icon: Icon }) => <div className={`media-editor-track-row ${activeTrack === id ? "is-active" : ""}`} key={id}>
                <button className="media-editor-track-label" onClick={() => { setActiveTrack(id); if (id === "video" || id === "wordbyword") setSelected(null); else if (id === "transcript" && !selected && cues[0]) setSelected(cues[0].id); else if (id === "translation" && !selected && translations[0]) setSelected(translations[0].id); }}>
                  <Icon size={14}/><span>{label}</span>
                </button>
                <div className="media-editor-track-lane" onClick={() => setActiveTrack(id)}>
                  {id === "video" && <button className={`media-editor-track-clip video-clip ${activeTrack === "video" ? "selected" : ""}`} style={{ left: "0%", width: "100%" }} onClick={() => { setActiveTrack("video"); setSelected(null); seek(0); }} title={asset.name}><Film size={12}/><span>{asset.name}</span></button>}
                  {id === "transcript" && cues.map(c => <button key={c.id} type="button" className={`media-editor-track-clip transcript-clip ${selected === c.id ? "selected" : ""} media-editor-draggable-clip`} style={{ left: `${pct(c.startMs)}%`, width: `${Math.max(.7, pct(c.endMs - c.startMs))}%`, touchAction: "none", cursor: "grab" }} onClick={() => { if (timelineDragMoved.current) { timelineDragMoved.current = false; return; } setActiveTrack("transcript"); setSelected(c.id); seek(c.startMs); }} onPointerDown={e => beginCueDrag(e, c, "move")} title={c.text || "Trecho sem texto"}><span>{c.text || "Trecho"}</span><span role="presentation" title="Ajustar início" onPointerDown={e => { e.stopPropagation(); beginCueDrag(e as unknown as ReactPointerEvent<HTMLButtonElement>, c, "start"); }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize", zIndex: 2, background: "rgba(255,255,255,.22)", borderRadius: "inherit" }}/><span role="presentation" title="Ajustar fim" onPointerDown={e => { e.stopPropagation(); beginCueDrag(e as unknown as ReactPointerEvent<HTMLButtonElement>, c, "end"); }} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize", zIndex: 2, background: "rgba(255,255,255,.22)", borderRadius: "inherit" }}/></button>)}
                  {id === "translation" && (translations.length ? translations.map(t => <button key={t.id} className={"media-editor-track-clip translation-clip " + (selected === t.id ? "selected" : "")} style={{ left: pct(t.startMs) + "%", width: Math.max(.7, pct(t.endMs - t.startMs)) + "%" }} onClick={() => { setActiveTrack("translation"); setSelected(t.id); seek(t.startMs); }} title={t.text}><span>{t.text}</span></button>) : <span className="media-editor-track-empty">Traduções aparecerão aqui</span>)}
                  {id === "wordbyword" && (cues.some(c => c.wordAlignment === "whisperx" && c.words?.length) ? cues.filter(c => c.wordAlignment === "whisperx").flatMap(c => (c.words ?? []).map((word, index) => ({ cue: c, word, index }))).map(({ cue, word, index }) => <button key={cue.id + "-word-" + index} className="media-editor-track-clip wordbyword-clip" style={{ left: pct(word.startMs) + "%", width: Math.max(.35, pct(word.endMs - word.startMs)) + "%" }} onClick={() => { setActiveTrack("wordbyword"); setSelected(cue.id); seek(word.startMs); }} title={word.text}><span>{word.text}</span></button>) : <span className="media-editor-track-empty">Alinhe os blocos para exibir as palavras</span>)}
                  <div className="media-editor-lane-playhead" style={{ left: `${pct(current)}%` }}/>
                </div>
              </div>)}
            </div>
            <input className="media-editor-scrubber" aria-label="Navegar pela timeline" type="range" min="0" max={Math.max(1, duration)} step="50" value={Math.min(current, duration || current)} onChange={e => seek(Number(e.target.value))}/>
          </section>
        </main>

        <aside className="media-editor-inspector">
          <div className="media-editor-inspector-head">
            <span className="eyebrow">PROPRIEDADES</span>
            <h3>{trackNames.find(t => t.id === activeTrack)?.label}</h3>
            <p>Selecione um elemento na timeline para editar suas propriedades.</p>
          </div>

          {activeTrack === "video" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-card"><Film size={18}/><strong>{asset.name}</strong><span>Mídia de origem do projeto</span></div>
            <div className="media-editor-property"><span>Duração</span><strong>{fmt(duration)}</strong></div>
            <div className="media-editor-property"><span>Posição atual</span><strong>{fmt(current)}</strong></div>
            <div className="media-editor-inspector-note">O clipe original é preservado. Os recortes e posicionamentos da timeline serão configurados como elementos independentes, sem modificar o arquivo-fonte.</div>
          </div>}

          {activeTrack === "transcript" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Transcrição</strong><button className="primary-button" onClick={addCue} disabled={loading}><Plus size={13}/> Novo trecho</button></div>
              {chosen ? <>
                <div className="media-editor-time-fields">
                  <label>Início (ms)<input type="number" min="0" value={chosen.startMs} onChange={e => updateCue(chosen.id, { startMs: Math.max(0, Math.min(Number(e.target.value), chosen.endMs - 100)) })}/></label>
                  <label>Fim (ms)<input type="number" min="1" value={chosen.endMs} onChange={e => updateCue(chosen.id, { endMs: Math.max(chosen.startMs + 100, Number(e.target.value)) })}/></label>
                </div>
                <label className="media-editor-text-label">Texto reconhecido<textarea value={chosen.text} onChange={e => updateCue(chosen.id, { text: e.target.value })} placeholder="Texto da transcrição..."/></label>
                {chosen.words && chosen.words.length > 1 ? <div className="media-editor-inspector-section" style={{ marginTop: 12 }}>
                  <div className="media-editor-section-title"><strong>Dividir este trecho</strong><span className="media-editor-translation-count">{chosen.words.length} palavras</span></div>
                  <p className="media-editor-translation-help">Escolha a palavra que inicia a próxima fala. O corte será feito entre as palavras e os tempos originais serão preservados.</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {chosen.words.slice(1).map((word, index) => <button key={chosen.id + "-split-" + index} type="button" className="media-editor-secondary-action" onClick={() => void splitCueAtWord(index + 1)} disabled={saving || aligning} title={`Dividir antes de "${word.text.trim()}"`}>Dividir antes de “{word.text.trim()}”</button>)}
                  </div>
                </div> : <div className="media-editor-inspector-note">Para dividir com precisão, alinhe este trecho com o WhisperX. Depois, escolha a palavra que inicia a próxima fala.</div>}

                <div className="media-editor-cue-buttons"><button onClick={() => seek(chosen.startMs)}><Clock3 size={13}/> Ir ao início</button><button className="danger" onClick={() => { setCues(items => items.filter(c => c.id !== chosen.id)); setEditorialResult(null); setSelected(null); setSaved(false); setDirty(true); }}><Trash2 size={13}/> Excluir trecho</button></div>
                <div className="media-editor-inspector-note">{chosen.wordAlignment === "whisperx" ? (chosen.words?.length ?? 0) + " palavras alinhadas pelo WhisperX." : (chosen.words?.length ?? 0) + " palavras identificadas pelo mecanismo de transcrição. O alinhamento preciso ainda está pendente."}</div>
              </> : <div className="media-editor-no-cue"><Captions size={22}/><strong>Nenhum trecho selecionado</strong><span>Selecione um bloco na faixa ou crie um novo trecho.</span></div>}
            </div>
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Gerar transcrição</strong></div>
              <div className="media-editor-transcription-options">
                <label>Modo<select value={transcriptionMode} onChange={e => setTranscriptionMode(e.target.value as "auto" | "cloud" | "local")}><option value="auto">Automático (Groq + fallback)</option><option value="cloud">Nuvem (Groq Whisper)</option><option value="local">Local (Faster-Whisper)</option></select></label>
                <label>Idioma<select value={transcriptionLanguage} onChange={e => setTranscriptionLanguage(e.target.value)}><option value="">Detectar automaticamente</option><option value="pt">Português</option><option value="en">Inglês</option><option value="es">Espanhol</option><option value="fr">Francês</option><option value="de">Alemão</option><option value="it">Italiano</option></select></label>
                {(transcriptionMode === "local" || transcriptionMode === "auto") && <label>Modelo local<select value={transcriptionModel} onChange={e => setTranscriptionModel(e.target.value)}><option value="tiny">Tiny · mais rápido</option><option value="base">Base</option><option value="small">Small · equilibrado</option><option value="medium">Medium</option><option value="large-v3">Large v3 · mais preciso</option></select></label>}
              </div>
              {(transcriptionMode === "local" || transcriptionMode === "auto") && <div className="media-editor-asr-status"><span>{localAsrChecking ? "Verificando mecanismo local..." : localAsrReady ? "Faster-Whisper instalado" : "Faster-Whisper não instalado"}</span>{!localAsrChecking && !localAsrReady && <button onClick={() => void installLocalAsr()} disabled={installingAsr}>{installingAsr ? "Instalando..." : "Instalar suporte local"}</button>}</div>}
              <button className="primary-button media-editor-transcribe-button" onClick={() => void transcribe()} disabled={loading || transcribing || (transcriptionMode === "local" && !localAsrReady)}><Captions size={15}/>{transcribing ? "Transcrevendo..." : "Iniciar transcrição"}</button>
              {transcriptionInfo && <p className="media-editor-transcription-info">{transcriptionInfo}</p>}
            </div>
          </div>}

          {activeTrack === "translation" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Tradução para PT-BR</strong><span className="media-editor-translation-count">{translations.length}/{cues.length}</span></div>
              <p className="media-editor-translation-help">A tradução e as predições editoriais seguem o contrato 1.3. Groq e IA externa recebem a mesma entrada e as mesmas regras.</p>
              <div className="media-editor-contract-options">
                <label><input type="checkbox" checked={includeWordTranslations} disabled={Boolean(editorialResult)} onChange={e => { setIncludeWordTranslations(e.target.checked); if (!e.target.checked) setIncludeSemanticUnits(false); }}/> Traduções palavra por palavra</label>
                <label><input type="checkbox" checked={includeSemanticUnits} disabled={!includeWordTranslations || Boolean(editorialResult)} onChange={e => setIncludeSemanticUnits(e.target.checked)}/> Sugestões de unidades semânticas</label>
                {editorialResult && <button className="media-editor-inline-link" onClick={() => void resetEditorialDraft()}>Reconfigurar predições</button>}
              </div>
              <button className="primary-button media-editor-transcribe-button" onClick={() => void translateAll()} disabled={loading || translating || cues.length === 0}><Languages size={15}/>{translating ? "Traduzindo..." : translations.length ? "Gerar tradução novamente" : "Traduzir com Groq"}</button>
              {translationStream && <div style={{ marginTop: 10, padding: 10, borderRadius: 8, border: "1px solid var(--border-subtle, #343a46)", background: "var(--panel-muted, rgba(127,127,127,.06))" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6, fontSize: 12, fontWeight: 700 }}>
                  <span>{translating ? "Groq · resposta em streaming" : "Último trecho recebido"}</span>
                  <span>{translationStream.cueId}</span>
                </div>
                <pre style={{ margin: 0, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.45 }}>{translationStream.text}</pre>
              </div>}
              <button className="media-editor-secondary-action" onClick={() => void downloadExternalPackage()} disabled={loading || preparingExternalPackage || cues.length === 0}><Download size={14}/>{preparingExternalPackage ? "Preparando pacote..." : "Baixar pacote para IA externa"}</button>
              {editorialResult && <div className="media-editor-editorial-status">
                <span>{editorialResult.approval === "approved" ? "Resultado aprovado" : "Resultado aguardando revisão humana"}</span>
                {editorialResult.approval === "draft" && <button className="media-editor-secondary-action" onClick={() => void approveEditorial()} disabled={loading || saving || dirty || translationDirty}>Aprovar resultado revisado</button>}
              </div>}
              <input ref={translationFileInput} type="file" accept=".json,application/json" hidden onChange={e => void importTranslations(e.target.files?.[0])}/>
              <button className="media-editor-secondary-action" onClick={() => translationFileInput.current?.click()} disabled={loading || cues.length === 0}>Importar resultado JSON</button>
              {translationInfo && <p className="media-editor-transcription-info">{translationInfo}</p>}
            </div>
            {chosen ? <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Trecho selecionado</strong><button className="media-editor-inline-link" onClick={() => { setActiveTrack("transcript"); seek(chosen.startMs); }}>Ver original</button></div>
              <div className="media-editor-source-text">{selectedEditorialSuggestion?.approved_en || chosen.text}</div>
              {selectedEditorialSuggestion && <div className="media-editor-inspector-section" style={{ marginTop: 12, padding: 12, border: "1px solid var(--border-subtle, #343a46)", borderRadius: 10 }}>
                <div className="media-editor-section-title"><strong>Prévia da tradução editorial</strong><span className="media-editor-translation-count">Contrato 1.3</span></div>
                <div className="media-editor-source-text" style={{ marginTop: 8 }}>{selectedEditorialSuggestion.approved_en || chosen.text}</div>
                <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, fontWeight: 600 }}>{selectedEditorialSuggestion.approved_pt || translations.find(t => t.id === chosen.id)?.text || "Tradução ainda não disponível"}</div>
              </div>}
              <label className="media-editor-text-label">Tradução em português<textarea value={translations.find(t => t.id === chosen.id)?.text ?? ""} onChange={e => {
                const existing = translations.find(t => t.id === chosen.id);
                if (existing) updateTranslation(chosen.id, e.target.value);
                else { setTranslations(items => [...items, { id: chosen.id, startMs: chosen.startMs, endMs: chosen.endMs, text: e.target.value }].sort((a,b) => a.startMs-b.startMs)); setEditorialResult(current => current ? { ...current, approval: "draft" } : null); setTranslationDirty(true); setDirty(true); setSaved(false); }
              }} placeholder="A tradução deste trecho aparecerá aqui..."/></label>
              <div className="media-editor-inspector-note">Editar esta tradução não modifica o texto reconhecido nem os tempos da transcrição.</div>
            </div> : <div className="media-editor-no-cue"><Languages size={22}/><strong>Nenhum trecho selecionado</strong><span>Selecione um bloco na faixa de tradução ou na transcrição.</span></div>}
          </div>}
          {activeTrack === "wordbyword" && <div className="media-editor-inspector-content">
            <div className="media-editor-inspector-section">
              <div className="media-editor-section-title"><strong>Sincronização palavra por palavra</strong><span className="media-editor-translation-count">{cues.filter(c => c.wordAlignment === "whisperx").length}/{cues.length} blocos</span></div>
              <p className="media-editor-translation-help">O WhisperX calcula os tempos de cada palavra usando o áudio original e o texto transcrito. Os blocos já alinhados são preservados e ignorados nas próximas execuções.</p>
              <button className="primary-button media-editor-transcribe-button" onClick={() => void alignWords()} disabled={loading || saving || aligning || cues.length === 0}>
                <Clock3 size={15}/>{aligning ? "Alinhando palavras..." : "Alinhar palavras com WhisperX"}
              </button>
              {alignmentInfo && <p className="media-editor-transcription-info">{alignmentInfo}</p>}
              <div className="media-editor-inspector-note">{cues.reduce((total, cue) => total + (cue.wordAlignment === "whisperx" ? cue.words?.length ?? 0 : 0), 0)} palavras sincronizadas. Cada bloco concluído é salvo imediatamente no projeto.</div>
              {chosen && <div className="media-editor-source-text">{chosen.text}</div>}
            </div>
          </div>}
        </aside>
      </div>
    </section>
  </div>;
}
