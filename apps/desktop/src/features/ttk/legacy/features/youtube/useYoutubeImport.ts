import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { desktopApi } from "../../services/desktop-api";
import { runTrackedTask } from "../../services/task-center";
import type { DownloadProgress, MediaAsset, Project, YoutubeCacheEntry, YoutubeInspection } from "../../shared/types";

type Options = {
  project: Project | null;
  setAssets: Dispatch<SetStateAction<MediaAsset[]>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setMediaModal: Dispatch<SetStateAction<boolean>>;
};

export function useYoutubeImport({ project, setAssets, setBusy, setError, setNotice, setMediaModal }: Options) {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeInfo, setYoutubeInfo] = useState<YoutubeInspection | null>(null);
  const [quality, setQuality] = useState(1080);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [youtubeCache, setYoutubeCache] = useState<YoutubeCacheEntry | null>(null);
  const [trimStartMs, setTrimStartMs] = useState(0);
  const [trimEndMs, setTrimEndMs] = useState(0);
  const [trimBusy, setTrimBusy] = useState(false);
  const [outputRatio, setOutputRatio] = useState<"9:16" | "16:9" | "1:1" | "original">("9:16");
  const [frameMode, setFrameMode] = useState<"blur" | "contain" | "color">("blur");
  const [frameColor, setFrameColor] = useState("#000000");
  const trimVideoRef = useRef<HTMLVideoElement | null>(null);

  async function inspectYoutube() {
    if (!youtubeUrl.trim()) return;
    setBusy(true);
    setError("");
    setYoutubeInfo(null);
    setProgress(null);
    try {
      const info = await desktopApi.inspectYoutube(youtubeUrl.trim());
      setYoutubeInfo(info);
      const preferred = info.qualities.find(item => item.height <= 1080) ?? info.qualities[0];
      setQuality(preferred?.height ?? 0);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function downloadYoutube() {
    if (!youtubeInfo) return;
    setBusy(true);
    setError("");
    setProgress({ projectId: project?.id ?? "", percent: 0, status: "starting" });
    try {
      const cached = await runTrackedTask("download", "Preparando vídeo do YouTube", () => desktopApi.prepareYoutubeCache(youtubeInfo.url, quality));
      // mediaShared fica fora do escopo padrão do asset:// do Tauri. Autorize somente
      // o arquivo validado pelo backend antes de entregar o caminho ao preview.
      const previewPath = await desktopApi.authorizeYoutubePreview(cached.videoId);
      setYoutubeCache({ ...cached, filePath: previewPath });
      setTrimStartMs(0);
      setTrimEndMs(cached.durationMs ?? youtubeInfo.durationMs ?? 0);
      setMediaModal(false);
      setProgress(null);
    } catch (error) {
      setError(String(error));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmYoutubeTrim() {
    if (!project || !youtubeCache) return;
    setTrimBusy(true);
    setError("");
    try {
      const asset = await runTrackedTask("trim", "Recortando vídeo", () => desktopApi.trimYoutubeCache(project.id, youtubeCache.videoId, trimStartMs, trimEndMs, outputRatio, frameMode, frameColor));
      setAssets(current => [asset, ...current]);
      setNotice("Trecho preparado em 9:16 e importado para a biblioteca. A imagem original foi preservada, com preenchimento de fundo. O download original permanece no cache temporário por até 7 dias.");
      setYoutubeCache(null);
      setYoutubeUrl("");
      setYoutubeInfo(null);
      setProgress(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setTrimBusy(false);
    }
  }

  return {
    youtubeUrl, setYoutubeUrl, youtubeInfo, setYoutubeInfo,
    quality, setQuality, progress, setProgress,
    youtubeCache, setYoutubeCache, trimStartMs, setTrimStartMs,
    trimEndMs, setTrimEndMs, trimBusy, trimVideoRef, outputRatio, setOutputRatio, frameMode, setFrameMode, frameColor, setFrameColor,
    inspectYoutube, downloadYoutube, confirmYoutubeTrim
  };
}
