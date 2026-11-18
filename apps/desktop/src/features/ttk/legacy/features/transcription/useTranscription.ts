import { useEffect, useState } from "react";
import type { MediaAsset, Project } from "../../shared/types";
import type { TranscriptionProgress, TranscriptResult, CueTranslation } from "../../services/desktop-api";
import { desktopApi } from "../../services/desktop-api";
import { runTrackedTask } from "../../services/task-center";

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
  const [transcriptionOpen, setTranscriptionOpen] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptResult | null>(null);
  const [transcriptionTranslations, setTranscriptionTranslations] = useState<CueTranslation[]>([]);
  const [translationBusy, setTranslationBusy] = useState(false);

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
    transcriptionResult, transcriptionTranslations, translationBusy,
    translateTranscription, insertTranscription, updateTranscriptionCue,
    transcriptionAssetId, setTranscriptionAssetId,
    transcriptionContext, setTranscriptionContext,
    transcriptionMode, setTranscriptionMode,
    transcriptionLanguage, setTranscriptionLanguage,
    transcriptionModel, setTranscriptionModel,
    transcriptionBusy, transcriptionProgress, setTranscriptionProgress,
    localAsrInstalled, localAsrChecking, localAsrInstalling,
    transcriptionMessage, setTranscriptionMessage,
    transcriptionOpen, setTranscriptionOpen,
    installLocalTranscription, transcribeSelectedMedia
  };
}
