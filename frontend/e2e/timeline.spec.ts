import { expect, type Page, test } from "@playwright/test";

const cue = {
  id: "c1",
  scene_id: "s1",
  order: 1,
  speaker: "",
  original_en: "How are you?",
  approved_en: "How are you?",
  approved_pt: "Como você está?",
  speech_timing: { start_ms: 100, end_ms: 1800 },
  subtitle_timing: { start_ms: 100, end_ms: 1800 },
  revision: 1,
  provenance: { approval: "draft", editorial_preparation: "complete" },
  words: [
    { id: "w1", order: 1, surface: "How", start_ms: 100, end_ms: 500, pt: "Como" },
    { id: "w2", order: 2, surface: "are", start_ms: 510, end_ms: 750, pt: "está" },
    { id: "w3", order: 3, surface: "you?", start_ms: 760, end_ms: 1100, pt: "você?" },
  ],
};

async function mockEditorialWorkstation(page: Page) {
  await page.route("**/api/projects?**", (route) =>
    route.fulfill({
      json: [{ id: "p1", title: "Entrevista", content_type: "production", archived: false }],
    }),
  );
  await page.route("**/api/projects/p1/media", (route) =>
    route.fulfill({
      json: {
        state: "ready_for_review",
        can_review: true,
        ingest_job_id: "j1",
        cut_url: "/cut.mp4",
        waveform: { bucket_ms: 40, peaks: [0.2, 0.7] },
      },
    }),
  );
  await page.route("**/api/editorial/projects/p1/review", (route) =>
    route.fulfill({
      json: {
        status: "ready",
        ingest_job_id: "j1",
        cut_url: "/cut.mp4",
        scene: {
          id: "s1",
          project_id: "p1",
          order: 1,
          duration_ms: 2000,
          provenance: { ingest_job_id: "j1" },
        },
      },
    }),
  );
  await page.route("**/api/editorial/scenes/s1/cues", (route) => route.fulfill({ json: [cue] }));
  await page.route("**/api/editorial/cues/c1/text", (route) =>
    route.fulfill({ json: { ...cue, provenance: { approval: "approved" } } }),
  );
  await page.route("**/api/editorial/cues/c1/timing", (route) => route.fulfill({ json: cue }));
  await page.route("**/api/editorial/assistant/status", (route) =>
    route.fulfill({
      json: { groq_configured: true, groq_model: "test-model", fallback_available: true },
    }),
  );
  await page.route("**/api/editorial/scenes/s1/assistance", (route) =>
    route.fulfill({ status: 202, json: { job_id: "job-ai", status: "queued" } }),
  );
  await page.route("**/api/jobs/job-ai", (route) =>
    route.fulfill({
      json: {
        status: "succeeded",
        output: {
          scene_id: "s1",
          input_sha256: "a".repeat(64),
          provider: "groq",
          model: "test-model",
          rate_limits: {},
          suggestions: [
            {
              cue_id: "c1",
              order: 1,
              approved_en: "How are you?",
              approved_pt: "Como você está?",
              notes: "Tradução natural.",
              word_translations: [
                { word_id: "w1", pt: "Como" },
                { word_id: "w2", pt: "está" },
                { word_id: "w3", pt: "você?" },
              ],
              semantic_units: [{ word_ids: ["w1", "w2", "w3"], pt: "Como você está?" }],
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/editorial/cues/c1/words/semantic-units", (route) =>
    route.fulfill({ json: cue.words }),
  );
}

test("editor can operate the cue and word timeline", async ({ page }) => {
  await mockEditorialWorkstation(page);
  await page.goto("/editorial?project=p1");
  await expect(
    page.getByRole("img", { name: "Waveform, cues e tempos das palavras" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Aumentar zoom" }).click();
  await expect(page.getByLabel("Zoom atual")).toHaveText("Zoom 2×");
  const inHandle = page.locator(".timeline-edge-hit").first();
  await inHandle.scrollIntoViewIfNeeded();
  const handleBox = await inHandle.boundingBox();
  if (!handleBox) throw new Error("IN handle is not visible");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 20, handleBox.y + 10);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
  await page.getByLabel("Português aprovado").fill("Como você vai?");
  await expect(page.getByText("Alterações não salvas", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Aprovar cue" }).click();
  await expect(page.locator(".review-message")).toContainText("Cue 1 aprovado");
  await expect(page.locator("body")).toHaveCSS("overflow-x", "visible");
});

test("AI semantic grouping remains a draft until save", async ({ page }) => {
  await mockEditorialWorkstation(page);
  await page.goto("/editorial?project=p1");
  await page.getByRole("button", { name: "Sugerir com Groq" }).click();
  await expect(page.getByLabel("Unidades sugeridas")).toContainText(
    "How are you? → Como você está?",
  );
  await page.getByRole("button", { name: "Aplicar grupo" }).click();
  await expect(page.getByText("Alterações não salvas", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.locator(".review-message")).toContainText("Alterações salvas");
});

test("Ctrl+Enter opens the iHub preview with EN, PT and Dual modes", async ({ page }) => {
  await mockEditorialWorkstation(page);
  await page.goto("/editorial?project=p1");
  await expect(page.getByRole("button", { name: "Prévia no iHub" })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  const preview = page.getByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("button", { name: "Dual" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await preview.getByRole("button", { name: "PT" }).click();
  await expect(preview.getByRole("button", { name: "PT" })).toHaveAttribute("aria-pressed", "true");
  await preview.getByRole("button", { name: "EN" }).click();
  await expect(preview.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`workstation keeps timeline and actions usable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockEditorialWorkstation(page);
    await page.goto("/editorial?project=p1");
    await expect(
      page.getByRole("img", { name: "Waveform, cues e tempos das palavras" }),
    ).toBeInViewport();
    await expect(page.getByRole("button", { name: "Aprovar cue" })).toBeInViewport();
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => element.getBoundingClientRect().right > width + 1)
        .slice(0, 8)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: Math.round(element.getBoundingClientRect().right),
          text: element.textContent?.trim().slice(0, 80),
          html: element.outerHTML.slice(0, 160),
        }));
    });
    expect(overflow).toEqual([]);
  });
}
