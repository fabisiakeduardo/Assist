import { test, expect } from "@playwright/test";
import { ANALYST, loginAs } from "./helpers";

test.describe("console do analista", () => {
  test("lista conversas com fila N1/N2 e permite assumir atendimento", async ({ page }) => {
    await loginAs(page, ANALYST);
    await page.waitForURL("**/console");

    await expect(page.getByRole("heading", { name: "Conversas" })).toBeVisible();

    // fila visível nos cards transferidos (seed: Carla N1 e Bruno N2)
    const n1 = page.locator(".cl-item", { hasText: "Transferida N1" }).first();
    const n2 = page.locator(".cl-item", { hasText: "Transferida N2" }).first();
    await expect(n1).toBeVisible();
    await expect(n2).toBeVisible();

    // abre a conversa transferida e assume o atendimento
    await n1.click();
    const assume = page.getByRole("button", { name: /Assumir atendimento/ });
    await expect(assume).toBeVisible();
    await assume.click();
    await expect(page.getByText("Você está atendendo").first()).toBeVisible();

    // responde como analista
    const reply = page.getByLabel("Responder como analista");
    await reply.fill("Oi! Já estou olhando o seu caso.");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.locator(".analyst-msg .bubble").last()).toContainText(
      "Já estou olhando o seu caso.",
    );
  });
});
