import { expect, test } from "@playwright/test";

test("navigates through the studio shell", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("heading", { name: "Projetos" })).toBeVisible(); await page.getByRole("link", { name: "História" }).click(); await expect(page.getByRole("heading", { name: "Modo História" })).toBeVisible(); });
