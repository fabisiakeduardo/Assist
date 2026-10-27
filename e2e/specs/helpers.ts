import { expect, type Page } from "@playwright/test";

export const EMPLOYEE = "ana.souza@nexo.com.br";
export const ANALYST = "rafael.lima@nexo.com.br";

/** Login por senha (AUTH_ANY_PASSWORD=true no servidor de teste). */
export async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail corporativo").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("qualquer-senha");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Espera a mensagem final do agent (bolha .msg.agent com .bubble com texto). */
export async function waitAgentReply(page: Page, matcher: RegExp | string, timeout = 45_000) {
  await expect(page.locator(".msg.agent .bubble").last()).toContainText(matcher, { timeout });
}
