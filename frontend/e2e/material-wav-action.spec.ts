import { expect, test, type Page } from "@playwright/test";

async function arrangeMaterialPage(page: Page) {
  await page.route("**/api/projects?*", (route) =>
    route.fulfill({ json: [{ id: "project-1", title: "Demo", content_type: "dialogue" }] }),
  );
  await page.route("**/api/voices", (route) =>
    route.fulfill({
      json: [
        {
          id: "voice-1",
          name: "Juliana",
          version: 3,
          model_id: "chatterbox-turbo",
          model_sha256: "a".repeat(64),
          reference_audio_sha256: "b".repeat(64),
          parameters: {},
          snapshot_sha256: "c".repeat(64),
          preview_ready: true,
          preview_url: null,
          reference_ready: true,
        },
      ],
    }),
  );
  await page.route("**/api/projects/project-1/materials-ai/review", (route) =>
    route.fulfill({ json: { status: "pending", source_sha256: "", document: null } }),
  );
  await page.route("**/api/projects/project-1/materials/latest-export", (route) =>
    route.fulfill({ status: 404, json: { detail: "export not found" } }),
  );
  await page.route(/\/api\/projects\/project-1\/materials(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        cards: [
          {
            cue_id: "cue-1",
            scene_order: 1,
            cue_order: 1,
            approved_en: "Hello!",
            approved_pt: "Olá!",
            tags: [],
            included: true,
            speaker: "Juliana",
            speech_start_ms: 0,
            speech_end_ms: 650,
            reel_start_ms: null,
            reel_end_ms: null,
            audio_ready: false,
            audio_url: null,
            audio_error: null,
            editorial_ready: true,
            highlights: [],
          },
        ],
        voice_id: "voice-1",
        voice_version: 3,
      },
    }),
  );
}

test("Preparar WAV submits a job and shows queue state within the card", async ({ page }) => {
  await arrangeMaterialPage(page);
  let submissions = 0;
  await page.route("**/api/projects/project-1/materials/cue-1/audio", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ voice_id: "voice-1" });
    submissions += 1;
    return route.fulfill({ status: 202, json: { id: "audio-job-1", status: "queued" } });
  });
  await page.route("**/api/jobs/audio-job-1", (route) =>
    route.fulfill({ json: { id: "audio-job-1", status: "queued" } }),
  );
  await page.goto("/materials?project=project-1");

  const prepare = page.getByRole("button", { name: "Preparar WAV" });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(page.getByRole("button", { name: "Na fila" })).toBeDisabled();
  await expect(page.getByText("Tarefa recebida. Aguardando o worker.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver monitor de jobs" })).toBeVisible();
  expect(submissions).toBe(1);
});

test("Preparar WAV reports rejected requests visibly without leaving the table", async ({
  page,
}) => {
  await arrangeMaterialPage(page);
  await page.route("**/api/projects/project-1/materials/cue-1/audio", (route) =>
    route.fulfill({
      status: 422,
      json: { detail: "A referência de voz selecionada não é válida." },
    }),
  );
  await page.goto("/materials?project=project-1");

  const prepare = page.getByRole("button", { name: "Preparar WAV" });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(
    page.getByText(
      "Não foi possível iniciar a síntese: A referência de voz selecionada não é válida.",
    ),
  ).toBeVisible();
  await expect(prepare).toBeEnabled();
});
