import { expect, test } from "@playwright/test";

const production = {
  contract: "nova-tiktok-media/1",
  id: "tiktok-test",
  title: "Lyrics test",
  format: "lyrics_video",
  theme: "ihub",
  revision: 3,
  source_project_id: null,
  source_scene_id: null,
  source_youtube_id: "dQw4w9WgXcQ",
  source_cut_job_id: "cut-1",
  video_captions: [
    {
      cue_id: "1",
      start_ms: 0,
      end_ms: 2000,
      en: "Hello!",
      pt: "Olá!",
      highlight: "",
      note: "",
      enabled: true,
    },
    {
      cue_id: "2",
      start_ms: 2500,
      end_ms: 4200,
      en: "Let's go!",
      pt: "Vamos!",
      highlight: "",
      note: "",
      enabled: true,
    },
  ],
  caption_style: {
    template: "clean",
    position: "bottom",
    animation: "fade",
    text_scale: 1,
    text_color: "#FFFFFF",
  },
  slides: [
    {
      id: "s1",
      kind: "lyric",
      heading: "Lyric",
      en: "",
      pt: "",
      note: "",
      highlight: "",
      speaker: "",
      duration_ms: 4500,
    },
  ],
  audio_filename: null,
};

test("Media Studio keeps the preview, timeline and contextual inspector on screen", async ({
  page,
}) => {
  await page.route("**/api/tiktok-media/projects", (route) =>
    route.fulfill({ json: [production] }),
  );
  await page.route("**/api/tiktok-media/projects/tiktok-test", (route) =>
    route.fulfill({ json: production }),
  );
  await page.route("**/api/tiktok-media/projects/tiktok-test/source/status", (route) =>
    route.fulfill({
      json: {
        source_ready: true,
        duration_ms: 5000,
        download_status: "succeeded",
        download_error: null,
        ingest_status: "succeeded",
        ingest_job_id: "cut-1",
        ingest_error: null,
        cut_ready: true,
      },
    }),
  );
  await page.route("**/api/projects?*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/voices*", (route) => route.fulfill({ json: [] }));

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/tiktok-media");
    await expect(page.getByRole("button", { name: "Editar fala 1 em 00:00.0" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Editar bloco" })).toBeVisible();
    await expect(page.getByLabel("Linha do tempo das legendas")).toBeInViewport();
    await expect(page.getByLabel("Prévia da cena original com legendas")).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2),
    ).toBe(true);
    await page.getByRole("button", { name: "Visual" }).click();
    await expect(page.getByLabel("Estilo das legendas")).toBeVisible();
    await expect(page.getByLabel("Inglês")).toHaveCount(0);
  }
});
