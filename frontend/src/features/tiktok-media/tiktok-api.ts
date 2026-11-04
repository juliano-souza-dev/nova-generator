import { apiRequest, apiUrl } from "../../lib/api";

export type MediaFormat = "carousel" | "lesson_video" | "lyrics_video" | "shadowing_video";
export type MediaTheme = "ihub" | "midnight" | "warm";
export type MediaKind = "cover" | "lesson" | "example" | "challenge" | "lyric";
export type MediaVisualMode = "slides" | "video_source" | "shadowing";
export type MediaBackground = "video" | "paper";
export type PaperTheme = "cream" | "kraft" | "night" | "aurora";
export type MediaAudioMode = "silent" | "uploaded" | "voice" | "original";
export type SlideMotion = "still" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right";

export type MediaMotionGraphic = {
  id: string;
  start_ms: number;
  duration_ms: number;
  icon:
    | "check"
    | "cross"
    | "star"
    | "idea"
    | "arrow"
    | "sound"
    | "sparkle"
    | "warning";
  label: string;
  animation: "pop" | "fade" | "slide" | "bounce";
  sound: "none" | "pop" | "success" | "whoosh" | "ding";
  position: "top" | "center" | "bottom" | "left" | "right";
  enabled: boolean;
};

export type MediaCaption = {
  cue_id: string;
  start_ms: number;
  end_ms: number;
  en: string;
  pt: string;
  highlight: string;
  note?: string;
  enabled: boolean;
};

export type MediaCaptionStyle = {
  template: "clean" | "impact" | "karaoke" | "handwriting" | "neon" | "popstar" | "cinema";
  position: "top" | "center" | "bottom";
  animation: "none" | "fade" | "pop";
  text_scale: number;
  text_color: string;
};

export const DEFAULT_CAPTION_STYLE: MediaCaptionStyle = {
  template: "clean",
  position: "bottom",
  animation: "fade",
  text_scale: 1,
  text_color: "#FFFFFF",
};

export type MediaSlide = {
  id: string;
  kind: MediaKind;
  heading: string;
  en: string;
  pt: string;
  note: string;
  highlight: string;
  speaker: string;
  narration_text?: string;
  duration_ms: number;
  motion?: SlideMotion;
  background_image?: string | null;
};
export type ShadowingClip = {
  source_sha256: string;
  plan_sha256: string;
  block_ids: string[];
};
export type MediaProject = {
  contract: "nova-tiktok-media/1";
  id: string;
  title: string;
  format: MediaFormat;
  theme: MediaTheme;
  background_mode?: MediaBackground;
  paper_theme?: PaperTheme;
  animated_scenes?: boolean;
  source_project_id: string | null;
  source_scene_id?: string | null;
  source_youtube_id?: string | null;
  source_cut_job_id?: string | null;
  video_captions?: MediaCaption[];
  motion_graphics?: MediaMotionGraphic[];
  shadowing_clip?: ShadowingClip | null;
  caption_style?: MediaCaptionStyle;
  revision: number;
  slides: MediaSlide[];
  audio_filename: string | null;
};
export type MediaEdit = Pick<
  MediaProject,
  | "title"
  | "format"
  | "theme"
  | "background_mode"
  | "paper_theme"
  | "animated_scenes"
  | "source_project_id"
  | "source_scene_id"
  | "source_youtube_id"
  | "source_cut_job_id"
  | "video_captions"
  | "motion_graphics"
  | "shadowing_clip"
  | "caption_style"
  | "revision"
  | "slides"
>;
export type MediaRender = { job_id: string; render_id: string; status: string };
export type MediaLibraryVideo = {
  project_id: string;
  render_id: string;
  title: string;
  format: MediaFormat;
  visual_mode: MediaVisualMode;
  duration_ms: number;
  size_bytes: number;
  completed_at: string;
};
export type MediaIdeas = {
  slides: MediaSlide[];
  provider: "groq";
  needs_review: boolean;
};
export type MediaSourceStatus = {
  source_ready: boolean;
  duration_ms: number | null;
  download_status: string | null;
  download_error: string | null;
  ingest_status: string | null;
  ingest_error: string | null;
  ingest_job_id?: string | null;
  cut_ready?: boolean;
  mp3_ready?: boolean;
};

export const mediaApi = {
  library: () => apiRequest<MediaLibraryVideo[]>("/tiktok-media/library"),
  list: () => apiRequest<MediaProject[]>("/tiktok-media/projects"),
  get: (id: string) => apiRequest<MediaProject>(`/tiktok-media/projects/${id}`),
  create: (title: string, format: MediaFormat, animatedScenes = false) =>
    apiRequest<MediaProject>("/tiktok-media/projects", {
      method: "POST",
      body: JSON.stringify({ title, format, animated_scenes: animatedScenes }),
    }),
  importPackage: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<MediaProject>("/tiktok-media/packages/import", {
      method: "POST",
      body,
    });
  },
  update: (id: string, payload: MediaEdit) =>
    apiRequest<MediaProject>(`/tiktok-media/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  uploadAudio: (id: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<MediaProject>(`/tiktok-media/projects/${id}/audio`, {
      method: "POST",
      body,
    });
  },
  audioUrl: (id: string) => apiUrl(`/tiktok-media/projects/${id}/audio`),
  slideImageUrl: (id: string, filename: string) =>
    apiUrl(`/tiktok-media/projects/${id}/images/${filename}`),
  uploadSlideImage: (id: string, revision: number, slideId: string, image: Blob) => {
    const body = new FormData();
    body.append("revision", String(revision));
    body.append("image", image, "cena.png");
    return apiRequest<MediaProject>(`/tiktok-media/projects/${id}/slides/${slideId}/image`, {
      method: "POST",
      body,
    });
  },
  sourceUrl: (id: string) => apiUrl(`/tiktok-media/projects/${id}/source`),
  originalUrl: (id: string) => apiUrl(`/tiktok-media/projects/${id}/source/original`),
  cutMp3Url: (id: string) => apiUrl(`/tiktok-media/projects/${id}/source/audio.mp3`),
  sourceStatus: (id: string) =>
    apiRequest<MediaSourceStatus>(`/tiktok-media/projects/${id}/source/status`),
  prepareYoutube: (id: string, revision: number, url: string) =>
    apiRequest<{ project: MediaProject; job_id: string }>(
      `/tiktok-media/projects/${id}/source/youtube`,
      {
        method: "POST",
        body: JSON.stringify({ revision, url }),
      },
    ),
  transcribeCut: (id: string, revision: number, startMs: number, endMs: number) =>
    apiRequest<{ job_id: string; status: string }>(`/tiktok-media/projects/${id}/source/ingest`, {
      method: "POST",
      body: JSON.stringify({
        revision,
        start_ms: startMs,
        end_ms: endMs,
        language: "en",
      }),
    }),
  ideas: (prompt: string, format: MediaFormat, count: number) =>
    apiRequest<MediaIdeas>("/tiktok-media/ideas", {
      method: "POST",
      body: JSON.stringify({ prompt, format, count }),
    }),
  async exportSlides(id: string, revision: number, images: Blob[]) {
    const body = new FormData();
    body.append("revision", String(revision));
    images.forEach((image, index) => body.append("images", image, `slide-${index + 1}.png`));
    const response = await fetch(apiUrl(`/tiktok-media/projects/${id}/slides.zip`), {
      method: "POST",
      body,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Não foi possível exportar os quadros.");
    }
    return response.blob();
  },
  render: (
    id: string,
    revision: number,
    images: Blob[],
    audioMode: MediaAudioMode,
    voiceProfileId: string,
    visualMode: MediaVisualMode = "slides",
    endAtLastCaption = false,
    addOutro = false,
    renderQuality: "balanced" | "full" = "balanced",
    voiceLanguage: "pt-BR" | "en" = "pt-BR",
  ) => {
    const body = new FormData();
    body.append("revision", String(revision));
    body.append("audio_mode", audioMode);
    body.append("visual_mode", visualMode);
    body.append("end_at_last_caption", String(endAtLastCaption));
    body.append("add_outro", String(addOutro));
    body.append("render_quality", renderQuality);
    if (audioMode === "voice") {
      body.append("voice_profile_id", voiceProfileId);
      body.append("voice_language", voiceLanguage);
    }
    images.forEach((image, index) => body.append("images", image, `slide-${index + 1}.png`));
    return apiRequest<MediaRender>(`/tiktok-media/projects/${id}/render`, {
      method: "POST",
      body,
    });
  },
  videoUrl: (id: string, renderId: string) =>
    apiUrl(`/tiktok-media/projects/${id}/renders/${renderId}/video`),
  videoDownloadUrl: (id: string, renderId: string) =>
    apiUrl(`/tiktok-media/projects/${id}/renders/${renderId}/video?download=true`),
};

export function blankSlide(kind: MediaKind = "lesson"): MediaSlide {
  return {
    id: crypto.randomUUID(),
    kind,
    heading: kind === "lyric" ? "LYRICS + TRADUÇÃO" : "ENGLISH IN CONTEXT",
    en: "",
    pt: "",
    note: "",
    highlight: "",
    speaker: "",
    duration_ms: 4500,
    motion: "still",
    background_image: null,
  };
}

export function readExternalStoryboard(value: string): MediaSlide[] {
  const payload: unknown = JSON.parse(value);
  if (!payload || typeof payload !== "object" || !("slides" in payload)) {
    throw new Error("JSON precisa conter uma lista 'slides'.");
  }
  const slides = (payload as { slides: unknown }).slides;
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > 30) {
    throw new Error("O roteiro precisa conter entre 1 e 30 quadros.");
  }
  return slides.map((slide: unknown, index: number) => {
    if (!slide || typeof slide !== "object") {
      throw new Error(`Quadro ${index + 1} inválido.`);
    }
    const value = slide as Record<string, unknown>;
    const kind: MediaKind = ["cover", "lesson", "example", "challenge", "lyric"].includes(
      String(value.kind),
    )
      ? (value.kind as MediaKind)
      : "lesson";
    const pick = (field: string, max: number) => {
      const content = value[field] ?? "";
      if (typeof content !== "string" || content.length > max) {
        throw new Error(`Quadro ${index + 1}: campo ${field} inválido.`);
      }
      return content;
    };
    const duration = value.duration_ms ?? 4500;
    if (
      typeof duration !== "number" ||
      !Number.isInteger(duration) ||
      duration < 1000 ||
      duration > 20000
    ) {
      throw new Error(`Quadro ${index + 1}: duração precisa ser 1–20 segundos.`);
    }
    return {
      id: crypto.randomUUID(),
      kind,
      heading: pick("heading", 120),
      en: pick("en", 600),
      pt: pick("pt", 800),
      note: pick("note", 900),
      highlight: pick("highlight", 120),
      speaker: pick("speaker", 100),
      duration_ms: Number(duration),
      motion: ["still", "zoom_in", "zoom_out", "pan_left", "pan_right"].includes(
        String(value.motion),
      )
        ? (value.motion as SlideMotion)
        : "still",
      background_image: null,
    };
  });
}
