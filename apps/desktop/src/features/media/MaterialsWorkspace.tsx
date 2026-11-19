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
import { buildLearningJourneyPackage, validateLearningJourney, type LearningJourneyPackage } from "./learning-journey-contract";

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
type MaterialDocument = { version: 1 | 2; projectId?: string; assetId?: string; assetName?: string; sourceVideoId?: string | null; cards: AnkiCard[]; updatedAt?: string; sourceSignature?: string; learningJourney?: LearningJourneyPackage; pedagogicalContent?: PedagogicalContentPackage };
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
  onPreview: (timeMs: number) => void; onDemoSeekAndPlay: (timeMs: number) => void;
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
  const [pedagogicalProcessing, setPedagogicalProcessing] = useState(false);
  const [pedagogicalFileName, setPedagogicalFileName] = useState("");
  const [activeMaterialTab, setActiveMaterialTab] = useState<"pedagogical" | "anki">("pedagogical");
  const [activePedagogicalTab, setActivePedagogicalTab] = useState<"vocabulary" | "prediction" | "journey">("vocabulary");
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
      setSourceInfo({ cues: 0, translations: 0, editorial: 0, shadowing: 0, predictions: 0 });
      return;
    }
    setLoading(true); setError(""); setNotice("");
    try {
      const [cues, translations, prediction, stored] = await Promise.all([
        invoke<Cue[]>("load_project_subtitles", { projectId, assetId: selectedId }),
        invoke<Translation[]>("load_project_translations", { projectId, assetId: selectedId }).catch(() => [] as Translation[]),
        invoke<any>("load_prediction_listening_result", { projectId, assetId: selectedId }).catch(() => null),
        invoke<MaterialDocument | null>("load_project_materials", { projectId, assetId: selectedId }).catch(() => null)
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
      const storedJourneySignature = learningJourneySourceSignature(materialSignature, Array.isArray(stored?.cards) ? stored.cards : []);
      setLearningJourney(savedJourney && savedJourney.source?.sourceSignature === storedJourneySignature && validateLearningJourney(savedJourney).length === 0 ? savedJourney : null);
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
    const journeyIsCurrent = learningJourney?.source?.sourceSignature === learningJourneySourceSignature(sourceSignature, cards);
    const document: MaterialDocument = { version: 2, projectId, assetId, assetName: selectedAsset?.name ?? "English Materials", sourceVideoId: selectedAsset?.sourceVideoId ?? null, cards, learningJourney: journeyIsCurrent ? learningJourney ?? undefined : undefined, pedagogicalContent: pedagogicalContent ?? undefined, updatedAt: new Date().toISOString(), sourceSignature };
    await invoke("save_project_materials", { projectId, assetId, materials: document });
    await invoke("update_project_stage", { id: projectId, stage: "Materiais" });
    onProjectUpdated?.();
    return document;
  }

  function createLearningJourney() {
    if (!assetId) return;
    try {
      const journey = buildLearningJourneyPackage({
        projectId, assetId, sourceSignature: learningJourneySourceSignature(sourceSignature, cards), cues: sourceCues,
        cards: cards.map(card => ({
          id: card.id, sourceCueId: card.sourceCueId, type: card.type, focus: card.focus,
          meaning: card.meaning, highlightEn: card.highlightEn,
          explanation: card.explanation, exampleEn: card.exampleEn,
          examplePt: card.examplePt, status: card.status
        }))
      });
      const errors = validateLearningJourney(journey);
      if (errors.length) throw new Error(errors.join("\n"));
      setLearningJourney(journey);
      setNotice("Rascunho da jornada criado. Revise as atividades antes de publicar no iHubEnglish.");
      setError("");
    } catch (e) { setError(String(e)); }
  }

  function exportLearningJourney() {
    if (!learningJourney) return;
    if (learningJourney.source.sourceSignature !== learningJourneySourceSignature(sourceSignature, cards)) {
      setError("Os cards aprovados foram alterados. Regenere a jornada antes de exportar.");
      return;
    }
    const errors = validateLearningJourney(learningJourney);
    if (errors.length) { setError(errors.join("\n")); return; }
    const blob = new Blob([JSON.stringify(learningJourney, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "learning-journey-" + assetId + ".json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Pacote JSON da jornada exportado.");
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

  async function exportFinalPedagogicalPackage() {
    if (!pedagogicalContent || !assetId || exporting) return;
    const selectedItems = pedagogicalContent.items.filter(item => item.include_in_hub !== false);
    if (!selectedItems.length) {
      setError("Selecione pelo menos um item pedagógico para incluir no pacote final.");
      return;
    }
    setError(""); setNotice("");
    try {
      const { sourceHash } = await buildPedagogicalInput();
      if (pedagogicalContent.source_hash !== sourceHash || pedagogicalContent.editorial_signature !== sourceSignature) {
        throw new Error("Este conteúdo pedagógico está desatualizado em relação à transcrição. Gere novamente as instruções e importe um novo resultado da IA.");
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
      const journeyIsCurrent = Boolean(
        learningJourney &&
        learningJourney.source?.sourceSignature === learningJourneySourceSignature(sourceSignature, cards) &&
        validateLearningJourney(learningJourney).length === 0
      );

      await persistMaterials();
      const payload = {
        schema: "ihub-generator-pedagogical-import/1.0",
        project: { id: projectId, asset_id: assetId, name: selectedAsset?.name ?? "" },
        cues: sourceCues.map((cue, index) => ({
          order: index + 1, start_ms: Math.round(cue.startMs), end_ms: Math.round(cue.endMs),
          speaker: cue.speaker ?? "", final_en: cue.text,
          pt: sourceTranslations.find(item => item.id === cue.id)?.text ?? ""
        })),
        pedagogical_content: { ...pedagogicalContent, items: selectedItems },
        prediction_listening: predictionIsCurrent ? predictionReview.materials ?? null : null,
        learning_journey: journeyIsCurrent ? learningJourney : null
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "ihub-conteudo-completo-" + assetId + ".json"; anchor.click();
      URL.revokeObjectURL(url);
      setNotice("JSON completo gerado com " + selectedItems.length + " item(ns) pedagógico(s) selecionado(s)" +
        (predictionIsCurrent ? ", Prediction Listening aprovado" : "") +
        (journeyIsCurrent ? " e Jornada de aprendizagem" : "") + ".");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      {activeMaterialTab === "pedagogical" && <div className="materials-heading-actions"><button className="primary-button" onClick={() => void exportFinalPedagogicalPackage()} disabled={!pedagogicalContent || !includedPedagogicalCount || pedagogicalProcessing || exporting}><Download size={15}/>{exporting ? "Preparando JSON..." : "Exportar JSON completo"}</button></div>}
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
            <button type="button" className={activePedagogicalTab === "vocabulary" ? "active" : ""} onClick={() => setActivePedagogicalTab("vocabulary")}>Reconhecimento contextual do vocabulário</button>
            <button type="button" className={activePedagogicalTab === "prediction" ? "active" : ""} onClick={() => setActivePedagogicalTab("prediction")}>Prediction Listening</button>
            <button type="button" className={activePedagogicalTab === "journey" ? "active" : ""} onClick={() => setActivePedagogicalTab("journey")}>Jornada de aprendizagem · 7 dias</button>
          </nav>
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
              onClose={() => setActivePedagogicalTab("vocabulary")} onPreview={prediction.onPreview}
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
                <p>Prepare atividades progressivas a partir da transcrição revisada e dos cards aprovados. O Dia 1 reaproveita as etapas atuais do iHubEnglish.</p></div>
              <div className="materials-journey-actions">
                <button className="secondary-button" type="button" onClick={createLearningJourney} disabled={loading || !sourceCues.length}><Sparkles size={14}/>{learningJourney ? "Regenerar rascunho" : "Gerar jornada"}</button>
                <button className="secondary-button" type="button" onClick={exportLearningJourney} disabled={!learningJourney}><Download size={14}/> Exportar JSON</button>
              </div>
            </div>
            {learningJourney && learningJourney.source.sourceSignature !== learningJourneySourceSignature(sourceSignature, cards) && <p className="materials-journey-stale">Os cards aprovados mudaram. Regenere a jornada antes de exportar ou publicar.</p>}
            {learningJourney ? <div className="materials-journey-days">{learningJourney.days.map(day => <article key={day.day} className="materials-journey-day"><span>DIA {String(day.day).padStart(2, "0")}</span><strong>{day.title}</strong><small>{day.mode === "existing-stages" ? "Etapas atuais" : day.mode === "listening-recall" ? day.activities.length + " exercícios de listening" : day.mode === "micro-lessons" ? day.lessons.length + " microaulas" : day.mode === "deep-listening" ? day.tasks.length + " tarefas" : day.mode === "speaking" ? day.prompts.length + " propostas de speaking" : "Desafio integrado"}</small></article>)}</div> : <p className="materials-journey-empty">O rascunho será montado com exercícios de identificação, lacunas e compreensão auditiva; microaulas derivadas dos cards aprovados; tarefas de escuta profunda; e propostas de gravação e comparação.</p>}
            {learningJourney && <p className="materials-journey-note">Rascunho editável · {learningJourney.days[1].activities.length} atividades no Dia 2 · {learningJourney.days[2].lessons.length} microaulas no Dia 3. Salve os Materiais para manter o pacote neste projeto.</p>}
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
