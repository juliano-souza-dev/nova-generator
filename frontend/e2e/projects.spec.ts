import { expect, test } from "@playwright/test";

test("opens the project creation form", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "Novo projeto" }).click();
  await expect(page.getByRole("heading", { name: "Novo projeto" })).toBeVisible();
  await expect(page.getByLabel("URL do YouTube (opcional)")).toBeVisible();
});
