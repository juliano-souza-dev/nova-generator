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
  await page.route("**/api/projects/p1/media/source-waveform", (route) =>
    route.fulfill({
      json: {
        sample_rate_hz: 8000,
        bucket_ms: 20,
        peaks: Array.from({ length: 100 }, (_, i) => 0.2 + (i % 5) / 8),
      },
    }),
  );
  await page.goto("/media?project=p1");
  await expect(page.getByLabel("Etapas do processamento")).toContainText("Revisar legenda");
  await expect(page.getByLabel("Player da fonte de vídeo")).toHaveAttribute("src", "/source.mp4");
  const wave = page.getByRole("img", { name: "Waveform da fonte com intervalo de corte" });
  await expect(wave).toBeVisible();
  await wave.scrollIntoViewIfNeeded();
  const bounds = await wave.boundingBox();
  if (!bounds) throw new Error("Missing waveform");
  await page.mouse.click(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.5);
  await page.keyboard.press("i");
  await expect(page.getByLabel("Início do corte em segundos")).toHaveValue("0.500");
  await page.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.5);
  await page.getByRole("button", { name: /Marcar fim/ }).click();
  await expect(page.getByLabel("Fim do corte em segundos")).toHaveValue("1.500");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("o");
  await expect(page.getByLabel("Fim do corte em segundos")).toHaveValue("1.490");
  await page.getByRole("button", { name: "Aumentar zoom" }).click();
  await expect(page.getByLabel("Zoom", { exact: true })).toHaveText("2×");
  await page.keyboard.press("-");
  await expect(page.getByLabel("Zoom", { exact: true })).toHaveText("1×");
  const startBefore = await page.getByLabel("Início do corte em segundos").inputValue();
  await page.mouse.dblclick(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.5);
  await expect(page.getByLabel("Início do corte em segundos")).toHaveValue(startBefore);
  await page.getByRole("button", { name: "Restaurar seleção" }).click();
  await expect(page.getByLabel("Início do corte em segundos")).toHaveValue("0.000");
  await expect(page.getByLabel("Fim do corte em segundos")).toHaveValue("2.000");
  await wave.scrollIntoViewIfNeeded();
  const dragBounds = await wave.boundingBox();
  if (!dragBounds) throw new Error("Missing waveform");
  await page.mouse.move(dragBounds.x + 5, dragBounds.y + dragBounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    dragBounds.x + dragBounds.width * 0.3,
    dragBounds.y + dragBounds.height * 0.5,
    { steps: 5 },
  );
  await page.mouse.up();
  expect(Number(await page.getByLabel("Início do corte em segundos").inputValue())).toBeCloseTo(
    0.6,
    1,
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await wave.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/cut-editor-1366.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await wave.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/cut-editor-1440.png" });
  await page.getByRole("link", { name: "Revisar legenda" }).click();
  await expect(page).toHaveURL(/\/editorial\?project=p1$/);
});
