import { expect, test, type Page } from "@playwright/test";

const sourceCues = [
  {
    id: "cue-1",
    order: 1,
    speaker: "Mike",
    start_ms: 1000,
    end_ms: 1700,
    en: "Hello.",
    pt: "Olá.",
    eligible: true,
  },
  {
    id: "cue-2",
    order: 2,
    speaker: "Donna",
    start_ms: 1900,
    end_ms: 2600,
    en: "What?",
    pt: "O quê?",
    eligible: true,
  },
];
const plan = {
  contract: "nova-generator-shadowing/2.0",
  project_id: "project-1",
  scene_id: "scene-1",
  source_sha256: "a".repeat(64),
  plan_sha256: "b".repeat(64),
  duration_ms: 5000,
  origin: "automatic",
  status: "draft",
  source_cues: sourceCues,
  excluded_cues: [],
  blocks: sourceCues.map((cue, index) => ({
    id: `block-${index + 1}`,
    start_ms: cue.start_ms,
    end_ms: cue.end_ms,
    speaker: cue.speaker,
    word_count: 1,
    pause_duration_ms: 2300,
    cue_ids: [cue.id],
    en: cue.en,
    pt: cue.pt,
  })),
};

async function arrangeShadowing(page: Page) {
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

test("Shadowing lets the user exclude a speaker's cue without editing the Editorial", async ({
  page,
}) => {
  await arrangeShadowing(page);
  let submittedGroups: string[][] | null = null;
  await page.route("**/api/projects/project-1/shadowing/scene-1/blocks", (route) => {
    expect(route.request().method()).toBe("PUT");
    const payload = route.request().postDataJSON();
    expect(payload.source_sha256).toBe(plan.source_sha256);
    expect(payload.plan_sha256).toBe(plan.plan_sha256);
    submittedGroups = payload.groups;
    return route.fulfill({ json: { ...plan, origin: "manual" } });
  });

  await page.goto("/shadowing?project=project-1");
  await expect(page.getByRole("heading", { name: "Montar prática com IA" })).toBeVisible();
  await expect(page.getByText("Prática 1 · Mike")).toBeVisible();
  await expect(page.getByText("Prática 2 · Donna")).toBeVisible();
  await page.getByRole("button", { name: "Excluir grupo" }).first().click();
  await expect.poll(() => submittedGroups).toEqual([["cue-2"]]);
});

test("Shadowing sends the current scene to Groq and displays revised origin", async ({ page }) => {
  await arrangeShadowing(page);
  let generated = false;
  await page.route("**/api/projects/project-1/shadowing/scene-1/generate", (route) => {
    expect(route.request().method()).toBe("POST");
    generated = true;
    return route.fulfill({ json: { ...plan, origin: "groq" } });
  });
  await page.goto("/shadowing?project=project-1");
  await page.getByRole("button", { name: "Gerar proposta com Groq" }).click();
  await expect(page.getByText(/A Groq gerou uma nova proposta/)).toBeVisible();
  expect(generated).toBe(true);
});
