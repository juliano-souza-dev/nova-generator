import { expect, test } from "@playwright/test";

test("editor can operate the cue and word timeline", async ({ page }) => {
  await page.goto("/editorial");
  await expect(
    page.getByRole("img", { name: "Waveform, cues e tempos das palavras" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reproduzir" }).click();
  await expect(page.getByRole("button", { name: "Pausar" })).toBeVisible();
  await page.getByRole("button", { name: "Aumentar zoom" }).click();
  await expect(page.getByLabel("Zoom atual")).toHaveText("3×");
});
