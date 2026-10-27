import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Testes de UI end-to-end: sobe a API (engine scripted, SQLite em memória,
// seed completo) e o Vite dev, depois dirige um Chromium de verdade.
// Tudo que a spec precisa é determinístico — sem LLM, sem caos do TicketService.

const apiDir = path.resolve(__dirname, "../apps/api");
const webDir = path.resolve(__dirname, "../apps/web");

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // um banco em memória por API — serial
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:5100",
    locale: "pt-BR",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx src/index.ts",
      cwd: apiDir,
      url: "http://localhost:4100/health",
      timeout: 45_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: "4100",
        DATABASE_FILE: ":memory:", // seed limpo a cada run
        AGENT_ENGINE: "scripted", // agent determinístico, sem LLM
        AUTH_ANY_PASSWORD: "true",
        TICKETS_CHAOS_RATE: "0",
      },
    },
    {
      command: "npx vite --port 5100 --strictPort",
      cwd: webDir,
      url: "http://localhost:5100",
      timeout: 45_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
