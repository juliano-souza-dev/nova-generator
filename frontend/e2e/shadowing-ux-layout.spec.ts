import { expect, test, type Page } from "@playwright/test";

const cues = [
  { id: "cue-1", order: 1, speaker: "Mike", start_ms: 1000, end_ms: 1750,
    en: "Hello.", pt: "Olá.", eligible: true },
  { id: "cue-2", order: 2, speaker: "Donna", start_ms: 1900, end_ms: 2500,
    en: "What?", pt: "O quê?", eligible: true },
];
const base = {
  contract: "nova-generator-shadowing/2.0",
  project_id: "project-1",
  scene_id: "scene-1",
  source_sha256: "a".repeat(64),
  plan_sha256: "b".repeat(64),
  duration_ms: 5000,
  origin: "automatic",
  status: "draft",
  source_cues: cues,
  excluded_cues: [{ ...cues[1], reason: "Não selecionado" }],
  blocks: [
    { id: "block-1", start_ms: 1000, end_ms: 1750, speaker: "Mike",
      word_count: 1, pause_duration_ms: 2500, cue_ids: ["cue-1"],
      en: "Hello.", pt: "Olá." },
  ],
};

async function prepare(page: Page, plan = base) {
  await page.route("**/api/projects?*", (route) =>
    route.fulfill({ json: [{ id: "project-1", title: "Dialogue" }] }),
  );
  await page.route("**/api/projects/project-1/media", (route) =>
    route.fulfill({ json: { cut_url: null } }),
  );
  await page.route("**/api/projects/project-1/shadowing", (route) =>
    route.fulfill({ json: [plan] }),
  );
}

for (const width of [1440, 1024, 390]) {
  test(`Shadowing stays readable with sticky actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await prepare(page);
    await page.goto("/shadowing?project=project-1");
    await expect(page.getByRole("navigation", { name: "Etapas do Shadowing" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Práticas selecionadas" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cues disponíveis" })).toBeVisible();
    await expect(page.locator("#shadowing-actions")).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const columns = await page.locator(".shadowing-layout").evaluate((node) =>
      getComputedStyle(node).gridTemplateColumns.trim().split(/\\s+/).length,
    );
    expect(columns).toBe(width >= 1024 ? 2 : 1);
  });
}

test("Undo restores a deleted practice by submitting an inverse edit", async ({ page }) => {
  let current = base;
  const changes: string[][][] = [];
  await prepare(page);
  await page.unroute("**/api/projects/project-1/shadowing");
  await page.route("**/api/projects/project-1/shadowing", (route) =>
    route.fulfill({ json: [current] }),
  );
  await page.route("**/api/projects/project-1/shadowing/scene-1/blocks", (route) => {
    const submitted = route.request().postDataJSON();
    changes.push(submitted.groups);
    current = {
      ...current,
      origin: "manual",
      plan_sha256: changes.length === 1 ? "c".repeat(64) : "d".repeat(64),
      blocks: changes.length === 1 ? [] : base.blocks,
      excluded_cues: changes.length === 1 ? cues.map((cue) => ({
        ...cue, reason: "Fora",
      })) : base.excluded_cues,
    };
    return route.fulfill({ json: current });
  });
  await page.goto("/shadowing?project=project-1");
  await page.getByRole("button", { name: "Excluir grupo" }).click();
  await expect(page.getByText(/Grupo excluído/)).toBeVisible();
  await page.getByRole("button", { name: "Desfazer" }).last().click();
  await expect.poll(() => changes).toEqual([[], [["cue-1"]]]);
  await expect(page.getByText("Prática 1 · Mike")).toBeVisible();
});
