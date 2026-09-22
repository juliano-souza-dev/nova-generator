import { expect, test } from "@playwright/test";

test("validates, reviews, renders and publishes a Story", async ({ page }) => {
  let uploads = 0;
  let published = false;
  await page.route("**/api/stories", async (route) => {
    uploads++;
    if (uploads === 1) {
      await route.fulfill({
        status: 422,
        json: { issues: [{ path: "$.cues[0].image", message: "missing image" }] },
      });
    } else {
      await route.fulfill({
        status: 201,
        json: {
          id: "00000000-0000-4000-8000-000000000001",
          title: "História Á",
          language: "en",
          aspect_ratio: "9:16",
          images: [{ path: "images/one.jpg", sha256: "abc", size_bytes: 5 }],
          image_urls: { "images/one.jpg": "/api/stories/1/images/images/one.jpg" },
          cues: [
            {
              order: 1,
              image: "images/one.jpg",
              en: "Don’t stop.",
              pt: "Não pare.",
              highlights: [{ text: "Don’t", pt: "Não", type: "important_word", occurrence: 1 }],
            },
          ],
          preview_url: null,
        },
      });
    }
  });
  await page.route("**/api/voices", (route) =>
    route.fulfill({ json: [{ id: "voice-id", name: "Ana", version: 1 }] }),
  );
  await page.route("**/api/stories/*/render", (route) =>
    route.fulfill({ status: 202, json: { job_id: "job-1", status: "queued" } }),
  );
  await page.route("**/api/jobs/job-1", (route) =>
    route.fulfill({
      json: { id: "job-1", kind: "story.render", status: "succeeded", error_message: null },
    }),
  );
  await page.route("**/api/stories/*/publication", async (route) => {
    published = true;
    await route.fulfill({
      json: { schema: "immersionhub-text-audio", youtubeVideoId: "abcdefghijk" },
    });
  });
  await page.route("**/api/stories/1/images/**", (route) => route.fulfill({ body: "image" }));
  await page.route("**/api/stories/1/preview", (route) => route.fulfill({ body: "video" }));
  await page.route("**/api/stories/00000000-0000-4000-8000-000000000001", (route) =>
    route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-000000000001",
        title: "História Á",
        language: "en",
        aspect_ratio: "9:16",
        images: [],
        image_urls: {},
        cues: [],
        preview_url: "/api/stories/1/preview",
      },
    }),
  );

  await page.goto("/story");
  const upload = page.getByLabel("Pacote da História (.zip)");
  await upload.setInputFiles({
    name: "bad.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("bad"),
  });
  await expect(page.getByText("$.cues[0].image")).toBeVisible();
  await expect(page.getByRole("button", { name: "Iniciar render" })).toHaveCount(0);
  await upload.setInputFiles({
    name: "corrected.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("good"),
  });
  await expect(page.getByText("Don’t stop.")).toBeVisible();
  await expect(page.getByText("Não pare.")).toBeVisible();
  await page.getByLabel("Perfil de voz").selectOption("voice-id");
  await page.getByRole("button", { name: "Iniciar render" }).click();
  await expect(page.getByText("job-1")).toBeVisible();
  await page.getByRole("button", { name: "Carregar prévia" }).click();
  await expect(page.getByLabel("Prévia da História")).toBeVisible();
  await page.getByLabel("URL ou ID do YouTube").fill("invalid");
  await expect(page.getByRole("button", { name: "Gerar JSON público" })).toBeDisabled();
  await page.getByLabel("URL ou ID do YouTube").fill("abcdefghijk");
  await page.getByRole("button", { name: "Gerar JSON público" }).click();
  await expect(page.getByText("JSON validado para publicação.")).toBeVisible();
  expect(published).toBe(true);
});
