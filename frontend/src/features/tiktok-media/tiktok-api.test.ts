import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  apiRequest: vi.fn(async () => ({ job_id: "job-1", render_id: "render-1", status: "queued" })),
  apiUrl: (path: string) => `/api${path}`,
}));

import { apiRequest } from "../../lib/api";
import { mediaApi, readExternalStoryboard } from "./tiktok-api";

describe("TikTok Media external AI draft", () => {
  it("keeps bilingual text literal and marks a fresh slide", () => {
    const slides = readExternalStoryboard(
      JSON.stringify({
        slides: [
          {
            kind: "lesson",
            heading: "Contexto",
            en: "While you're at it",
            pt: "Já que você está nisso",
            duration_ms: 5000,
          },
        ],
      }),
    );
    expect(slides).toHaveLength(1);
    expect(slides[0].en).toBe("While you're at it");
    expect(slides[0].pt).toBe("Já que você está nisso");
    expect(slides[0].id).toBeTruthy();
  });

  it("accepts camera movements in imported scripts without trusting image paths", () => {
    const [slide] = readExternalStoryboard(
      JSON.stringify({
        slides: [{ kind: "example", motion: "pan_left", background_image: "../outside.png" }],
      }),
    );
    expect(slide.motion).toBe("pan_left");
    expect(slide.background_image).toBeNull();
  });

  it("blocks invalid durations and unsupported structures", () => {
    expect(() => readExternalStoryboard('{"slides":[{"duration_ms":999}]}')).toThrow();
    expect(() => readExternalStoryboard('{"slides":[]}')).toThrow();
    expect(() => readExternalStoryboard('{"foo":"bar"}')).toThrow();
  });
});

describe("TikTok Media video source request", () => {
  it("prepares YouTube and the cut in the standalone Media API", async () => {
    vi.mocked(apiRequest).mockClear();
    await mediaApi.prepareYoutube("media-1", 3, "https://youtu.be/dQw4w9WgXcQ");
    await mediaApi.transcribeCut("media-1", 4, 1000, 56000);
    expect(vi.mocked(apiRequest).mock.calls[0][0]).toBe(
      "/tiktok-media/projects/media-1/source/youtube",
    );
    expect(JSON.parse(String(vi.mocked(apiRequest).mock.calls[0][1]?.body))).toEqual({
      revision: 3,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(vi.mocked(apiRequest).mock.calls[1][0]).toBe(
      "/tiktok-media/projects/media-1/source/ingest",
    );
    expect(JSON.parse(String(vi.mocked(apiRequest).mock.calls[1][1]?.body))).toMatchObject({
      revision: 4,
      start_ms: 1000,
      end_ms: 56000,
    });
    expect(mediaApi.originalUrl("media-1")).toContain(
      "/tiktok-media/projects/media-1/source/original",
    );
  });

  it("renders the exact cut with original audio and no uploaded slide frames", async () => {
    vi.mocked(apiRequest).mockClear();
    await mediaApi.render("production-1", 4, [], "original", "", "video_source");
    expect(apiRequest).toHaveBeenCalledOnce();
    const [path, options] = vi.mocked(apiRequest).mock.calls[0];
    expect(path).toBe("/tiktok-media/projects/production-1/render");
    const form = options?.body as FormData;
    expect(form.get("revision")).toBe("4");
    expect(form.get("visual_mode")).toBe("video_source");
    expect(form.get("audio_mode")).toBe("original");
    expect(form.has("voice_profile_id")).toBe(false);
    expect(form.getAll("images")).toHaveLength(0);
    expect(mediaApi.sourceUrl("production-1")).toBe(
      "/api/tiktok-media/projects/production-1/source",
    );
  });
});

describe("TikTok Media animated scene requests", () => {
  it("creates a local animated production and uploads the scene image with revision", async () => {
    vi.mocked(apiRequest).mockClear();
    await mediaApi.create("Watch", "lesson_video", true);
    const [, createOptions] = vi.mocked(apiRequest).mock.calls[0];
    expect(JSON.parse(String(createOptions?.body))).toMatchObject({ animated_scenes: true });
    const image = new Blob(["png"], { type: "image/png" });
    await mediaApi.uploadSlideImage("project-1", 2, "slide-1", image);
    const [path, uploadOptions] = vi.mocked(apiRequest).mock.calls[1];
    expect(path).toBe("/tiktok-media/projects/project-1/slides/slide-1/image");
    const form = uploadOptions?.body as FormData;
    expect(form.get("revision")).toBe("2");
    expect(form.getAll("image")).toHaveLength(1);
  });

  it("sends balanced/full render quality independently of original video", async () => {
    vi.mocked(apiRequest).mockClear();
    await mediaApi.render("production-1", 5, [], "silent", "", "slides", false, false, "full");
    const [, options] = vi.mocked(apiRequest).mock.calls[0];
    expect((options?.body as FormData).get("render_quality")).toBe("full");
  });

  it("freezes the selected narration language for a Qwen voice render", async () => {
    vi.mocked(apiRequest).mockClear();
    await mediaApi.render(
      "production-1", 5, [], "voice", "voice-1", "slides", false, false, "balanced", "en",
    );
    const [, options] = vi.mocked(apiRequest).mock.calls[0];
    const form = options?.body as FormData;
    expect(form.get("voice_profile_id")).toBe("voice-1");
    expect(form.get("voice_language")).toBe("en");
  });
});
