import { expect, test } from "@playwright/test";

test("opens the job monitor", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Monitor de jobs" })).toBeVisible();
  await expect(page.getByText("Nenhum job encontrado")).toBeVisible();
});
