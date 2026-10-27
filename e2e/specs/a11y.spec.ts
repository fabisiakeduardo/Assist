import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { ANALYST, EMPLOYEE, loginAs } from "./helpers";

// Auditoria axe nas três telas principais — violações bloqueiam o CI.
test.describe("a11y (axe)", () => {
  test("tela de login", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("chat do funcionário", async ({ page }) => {
    await loginAs(page, EMPLOYEE);
    await page.waitForURL("**/chat");
    await expect(page.getByPlaceholder(/Escreva para o Nexo/)).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("console do analista", async ({ page }) => {
    await loginAs(page, ANALYST);
    await page.waitForURL("**/console");
    await expect(page.getByRole("heading", { name: "Conversas" })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
