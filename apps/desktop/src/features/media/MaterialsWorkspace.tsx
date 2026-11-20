import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import {
  AudioLines, BookOpen, Check, CheckCircle2, Download, FileAudio, FileText, Layers3,
  LoaderCircle, Plus, RefreshCw, Save, Sparkles, Trash2, Volume2
} from "lucide-react";
import "./MaterialsWorkspace.css";
import { runTrackedTask } from "../tasks/TaskCenter";
import PredictionListening from "./PredictionListening";
import SmartLearningMoments from "./SmartLearningMoments";
import Day1Preparation, { type Day1PreparationData } from "./Day1Preparation";
import Day2ListeningRecall from "./Day2ListeningRecall";
import Day3NoticeInContext from "./Day3NoticeInContext";
import Day4DeepListening from "./Day4DeepListening";
import Day5SpeakCompare from "./Day5SpeakCompare";
import Day6Day7Challenge from "./Day6Day7Challenge";
import { buildSmartLearningSource, validateSmartLearningMoments, type SmartLearningMomentsPackage } from "./smart-learning-moments-contract";
import { buildLearningJourneyPackage, validateLearningJourney, validateLearningJourneyDraft, type LearningJourneyPackage } from "./learning-journey-contract";
import type { DeepListeningTask, ListeningQuestion, MicroLesson, SpeakingPrompt } from "./learning-journey-contract";

type Asset = { id: string; name: string; kind: string; durationMs?: number | null; sourceVideoId?: string | null };
type Cue = { id: string; text: string; startMs: number; endMs: number; speaker?: string; wordAlignment?: string | null; words?: { text: string; startMs: number; endMs: number }[] };
type Translation = { id: string; text: string };
type SourceType = "editorial" | "shadowing" | "prediction" | "manual";
type AnkiCard = {
  id: string;
  key: string;
  sourceCueId: string;
  sourceType: SourceType;
  type: string;
  focus: string;
  meaning: string;
  highlightEn: string;
  markedEn: string;
  highlightPt: string;
  markedPt: string;
  explanation: string;
  exampleEn: string;
  examplePt: string;
  speaker: string;
  audioText: string;
  audioPath?: string;
  audioSource?: "tts" | "video";
  sourceStartMs?: number;
  sourceEndMs?: number;
  status: "draft" | "approved";
};
type PedagogicalLayer = { context: string; usage: string; example_en: string; example_pt: string; nuance?: string };
type PedagogicalItem = { id: string; cue_order: number; start_ms: number; end_ms: number; type: string; expression: string; meaning_pt: string; explanation_pt: string; source_en: string; source_pt: string; layers: PedagogicalLayer[]; include_in_hub?: boolean };
type PedagogicalContentPackage = { contract: "ihub-pedagogical-content/1.0"; title: string; language: string; source_hash: string; minimum_items: number; items: PedagogicalItem[]; editorial_signature?: string };
type MaterialDocument = { version: 1 | 2; projectId?: string; assetId?: string; assetName?: string; sourceVideoId?: string | null; cards: AnkiCard[]; updatedAt?: string; sourceSignature?: string; learningJourney?: LearningJourneyPackage; pedagogicalContent?: PedagogicalContentPackage; smartLearningMoments?: SmartLearningMomentsPackage };
type AudioResult = { cardId: string; audioPath: string; sampleRate: number; language: string; speaker: string };
type SharedVoice = { id: string; name: string; mode?: "voice_clone" | "voice_design" };
function learningJourneySourceSignature(sourceSignature: string, cards: AnkiCard[]) {
  return JSON.stringify([
    sourceSignature,
    cards.filter(card => card.status === "approved").map(card => [
      card.id, card.sourceCueId, card.type, card.focus, card.meaning, card.highlightEn,
      card.explanation, card.exampleEn, card.examplePt
    ])
  ]);
}


const MATERIAL_TTS_LANGUAGE = "English" as const;
const createCardId = () => crypto.randomUUID();
const newCard = (): AnkiCard => {
  const id = createCardId();
  return {
    id, key: "anki-" + id, sourceCueId: "", sourceType: "manual", type: "expression",
    focus: "", meaning: "", highlightEn: "", markedEn: "", highlightPt: "", markedPt: "",
    explanation: "", exampleEn: "", examplePt: "", speaker: "", audioText: "", status: "draft"
  };
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const normalizeCardType = (value: unknown) => {
  const candidate = text(value).trim();
  return !candidate || /^(shadowing|listening|editorial|manual)$/i.test(candidate) ? "expression" : candidate;
};
const highlightedText = (sentence: string, target: string) => {
  if (!sentence || !target) return sentence;
  const start = sentence.toLocaleLowerCase().indexOf(target.toLocaleLowerCase());
  if (start < 0) return sentence;
  const end = start + target.length;
  return <>{sentence.slice(0, start)}<mark className="materials-preview-highlight">{sentence.slice(start, end)}</mark>{sentence.slice(end)}</>;
};
const buildEnrichmentPayload = (projectId: string, assetId: string, sourceVideoId: string | null, sourceSignature: string, cards: AnkiCard[], cues: Cue[], translations: Translation[]) => ({
  contract: "nova-generator-materials-enrichment-input/1.0",
  project_id: projectId, asset_id: assetId, source_video_id: sourceVideoId, source_signature: sourceSignature,
  items: cards.map(card => {
    const cue = cues.find(item => item.id === card.sourceCueId);
    const translation = translations.find(item => item.id === card.sourceCueId)?.text ?? "";
    return {
      card_id: card.id, source_type: card.sourceType, source_cue_id: card.sourceCueId || null,
      start_ms: cue?.startMs ?? card.sourceStartMs ?? null, end_ms: cue?.endMs ?? card.sourceEndMs ?? null,
      source_en: cue?.text ?? "", source_pt: translation,
      focus_en: card.focus, focus_pt: card.meaning, highlight_en: card.highlightEn, highlight_pt: card.highlightPt,
      card_type: card.type
    };
  })
});
const hashPayload = async (value: unknown) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
};
const mergeSourceCards = (stored: AnkiCard[], generated: AnkiCard[]) => {
  const used = new Set<string>();
  const merged = generated.map(next => {
    const match = stored.find(card => !used.has(card.id) && (card.key === next.key || (card.sourceType === next.sourceType && card.sourceCueId === next.sourceCueId && card.focus === next.focus)));
    if (!match) return next;
    used.add(match.id);
    return { ...next, ...match, type: ["shadowing", "listening"].includes(text(match.type).toLowerCase()) ? next.type : match.type, key: next.key, sourceCueId: next.sourceCueId, sourceType: next.sourceType, sourceStartMs: next.sourceStartMs, sourceEndMs: next.sourceEndMs };
  });
  return [...merged, ...stored.filter(card => !used.has(card.id))];
};
const normalizeStoredCard = (raw: any): AnkiCard => {
  const id = text(raw?.id) || createCardId();
  const focus = text(raw?.focus) || text(raw?.front);
  const meaning = text(raw?.meaning) || text(raw?.back);
  const highlightEn = text(raw?.highlightEn) || text(raw?.expression);
  const highlightPt = text(raw?.highlightPt);
  return {
    id, key: text(raw?.key) || "anki-" + id,
    sourceCueId: text(raw?.sourceCueId), sourceType: raw?.sourceType || "manual",
    type: normalizeCardType(raw?.type), focus, meaning,
    highlightEn, markedEn: text(raw?.markedEn) || highlightEn,
    highlightPt, markedPt: text(raw?.markedPt) || highlightPt,
    explanation: text(raw?.explanation),
    exampleEn: text(raw?.exampleEn),
    examplePt: text(raw?.examplePt),
    speaker: text(raw?.speaker),
    audioText: text(raw?.audioText) || focus,
    audioPath: text(raw?.audioPath) || undefined,
    audioSource: raw?.audioSource === "video" ? "video" : raw?.audioSource === "tts" ? "tts" : undefined,
    sourceStartMs: Number.isFinite(raw?.sourceStartMs) ? Number(raw.sourceStartMs) : undefined,
    sourceEndMs: Number.isFinite(raw?.sourceEndMs) ? Number(raw.sourceEndMs) : undefined,
    status: raw?.status === "approved" ? "approved" : "draft"
  };
};
const cardFromSuggestion = (item: any, cue: Cue, translation?: Translation, index = 0): AnkiCard => {
  const focus = text(item.approved_en) || cue.text;
  const highlightEn = text(item.highlight_en) || text(item.highlightEn) || text(item.expression) || text(item.highlighted_expression);
  const highlightPt = text(item.highlight_pt) || text(item.highlightPt) || text(item.expression_pt);
  const example = Array.isArray(item.examples) ? item.examples[0] : null;
  return {
    id: createCardId(), key: "source:editorial:" + cue.id + ":" + (text(item.id) || String(index)), sourceCueId: cue.id, sourceType: "editorial",
    type: normalizeCardType(item.type), focus,
    meaning: text(item.meaning) || text(item.approved_pt) || text(translation?.text),
    highlightEn, markedEn: text(item.marked) || text(item.marked_en) || highlightEn,
    highlightPt, markedPt: text(item.marked_pt) || text(item.markedPt) || highlightPt,
    explanation: text(item.mini_lesson) || text(item.explanation) || text(item.analysis),
    exampleEn: text(item.example_en) || text(item.exampleEn) || text(example?.en),
    examplePt: text(item.example_pt) || text(item.examplePt) || text(example?.pt),
    speaker: text(cue.speaker), audioText: focus, sourceStartMs: cue.startMs, sourceEndMs: cue.endMs, status: "draft"
  };
};
const cardFromPrediction = (item: any, cue: Cue, translation?: Translation): AnkiCard => {
  const id = createCardId();
  const focus = cue.text;
  const answer = text(item.answerText);
  const meaning = text(translation?.text);
  return {
    id, key: "source:prediction:" + text(item.id),
    sourceCueId: cue.id, sourceType: "prediction", type: "expression",
    focus, meaning, highlightEn: answer || text(item.highlightedText) || focus,
    markedEn: answer || text(item.markedEn) || text(item.highlightedText) || focus,
    highlightPt: "", markedPt: "", explanation: text(item.explanation),
    exampleEn: text(item.exampleEn), examplePt: text(item.examplePt),
    speaker: text(cue.speaker), audioText: focus, sourceStartMs: cue.startMs, sourceEndMs: cue.endMs, status: "draft"
  };
};
const cardFromShadowing = (cue: Cue, translation?: Translation): AnkiCard => {
  const meaning = text(translation?.text);
  return {
    id: createCardId(), key: "source:shadowing:" + cue.id, sourceCueId: cue.id,
    sourceType: "shadowing", type: "expression", focus: cue.text, meaning,
    highlightEn: cue.text, markedEn: cue.text, highlightPt: meaning, markedPt: meaning,
    explanation: "Trecho selecionado e concluído no Shadowing.",
    exampleEn: "", examplePt: "", speaker: text((cue as any).speaker), audioText: cue.text, sourceStartMs: cue.startMs, sourceEndMs: cue.endMs, status: "draft"
  };
};

type PredictionWorkspaceProps = {
  assetName: string; cues: Cue[]; selectedCueIds: string[]; sourceSignature: string; ready: boolean;
  onPreview: (startMs: number, endMs: number) => void; onPreviewModeChange: (active: boolean) => void; onDemoSeekAndPlay: (timeMs: number) => void;
  onDemoPause: () => void; onDemoResume: (timeMs: number) => void; getCurrentTime: () => number;
};
export default function MaterialsWorkspace({ projectId, initialAssetId, onProjectUpdated, prediction }: {
  projectId: string; initialAssetId?: string; onProjectUpdated?: () => void; prediction?: PredictionWorkspaceProps;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [cards, setCards] = useState<AnkiCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [audioBusy, setAudioBusy] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [learningJourney, setLearningJourney] = useState<LearningJourneyPackage | null>(null);
  const [pedagogicalContent, setPedagogicalContent] = useState<PedagogicalContentPackage | null>(null);
  const [smartLearningMoments, setSmartLearningMoments] = useState<SmartLearningMomentsPackage | null>(null);
  const [pedagogicalProcessing, setPedagogicalProcessing] = useState(false);
  const [pedagogicalFileName, setPedagogicalFileName] = useState("");
  const [activeMaterialTab, setActiveMaterialTab] = useState<"pedagogical" | "anki">("pedagogical");
  const [activePedagogicalTab, setActivePedagogicalTab] = useState<"smart" | "vocabulary" | "prediction" | "journey">("smart");
  const [selectedJourneyDay, setSelectedJourneyDay] = useState<number | null>(null);
  const [voices, setVoices] = useState<SharedVoice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [voiceCloningReady, setVoiceCloningReady] = useState(false);
  const [sourceInfo, setSourceInfo] = useState({ cues: 0, translations: 0, editorial: 0, shadowing: 0, predictions: 0 });
  const [sourceSignature, setSourceSignature] = useState("");
  const [sourceCues, setSourceCues] = useState<Cue[]>([]);
  const [sourceTranslations, setSourceTranslations] = useState<Translation[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const pedagogicalInput = useRef<HTMLInputElement>(null);

  const selectedAsset = useMemo(() => assets.find(item => item.id === assetId), [assets, assetId]);
  const includedPedagogicalCount = pedagogicalContent?.items.filter(item => item.include_in_hub !== false).length ?? 0;
  const approvedCards = useMemo(() => cards.filter(card => card.status === "approved"), [cards]);
  const approvedCount = approvedCards.length;
  const pendingAudioCount = approvedCards.filter(card => !card.audioPath).length;
  const refreshAssets = useCallback(async () => {
    const items = await invoke<Asset[]>("list_project_media", { projectId });
    const videos = items.filter(item => item.kind === "video");
    setAssets(videos);
    setAssetId(current => current && videos.some(item => item.id === current) ? current : (videos.some(item => item.id === initialAssetId) ? initialAssetId! : videos[0]?.id ?? ""));
  }, [projectId, initialAssetId]);

  const loadSource = useCallback(async (selectedId: string) => {
    if (!selectedId) {
      setCards([]);
      setLearningJourney(null);
      setPedagogicalContent(null);
      setSmartLearningMoments(null);
      setSourceInfo({ cues: 0, translations: 0, editorial: 0, shadowing: 0, predictions: 0 });
      return;
    }
    setLoading(true); setError(""); setNotice("");
    try {
      const [cues, translations, prediction, stored, savedSmartLearningMoments] = await Promise.all([
        invoke<Cue[]>("load_project_subtitles", { projectId, assetId: selectedId }),
        invoke<Translation[]>("load_project_translations", { projectId, assetId: selectedId }).catch(() => [] as Translation[]),
        invoke<any>("load_prediction_listening_result", { projectId, assetId: selectedId }).catch(() => null),
        invoke<MaterialDocument | null>("load_project_materials", { projectId, assetId: selectedId }).catch(() => null),
        invoke<SmartLearningMomentsPackage | null>("load_smart_learning_moments", { projectId, assetId: selectedId }).catch(() => null)
      ]);
      setSourceCues(cues);
      setSourceTranslations(translations);
      const editorial = await invoke<any>("load_project_editorial_result", { projectId, assetId: selectedId, cues }).catch(() => null);
      const signature = JSON.stringify([
        cues.map(c => [c.id, c.startMs, c.endMs, c.text]),
        translations.map(t => [t.id, t.text]),
        editorial?.suggestions?.map((item: any) => [item.cue_id, item.approved_en, item.approved_pt]) ?? []
      ]);
      const shadowing = await invoke<{ selectedCueIds: string[]; sourceSignature: string } | null>(
        "load_shadowing_selection", { projectId, assetId: selectedId, cues, sourceSignature: signature }
      ).catch(() => null);
      const shadowingIds = shadowing?.sourceSignature === signature ? shadowing.selectedCueIds : [];
      const translationById = new Map(translations.map(item => [item.id, item]));
      let currentPredictionHash = "";
      if (shadowingIds.length) {
        const predictionPackage = await invoke<{ sourceHash: string }>("prepare_prediction_listening_package", {
          projectId, assetId: selectedId, cues, selectedCueIds: shadowingIds, sourceSignature: signature
        }).catch(() => null);
        currentPredictionHash = predictionPackage?.sourceHash ?? "";
      }
      const isPredictionSaved = Boolean(currentPredictionHash && prediction?.contract === "nova-generator-prediction-listening-review/1.0" && prediction?.saved_at && prediction?.source_hash === currentPredictionHash);
      const materialSignature = JSON.stringify([
        signature,
        shadowingIds,
        currentPredictionHash,
        isPredictionSaved && Array.isArray(prediction?.challenges)
          ? prediction.challenges.map((item: any) => [item.id, item.status, item.answerText])
          : []
      ]);
      const savedJourney = stored?.learningJourney;
      const savedPedagogicalContent = stored?.pedagogicalContent;
setPedagogicalContent(savedPedagogicalContent?.contract === "ihub-pedagogical-content/1.0" && savedPedagogicalContent.editorial_signature === materialSignature ? savedPedagogicalContent : null);
      const smartLearningSnapshot = savedSmartLearningMoments ?? stored?.smartLearningMoments ?? null;
      setSmartLearningMoments(smartLearningSnapshot?.source_signature === materialSignature ? smartLearningSnapshot : null);
      const storedJourneySignature = learningJourneySourceSignature(materialSignature, Array.isArray(stored?.cards) ? stored.cards : []);
      const savedJourneySourceMatches = savedJourney?.source?.mediaSignature
        ? savedJourney.source.mediaSignature === materialSignature
        : savedJourney?.source?.sourceSignature === storedJourneySignature;
      setLearningJourney(savedJourney && savedJourneySourceMatches && validateLearningJourneyDraft(savedJourney).length === 0 ? savedJourney : null);
      setSourceSignature(materialSignature);
      setSourceInfo({
        cues: cues.length,
        translations: translations.length,
        editorial: editorial?.suggestions?.length ?? 0,
        shadowing: shadowingIds.length,
        predictions: isPredictionSaved && Array.isArray(prediction?.challenges) ? prediction.challenges.filter((item: any) => item.status === "approved").length : 0
      });

      const suggestions = Array.isArray(editorial?.suggestions) ? editorial.suggestions : [];
      const editorialCards = suggestions.flatMap((item: any, index: number) => {
        const cue = cues.find(candidate => candidate.id === (item.cue_id ?? item.cueId));
        if (!cue) return [];
        const card = cardFromSuggestion(item, cue, translationById.get(cue.id), index);
        return card.focus.trim() && card.meaning.trim() ? [card] : [];
      });
      const shadowingCards = shadowingIds.flatMap(id => {
        const cue = cues.find(candidate => candidate.id === id);
        if (!cue) return [];
        const card = cardFromShadowing(cue, translationById.get(cue.id));
        return card.focus.trim() && card.meaning.trim() ? [card] : [];
      });
      const predictionCards = isPredictionSaved && Array.isArray(prediction?.challenges)
        ? prediction.challenges.filter((item: any) => item.status === "approved").flatMap((item: any) => {
            const cue = cues.find(candidate => candidate.id === item.cueId);
            if (!cue) return [];
            const card = cardFromPrediction(item, cue, translationById.get(cue.id));
            return card.focus.trim() && card.meaning.trim() ? [card] : [];
          })
        : [];
      const generated = [...editorialCards, ...shadowingCards, ...predictionCards];
      const savedCards = (stored?.version === 1 || stored?.version === 2) && Array.isArray(stored.cards) ? stored.cards.map(normalizeStoredCard) : [];
      setCards(mergeSourceCards(savedCards, generated));
      if (savedCards.length && stored?.sourceSignature !== materialSignature) setNotice("As fontes mudaram. Novos cards foram incorporados; suas edições e cards anteriores foram preservados para revisão.");
    } catch (e) {
      setError(String(e)); setCards([]);
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void refreshAssets().catch(e => setError(String(e))); }, [refreshAssets]);
  useEffect(() => { if (assetId) void loadSource(assetId); else setLoading(false); }, [assetId, loadSource]);

  // Persist Smart Learning Moments independently so edits and imported audio survive
  // closing the workspace without requiring the user to save all Anki materials.
  useEffect(() => {
    if (loading || !assetId || !smartLearningMoments || smartLearningMoments.source_signature !== sourceSignature) return;
    const timeout = window.setTimeout(() => {
      void invoke("save_smart_learning_moments", {
        projectId, assetId, value: smartLearningMoments
      }).catch(error => setError("Não foi possível salvar Smart Learning Moments automaticamente: " + String(error)));
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [projectId, assetId, loading, smartLearningMoments, sourceSignature]);
  const refreshVoices = useCallback(async () => {
    const status = await invoke<any>("get_shared_runtime_status");
    const available = Array.isArray(status?.voices) ? status.voices as SharedVoice[] : [];
    setVoices(available);
    setSelectedVoiceId(current => current && available.some(voice => voice.id === current)
      ? current
      : (available.find(voice => voice.id === status?.defaultVoiceId)?.id ?? available[0]?.id ?? ""));
    setVoiceCloningReady(Boolean(status?.voiceCloningReady && available.length));
  }, []);

  useEffect(() => {
    void refreshVoices().catch(() => {
      setVoices([]);
      setSelectedVoiceId("");
      setVoiceCloningReady(false);
    });
  }, [refreshVoices]);

  function updateCard(id: string, patch: Partial<AnkiCard>) {
    setCards(current => current.map(card => {
      if (card.id !== id) return card;
      const audioTextChanged = patch.focus !== undefined || patch.audioText !== undefined;
      return {
        ...card,
        ...patch,
        audioPath: audioTextChanged ? undefined : (patch.audioPath ?? card.audioPath),
        status: patch.status ?? (Object.keys(patch).some(key => key !== "audioPath") ? "draft" : card.status)
      };
    }));
  }

  async function persistMaterials() {
    if (!assetId) throw new Error("Selecione uma mídia de origem.");
    const journeyIsCurrent = Boolean(
      learningJourney &&
      (learningJourney.source?.mediaSignature === sourceSignature ||
        learningJourney.source?.sourceSignature === learningJourneySourceSignature(sourceSignature, cards))
    );
    const document: MaterialDocument = { version: 2, projectId, assetId, assetName: selectedAsset?.name ?? "English Materials", sourceVideoId: selectedAsset?.sourceVideoId ?? null, cards, learningJourney: journeyIsCurrent ? learningJourney ?? undefined : undefined, pedagogicalContent: pedagogicalContent ?? undefined, smartLearningMoments: smartLearningMoments ?? undefined, updatedAt: new Date().toISOString(), sourceSignature };
    await invoke("save_project_materials", { projectId, assetId, materials: document });
    await invoke("update_project_stage", { id: projectId, stage: "Materiais" });
    onProjectUpdated?.();
    return document;
  }

  function updateDay1Notice(lessons: MicroLesson[]) {
    try {
      const currentJourneySignature = learningJourneySourceSignature(sourceSignature, cards);
      const base = learningJourney?.source.sourceSignature === currentJourneySignature ? learningJourney : buildLearningJourneyPackage({
        projectId, assetId, sourceSignature: currentJourneySignature, mediaSignature: sourceSignature, cues: sourceCues,
        cards: cards.map(card => ({ id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus, meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation, exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status }))
      });
      setLearningJourney({ ...base, day1NoticeLessons: lessons });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function updateDay1Preparation(data: Day1PreparationData) {
    try {
      const currentJourneySignature = learningJourneySourceSignature(sourceSignature, cards);
      const base = learningJourney?.source.sourceSignature === currentJourneySignature ? learningJourney : buildLearningJourneyPackage({
        projectId, assetId, sourceSignature: currentJourneySignature, mediaSignature: sourceSignature, cues: sourceCues,
        cards: cards.map(card => ({ id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus, meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation, exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status }))
      });
      setLearningJourney({ ...base, day1Preparation: data });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function updateDay2Activities(activities: ListeningQuestion[]) {
    try {
      const currentJourneySignature = learningJourneySourceSignature(sourceSignature, cards);
      const base = learningJourney?.source.sourceSignature === currentJourneySignature
        ? learningJourney
        : buildLearningJourneyPackage({
        projectId, assetId, sourceSignature: currentJourneySignature, mediaSignature: sourceSignature,
        cues: sourceCues,
        cards: cards.map(card => ({
          id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus,
          meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation,
          exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status
        }))
      });
      const days = base.days.map((day, index) => index === 1 ? { ...day, activities } : day) as LearningJourneyPackage["days"];
      setLearningJourney({ ...base, days });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function updateDay3Lessons(lessons: MicroLesson[]) {
    try {
      const currentJourneySignature = learningJourneySourceSignature(sourceSignature, cards);
      const base = learningJourney?.source.sourceSignature === currentJourneySignature
        ? learningJourney
        : buildLearningJourneyPackage({
          projectId, assetId, sourceSignature: currentJourneySignature, mediaSignature: sourceSignature,
          cues: sourceCues,
          cards: cards.map(card => ({
            id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus,
            meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation,
            exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status
          }))
        });
      const days = base.days.map((day, index) => index === 2 ? { ...day, lessons } : day) as LearningJourneyPackage["days"];
      setLearningJourney({ ...base, days });
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  function approvedDay3Lessons(journey: LearningJourneyPackage) {
    return journey.days[2].lessons.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }

  function updateDay4Tasks(tasks: DeepListeningTask[]) {
    try {
      const currentJourneySignature = learningJourneySourceSignature(sourceSignature, cards);
      const base = learningJourney?.source.sourceSignature === currentJourneySignature
        ? learningJourney
        : buildLearningJourneyPackage({
          projectId, assetId, sourceSignature: currentJourneySignature, mediaSignature: sourceSignature,
          cues: sourceCues,
          cards: cards.map(card => ({
            id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus,
            meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation,
            exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status
          }))
        });
      const days = base.days.map((day, index) => index === 3 ? { ...day, tasks } : day) as LearningJourneyPackage["days"];
      setLearningJourney({ ...base, days });
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  function approvedDay4Tasks(journey: LearningJourneyPackage) {
    return journey.days[3].tasks.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }

  function updateDay5Prompts(prompts: SpeakingPrompt[]) {
    try {
      const currentJourneySignature = learningJourneySourceSignature(sourceSignature, cards);
      const base = learningJourney?.source.sourceSignature === currentJourneySignature
        ? learningJourney
        : buildLearningJourneyPackage({
          projectId, assetId, sourceSignature: currentJourneySignature, mediaSignature: sourceSignature,
          cues: sourceCues,
          cards: cards.map(card => ({
            id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus,
            meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation,
            exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status
          }))
        });
      const days = base.days.map((day, index) => index === 4 ? { ...day, prompts } : day) as LearningJourneyPackage["days"];
      setLearningJourney({ ...base, days });
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  function approvedDay5Prompts(journey: LearningJourneyPackage) {
    return journey.days[4].prompts.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }

  function updateDay6Challenge(value: { listening: ListeningQuestion[]; speaking: SpeakingPrompt[]; successCriteria: string[] }) {
    if (!learningJourney) return;
    const days = learningJourney.days.map((day, index) => index === 5 ? { ...day, listening: value.listening, speaking: value.speaking } : day) as LearningJourneyPackage["days"];
    setLearningJourney({ ...learningJourney, days });
    setError("");
  }

  function updateDay7Challenge(value: { listening: ListeningQuestion[]; speaking: SpeakingPrompt[]; successCriteria: string[] }) {
    if (!learningJourney) return;
    const days = learningJourney.days.map((day, index) => index === 6 ? { ...day, listening: value.listening, speaking: value.speaking, successCriteria: value.successCriteria } : day) as LearningJourneyPackage["days"];
    setLearningJourney({ ...learningJourney, days });
    setError("");
  }

  function approvedDay6Listening(journey: LearningJourneyPackage) {
    return journey.days[5].listening.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }
  function approvedDay6Speaking(journey: LearningJourneyPackage) {
    return journey.days[5].speaking.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }
  function approvedDay7Listening(journey: LearningJourneyPackage) {
    return journey.days[6].listening.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }
  function approvedDay7Speaking(journey: LearningJourneyPackage) {
    return journey.days[6].speaking.filter(item => item.status === "approved" && item.include_in_hub !== false);
  }

  function approvedDay2Activities(journey: LearningJourneyPackage) {
    const requiredTypes = ["identify", "word-recognition", "gap", "reconstruct"];
    return journey.days[1].activities.filter(item =>
      requiredTypes.includes(item.type) &&
      (item as ListeningQuestion & { status?: string }).status === "approved" &&
      (item as ListeningQuestion & { include_in_hub?: boolean }).include_in_hub !== false
    );
  }

  function remainingJourneyDaysApproved(journey: LearningJourneyPackage) {
    const groups = [
      approvedDay3Lessons(journey),
      approvedDay4Tasks(journey),
      approvedDay5Prompts(journey),
      approvedDay6Listening(journey),
      approvedDay6Speaking(journey),
      approvedDay7Listening(journey),
      approvedDay7Speaking(journey)
    ] as Array<Array<{ status?: string }>>;
    return groups.every(items => items.length > 0 && items.every(item => item.status === "approved"));
  }

  function journeyReadyForExport(journey: LearningJourneyPackage) {
    const approved = approvedDay2Activities(journey);
    const types = new Set(approved.map(item => item.type));
    const deepModes = new Set(approvedDay4Tasks(journey).map(task => task.mode));
    return remainingJourneyDaysApproved(journey) &&
      ["identify", "word-recognition", "gap", "reconstruct"].every(type => types.has(type as any)) &&
      ["no-subtitles", "gap-fill", "connected-speech", "rhythm"].every(mode => deepModes.has(mode as any));
  }

  async function exportLearningJourney() {
    if (!learningJourney) return;
    if (learningJourney.source.sourceSignature !== learningJourneySourceSignature(sourceSignature, cards)) {
      setError("Os cards aprovados foram alterados. Regenere a jornada antes de exportar.");
      return;
    }
    if (!journeyReadyForExport(learningJourney)) {
      setError("O Day 2 pode ser revisado e salvo agora. A exportação da jornada completa será liberada quando os Dias 3 a 7 também estiverem preparados e aprovados, e houver ao menos uma atividade aprovada em cada modalidade do Day 2.");
      return;
    }
    const approvedActivities = approvedDay2Activities(learningJourney);
    const approvedLessons = approvedDay3Lessons(learningJourney);
    const approvedDeepTasks = approvedDay4Tasks(learningJourney);
    const approvedSpeakingPrompts = approvedDay5Prompts(learningJourney);
    const approvedDay6Listen = approvedDay6Listening(learningJourney);
    const approvedDay6Speak = approvedDay6Speaking(learningJourney);
    const approvedDay7Listen = approvedDay7Listening(learningJourney);
    const approvedDay7Speak = approvedDay7Speaking(learningJourney);
    const predictionReview = await invoke<any>('load_prediction_listening_result', { projectId, assetId }).catch(() => null);
    const predictionChallenges = predictionReview?.saved_at && Array.isArray(predictionReview.challenges)
      ? predictionReview.challenges.filter((item: any) => item.status === 'approved').map((item: any) => ({
          id: item.id, type: item.type, cueOrder: sourceCues.findIndex(cue => cue.id === item.cueId) + 1,
          clipStart: item.clipStartMs / 1000, pauseAt: item.pauseAtMs / 1000, resumeAt: item.resumeAtMs / 1000,
          prompt: item.prompt, choices: (item.choices || []).map((choice: any, index: number) => ({ id: item.id + '-choice-' + (index + 1), text: choice.text, isCorrect: choice.is_correct === true })),
          status: 'approved', generatedBy: 'ai', reviewedAt: predictionReview.saved_at, reviewedBy: 'Nova Generator',
          feedbackCorrect: 'Muito bem! Continue assistindo.', feedbackIncorrect: 'Ouça o trecho anterior novamente e tente outra vez.', explanation: item.explanation
        })).filter((item: any) => item.cueOrder > 0)
      : [];
    const selectedMoment = smartLearningMoments?.final_selection
      ? smartLearningMoments
      : null;
    const exportJourney = {
      ...learningJourney,
      ...(learningJourney.day1Preparation ? { day1Preparation: { ...learningJourney.day1Preparation, predictionListening: { version: 1 as const, challenges: predictionChallenges } } } : predictionChallenges.length ? { day1Preparation: { predictionListening: { version: 1 as const, challenges: predictionChallenges } } } : {}),
      ...(learningJourney.day1NoticeLessons?.length ? { day1NoticeLessons: learningJourney.day1NoticeLessons.filter(item => item.status === 'approved' && item.include_in_hub !== false) } : {}),
      ...(selectedMoment ? { smartLearningMoments: selectedMoment } : {}),
      days: learningJourney.days.map((day, index) =>
        index === 1 ? { ...day, activities: approvedActivities } :
        index === 2 ? { ...day, lessons: approvedLessons } :
        index === 3 ? { ...day, tasks: approvedDeepTasks } :
        index === 4 ? { ...day, prompts: approvedSpeakingPrompts } :
        index === 5 ? { ...day, listening: approvedDay6Listen, speaking: approvedDay6Speak } :
        index === 6 ? { ...day, listening: approvedDay7Listen, speaking: approvedDay7Speak } : day)
    };
    const errors = validateLearningJourney(exportJourney);
    if (errors.length) { setError(errors.join("\n")); return; }
    const blob = new Blob([JSON.stringify(exportJourney, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "learning-journey-" + assetId + ".json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(selectedMoment ? "Jornada completa exportada com Smart Learning Moment." : "Jornada completa exportada.");
  }

  async function saveMaterials() {
    if (!assetId || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await runTrackedTask("materials", "Salvar Materiais", () => persistMaterials());
      
    } catch { /* A Central de Processamento registra a falha. */ }
    finally { setSaving(false); }
  }

  async function generateAudio(card: AnkiCard) {
    if (!assetId || !voiceCloningReady || !selectedVoiceId || audioBusy.includes(card.id)) return;
    const audioText = card.audioText.trim() || card.focus.trim();
    if (!audioText) { setError("Preencha o texto para áudio antes de gerar."); return; }
    setAudioBusy(current => [...current, card.id]); setError(""); setNotice("");
    try {
      const audio = await runTrackedTask("materials", "Gerar áudio do card Anki", async () => {
        const result = await invoke<AudioResult[]>("generate_material_audio", {
          projectId, assetId, voiceId: selectedVoiceId, requests: [{ cardId: card.id, text: audioText, language: MATERIAL_TTS_LANGUAGE }]
        });
        const generated = result[0];
        if (!generated?.audioPath) throw new Error("O sintetizador não retornou o arquivo de áudio.");
        return generated;
      });
      setCards(current => current.map(item => item.id === card.id ? { ...item, audioPath: audio.audioPath, audioSource: "tts", speaker: audio.speaker } : item));
      
    } catch { /* A Central de Processamento registra a falha. */ }
    finally { setAudioBusy(current => current.filter(id => id !== card.id)); }
  }

  async function generateSourceAudio(card: AnkiCard) {
    if (!assetId || card.sourceStartMs == null || card.sourceEndMs == null || card.sourceEndMs <= card.sourceStartMs) return;
    setAudioBusy(current => [...current, card.id]); setError(""); setNotice("");
    try {
      const audioPath = await runTrackedTask("materials", "Extrair áudio original do card", () => invoke<string>("extract_material_source_audio", { projectId, assetId, cardId: card.id, startMs: card.sourceStartMs!, endMs: card.sourceEndMs! }));
      setCards(current => current.map(item => item.id === card.id ? { ...item, audioPath, audioSource: "video" } : item));
      
    } catch { /* A Central de Processamento registra a falha. */ }
    finally { setAudioBusy(current => current.filter(id => id !== card.id)); }
  }

  async function generatePendingAudio() {
    const pending = approvedCards.filter(card => !card.audioPath);
    if (!assetId || !voiceCloningReady || !selectedVoiceId || !pending.length || audioBusy.length) return;
    const invalid = pending.find(card => !(card.audioText.trim() || card.focus.trim()));
    if (invalid) { setError("O card " + invalid.id + " não possui texto para sintetização."); return; }
    setAudioBusy(pending.map(card => card.id)); setError(""); setNotice("");
    try {
      const result = await runTrackedTask("materials", "Gerar áudios dos cards aprovados", () => invoke<AudioResult[]>("generate_material_audio", {
        projectId, assetId, voiceId: selectedVoiceId,
        requests: pending.map(card => ({
          cardId: card.id, text: card.audioText.trim() || card.focus.trim(), language: MATERIAL_TTS_LANGUAGE
        }))
      }));
      const byId = new Map(result.map(item => [item.cardId, item]));
      setCards(current => current.map(card => {
        const generated = byId.get(card.id);
        return generated ? { ...card, audioPath: generated.audioPath, audioSource: "tts", speaker: generated.speaker } : card;
      }));
      
    } catch { /* A Central de Processamento registra a falha. */ }
    finally { setAudioBusy([]); }
  }

  async function exportPackage() {
    if (!assetId || exporting || !approvedCount) return;
    if (pendingAudioCount) { setError("Gere o áudio de todos os cards aprovados antes de exportar o pacote Anki."); return; }
    setError(""); setNotice("");
    try {
      const path = await saveFile({
        title: "Exportar pacote de Materiais",
        defaultPath: "materiais-" + assetId + ".zip",
        filters: [{ name: "Pacote de Materiais", extensions: ["zip"] }]
      });
      if (!path) return;
      setExporting(true);
      await persistMaterials();
      await runTrackedTask("materials", "Exportar pacote de Materiais", () => invoke("export_project_materials_package", { projectId, assetId, outputPath: path }));
      
    } catch { /* A Central de Processamento registra a falha. */ }
    finally { setExporting(false); }
  }

  async function createExternalInput() {
    if (!cards.length || !assetId) return;
    setError(""); setNotice("");
    try {
      const payload = buildEnrichmentPayload(projectId, assetId, selectedAsset?.sourceVideoId ?? null, sourceSignature, cards, sourceCues, sourceTranslations);
      const sourceHash = await hashPayload(payload);
      const outputContract = "nova-generator-materials-enrichment-output/1.1";
      const lines = [
        "NOVA GENERATOR | MATERIAIS DIDÁTICOS",
        "EXTERNAL AI GENERATION PACKAGE | INPUT 1.0",
        "INPUT_CONTRACT: nova-generator-materials-enrichment-input/1.0",
        "REQUIRED_OUTPUT_CONTRACT: " + outputContract,
        "SOURCE_HASH: " + sourceHash,
        "PROJECT_ID: " + projectId,
        "ASSET_ID: " + assetId,
        "VIDEO_ID: " + (selectedAsset?.sourceVideoId ?? "NOT_AVAILABLE"),
        "TOTAL_ITEMS: " + cards.length,
        "TIMING_UNIT: milliseconds, relative to the beginning of the selected video asset",
        "",
        "==============================================================",
        "1. OBJECTIVE",
        "==============================================================",
        "Prepare didactic enrichment for every supplied Anki item. Preserve the original scene and its meaning, but teach the highlighted English expression, phrasal verb, collocation, or grammatical structure.",
        "For EACH card_id, fill card_type, mini_lesson_pt, example_en, and example_pt. Classify the highlighted keyword or expression itself, not the source activity: use a precise category such as PHRASAL VERB, IDIOM, COLLOCATION, GRAMMATICAL STRUCTURE, VOCABULARY, or EXPRESSION. Never use SHADOWING, LISTENING, EDITORIAL, or another workflow/source label as card_type. Base the classification primarily on HIGHLIGHT_EN and its use in SOURCE_EN. If HIGHLIGHT_EN is NOT_AVAILABLE or contains the entire sentence, identify the most useful teachable keyword or grammar pattern within FOCUS_EN and SOURCE_EN before classifying it. If the highlighted item is a multi-word verb with a particle or preposition (for example, give up or look forward to), classify it as PHRASAL VERB. If it is a fixed figurative expression, use IDIOM; a natural word combination, COLLOCATION; a reusable grammar pattern, GRAMMATICAL STRUCTURE; an isolated word, VOCABULARY; otherwise EXPRESSION. The mini-lesson must explain meaning, form, pragmatic use, and why the expression fits the supplied scene. The new English example must be a different sentence from the source scene, natural and reusable. Translate that new example naturally into Brazilian Portuguese.",
        "",
        "2. STRICT SOURCE AND TIMING RULES",
        "Do not modify card_id, source_cue_id, start_ms, end_ms, source_en, source_pt, focus_en, focus_pt, highlight_en, or highlight_pt. You MUST return a newly classified card_type for every item.",
        "Never invent, estimate, shift, round, or renumber timestamps. Copy IDs and source timing exactly. If start_ms or end_ms is null, keep it null.",
        "The timestamps identify the original audio segment to be played with the Anki card. They must remain attached to the same card.",
        "Do not use the original scene sentence as the additional example. Keep the original scene only as source context.",
        "",
        "3. REQUIRED OUTPUT",
        "Return ONLY valid JSON, without Markdown or commentary, using the exact contract and SOURCE_HASH below.",
        JSON.stringify({ contract: outputContract, source_hash: sourceHash, items: cards.map(card => ({ card_id: card.id, card_type: "", mini_lesson_pt: "", example_en: "", example_pt: "" })) }, null, 2),
        "",
        "4. SOURCE ITEMS"
      ];
      payload.items.forEach((item, index) => {
        lines.push("", "[ITEM " + String(index + 1).padStart(4, "0") + "]",
          "CARD_ID: " + item.card_id, "SOURCE_TYPE: " + item.source_type,
          "SOURCE_CUE_ID: " + (item.source_cue_id ?? "NOT_AVAILABLE"),
          "START_MS: " + (item.start_ms ?? "NOT_AVAILABLE"), "END_MS: " + (item.end_ms ?? "NOT_AVAILABLE"),
          "SOURCE_EN: " + (item.source_en || "NOT_AVAILABLE"), "SOURCE_PT: " + (item.source_pt || "NOT_AVAILABLE"),
          "FOCUS_EN: " + (item.focus_en || "NOT_AVAILABLE"), "FOCUS_PT: " + (item.focus_pt || "NOT_AVAILABLE"),
          "HIGHLIGHT_EN: " + (item.highlight_en || "NOT_AVAILABLE"), "HIGHLIGHT_PT: " + (item.highlight_pt || "NOT_AVAILABLE"),
          "CARD_TYPE: " + (item.card_type || "NOT_AVAILABLE"));
      });
      const path = await saveFile({ title: "Salvar entrada de enriquecimento dos Materiais", defaultPath: "materiais-entrada-ia.txt", filters: [{ name: "Texto para IA externa", extensions: ["txt"] }] });
      if (!path) return;
      await runTrackedTask("materials", "Preparar entrada para IA externa", () => invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode(lines.join("\n"))) }));
    } catch { /* A Central de Processamento registra a falha. */ }
  }

  async function importExternalResult(file?: File) {
    if (!file) return;
    setError(""); setNotice("");
    try {
      await runTrackedTask("materials", "Importar classificação e enriquecimento da IA", async () => {
        const parsed = JSON.parse(await file.text());
        if (parsed?.contract !== "nova-generator-materials-enrichment-output/1.1") throw new Error("Contrato de saída inválido. Importe o JSON gerado a partir do TXT de Materiais.");
        const payload = buildEnrichmentPayload(projectId, assetId, selectedAsset?.sourceVideoId ?? null, sourceSignature, cards, sourceCues, sourceTranslations);
        const expectedHash = await hashPayload(payload);
        if (parsed.source_hash !== expectedHash) throw new Error("SOURCE_HASH não corresponde aos cards e tempos atuais. Gere uma nova entrada TXT.");
        if (!Array.isArray(parsed.items) || parsed.items.length !== cards.length) throw new Error("O JSON precisa retornar exatamente um item para cada card enviado.");
        const returned = new Map<string, any>();
        for (const item of parsed.items) {
          if (!item || typeof item.card_id !== "string" || returned.has(item.card_id)) throw new Error("Há card_id ausente ou duplicado no retorno.");
          if (![item.card_type, item.mini_lesson_pt, item.example_en, item.example_pt].every(value => typeof value === "string" && value.trim())) throw new Error("Cada item precisa conter card_type, mini_lesson_pt, example_en e example_pt preenchidos.");
          returned.set(item.card_id, item);
        }
        const expectedIds = new Set(cards.map(card => card.id));
        if (returned.size !== expectedIds.size || [...returned.keys()].some(id => !expectedIds.has(id))) throw new Error("Os IDs do JSON não correspondem aos cards atuais.");
        setCards(current => current.map(card => {
          const result = returned.get(card.id)!;
          return { ...card, type: normalizeCardType(result.card_type).toUpperCase(), explanation: result.mini_lesson_pt, exampleEn: result.example_en, examplePt: result.example_pt, status: "draft" };
        }));
      });
      
    } catch { /* A Central de Processamento registra a falha. */ }
    finally { if (importInput.current) importInput.current.value = ""; }
  }


  function buildPedagogicalInput() {
    if (!assetId || sourceCues.length < 1) throw new Error("A transcrição revisada é necessária.");
    const source = {
      project_id: projectId, asset_id: assetId, source_signature: sourceSignature,
      cues: sourceCues.map((cue, index) => ({
        cue_order: index + 1, cue_id: cue.id, start_ms: Math.round(cue.startMs), end_ms: Math.round(cue.endMs),
        speaker: cue.speaker ?? "", text_en: cue.text,
        text_pt: sourceTranslations.find(item => item.id === cue.id)?.text ?? ""
      }))
    };
    return hashPayload(source).then(sourceHash => ({ source, sourceHash }));
  }

  async function generatePedagogicalInput() {
    if (!assetId || !sourceCues.length || loading || pedagogicalProcessing) return;
    setError(""); setNotice("");
    try {
      const { source, sourceHash } = await buildPedagogicalInput();
      const lines = [
        "NOVA GENERATOR | CONTEÚDO PEDAGÓGICO",
        "INSTRUÇÕES PARA IA EXTERNA | RECONHECIMENTO CONTEXTUAL DO VOCABULÁRIO",
        "REQUIRED_OUTPUT_CONTRACT: ihub-pedagogical-content/1.0",
        "SOURCE_HASH: " + sourceHash,
        "PROJECT_ID: " + projectId,
        "ASSET_ID: " + assetId,
        "VIDEO_ID: " + (selectedAsset?.sourceVideoId ?? "NOT_AVAILABLE"),
        "TIMING_UNIT: milliseconds, relative to the selected media asset",
        "",
        "OBJETIVO",
        "Analise integralmente a transcrição revisada abaixo. Extraia expressões e estruturas que realmente ajudem um estudante de inglês a compreender e reutilizar o idioma: vocabulário, phrasal verbs, idioms, collocations, estruturas gramaticais, discourse markers, expressões fixas e padrões de frase.",
        "Selecione PELO MENOS 5 itens distintos. Priorize unidades úteis, naturais, reutilizáveis e relevantes para a cena. Não escolha palavras triviais apenas para atingir o mínimo.",
        "",
        "INTEGRIDADE DA FONTE",
        "A transcrição já foi revisada e seus tempos são definitivos. Não reescreva, reordene, una, divida ou altere nenhuma cue. Cada item deve apontar para cue_order e copiar start_ms/end_ms exatamente da cue correspondente. Não invente citações. Use a tradução em português apenas como apoio contextual.",
        "",
        "MAPA DE USO EM CAMADAS",
        "Para CADA item, crie pelo menos 3 camadas que representem situações comunicativas realmente diferentes. Não repita a mesma ideia trocando apenas nomes.",
        "Cada camada deve conter: context (situação curta), usage (quando e por que alguém usaria a expressão), example_en (frase original e natural) e example_pt (tradução natural em português brasileiro). Inclua nuance quando houver diferença de registro, tom, gramática ou sentido.",
        "Demonstre variedade de interlocutores, situações, tempos verbais ou funções pragmáticas quando fizer sentido. Preserve o significado central e explique mudanças reais de sentido.",
        "",
        "QUALIDADE PEDAGÓGICA",
        "Classifique cada item usando exatamente uma categoria: vocabulary, phrasal_verb, idiom, collocation, grammatical_structure, discourse_marker, expression ou sentence_pattern.",
        "Priorize expressões com várias palavras e padrões reutilizáveis em vez de palavras isoladas. Evite duplicatas, sobreposição e traduções literais enganosas. Os exemplos não podem copiar a frase da cena.",
        "Escreva explicações claras em português brasileiro, adequadas a estudantes iniciantes, sem reduzir a explicação a uma tradução.",
        "",
        "FORMATO DE SAÍDA OBRIGATÓRIO",
        "Retorne SOMENTE JSON válido, sem Markdown ou comentários. Preserve o SOURCE_HASH exatamente. Siga este contrato:",
        JSON.stringify({
          contract: "ihub-pedagogical-content/1.0", title: "Contextual Vocabulary Recognition", language: "en",
          source_hash: sourceHash, minimum_items: 5,
          items: [{
            id: "stable-item-id", cue_order: 1, start_ms: 0, end_ms: 1000,
            type: "phrasal_verb", expression: "figure out", meaning_pt: "descobrir; entender",
            explanation_pt: "Explicação clara do significado e do uso.",
            source_en: "Exact excerpt from the cited cue.", source_pt: "Tradução da fala de origem.",
            layers: [
              { context: "Solving a problem", usage: "When someone needs to find an answer.", example_en: "I need to figure out how this works.", example_pt: "Preciso descobrir como isso funciona.", nuance: "Informal and common in conversation." },
              { context: "Understanding a situation", usage: "When someone is trying to understand what happened.", example_en: "She finally figured out the reason.", example_pt: "Ela finalmente entendeu o motivo." },
              { context: "Making a decision", usage: "When someone needs time to decide a practical next step.", example_en: "We will figure out what to do tomorrow.", example_pt: "Vamos descobrir o que fazer amanhã." }
            ]
          }]
        }, null, 2),
        "",
        "TRANSCRIÇÃO REVISADA"
      ];
      source.cues.forEach(cue => lines.push(
        "", "[CUE " + String(cue.cue_order).padStart(4, "0") + "]",
        "CUE_ORDER: " + cue.cue_order, "CUE_ID: " + cue.cue_id,
        "START_MS: " + cue.start_ms, "END_MS: " + cue.end_ms,
        "SPEAKER: " + (cue.speaker || "NOT_AVAILABLE"), "EN: " + cue.text_en,
        "PT: " + (cue.text_pt || "NOT_AVAILABLE")
      ));
      const path = await saveFile({
        title: "Salvar instruções do conteúdo pedagógico",
        defaultPath: "conteudo-pedagogico-" + assetId + "-instrucoes.txt",
        filters: [{ name: "Instruções para IA externa", extensions: ["txt"] }]
      });
      if (!path) return;
      const bytes = Array.from(new TextEncoder().encode("\uFEFF" + lines.join("\r\n")));
      await runTrackedTask("materials", "Salvar instruções do conteúdo pedagógico", () =>
        invoke("save_external_translation_package", { path, bytes })
      );
      setNotice("Arquivo TXT salvo com as instruções completas e " + source.cues.length + " trechos da transcrição revisada. Envie-o à IA e importe o JSON de resposta.");
    } catch (e) { setError(String(e)); }
  }

  async function importPedagogicalContent(file?: File) {
    if (!file || !assetId || pedagogicalProcessing) return;
    setError(""); setNotice(""); setPedagogicalProcessing(true);
    setPedagogicalFileName(file.name);
    try {
      await runTrackedTask("materials", "Validar e processar conteúdo pedagógico", async () => {
        if (file.size > 8 * 1024 * 1024) throw new Error("O JSON excede o limite de 8 MB.");
        const parsed = JSON.parse(await file.text()) as PedagogicalContentPackage;
        if (parsed?.contract !== "ihub-pedagogical-content/1.0") throw new Error("Contrato inválido. Use o JSON gerado a partir do TXT desta transcrição.");
        const { sourceHash } = await buildPedagogicalInput();
        if (parsed.source_hash !== sourceHash) throw new Error("A transcrição ou os tempos mudaram. Baixe um novo TXT e gere novamente o JSON.");
        if (!Array.isArray(parsed.items) || parsed.items.length < 5) throw new Error("O conteúdo precisa conter pelo menos cinco itens pedagógicos.");
        const allowedTypes = new Set(["vocabulary", "phrasal_verb", "idiom", "collocation", "grammatical_structure", "discourse_marker", "expression", "sentence_pattern"]);
        const seen = new Set<string>();
        for (const item of parsed.items) {
          const expression = text(item.expression).trim().toLocaleLowerCase("en-US");
          const cueOrder = Number(item.cue_order);
          const cue = Number.isInteger(cueOrder) ? sourceCues[cueOrder - 1] : undefined;
          if (!expression || seen.has(expression)) throw new Error("Há expressão vazia ou duplicada no conteúdo.");
          seen.add(expression);
          if (!allowedTypes.has(item.type)) throw new Error("Categoria inválida para o item: " + expression);
          if (!cue || Number(item.start_ms) !== Math.round(cue.startMs) || Number(item.end_ms) !== Math.round(cue.endMs)) throw new Error("O item \"" + expression + "\" aponta para uma cue ou timestamp diferente da transcrição.");
          if (!text(item.meaning_pt).trim() || !text(item.explanation_pt).trim() || !text(item.source_en).trim() || !cue.text.includes(item.source_en.trim()) || !Array.isArray(item.layers) || item.layers.length < 3) throw new Error("O item \"" + expression + "\" precisa conter significado, explicação, trecho exato da fonte e ao menos três camadas.");
          if (item.layers.some(layer => !text(layer.context).trim() || !text(layer.usage).trim() || !text(layer.example_en).trim() || !text(layer.example_pt).trim())) throw new Error("Uma camada do item \"" + expression + "\" está incompleta.");
        }
        const content: PedagogicalContentPackage = { ...parsed, items: parsed.items.map(item => ({ ...item, include_in_hub: item.include_in_hub !== false })), editorial_signature: sourceSignature };
        const journeyIsCurrent = learningJourney?.source?.sourceSignature === learningJourneySourceSignature(sourceSignature, cards);
        const document: MaterialDocument = {
          version: 2, projectId, assetId, assetName: selectedAsset?.name ?? "English Materials",
          sourceVideoId: selectedAsset?.sourceVideoId ?? null, cards,
          learningJourney: journeyIsCurrent ? learningJourney ?? undefined : undefined,
          pedagogicalContent: content, updatedAt: new Date().toISOString(), sourceSignature
        };
        await invoke("save_project_materials", { projectId, assetId, materials: document });
        await invoke("update_project_stage", { id: projectId, stage: "Materiais" });
        setPedagogicalContent(content);
        onProjectUpdated?.();
      });
      setNotice("Conteúdo processado, validado e salvo no projeto. " + file.name + " contém " + file.size.toLocaleString("pt-BR") + " bytes.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPedagogicalProcessing(false);
      if (pedagogicalInput.current) pedagogicalInput.current.value = "";
    }
  }

  function togglePedagogicalItem(itemId: string) {
    setPedagogicalContent(current => current ? {
      ...current,
      items: current.items.map(item => item.id === itemId
        ? { ...item, include_in_hub: item.include_in_hub === false }
        : item)
    } : current);
  }

  function setAllPedagogicalItemsIncluded(included: boolean) {
    setPedagogicalContent(current => current ? {
      ...current,
      items: current.items.map(item => ({ ...item, include_in_hub: included }))
    } : current);
  }

  async function buildSelectedSmartLearningMoment() {
    if (!smartLearningMoments) return null;
    const source = buildSmartLearningSource(projectId, assetId, sourceSignature, sourceCues, sourceTranslations);
    const expectedHash = await hashPayload(source);
    const errors = validateSmartLearningMoments(smartLearningMoments, expectedHash, sourceCues);
    if (smartLearningMoments.source_signature !== sourceSignature || errors.length) {
      throw new Error("Smart Learning Moments está desatualizado ou inválido: " + errors.join(" "));
    }
    const selected = smartLearningMoments.candidates.find(item => item.id === smartLearningMoments.final_selection);
    if (!selected) return null;
    const audioAssets = selected.audio_assets ?? [];
    if (!selected.merged_audio?.audio_path) throw new Error("Conclua a mini aula e unifique seus segmentos de áudio antes de exportar.");
    const mergedResponse = await fetch(convertFileSrc(selected.merged_audio.audio_path));
    if (!mergedResponse.ok) throw new Error("Não foi possível ler o áudio unificado da mini aula.");
    const mergedBytes = new Uint8Array(await mergedResponse.arrayBuffer());
    const mergedBlob = await mergedResponse.blob();
    const mergedBinary = Array.from({ length: Math.ceil(mergedBytes.length / 0x8000) }, (_, index) =>
      String.fromCharCode(...mergedBytes.subarray(index * 0x8000, Math.min(mergedBytes.length, (index + 1) * 0x8000)))
    ).join("");
    const mergedAudio = {
      file_name: selected.merged_audio.file_name,
      mime_type: mergedBlob.type || "audio/mpeg",
      audio_base64: btoa(mergedBinary),
      segment_count: selected.merged_audio.segment_count
    };
    const missingSegments = selected.lesson.narration.segments.filter(segment => !audioAssets.some(asset => asset.segment_id === segment.id));
    if (missingSegments.length) {
      throw new Error("Gere ou importe o áudio de todos os segmentos da mini aula antes de exportar. Pendentes: " + missingSegments.map(item => item.id).join(", "));
    }
    const toBase64 = (bytes: Uint8Array) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return btoa(binary);
    };
    const embeddedAudio = await Promise.all(audioAssets.map(async asset => {
      if (asset.audio_base64) return { ...asset, audio_path: undefined };
      if (!asset.audio_path) throw new Error("Um segmento não possui arquivo de áudio: " + asset.segment_id);
      const response = await fetch(convertFileSrc(asset.audio_path));
      if (!response.ok) throw new Error("Não foi possível ler o áudio interno do segmento " + asset.segment_id + ".");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const blob = await response.blob();
      return { segment_id: asset.segment_id, language: asset.language, audio_base64: toBase64(bytes), mime_type: blob.type || "audio/wav", provider: asset.provider };
    }));
    return {
      contract: smartLearningMoments.contract,
      selection_limit: 1,
      selected_at: new Date().toISOString(),
      moment: { ...selected, audio_assets: embeddedAudio, merged_audio: mergedAudio }
    };
  }

  async function exportFinalPedagogicalPackage() {
    if ((!pedagogicalContent && !smartLearningMoments?.final_selection && !sourceInfo.predictions && !learningJourney) || !assetId || exporting) return;
    const selectedItems = pedagogicalContent?.items.filter(item => item.include_in_hub !== false) ?? [];
    if (!selectedItems.length && !smartLearningMoments?.final_selection && !sourceInfo.predictions && !learningJourney) {
      setError("Selecione conteúdo pedagógico, aprove uma mini aula ou prepare a Jornada de aprendizagem antes de exportar.");
      return;
    }
    setError(""); setNotice(""); setExporting(true);
    try {
      if (pedagogicalContent) {
        const { sourceHash } = await buildPedagogicalInput();
        if (pedagogicalContent.source_hash !== sourceHash || pedagogicalContent.editorial_signature !== sourceSignature) {
          throw new Error("Este conteúdo pedagógico está desatualizado em relação à transcrição. Gere novamente as instruções e importe um novo resultado da IA.");
        }
      }

      const predictionReview = await invoke<any>("load_prediction_listening_result", { projectId, assetId }).catch(() => null);
      const predictionPackage = prediction?.ready
        ? await invoke<{ sourceHash: string }>("prepare_prediction_listening_package", {
            projectId, assetId, cues: prediction.cues, selectedCueIds: prediction.selectedCueIds,
            sourceSignature: prediction.sourceSignature
          }).catch(() => null)
        : null;
      const predictionIsCurrent = Boolean(
        predictionReview?.contract === "nova-generator-prediction-listening-review/1.0" &&
        predictionReview?.saved_at && predictionPackage?.sourceHash &&
        predictionReview?.source_hash === predictionPackage.sourceHash
      );
      const journeySourceIsCurrent = Boolean(
        learningJourney &&
        learningJourney.source?.sourceSignature === learningJourneySourceSignature(sourceSignature, cards) &&
        validateLearningJourney(learningJourney).length === 0
      );
      if (learningJourney && !journeySourceIsCurrent) {
        throw new Error("A Jornada de aprendizagem está desatualizada ou incompleta. Revise e salve os dias antes de exportar o JSON completo.");
      }
      if (learningJourney && !journeyReadyForExport(learningJourney)) {
        throw new Error("A Jornada de aprendizagem ainda não está pronta. Cada modalidade obrigatória precisa ter ao menos uma atividade aprovada.");
      }
      const journeyIsCurrent = Boolean(learningJourney && journeySourceIsCurrent && journeyReadyForExport(learningJourney));
      const exportJourney = journeyIsCurrent && learningJourney ? {
        ...learningJourney,
        days: learningJourney.days.map((day, index) =>
          index === 1 ? { ...day, activities: approvedDay2Activities(learningJourney) } :
          index === 2 ? { ...day, lessons: approvedDay3Lessons(learningJourney) } :
          index === 3 ? { ...day, tasks: approvedDay4Tasks(learningJourney) } :
          index === 4 ? { ...day, prompts: approvedDay5Prompts(learningJourney) } :
          index === 5 ? { ...day, listening: approvedDay6Listening(learningJourney), speaking: approvedDay6Speaking(learningJourney) } :
          index === 6 ? { ...day, listening: approvedDay7Listening(learningJourney), speaking: approvedDay7Speaking(learningJourney) } : day)
      } : null;
      if (exportJourney) {
        const journeyErrors = validateLearningJourney(exportJourney);
        if (journeyErrors.length) throw new Error("A Jornada de aprendizagem não passou na validação final: " + journeyErrors.join(" "));
      }
      if (!selectedItems.length && !smartLearningMoments?.final_selection && !predictionIsCurrent && !journeyIsCurrent) {
        throw new Error("Não há conteúdo aprovado e atualizado para exportar. Aprove os materiais ou conclua a revisão da jornada.");
      }

      const toBase64 = (bytes: Uint8Array) => {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      };
      const exportedAnkiCards = await Promise.all(approvedCards.map(async card => {
        let audio: { base64: string; mime_type: string; source: string } | null = null;
        if (card.audioPath) {
          const response = await fetch(convertFileSrc(card.audioPath));
          if (!response.ok) throw new Error("Não foi possível incorporar o áudio do card aprovado " + card.id + " ao JSON completo.");
          const blob = await response.blob();
          audio = {
            base64: toBase64(new Uint8Array(await blob.arrayBuffer())),
            mime_type: blob.type || "audio/mpeg",
            source: card.audioSource ?? "unknown"
          };
        }
        const { audioPath: _audioPath, ...cardData } = card;
        return { ...cardData, audio };
      }));
      await persistMaterials();
      const payload = {
        schema: "ihub-generator-pedagogical-import/1.0",
        package_version: 2,
        generated_at: new Date().toISOString(),
        project: { id: projectId, asset_id: assetId, name: selectedAsset?.name ?? "", source_video_id: selectedAsset?.sourceVideoId ?? null },
        source: {
          signature: sourceSignature,
          cue_count: sourceCues.length,
          translation_count: sourceTranslations.length
        },
        cues: sourceCues.map((cue, index) => ({
          order: index + 1, start_ms: Math.round(cue.startMs), end_ms: Math.round(cue.endMs),
          speaker: cue.speaker ?? "", final_en: cue.text,
          pt: sourceTranslations.find(item => item.id === cue.id)?.text ?? "",
          words: cue.words?.map(word => ({ text: word.text, start_ms: Math.round(word.startMs), end_ms: Math.round(word.endMs) })) ?? []
        })),
        anki_cards: exportedAnkiCards,
        pedagogical_content: pedagogicalContent ? { ...pedagogicalContent, minimum_items: selectedItems.length, items: selectedItems } : null,
        smart_learning_moment: await buildSelectedSmartLearningMoment(),
        prediction_listening: predictionIsCurrent ? predictionReview.materials ?? null : null,
        learning_journey: exportJourney
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "ihub-conteudo-completo-" + assetId + ".json"; anchor.click();
      URL.revokeObjectURL(url);
      setNotice("JSON completo gerado com " + selectedItems.length + " item(ns) pedagógico(s) selecionado(s)" + (smartLearningMoments?.final_selection ? " e uma mini aula Smart Learning Moments" : "") +
        (predictionIsCurrent ? ", Prediction Listening aprovado" : "") +
        (journeyIsCurrent ? " e Jornada de aprendizagem" : "") + ".");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  function exportJson() {
    const payload = JSON.stringify({ schema: "nova-generator-materials/2.0", projectId, assetId, assetName: selectedAsset?.name, cards, pedagogical_content: pedagogicalContent ?? undefined }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "materiais-" + assetId + ".json"; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <section className="materials-workspace">
    <header className="materials-heading">
      <div><span className="eyebrow">ESTÚDIO DIDÁTICO</span><h2>Materiais</h2><p>Reúna conteúdos aprovados, prepare cards Anki e gere os áudios usados no estudo.</p></div>
      {activeMaterialTab === "pedagogical" && <div className="materials-heading-actions"><button className="secondary-button" onClick={() => void saveMaterials()} disabled={!assetId || saving}><Save size={15}/>{saving ? "Salvando..." : "Salvar no projeto"}</button><button className="primary-button" onClick={() => void exportFinalPedagogicalPackage()} disabled={(!includedPedagogicalCount && !smartLearningMoments?.final_selection && !sourceInfo.predictions && !learningJourney && !approvedCount) || pedagogicalProcessing || exporting}><Download size={15}/>{exporting ? "Preparando JSON..." : "Exportar JSON completo"}</button></div>}
      {activeMaterialTab === "anki" && <div className="materials-heading-actions">
        <button className="secondary-button" onClick={() => void createExternalInput()} disabled={!cards.length || loading}><FileText size={15}/> Gerar TXT para IA</button>
        <button className="secondary-button" onClick={() => importInput.current?.click()}><Download size={15}/> Importar JSON da IA</button>
        <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => void importExternalResult(event.target.files?.[0])}/>
        <button className="secondary-button" onClick={exportJson} disabled={!cards.length}><Download size={15}/> Exportar JSON</button>
        <button className="secondary-button" onClick={() => void generatePendingAudio()} disabled={!voiceCloningReady || !pendingAudioCount || !approvedCount || Boolean(audioBusy.length)}><AudioLines size={15}/>{audioBusy.length ? "Gerando áudios..." : "Gerar áudios pendentes"}</button>
        <button className="primary-button" onClick={() => void saveMaterials()} disabled={!assetId || saving}><Save size={15}/>{saving ? "Salvando..." : "Salvar materiais"}</button>
        <button className="primary-button" onClick={() => void exportPackage()} disabled={!assetId || exporting || !approvedCount || pendingAudioCount > 0}><Download size={15}/>{exporting ? "Exportando..." : "Exportar pacote Anki"}</button>
      </div>}
    </header>

    {error && <div className="materials-alert error">{error}</div>}
    {notice && <div className="materials-alert success"><CheckCircle2 size={15}/>{notice}</div>}

    {!assets.length ? <div className="materials-empty"><div><Layers3 size={25}/></div><h3>Adicione uma mídia para começar</h3><p>A área Materiais usa transcrições, traduções e conteúdos aprovados vinculados aos vídeos do projeto.</p></div> : <>
      <div className="materials-source">
        <label className="sr-only" htmlFor="materials-source-select">Selecionar fonte do projeto</label>
        <select id="materials-source-select" value={assetId} onChange={event => setAssetId(event.target.value)} aria-label="Selecionar fonte do projeto">{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
      </div>

      {loading ? <div className="materials-loading"><LoaderCircle className="spin" size={20}/> Carregando fontes do projeto...</div> : <>
        <nav className="materials-main-tabs" aria-label="Categorias de materiais">
          <button type="button" className={activeMaterialTab === "pedagogical" ? "active" : ""} onClick={() => setActiveMaterialTab("pedagogical")}><BookOpen size={15}/> Conteúdo pedagógico</button>
          <button type="button" className={activeMaterialTab === "anki" ? "active" : ""} onClick={() => setActiveMaterialTab("anki")}><Layers3 size={15}/> ANKI</button>
        </nav>
        {activeMaterialTab === "pedagogical" ? <>
          <nav className="materials-subtabs" aria-label="Módulos de conteúdo pedagógico">
            <button type="button" className={activePedagogicalTab === "smart" ? "active" : ""} onClick={() => setActivePedagogicalTab("smart")}>Smart Learning Moments</button>
            <button type="button" className={activePedagogicalTab === "vocabulary" ? "active" : ""} onClick={() => setActivePedagogicalTab("vocabulary")}>Reconhecimento contextual do vocabulário</button>
            <button type="button" className={activePedagogicalTab === "prediction" ? "active" : ""} onClick={() => setActivePedagogicalTab("prediction")}>Prediction Listening</button>
            <button type="button" className={activePedagogicalTab === "journey" ? "active" : ""} onClick={() => setActivePedagogicalTab("journey")}>Jornada de aprendizagem · 7 dias</button>
          </nav>
          {activePedagogicalTab === "smart" && <SmartLearningMoments
            projectId={projectId} assetId={assetId} sourceSignature={sourceSignature}
            cues={sourceCues} translations={sourceTranslations} value={smartLearningMoments}
            onChange={setSmartLearningMoments}
          />}
          {activePedagogicalTab === "vocabulary" && <>
            <section className="materials-pedagogical-workbench">
              <div className="materials-pedagogical-intro">
                <div className="materials-pedagogical-icon"><BookOpen size={22}/></div>
                <div className="materials-pedagogical-copy">
                  <span className="eyebrow">MÓDULO 01 · CONTEÚDO PEDAGÓGICO</span>
                  <h3>Reconhecimento contextual do vocabulário</h3>
                  <p>Transforme a transcrição revisada em um mapa de expressões reutilizáveis. A IA identifica os itens, explica seus usos e cria exemplos em contextos diferentes.</p>
                </div>
                <div className="materials-pedagogical-source"><span>FONTE ATUAL</span><strong>{sourceCues.length} trechos</strong><small>{sourceTranslations.length} traduções disponíveis</small></div>
              </div>
              <div className="materials-pedagogical-steps">
                <article className="materials-pedagogical-step"><span>01</span><div><strong>Preparar instruções</strong><p>Baixe um TXT com o roteiro pedagógico, contrato JSON e transcrição revisada.</p><button className="primary-button" type="button" onClick={() => void generatePedagogicalInput()} disabled={loading || !sourceCues.length || pedagogicalProcessing}><FileText size={15}/> Baixar instruções TXT</button></div></article>
                <article className="materials-pedagogical-step"><span>02</span><div><strong>Enviar o resultado da IA</strong><p>Selecione o JSON retornado pela IA. O Nova valida os itens, as camadas e os tempos antes de salvar.</p><button className="secondary-button" type="button" onClick={() => pedagogicalInput.current?.click()} disabled={loading || !sourceCues.length || pedagogicalProcessing}><Download size={15}/> {pedagogicalProcessing ? "Processando JSON..." : "Selecionar JSON para importar"}</button><input ref={pedagogicalInput} type="file" accept=".json,application/json" hidden onChange={event => void importPedagogicalContent(event.target.files?.[0])}/></div></article>
                
              </div>
              {pedagogicalProcessing && <div className="materials-pedagogical-processing"><LoaderCircle className="spin" size={18}/><div><strong>Validando e salvando o conteúdo pedagógico</strong><span>{pedagogicalFileName || "Arquivo JSON selecionado"}</span></div></div>}
              {pedagogicalContent ? <div className="materials-pedagogical-results">
                <div className="materials-pedagogical-results-head"><div><span className="eyebrow">REVISÃO DO CONTEÚDO</span><h4>{pedagogicalContent.title || "Mapa de vocabulário contextual"}</h4><p>Escolha quais itens entram no JSON final. Os demais permanecem salvos no projeto, mas ficam fora da exportação.</p></div><div className="materials-pedagogical-result-count"><strong>{includedPedagogicalCount}/{pedagogicalContent.items.length}</strong><span>selecionados</span></div></div>
                <div className="materials-pedagogical-curation"><span>{includedPedagogicalCount} de {pedagogicalContent.items.length} itens serão enviados ao iHub</span><div><button type="button" onClick={() => setAllPedagogicalItemsIncluded(true)}>Selecionar todos</button><button type="button" onClick={() => setAllPedagogicalItemsIncluded(false)}>Limpar seleção</button></div></div>
                <div className="materials-pedagogical-item-list">{pedagogicalContent.items.map((item,index) => <article className="materials-pedagogical-item" key={item.id || item.expression}><div className="materials-pedagogical-item-top"><span>{String(index+1).padStart(2,"0")}</span><strong>{item.expression}</strong><small>{item.type.replaceAll("_"," ")}</small></div><button type="button" className={"materials-pedagogical-include" + (item.include_in_hub === false ? " excluded" : " included")} aria-pressed={item.include_in_hub !== false} onClick={() => togglePedagogicalItem(item.id)}>{item.include_in_hub === false ? <Plus size={13}/> : <Check size={13}/>} {item.include_in_hub === false ? "Incluir no JSON final" : "Incluído no JSON final"}</button><p>{item.meaning_pt}</p><div className="materials-pedagogical-item-meta"><span>Cue {item.cue_order}</span><span>{item.layers.length} camadas de uso</span></div><div className="materials-pedagogical-layer-preview">{item.layers.slice(0,3).map((layer,layerIndex)=><div key={layerIndex}><strong>{layer.context}</strong><p>{layer.example_en}</p><small>{layer.example_pt}</small></div>)}</div></article>)}</div>
              </div> : <div className="materials-pedagogical-empty"><Sparkles size={22}/><strong>Nenhum conteúdo importado ainda</strong><p>Comece baixando o TXT. Depois, envie o JSON produzido pela IA para validar e salvar o primeiro mapa de uso.</p></div>}
            </section>
            <div className="materials-stats">
              <div><BookOpen size={17}/><strong>{sourceInfo.cues}</strong><span>trechos</span></div>
              <div><Volume2 size={17}/><strong>{sourceInfo.translations}</strong><span>traduções</span></div>
              <div><Sparkles size={17}/><strong>{sourceInfo.editorial}</strong><span>sugestões editoriais</span></div>
              <div><AudioLines size={17}/><strong>{sourceInfo.shadowing}</strong><span>trechos Shadowing</span></div>
              <div><CheckCircle2 size={17}/><strong>{sourceInfo.predictions}</strong><span>desafios aprovados</span></div>
            </div>
          </>}
          {activePedagogicalTab === "prediction" && <section className="materials-prediction-panel">
            {prediction?.ready ? <PredictionListening
              projectId={projectId} assetId={assetId} assetName={prediction.assetName}
              cues={prediction.cues} selectedCueIds={prediction.selectedCueIds} sourceSignature={prediction.sourceSignature}
              onClose={() => setActivePedagogicalTab("vocabulary")} onPreview={prediction.onPreview} onPreviewModeChange={prediction.onPreviewModeChange}
              onDemoSeekAndPlay={prediction.onDemoSeekAndPlay} onDemoPause={prediction.onDemoPause}
              onDemoResume={prediction.onDemoResume} getCurrentTime={prediction.getCurrentTime}
              onProjectUpdated={onProjectUpdated} embedded
            /> : <div className="materials-prediction-prerequisite">
              <div><AudioLines size={20}/></div><h3>Prepare o Shadowing para gerar desafios</h3>
              <p>O Prediction Listening usa os trechos selecionados no Shadowing e o alinhamento palavra por palavra do WhisperX. Salve a transcrição, prepare o Shadowing e alinhe os trechos selecionados. Depois, volte a esta aba.</p>
            </div>}
          </section>}
          {activePedagogicalTab === "journey" && <section className="materials-journey-panel">
            <div className="materials-journey-heading">
              <div><span className="eyebrow">CONTEÚDO PEDAGÓGICO</span><h3>Jornada de aprendizagem · 7 dias</h3>
                <p>Uma sequência progressiva de compreensão, percepção e produção do inglês.</p></div>
              <div className="materials-journey-actions">
                <button className="secondary-button" type="button" onClick={exportLearningJourney} disabled={!learningJourney || !journeyReadyForExport(learningJourney)}><Download size={14}/> Exportar jornada completa</button>
              </div>
            </div>
            {learningJourney && learningJourney.source.sourceSignature !== learningJourneySourceSignature(sourceSignature, cards) && <p className="materials-journey-stale">Os cards aprovados mudaram. Regenere a jornada antes de exportar ou publicar.</p>}
            {selectedJourneyDay === null ? <div className="materials-journey-overview">
              <div className="materials-journey-section-heading">
                <div><span className="eyebrow">VISÃO GERAL</span><h4>Selecione um dia para preparar</h4></div>
                <span className="materials-journey-progress">7 etapas</span>
              </div>
              <div className="materials-journey-days">
                {[
                  { day: 1, title: "Explore & Understand", detail: learningJourney?.day1Preparation ? "Practice preparado · " + learningJourney.day1Preparation.expressionMatch.length + " expressões · " + learningJourney.day1Preparation.patternChallenge.length + " estruturas" : "Preparar Notice, Speak, Listen e Practice", state: "is-current" },
                  { day: 2, title: "Listening Recall", detail: learningJourney ? learningJourney.days[1].activities.length + " atividades · " + approvedDay2Activities(learningJourney).length + " aprovadas" : "Preparar atividades de listening", state: "is-current" },
                  { day: 3, title: "Notice in Context", detail: learningJourney ? learningJourney.days[2].lessons.length + " microaulas · " + approvedDay3Lessons(learningJourney).length + " aprovadas" : "Preparar microaulas contextuais", state: "is-current" },
                  { day: 4, title: "Deep Listening", detail: learningJourney ? learningJourney.days[3].tasks.length + " tarefas · " + approvedDay4Tasks(learningJourney).length + " aprovadas" : "Preparar escuta profunda", state: "is-current" },
                  { day: 5, title: "Speak & Compare", detail: learningJourney ? learningJourney.days[4].prompts.length + " práticas · " + approvedDay5Prompts(learningJourney).length + " aprovadas" : "Preparar prática oral e comparação", state: "is-current" },
                  { day: 6, title: "Listening & Speaking Challenge", detail: learningJourney ? learningJourney.days[5].listening.length + " listening · " + learningJourney.days[5].speaking.length + " speaking · " + (approvedDay6Listening(learningJourney).length + approvedDay6Speaking(learningJourney).length) + " aprovadas" : "Preparar desafio integrado", state: "is-current" },
                  { day: 7, title: "Final Challenge", detail: learningJourney ? learningJourney.days[6].listening.length + " listening · " + learningJourney.days[6].speaking.length + " speaking · " + (approvedDay7Listening(learningJourney).length + approvedDay7Speaking(learningJourney).length) + " aprovadas" : "Preparar avaliação final", state: "is-current" }
                ].map(day => <button type="button" key={day.day} className={"materials-journey-day " + day.state} onClick={() => setSelectedJourneyDay(day.day)}>
                  <span>DIA {String(day.day).padStart(2, "0")}</span><strong>{day.title}</strong><small>{day.detail}</small>
                  {day.day !== 1 && <em>Abrir preparação <span aria-hidden="true">→</span></em>}
                </button>)}
              </div>
            </div> : selectedJourneyDay === 1 ? <div className="materials-journey-work">
              <Day3NoticeInContext day={1} projectId={projectId} assetId={assetId} sourceSignature={sourceSignature} cues={sourceCues}
                cards={cards.map(card => ({ id: card.id, sourceCueId: card.sourceCueId, focus: card.focus, meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation, exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status }))}
                smartLearningMoments={smartLearningMoments as any} lessons={learningJourney?.day1NoticeLessons ?? []}
                onLessonsChange={updateDay1Notice} onBack={() => setSelectedJourneyDay(null)} onSave={() => void saveMaterials()} saving={saving} />
              <Day1Preparation projectId={projectId} assetId={assetId} sourceSignature={sourceSignature} cues={sourceCues}
                cards={cards.map(card => ({ id: card.id, sourceCueId: card.sourceCueId, focus: card.focus, meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation, exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status }))}
                value={learningJourney?.day1Preparation ?? null} onChange={updateDay1Preparation}
                onBack={() => setSelectedJourneyDay(null)} onSave={() => void saveMaterials()} saving={saving} />
              <section className="day1-existing-stages">
                <article><strong>Explore & Understand</strong><p>O vídeo, as legendas, os tempos, as traduções e os links continuam sendo preparados exclusivamente no editor. Esta etapa não altera esse material.</p></article>
                <article><strong>Speak · Shadowing</strong><p>{sourceInfo.shadowing > 0 ? sourceInfo.shadowing + " trechos selecionados no Shadowing." : "Ainda não há Shadowing preparado. Use a página de Shadowing já existente e retorne aqui."}</p></article>
                <article><strong>Listen · Áudio</strong><p>Usa o áudio original da mídia e a transcrição sincronizada já carregados no Kit. Não exige uma segunda preparação de áudio.</p></article>
              </section>
              <section className="materials-prediction-panel">
                {prediction?.ready ? <PredictionListening
                  projectId={projectId} assetId={assetId} assetName={prediction.assetName}
                  cues={prediction.cues} selectedCueIds={prediction.selectedCueIds} sourceSignature={prediction.sourceSignature}
                  onClose={() => setSelectedJourneyDay(null)} onPreview={prediction.onPreview} onPreviewModeChange={prediction.onPreviewModeChange}
                  onDemoSeekAndPlay={prediction.onDemoSeekAndPlay} onDemoPause={prediction.onDemoPause}
                  onDemoResume={prediction.onDemoResume} getCurrentTime={prediction.getCurrentTime}
                  onProjectUpdated={onProjectUpdated} embedded
                /> : <div className="materials-prediction-prerequisite"><h3>Prediction Listening</h3><p>Prepare o Shadowing e o alinhamento WhisperX para liberar a geração de desafios de previsão.</p></div>}
              </section>
            </div> : selectedJourneyDay === 2 ? <div className="materials-journey-work">
              <Day2ListeningRecall
                projectId={projectId}
                assetId={assetId}
                sourceSignature={sourceSignature}
                cues={sourceCues}
                translations={sourceTranslations}
                activities={learningJourney?.days[1].activities.filter(item =>
                  ["identify", "word-recognition", "gap", "reconstruct"].includes(item.type) &&
                  (Boolean((item as ListeningQuestion & { status?: string; score?: number }).status) ||
                  Number.isFinite((item as ListeningQuestion & { score?: number }).score))
                ) ?? []}
                onActivitiesChange={updateDay2Activities}
                onBack={() => setSelectedJourneyDay(null)}
                onSave={() => void saveMaterials()}
                saving={saving}
              />
            </div> : selectedJourneyDay === 3 ? <div className="materials-journey-work">
              <Day3NoticeInContext
                projectId={projectId}
                assetId={assetId}
                sourceSignature={sourceSignature}
                cues={sourceCues}
                cards={cards.map(card => ({ id: card.id, sourceCueId: card.sourceCueId, focus: card.focus, meaning: card.meaning, highlightEn: card.highlightEn, explanation: card.explanation, exampleEn: card.exampleEn, examplePt: card.examplePt, status: card.status }))}
                smartLearningMoments={smartLearningMoments as any}
                lessons={learningJourney?.days[2].lessons.filter(item => Boolean(item.status || item.score)) ?? []}
                onLessonsChange={updateDay3Lessons}
                onBack={() => setSelectedJourneyDay(null)}
                onSave={() => void saveMaterials()}
                saving={saving}
              />
            </div> : selectedJourneyDay === 4 ? <div className="materials-journey-work">
              <Day4DeepListening
                projectId={projectId}
                assetId={assetId}
                sourceSignature={sourceSignature}
                cues={sourceCues}
                tasks={learningJourney?.days[3].tasks.filter(item => Boolean(item.status || item.score)) ?? []}
                onTasksChange={updateDay4Tasks}
                onBack={() => setSelectedJourneyDay(null)}
                onSave={() => void saveMaterials()}
                saving={saving}
              />
            </div> : selectedJourneyDay === 5 ? <div className="materials-journey-work">
              <Day5SpeakCompare
                projectId={projectId}
                assetId={assetId}
                sourceSignature={sourceSignature}
                cues={sourceCues}
                prompts={learningJourney?.days[4].prompts.filter(item => Boolean(item.status || item.score)) ?? []}
                onPromptsChange={updateDay5Prompts}
                onBack={() => setSelectedJourneyDay(null)}
                onSave={() => void saveMaterials()}
                saving={saving}
              />
            </div> : selectedJourneyDay === 6 || selectedJourneyDay === 7 ? <div className="materials-journey-work">
              <Day6Day7Challenge
                day={selectedJourneyDay}
                projectId={projectId}
                assetId={assetId}
                sourceSignature={sourceSignature}
                cues={sourceCues}
                listening={selectedJourneyDay === 6 ? learningJourney?.days[5].listening.filter(item => Boolean(item.status || item.score)) ?? [] : learningJourney?.days[6].listening.filter(item => Boolean(item.status || item.score)) ?? []}
                speaking={selectedJourneyDay === 6 ? learningJourney?.days[5].speaking.filter(item => Boolean(item.status || item.score)) ?? [] : learningJourney?.days[6].speaking.filter(item => Boolean(item.status || item.score)) ?? []}
                successCriteria={selectedJourneyDay === 7 ? learningJourney?.days[6].successCriteria ?? [] : []}
                onChange={selectedJourneyDay === 6 ? updateDay6Challenge : updateDay7Challenge}
                onBack={() => setSelectedJourneyDay(null)}
                onSave={() => void saveMaterials()}
                saving={saving}
              />
            </div> : <section className="materials-journey-day-workspace">
              <header><div><span className="eyebrow">DIA {String(selectedJourneyDay).padStart(2, "0")} · PREPARAÇÃO</span><h4>{(["", "", "Listening Recall", "Notice in Context", "Deep Listening", "Speak & Compare", "Listening & Speaking Challenge", "Final Challenge"][selectedJourneyDay])}</h4><p>Área de preparação desta etapa. Aqui ficarão as atividades, instruções para IA, revisão e aprovação específicas do dia.</p></div></header>
              <div className="materials-journey-day-placeholder"><strong>Preparação do Dia {String(selectedJourneyDay).padStart(2, "0")}</strong><span>O espaço está reservado para construir e revisar o conteúdo desta etapa.</span></div>
              <footer><button className="secondary-button" type="button" onClick={() => setSelectedJourneyDay(null)}>Voltar aos dias</button><button className="primary-button" type="button" onClick={() => void saveMaterials()} disabled={saving}><Save size={14}/>{saving ? "Salvando..." : "Salvar"}</button></footer>
            </section>}
          </section>}
        </> : <div className="materials-anki-content">
        <div className="materials-runtime">
          <div className="materials-runtime-icon"><AudioLines size={18}/></div>
          <div className="materials-runtime-copy"><strong>Vozes compartilhadas</strong><p>{voiceCloningReady ? "A síntese utiliza o perfil selecionado na Biblioteca de vozes do Shared Runtime Manager." : "Nenhum perfil de voz pronto foi encontrado. Prepare uma voz no Shared Runtime Manager e sincronize o Nova Generator."}</p>
            <label className="materials-voice-select"><span className="materials-voice-select-head">Voz para os novos áudios<button type="button" className="materials-voice-refresh" onClick={() => void refreshVoices().catch(error => setError(String(error)))} title="Atualizar a lista de vozes"><RefreshCw size={12}/> Atualizar</button></span>
              <select value={selectedVoiceId} onChange={event => setSelectedVoiceId(event.target.value)} disabled={!voiceCloningReady}>{!voices.length && <option value="">Nenhuma voz disponível</option>}{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.mode === "voice_design" ? "VoiceDesign" : "Base · Clonagem"}</option>)}</select>
            </label>
          </div><span className={voiceCloningReady ? "ready" : "missing"}>{voiceCloningReady ? voices.length + (voices.length === 1 ? " voz" : " vozes") : "Indisponível"}</span>
        </div>
        <div className="materials-section-title">
          <div><span className="eyebrow">ANKI</span><h3>Cards de estudo</h3><p>Conteúdo editorial, Shadowing e desafios aprovados de Prediction Listening. Revise cada card antes de incluí-lo no pacote.</p></div>
          <div className="materials-card-count">{approvedCount} de {cards.length} aprovados · {pendingAudioCount} áudio(s) pendente(s)</div>
        </div>

        {loading ? <div className="materials-loading"><LoaderCircle className="spin" size={20}/> Carregando conteúdo do projeto...</div> : <>
          {!cards.length && <div className="materials-empty compact"><div><BookOpen size={22}/></div><h3>Nenhum card preparado</h3><p>Não encontramos conteúdos com frente e verso. Você pode criar os cards manualmente.</p></div>}
          <div className="materials-card-list">{cards.map((card, index) => <article className="materials-card" key={card.id}>
            <div className="materials-card-top">
              <div><span className="materials-card-number">CARD {String(index + 1).padStart(2, "0")}</span><span className={"materials-source-tag " + card.sourceType}>{card.sourceType === "prediction" ? "PREDICTION LISTENING" : card.sourceType === "shadowing" ? "SHADOWING" : card.sourceType === "editorial" ? "EDITORIAL" : "MANUAL"}</span><span className={card.status === "approved" ? "materials-status approved" : "materials-status"}>{card.status === "approved" ? "Aprovado" : "Rascunho"}</span></div>
              <button className="materials-icon-button" title="Excluir card" onClick={() => setCards(current => current.filter(item => item.id !== card.id))}><Trash2 size={15}/></button>
            </div>
            <div className="materials-card-fields">
              <label>Frase em inglês (frente) <textarea value={card.focus} onChange={e => updateCard(card.id, { focus: e.target.value })} placeholder="Frase completa em inglês"/></label>
              <label>Expressão destacada (EN) <input value={card.highlightEn} onChange={e => updateCard(card.id, { highlightEn: e.target.value })} placeholder="Ex.: figure out"/></label>
              <label>Trecho exato destacado (EN) <input value={card.markedEn} onChange={e => updateCard(card.id, { markedEn: e.target.value })} placeholder="Texto exato dentro da frase"/></label>
              <label>Tradução / significado (PT) <textarea value={card.meaning} onChange={e => updateCard(card.id, { meaning: e.target.value })} placeholder="Tradução contextual da frase ou expressão"/></label>
              <label>Destaque (PT) <input value={card.highlightPt} onChange={e => updateCard(card.id, { highlightPt: e.target.value })} placeholder="Equivalente em português"/></label>
              <label>Trecho exato destacado (PT) <input value={card.markedPt} onChange={e => updateCard(card.id, { markedPt: e.target.value })} placeholder="Texto exato dentro da tradução"/></label>
              <label>Tipo do card <input value={card.type} onChange={e => updateCard(card.id, { type: e.target.value })} placeholder="EXPRESSION, PHRASAL VERB, STRUCTURE..."/></label>
              <label>Mini-aula / explicação contextual <textarea value={card.explanation} onChange={e => updateCard(card.id, { explanation: e.target.value })} placeholder="Como entender e usar esta expressão no contexto"/></label>
              <label>Outro exemplo (EN) <textarea value={card.exampleEn} onChange={e => updateCard(card.id, { exampleEn: e.target.value })} placeholder="Exemplo adicional em inglês"/></label>
              <label>Outro exemplo (PT) <textarea value={card.examplePt} onChange={e => updateCard(card.id, { examplePt: e.target.value })} placeholder="Tradução do exemplo"/></label>
              <label>Texto para áudio <input value={card.audioText} onChange={e => updateCard(card.id, { audioText: e.target.value })} placeholder="Texto em inglês que será narrado"/></label>
            </div>
            <div className="materials-preview" aria-label="Prévia do card Anki Didactic v3">
              <div className="materials-preview-side">
                <span>FRENTE · EN → PT</span>
                <strong>{highlightedText(card.focus || "Sua frase em inglês aparecerá aqui", card.markedEn || card.highlightEn || card.focus)}</strong>
                <small>{card.highlightEn || "Expressão destacada"}</small>
                {card.audioPath && <audio controls preload="none" src={convertFileSrc(card.audioPath)}/>}
              </div>
              <div className="materials-preview-side back">
                <span>VERSO · MINI-AULA</span>
                <strong>{highlightedText(card.meaning || "A tradução contextual aparecerá aqui", card.markedPt || card.highlightPt || card.meaning)}</strong>
                <small>{card.type.toUpperCase()} · {card.highlightPt || "Significado da expressão"}</small>
                <p>{card.explanation || "A explicação contextual será exibida nesta área."}</p>
                {(card.exampleEn || card.examplePt) && <footer>{card.exampleEn}<small>{card.examplePt}</small></footer>}
              </div>
            </div>
            <div className="materials-audio-row">
              {card.audioPath ? <audio controls preload="none" src={convertFileSrc(card.audioPath)}/> : <span><FileAudio size={15}/> Nenhum áudio gerado</span>}
              <button className="secondary-button" onClick={() => void generateAudio(card)} disabled={!voiceCloningReady || audioBusy.length > 0 || !card.audioText.trim() && !card.focus.trim()}>
                {audioBusy.includes(card.id) ? <LoaderCircle className="spin" size={14}/> : card.audioPath && card.audioSource === "tts" ? <RefreshCw size={14}/> : <AudioLines size={14}/>}
                {audioBusy.includes(card.id) ? "Gerando..." : card.audioPath && card.audioSource === "tts" ? "Regenerar voz IA" : "Gerar voz IA"}
              </button>
              <button className="secondary-button" onClick={() => void generateSourceAudio(card)} disabled={audioBusy.length > 0 || card.sourceStartMs == null || card.sourceEndMs == null} title={card.sourceStartMs == null ? "Este card não possui vínculo de tempo com o vídeo" : "Extrair o áudio original deste trecho do vídeo"}><Volume2 size={14}/> Áudio do vídeo</button>
            </div>
            <footer className="materials-card-footer">
              <span>{card.sourceCueId ? "Vinculado à transcrição · " + (card.sourceStartMs ?? 0) + "–" + (card.sourceEndMs ?? 0) + " ms" : "Card manual sem tempo de vídeo"}</span>
              <button className={card.status === "approved" ? "materials-approve approved" : "materials-approve"} onClick={() => updateCard(card.id, { status: card.status === "approved" ? "draft" : "approved" })} disabled={card.status !== "approved" && (!card.focus.trim() || !card.meaning.trim())}>
                {card.status === "approved" ? <Check size={14}/> : <CheckCircle2 size={14}/>} {card.status === "approved" ? "Reabrir revisão" : "Aprovar card"}
              </button>
            </footer>
          </article>)}</div>
          <button className="materials-add-card" onClick={() => setCards(current => [...current, newCard()])}><Plus size={16}/> Adicionar card manual</button>
        </>}
        <div className="materials-next">
          <div className="materials-next-icon"><FileAudio size={19}/></div>
          <div><strong>Pacote de estudo</strong><p>O ZIP final reúne o pacote Anki (.apkg), o JSON editável e os áudios dos cards aprovados.</p></div>
          <span>{approvedCount > 0 && pendingAudioCount === 0 ? <CheckCircle2 size={15}/> : <RefreshCw size={15}/>} {approvedCount > 0 && pendingAudioCount === 0 ? "Pronto para exportar" : "Aguardando revisão e áudios"}</span>
        </div>
        </div>}

      </>}
    </>}
  </section>;
}
