import { test, expect } from "@playwright/test";
import { ANALYST, EMPLOYEE, loginAs } from "./helpers";

test.describe("login", () => {
  test("funcionária entra e cai no chat", async ({ page }) => {
    await loginAs(page, EMPLOYEE);
    await page.waitForURL("**/chat");
    await expect(page.getByRole("link", { name: "Atendimento" })).toBeVisible();
    await expect(page.getByPlaceholder(/Escreva para o Nexo/)).toBeVisible();
  });

  test("analista entra e cai no console", async ({ page }) => {
    await loginAs(page, ANALYST);
    await page.waitForURL("**/console");
    await expect(page.getByRole("heading", { name: "Conversas" })).toBeVisible();
  });

  test("e-mail sem acesso mostra erro e não entra", async ({ page }) => {
    await loginAs(page, "fora.da.empresa@nexo.com.br");
    await expect(page.getByText("Esse e-mail não tem acesso ao service desk.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("sem sessão, /chat redireciona para o login", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL("**/login");
  });
});
