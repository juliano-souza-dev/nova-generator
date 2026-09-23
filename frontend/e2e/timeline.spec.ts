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
  provenance: { approval: "draft" },
  words: [{ id: "w1", order: 1, surface: "How", start_ms: 100, end_ms: 500 }],
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
}

test("editor can operate the cue and word timeline", async ({ page }) => {
  await mockEditorialWorkstation(page);
  await page.goto("/editorial?project=p1");
  await expect(
    page.getByRole("img", { name: "Waveform, cues e tempos das palavras" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Aumentar zoom" }).click();
  await expect(page.getByLabel("Zoom atual")).toHaveText("Zoom 2×");
  await page.getByLabel("Português aprovado").fill("Como você vai?");
  await expect(page.getByText("Alterações não salvas", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Aprovar cue" }).click();
  await expect(page.locator(".review-message")).toContainText("Cue 1 aprovado");
  await expect(page.locator("body")).toHaveCSS("overflow-x", "visible");
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
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}
