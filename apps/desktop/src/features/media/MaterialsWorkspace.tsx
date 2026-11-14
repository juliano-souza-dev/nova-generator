import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import {
  AudioLines, BookOpen, Check, CheckCircle2, Download, FileAudio, FileText, Layers3,
  LoaderCircle, Plus, RefreshCw, Save, Sparkles, Trash2, Volume2, LockKeyhole
} from "lucide-react";
import "./MaterialsWorkspace.css";
import { runTrackedTask } from "../tasks/TaskCenter";

type Asset = { id: string; name: string; kind: string; durationMs?: number | null; sourceVideoId?: string | null };
type Cue = { id: string; text: string; startMs: number; endMs: number; speaker?: string };
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
type MaterialDocument = { version: 1 | 2; projectId?: string; assetId?: string; assetName?: string; sourceVideoId?: string | null; cards: AnkiCard[]; updatedAt?: string; sourceSignature?: string };
type AudioResult = { cardId: string; audioPath: string; sampleRate: number; language: string; speaker: string };

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

export default function MaterialsWorkspace({ projectId, initialAssetId, onProjectUpdated }: { projectId: string; initialAssetId?: string; onProjectUpdated?: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [cards, setCards] = useState<AnkiCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [audioBusy, setAudioBusy] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [predictionSaved, setPredictionSaved] = useState(false);
  const [ttsReady, setTtsReady] = useState(false);
  const [sourceInfo, setSourceInfo] = useState({ cues: 0, translations: 0, editorial: 0, shadowing: 0, predictions: 0 });
  const [sourceSignature, setSourceSignature] = useState("");
  const [sourceCues, setSourceCues] = useState<Cue[]>([]);
  const [sourceTranslations, setSourceTranslations] = useState<Translation[]>([]);
  const importInput = useRef<HTMLInputElement>(null);

  const selectedAsset = useMemo(() => assets.find(item => item.id === assetId), [assets, assetId]);
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
      setPredictionSaved(false);
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
      setPredictionSaved(isPredictionSaved);
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
      setError(String(e)); setCards([]); setPredictionSaved(false);
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void refreshAssets().catch(e => setError(String(e))); }, [refreshAssets]);
  useEffect(() => { if (assetId) void loadSource(assetId); else setLoading(false); }, [assetId, loadSource]);
  useEffect(() => {
    invoke<any>("get_shared_runtime_status")
      .then(status => setTtsReady(Boolean(status?.qwen3TtsReady)))
      .catch(() => setTtsReady(false));
  }, []);

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
    const document: MaterialDocument = { version: 2, projectId, assetId, assetName: selectedAsset?.name ?? "English Materials", sourceVideoId: selectedAsset?.sourceVideoId ?? null, cards, updatedAt: new Date().toISOString(), sourceSignature };
    await invoke("save_project_materials", { projectId, assetId, materials: document });
    await invoke("update_project_stage", { id: projectId, stage: "Materiais" });
    onProjectUpdated?.();
    return document;
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
    if (!assetId || !ttsReady || audioBusy.includes(card.id)) return;
    const audioText = card.audioText.trim() || card.focus.trim();
    if (!audioText) { setError("Preencha o texto para áudio antes de gerar."); return; }
    setAudioBusy(current => [...current, card.id]); setError(""); setNotice("");
    try {
      const audio = await runTrackedTask("materials", "Gerar áudio do card Anki", async () => {
        const result = await invoke<AudioResult[]>("generate_material_audio", {
          projectId, assetId, requests: [{ cardId: card.id, text: audioText, language: "English", speaker: "Aiden" }]
        });
        const generated = result[0];
        if (!generated?.audioPath) throw new Error("O sintetizador não retornou o arquivo de áudio.");
        return generated;
      });
      setCards(current => current.map(item => item.id === card.id ? { ...item, audioPath: audio.audioPath, audioSource: "tts" } : item));
      
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
    if (!assetId || !ttsReady || !pending.length || audioBusy.length) return;
    const invalid = pending.find(card => !(card.audioText.trim() || card.focus.trim()));
    if (invalid) { setError("O card " + invalid.id + " não possui texto para sintetização."); return; }
    setAudioBusy(pending.map(card => card.id)); setError(""); setNotice("");
    try {
      const result = await runTrackedTask("materials", "Gerar áudios dos cards aprovados", () => invoke<AudioResult[]>("generate_material_audio", {
        projectId, assetId,
        requests: pending.map(card => ({
          cardId: card.id, text: card.audioText.trim() || card.focus.trim(), language: "English", speaker: "Aiden"
        }))
      }));
      const byId = new Map(result.map(item => [item.cardId, item.audioPath]));
      setCards(current => current.map(card => byId.has(card.id) ? { ...card, audioPath: byId.get(card.id), audioSource: "tts" } : card));
      
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

  function exportJson() {
    const payload = JSON.stringify({ schema: "nova-generator-materials/2.0", projectId, assetId, assetName: selectedAsset?.name, cards }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "materiais-" + assetId + ".json"; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <section className="materials-workspace">
    <header className="materials-heading">
      <div><span className="eyebrow">ESTÚDIO DIDÁTICO</span><h2>Materiais</h2><p>Reúna conteúdos aprovados, prepare cards Anki e gere os áudios usados no estudo.</p></div>
      <div className="materials-heading-actions">
        <button className="secondary-button" onClick={() => void createExternalInput()} disabled={!cards.length || loading}><FileText size={15}/> Gerar TXT para IA</button>
        <button className="secondary-button" onClick={() => importInput.current?.click()}><Download size={15}/> Importar JSON da IA</button>
        <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => void importExternalResult(event.target.files?.[0])}/>
        <button className="secondary-button" onClick={exportJson} disabled={!cards.length}><Download size={15}/> Exportar JSON</button>
        <button className="secondary-button" onClick={() => void generatePendingAudio()} disabled={!ttsReady || !pendingAudioCount || !approvedCount || Boolean(audioBusy.length)}><AudioLines size={15}/>{audioBusy.length ? "Gerando áudios..." : "Gerar áudios pendentes"}</button>
        <button className="primary-button" onClick={() => void saveMaterials()} disabled={!assetId || saving}><Save size={15}/>{saving ? "Salvando..." : "Salvar materiais"}</button>
        <button className="primary-button" onClick={() => void exportPackage()} disabled={!assetId || exporting || !approvedCount || pendingAudioCount > 0}><Download size={15}/>{exporting ? "Exportando..." : "Exportar pacote Anki"}</button>
      </div>
    </header>

    {error && <div className="materials-alert error">{error}</div>}
    {notice && <div className="materials-alert success"><CheckCircle2 size={15}/>{notice}</div>}

    {!assets.length ? <div className="materials-empty"><div><Layers3 size={25}/></div><h3>Adicione uma mídia para começar</h3><p>A área Materiais usa transcrições, traduções e conteúdos aprovados vinculados aos vídeos do projeto.</p></div> : <>
      <div className="materials-source">
        <div><span className="eyebrow">CONTEÚDO DE ORIGEM</span><strong>{selectedAsset?.name ?? "Selecione um vídeo"}</strong><small>Os materiais são organizados por vídeo e permanecem vinculados ao projeto.</small></div>
        <select value={assetId} onChange={event => setAssetId(event.target.value)} aria-label="Vídeo de origem">{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
      </div>

      {loading ? <div className="materials-loading"><LoaderCircle className="spin" size={20}/> Carregando fontes do projeto...</div> : !predictionSaved ? <div className="materials-gate">
        <div><LockKeyhole size={23}/></div>
        <h3>Materiais ainda não liberados</h3>
        <p>Para liberar esta área, abra o editor da mídia, entre em Prediction Listening e clique em <strong>Salvar</strong>. Importar o JSON ou aprovar desafios, isoladamente, não libera a etapa.</p>
      </div> : <>
        <div className="materials-stats">
          <div><BookOpen size={17}/><strong>{sourceInfo.cues}</strong><span>trechos</span></div>
          <div><Volume2 size={17}/><strong>{sourceInfo.translations}</strong><span>traduções</span></div>
          <div><Sparkles size={17}/><strong>{sourceInfo.editorial}</strong><span>sugestões editoriais</span></div>
          <div><AudioLines size={17}/><strong>{sourceInfo.shadowing}</strong><span>trechos Shadowing</span></div>
          <div><CheckCircle2 size={17}/><strong>{sourceInfo.predictions}</strong><span>desafios aprovados</span></div>
        </div>

        <div className="materials-runtime">
          <div className="materials-runtime-icon"><AudioLines size={18}/></div>
          <div><strong>Qwen3-TTS 1.7B · voz em inglês</strong><p>{ttsReady ? "Runtime compartilhado pronto. A geração usa o ambiente isolado do Shared Runtime Manager." : "Runtime não disponível. Sincronize o Nova Generator e instale qwen3-tts pelo Shared Runtime Manager."}</p></div>
          <span className={ttsReady ? "ready" : "missing"}>{ttsReady ? "Disponível" : "Não instalado"}</span>
        </div>

        <div className="materials-section-title">
          <div><span className="eyebrow">GERADOR 01</span><h3>Cards Anki</h3><p>Conteúdo editorial, Shadowing e Prediction Listening. Revise cada card antes de incluí-lo no pacote.</p></div>
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
              <button className="secondary-button" onClick={() => void generateAudio(card)} disabled={!ttsReady || audioBusy.length > 0 || !card.audioText.trim() && !card.focus.trim()}>
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
      </>}
    </>}
  </section>;
}
