import { expect, test } from "@playwright/test";

test("opens the job monitor", async ({ page }) => {
  await page.route("**/api/jobs?*", (route) =>
    route.fulfill({ json: { items: [], offset: 0, limit: 25, total: 0 } }),
  );
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Monitor de jobs" })).toBeVisible();
  await expect(page.getByText("Nenhum job encontrado")).toBeVisible();
});
