import { useEffect, useState } from "react";
import type { MediaAsset, Project } from "../../shared/types";
import type { TranscriptionProgress } from "../../services/desktop-api";
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
    setTranscriptionMessage("");
    setTranscriptionProgress(null);
    try {
      const result = await runTrackedTask("transcription", "Transcrevendo mídia", () => desktopApi.transcribeMedia(
        project.id,
        transcriptionAssetId,
        transcriptionMode,
        transcriptionLanguage,
        transcriptionModel
      ));
      window.dispatchEvent(new CustomEvent("framelab:transcription-ready", {
        detail: { projectId: project.id, result, context: transcriptionContext }
      }));
      setTranscriptionContext(null);
      setTranscriptionMessage(
        result.cues.length + " legendas criadas com " +
        (result.engine === "groq" ? "Groq Whisper" : "Faster-Whisper local") +
        ". Elas foram adicionadas à faixa exclusiva de transcrição."
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

  return {
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
