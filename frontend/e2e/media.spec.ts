import { expect, test } from "@playwright/test";

test("opens the media source workspace", async ({ page }) => {
  await page.goto("/media");
  await expect(page.getByRole("heading", { name: "Fonte e corte de mídia" })).toBeVisible();
  await expect(page.getByText("Nenhum projeto para preparar")).toBeVisible();
});
