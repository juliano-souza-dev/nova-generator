import { apiRequest, apiUrl } from "../../lib/api";

export type MediaFormat = "carousel" | "lesson_video" | "lyrics_video";
export type MediaTheme = "ihub" | "midnight" | "warm";
export type MediaKind = "cover" | "lesson" | "example" | "challenge" | "lyric";

export type MediaSlide = {
  id: string;
  kind: MediaKind;
  heading: string;
  en: string;
  pt: string;
  note: string;
  highlight: string;
  speaker: string;
  duration_ms: number;
};
export type MediaProject = {
  contract: "nova-tiktok-media/1";
  id: string;
  title: string;
  format: MediaFormat;
  theme: MediaTheme;
  source_project_id: string | null;
  revision: number;
  slides: MediaSlide[];
  audio_filename: string | null;
};
export type MediaEdit = Pick<
  MediaProject,
  "title" | "format" | "theme" | "source_project_id" | "revision" | "slides"
>;
export type MediaRender = { job_id: string; render_id: string; status: string };
export type MediaIdeas = {
  slides: MediaSlide[];
  provider: "groq";
  needs_review: boolean;
};

export const mediaApi = {
  list: () => apiRequest<MediaProject[]>("/tiktok-media/projects"),
  get: (id: string) => apiRequest<MediaProject>(`/tiktok-media/projects/${id}`),
  create: (title: string, format: MediaFormat) =>
    apiRequest<MediaProject>("/tiktok-media/projects", {
      method: "POST",
      body: JSON.stringify({ title, format }),
    }),
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
  ideas: (prompt: string, format: MediaFormat, count: number) =>
    apiRequest<MediaIdeas>("/tiktok-media/ideas", {
      method: "POST",
      body: JSON.stringify({ prompt, format, count }),
    }),
  async exportSlides(id: string, revision: number, images: Blob[]) {
    const body = new FormData();
    body.append("revision", String(revision));
    images.forEach((image, index) =>
      body.append("images", image, `slide-${index + 1}.png`),
    );
    const response = await fetch(
      apiUrl(`/tiktok-media/projects/${id}/slides.zip`),
      {
        method: "POST",
        body,
      },
    );
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
    audioMode: "silent" | "uploaded" | "voice",
    voiceProfileId: string,
  ) => {
    const body = new FormData();
    body.append("revision", String(revision));
    body.append("audio_mode", audioMode);
    if (audioMode === "voice") body.append("voice_profile_id", voiceProfileId);
    images.forEach((image, index) =>
      body.append("images", image, `slide-${index + 1}.png`),
    );
    return apiRequest<MediaRender>(`/tiktok-media/projects/${id}/render`, {
      method: "POST",
      body,
    });
  },
  videoUrl: (id: string, renderId: string) =>
    apiUrl(`/tiktok-media/projects/${id}/renders/${renderId}/video`),
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
    const kind: MediaKind = [
      "cover",
      "lesson",
      "example",
      "challenge",
      "lyric",
    ].includes(String(value.kind))
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
      throw new Error(
        `Quadro ${index + 1}: duração precisa ser 1–20 segundos.`,
      );
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
    };
  });
}
