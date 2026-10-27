import { test, expect } from "@playwright/test";
import { EMPLOYEE, loginAs, waitAgentReply } from "./helpers";

test.describe("chat do funcionário", () => {
  test("problema → ajuda → impacto → rascunho → confirmação cria chamado", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, EMPLOYEE);
    await page.waitForURL("**/chat");

    // 1) relato de problema — o agent responde (artigo da central ou pergunta)
    const input = page.getByPlaceholder(/Escreva para o Nexo/);
    await input.fill("minha vpn não conecta de jeito nenhum desde cedo");
    await page.getByRole("button", { name: "Enviar" }).click();

    // a central de ajuda é consultada antes de qualquer chamado
    const notResolved = page.getByRole("button", { name: /abrir chamado/i });
    const soEu = page.getByRole("button", { name: "Só eu" });
    await expect(notResolved.or(soEu)).toBeVisible({ timeout: 45_000 });

    // 2) se a central respondeu, "não resolveu" segue para o intake de chamado
    if (await notResolved.isVisible()) {
      await notResolved.click();
      await expect(soEu).toBeVisible({ timeout: 45_000 });
    }

    // 3) impacto → o agent monta o rascunho (nada é criado antes de confirmar)
    await soEu.click();
    const draft = page.locator(".draft-card");
    await expect(draft).toBeVisible({ timeout: 45_000 });
    await expect(draft.getByText("Aguardando confirmação")).toBeVisible();

    // 4) confirma → chamado criado + card do chamado
    await page.getByRole("button", { name: "Confirmar" }).click();
    await waitAgentReply(page, /abri o (chamado|chamados)/i);
    await expect(page.locator(".ticket-card").first()).toBeVisible({ timeout: 20_000 });
    await expect(draft).not.toBeVisible();
  });

  test("pergunta how-to recebe resposta da central de ajuda", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, EMPLOYEE);
    await page.waitForURL("**/chat");

    const input = page.getByPlaceholder(/Escreva para o Nexo/);
    await input.fill("como eu conecto na vpn?");
    await page.getByRole("button", { name: "Enviar" }).click();

    // resposta do agent chega (conteúdo do artigo ou pergunta de impacto)
    await expect(page.locator(".msg.agent").last()).toBeVisible({ timeout: 45_000 });
    await waitAgentReply(page, /\S/);
    await expect(page.locator(".steps-line").last()).toBeVisible();
  });
});
