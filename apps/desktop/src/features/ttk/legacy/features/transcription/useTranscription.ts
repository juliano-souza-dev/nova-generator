import { useEffect, useState } from "react";
import type { MediaAsset, Project } from "../../shared/types";
import type { TranscriptionProgress, TranscriptResult, CueTranslation } from "../../services/desktop-api";
import { desktopApi } from "../../services/desktop-api";
import { runTrackedTask } from "../../services/task-center";
import { downloadExternalTranslationPackage } from "../../../../media/translationPackage";

type TranscriptionContext = {
  clipId: string;
  timelineStartMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
};

export function useTranscription(project: Project | null, assets: MediaAsset[]) {
  const [transcriptionAssetId, setTranscriptionAssetId] = useState("");
  const [transcriptionContext, setTranscriptionContext] = useState<TranscriptionContext | null>(null);
  const [transcriptionMode, setTranscriptionMode] = useState<"auto" | "cloud" | "local">("auto");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [transcriptionModel, setTranscriptionModel] = useState("small");
  const [transcriptionBusy, setTranscriptionBusy] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgress | null>(null);
  const [localAsrInstalled, setLocalAsrInstalled] = useState(false);
  const [localAsrChecking, setLocalAsrChecking] = useState(false);
  const [localAsrInstalling, setLocalAsrInstalling] = useState(false);
  const [transcriptionMessage, setTranscriptionMessage] = useState("");
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptResult | null>(null);
  const [transcriptionTranslations, setTranscriptionTranslations] = useState<CueTranslation[]>([]);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const [externalSourceHash, setExternalSourceHash] = useState("");
  const [externalPackageBusy, setExternalPackageBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!project) return;
    setLocalAsrChecking(true);
    void desktopApi.checkLocalAsr()
      .then(ready => { if (!cancelled) setLocalAsrInstalled(ready); })
      .catch(() => { if (!cancelled) setLocalAsrInstalled(false); })
      .finally(() => { if (!cancelled) setLocalAsrChecking(false); });
    return () => { cancelled = true; };
  }, [project?.id]);

  useEffect(() => {
    if (!assets.some(asset => asset.id === transcriptionAssetId && (asset.kind === "video" || asset.kind === "audio"))) {
      setTranscriptionAssetId(assets.find(asset => asset.kind === "video" || asset.kind === "audio")?.id ?? "");
    }
  }, [assets, transcriptionAssetId]);


  function openTranscriptionForClip(assetId: string | undefined, context: TranscriptionContext | null) {
    setTranscriptionAssetId(assetId ?? "");
    setTranscriptionContext(context);
    setTranscriptionResult(null);
    setTranscriptionTranslations([]);
    setExternalSourceHash("");
    setTranscriptionMessage("");
  }

  async function installLocalTranscription() {
    setLocalAsrInstalling(true);
    setTranscriptionMessage("");
    try {
      const message = await runTrackedTask("installation", "Instalando mecanismo de transcrição local", () => desktopApi.installLocalAsr());
      setLocalAsrInstalled(await desktopApi.checkLocalAsr());
      setTranscriptionMessage(message);
    } catch (error) {
      setTranscriptionMessage("Não foi possível instalar o suporte local: " + String(error));
    } finally {
      setLocalAsrInstalling(false);
    }
  }

  async function transcribeSelectedMedia() {
    if (!project || !transcriptionAssetId || transcriptionBusy) return;
    setTranscriptionBusy(true);
    setTranscriptionResult(null);
    setTranscriptionTranslations([]);
    setExternalSourceHash("");
    setTranscriptionMessage("");
    setTranscriptionProgress(null);
    try {
      const result = await runTrackedTask("transcription", "Transcrevendo mídia", () => desktopApi.transcribeMedia(
        project.id,
        transcriptionAssetId,
        transcriptionMode,
        transcriptionLanguage,
        transcriptionModel,
        transcriptionContext?.sourceStartMs,
        transcriptionContext?.sourceEndMs
      ));
      const scopedCues = transcriptionContext
        ? result.cues.filter(cue => cue.endMs > transcriptionContext.sourceStartMs && cue.startMs < transcriptionContext.sourceEndMs)
        : result.cues;
      setTranscriptionResult({ ...result, cues: scopedCues });
      setTranscriptionMessage(
        scopedCues.length + " trechos reconhecidos para o clipe selecionado. Revise e traduza antes de inserir na timeline."
      );
      setTranscriptionProgress({
        projectId: project.id,
        stage: "completed",
        percent: 100,
        completedChunks: 1,
        totalChunks: 1,
        message: "Transcrição concluída"
      });
    } catch (error) {
      setTranscriptionMessage("Falha na transcrição: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setTranscriptionBusy(false);
    }
  }



  function updateTranscriptionCue(cueId: string, text: string) {
    setTranscriptionResult(current => current ? {
      ...current,
      cues: current.cues.map(cue => cue.id === cueId ? { ...cue, text, words: [] } : cue)
    } : current);
    setTranscriptionTranslations(current => current.filter(item => item.id !== cueId));
    setExternalSourceHash("");
  }

  async function translateTranscription() {
    if (!transcriptionResult || translationBusy || !transcriptionResult.cues.length) return;
    setTranslationBusy(true);
    setTranscriptionMessage("");
    try {
      const translated = await desktopApi.translateGroqChunk("Português do Brasil", transcriptionResult.cues.map(cue => ({
        id: cue.id, text: cue.text, words: cue.words.map(word => word.text)
      })));
      setTranscriptionTranslations(translated);
      setTranscriptionMessage(translated.length + " trechos traduzidos. Revise o resultado antes de inserir.");
    } catch (error) {
      setTranscriptionMessage("Falha na tradução: " + (error instanceof Error ? error.message : String(error)));
    } finally { setTranslationBusy(false); }
  }



  async function downloadExternalPackage() {
    if (!project || !transcriptionContext || !transcriptionResult || externalPackageBusy) return;
    setExternalPackageBusy(true);
    try {
      const pkg = await desktopApi.prepareClipExternalTranslationPackage(project.id, transcriptionContext.clipId, transcriptionResult.cues);
      const content = pkg.files["entrada-editorial.txt"] ?? "";
      const hash = content.match(/^SOURCE_HASH:\\s*(.+)$/m)?.[1]?.trim() ?? "";
      if (!hash) throw new Error("O pacote não retornou o identificador da transcrição.");
      const saved = await downloadExternalTranslationPackage(pkg);
      if (saved) {
        setExternalSourceHash(hash);
        setTranscriptionMessage("TXT editorial salvo. Envie-o à IA externa e importe o JSON correspondente.");
      }
    } catch (error) {
      setTranscriptionMessage("Não foi possível preparar o TXT: " + (error instanceof Error ? error.message : String(error)));
    } finally { setExternalPackageBusy(false); }
  }

  async function importExternalTranslation(file?: File) {
    if (!file || !transcriptionResult) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.contract !== "nova-generator-external-editorial-output/1.0") throw new Error("O JSON não corresponde ao contrato editorial esperado.");
      if (!externalSourceHash || parsed.source_hash !== externalSourceHash) throw new Error("Este JSON não corresponde ao TXT exportado para esta transcrição.");
      if (parsed.predictions?.word_translations !== false || parsed.predictions?.semantic_units !== false) throw new Error("As predições do JSON não correspondem ao TXT exportado.");
      if (!Array.isArray(parsed.cues) || parsed.cues.length !== transcriptionResult.cues.length) throw new Error("O JSON precisa conter exatamente uma tradução para cada trecho.");
      const byNumber = new Map<number, any>();
      for (const item of parsed.cues) {
        const id = Number(item?.id);
        if (!Number.isInteger(id) || id < 1 || byNumber.has(id)) throw new Error("O JSON contém números de trecho inválidos ou duplicados.");
        byNumber.set(id, item);
      }
      const translated = transcriptionResult.cues.map((cue, index) => {
        const item = byNumber.get(index + 1);
        if (!item || String(item.en ?? "").trim() !== cue.text.trim()) throw new Error("O texto original do trecho " + (index + 1) + " foi alterado ou não corresponde à transcrição.");
        const text = String(item.pt ?? "").trim();
        if (!text) throw new Error("A tradução do trecho " + (index + 1) + " está vazia.");
        return { id: cue.id, translation: text };
      });
      setTranscriptionTranslations(translated);
      setTranscriptionMessage(translated.length + " traduções importadas e associadas a esta transcrição.");
    } catch (error) {
      setTranscriptionMessage("Falha ao importar JSON: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function alignTranscriptionWords() {
    if (!project || !transcriptionResult || !transcriptionContext || alignmentBusy) return;
    const language = transcriptionResult.language || transcriptionLanguage;
    if (!language) {
      setTranscriptionMessage("Informe o idioma da fala antes de executar o alinhamento WbW.");
      return;
    }
    setAlignmentBusy(true);
    setTranscriptionMessage("Alinhando palavras com WhisperX...");
    try {
      const aligned = await desktopApi.alignTimelineClip(
        project.id, transcriptionAssetId,
        transcriptionContext.sourceStartMs, transcriptionContext.sourceEndMs,
        language,
        transcriptionResult.cues.map(cue => ({ id: cue.id, text: cue.text, startMs: cue.startMs, endMs: cue.endMs }))
      );
      const byId = new Map(aligned.map(cue => [cue.id, cue]));
      setTranscriptionResult(current => current ? {
        ...current,
        cues: current.cues.map(cue => {
          const match = byId.get(cue.id);
          return match ? { ...cue, words: match.words } : cue;
        })
      } : current);
      setTranscriptionMessage(aligned.length + " trechos alinhados pelo WhisperX.");
    } catch (error) {
      setTranscriptionMessage("Falha no alinhamento WhisperX: " + (error instanceof Error ? error.message : String(error)));
    } finally { setAlignmentBusy(false); }
  }

  function insertTranscription() {
    if (!project || !transcriptionResult || !transcriptionContext) return;
    window.dispatchEvent(new CustomEvent("framelab:transcription-ready", {
      detail: {
        projectId: project.id,
        result: transcriptionResult,
        context: transcriptionContext,
        translations: transcriptionTranslations.map(item => ({ id: item.id, text: item.translation }))
      }
    }));
    setTranscriptionMessage("Transcrição inserida na timeline e vinculada ao clipe selecionado.");
    setTranscriptionContext(null);
    setTranscriptionResult(null);
    setTranscriptionTranslations([]);
    setTranscriptionOpen(false);
  }

  return {
    transcriptionResult, transcriptionTranslations, translationBusy, alignmentBusy, externalPackageBusy, externalSourceHash, openTranscriptionForClip,
    translateTranscription, alignTranscriptionWords, downloadExternalPackage, importExternalTranslation, insertTranscription, updateTranscriptionCue,
    transcriptionAssetId, setTranscriptionAssetId,
    transcriptionContext, setTranscriptionContext,
    transcriptionMode, setTranscriptionMode,
    transcriptionLanguage, setTranscriptionLanguage,
    transcriptionModel, setTranscriptionModel,
    transcriptionBusy, transcriptionProgress, setTranscriptionProgress,
    localAsrInstalled, localAsrChecking, localAsrInstalling,
    transcriptionMessage, setTranscriptionMessage,
    installLocalTranscription, transcribeSelectedMedia
  };
}
