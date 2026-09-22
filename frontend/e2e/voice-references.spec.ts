import { expect, test } from "@playwright/test";

test("uploads a WAV and creates a selectable voice without entering hashes", async ({ page }) => {
  const digest = "c".repeat(64);
  let created = false;
  let uploaded = false;
  await page.route("**/api/voices/model", (route) =>
    route.fulfill({ json: { available: true, model_sha256: "a".repeat(64) } }),
  );
  await page.route("**/api/voices/references", async (route) => {
    const reference = {
      sha256: digest,
      duration_ms: 2000,
      sample_rate: 16000,
      channels: 1,
      size_bytes: 64044,
      audio_url: `/api/voices/references/${digest}`,
    };
    if (route.request().method() === "POST") {
      uploaded = true;
      await route.fulfill({ status: 201, json: reference });
    } else {
      await route.fulfill({ json: uploaded ? [reference] : [] });
    }
  });
  await page.route("**/api/voices", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON();
      expect(payload.model_sha256).toBeUndefined();
      expect(payload.reference_audio_sha256).toBe(digest);
      created = true;
      await route.fulfill({
        status: 201,
        json: {
          id: "voice-id",
          name: payload.name,
          version: 1,
          model_id: "chatterbox-nano",
          model_sha256: "a".repeat(64),
          reference_audio_sha256: digest,
          parameters: {},
          snapshot_sha256: "b".repeat(64),
          preview_ready: false,
          preview_url: null,
        },
      });
    } else {
      await route.fulfill({
        json: created
          ? [
              {
                id: "voice-id",
                name: "Nova voz",
                version: 1,
                model_id: "chatterbox-nano",
                model_sha256: "a".repeat(64),
                reference_audio_sha256: digest,
                parameters: {},
                snapshot_sha256: "b".repeat(64),
                preview_ready: false,
                preview_url: null,
              },
            ]
          : [],
      });
    }
  });
  await page.route("**/api/voices/references/*", (route) => route.fulfill({ body: "audio" }));

  await page.goto("/voices");
  await expect(page.getByText("Modelo Chatterbox Nano disponível.")).toBeVisible();
  await page.getByLabel("Enviar WAV de referência (1 a 30 segundos)").setInputFiles({
    name: "speaker.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("wav"),
  });
  await page.getByLabel("Áudio de referência").selectOption(digest);
  await page.getByPlaceholder("Narradora Ana").fill("Nova voz");
  await page.getByRole("button", { name: "Criar e sintetizar prévia" }).click();
  await expect(page.getByRole("button", { name: /Nova voz v1/ })).toBeVisible();
});
