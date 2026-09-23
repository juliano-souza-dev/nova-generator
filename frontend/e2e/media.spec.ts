import { expect, test } from "@playwright/test";

test("opens the media source workspace", async ({ page }) => {
  await page.route("**/api/projects?*", (route) => route.fulfill({ json: [] }));
  await page.goto("/media");
  await expect(page.getByRole("heading", { name: "Fonte e corte de mídia" })).toBeVisible();
  await expect(page.getByText("Nenhum projeto para preparar")).toBeVisible();
});

test("guides source preparation and opens the current ASR candidate", async ({ page }) => {
  const project = {
    id: "p1",
    title: "Aula",
    content_type: "dialogue",
    archived: false,
    youtube_url: "https://youtu.be/dQw4w9WgXcQ",
    youtube_video_id: "dQw4w9WgXcQ",
    cache_status: "missing",
    job_status: "idle",
  };
  const candidate = {
    engine: "faster-whisper",
    model: "small",
    language: "en",
    cues: [{ start_ms: 0, end_ms: 900, text: "Ready?", words: [] }],
  };
  const snapshot = {
    state: "ready_for_review",
    current_step: "review",
    can_start: false,
    can_cut: true,
    can_review: true,
    review_url: "/editorial?project=p1",
    source_ready: true,
    source_url: "/source.mp4",
    duration_ms: 2000,
    download_job_id: "j0",
    download_status: "succeeded",
    download_error: null,
    ingest_job_id: "j1",
    ingest_status: "succeeded",
    ingest_error: null,
    cut_url: "/cut.mp4",
    cut_start_ms: 0,
    cut_end_ms: 2000,
    waveform: { sample_rate_hz: 8000, bucket_ms: 40, peaks: [0.2] },
    transcript_candidate: candidate,
  };
  await page.route("**/api/projects?*", (route) => route.fulfill({ json: [project] }));
  await page.route("**/api/projects/p1/media", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/media?project=p1");
  await expect(page.getByLabel("Etapas do processamento")).toContainText("Revisar legenda");
  await page.getByRole("link", { name: "Revisar legenda" }).click();
  await expect(page).toHaveURL(/\/editorial\?project=p1$/);
});
