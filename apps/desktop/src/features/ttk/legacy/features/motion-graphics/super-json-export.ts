import type { MotionGraphic } from "./model";

export type IHubSuperJsonSource = {
  youtubeUrl: string;
  sceneStartMs: number;
  sceneEndMs: number;
};

export type IHubSuperJson = {
  schema: "immersionhub-super-json";
  schema_version: "1.0";
  project: {
    id: string;
    source: "ttk-creator";
    exported_at: string;
    youtube_url: string;
    youtube_video_id: string;
    scene_start_ms: number;
    scene_end_ms: number;
    scene_duration_ms: number;
    timeline: "source_absolute_ms";
  };
  kit: {
    youtube: string;
    youtube_video_id: string;
    contentType: "immersion";
    scene_start_ms: number;
    scene_end_ms: number;
    scene_duration_ms: number;
  };
  cues: Array<Record<string, unknown>>;
};

function youtubeVideoId(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\\./, "");
    const id = host === "youtu.be"
      ? parsed.pathname.split("/").filter(Boolean)[0] ?? ""
      : parsed.searchParams.get("v")
        ?? parsed.pathname.match(/\\/(?:shorts|embed)\\/([A-Za-z0-9_-]{11})/)?.[1]
        ?? "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

export function buildIHubSuperJson(
  projectId: string,
  captions: MotionGraphic[],
  source: IHubSuperJsonSource,
): IHubSuperJson {
  const youtubeUrl = source.youtubeUrl.trim();
  const videoId = youtubeVideoId(youtubeUrl);
  const sceneStartMs = Math.max(0, Math.round(source.sceneStartMs));
  const sceneEndMs = Math.max(sceneStartMs + 1, Math.round(source.sceneEndMs));
  if (!videoId) throw new Error("O vídeo de origem não possui uma URL válida do YouTube.");
  if (sceneEndMs <= sceneStartMs) throw new Error("A janela do vídeo original é inválida.");

  const cues = captions.filter(item => item.isCaption && item.visible !== false)
    .slice().sort((a,b)=>a.startMs-b.startMs).map((item,index)=>({
      id: item.id || `cue-${index+1}`,
      start_ms: Math.max(0,Math.round(item.startMs)),
      end_ms: Math.max(0,Math.round(item.endMs)),
      approved_en: (item.captionEnglish || item.text || "").trim(),
      pt: (item.captionTranslation || "").trim(),
      words: (item.captionWords || []).map(word => ({
        text: word.text,
        start_ms: Math.max(0,Math.round(word.startMs)),
        end_ms: Math.max(0,Math.round(word.endMs)),
        ...(word.originalStartMs != null ? {original_start_ms:Math.round(word.originalStartMs)} : {}),
        ...(word.originalEndMs != null ? {original_end_ms:Math.round(word.originalEndMs)} : {}),
        ...(word.confidenceScore != null ? {confidence_score:word.confidenceScore} : {}),
        ...(word.reviewStatus ? {review_status:word.reviewStatus} : {}),
        ...(word.alignmentSource ? {alignment_source:word.alignmentSource} : {}),
        ...(word.pt?.trim() ? {pt:word.pt.trim()} : {}),
        ...(word.ptGroup ? {pt_group:word.ptGroup} : {}),
        ...(word.ptGroupRole ? {pt_group_role:word.ptGroupRole} : {}),
      })),
    }));

  return {
    schema: "immersionhub-super-json",
    schema_version: "1.0",
    project: {
      id: projectId,
      source: "ttk-creator",
      exported_at: new Date().toISOString(),
      youtube_url: youtubeUrl,
      youtube_video_id: videoId,
      scene_start_ms: sceneStartMs,
      scene_end_ms: sceneEndMs,
      scene_duration_ms: sceneEndMs - sceneStartMs,
      timeline: "source_absolute_ms",
    },
    kit: {
      youtube: youtubeUrl,
      youtube_video_id: videoId,
      contentType: "immersion",
      scene_start_ms: sceneStartMs,
      scene_end_ms: sceneEndMs,
      scene_duration_ms: sceneEndMs - sceneStartMs,
    },
    cues,
  };
}
