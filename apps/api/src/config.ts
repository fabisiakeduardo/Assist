import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Minimal .env loader (no dependency). Reads apps/api/.env and repo-root .env.
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
loadDotEnv(path.join(apiRoot, ".env"));
loadDotEnv(path.resolve(apiRoot, "../../.env"));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type AgentEngineKind = "auto" | "mastra" | "scripted";

export const config = {
  port: num("PORT", 4100),
  host: process.env.HOST ?? "0.0.0.0",
  databaseFile: process.env.DATABASE_FILE ?? path.join(apiRoot, "data", "nexo.db"),
  agentEngine: (process.env.AGENT_ENGINE ?? "auto") as AgentEngineKind,
  llmModel: process.env.LLM_MODEL ?? "openai/gpt-4o-mini",
  llmTemperature: num("LLM_TEMPERATURE", 0.2),
  ticketsChaosRate: num("TICKETS_CHAOS_RATE", 0.12),
  dailyMessageLimit: num("DAILY_MESSAGE_LIMIT", 30),
  /** Janela (dias) em que um chamado resolvido pode ser reaberto (Anexo A). */
  reopenWindowDays: 7,
} as const;

export function hasLlmKey(): boolean {
  const model = config.llmModel;
  const provider = model.split("/")[0] ?? "";
  const envFor: Record<string, string[]> = {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    groq: ["GROQ_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
  };
  const keys = envFor[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  return keys.some((k) => (process.env[k] ?? "").length > 0);
}
