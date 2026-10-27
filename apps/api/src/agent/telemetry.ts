import type { TurnUsage } from "../domain/types.js";

// ─── Telemetria de tokens/custo do LLM ───────────────────────────────────────
// O turno do Mastra pode ter vários steps (tool-call → tool-result → novo
// step); `stream.usage` já devolve o total consolidado — o fallback soma os
// `step-finish`. O custo é estimado por tabela de preço público (USD/1M) com
// override por env para modelos fora da lista.

const num = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) ? x : undefined;

/** Normaliza o objeto de usage do AI SDK/Mastra (campos podem vir undefined). */
export function toTurnUsage(raw: unknown): TurnUsage | undefined {
  const o = (raw ?? {}) as Record<string, unknown>;
  const input = num(o.inputTokens);
  const output = num(o.outputTokens);
  const total = num(o.totalTokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  const usage: TurnUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: total ?? (input ?? 0) + (output ?? 0),
  };
  const reasoning = num(o.reasoningTokens);
  const cached = num(o.cachedInputTokens);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  return usage;
}

/** Soma dois usages (para acumular steps quando o total não vem consolidado). */
export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
    ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
      ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }
      : {}),
  };
}

// Preços públicos por 1M de tokens (USD) — referência: páginas de pricing dos
// providers. Chaves são prefixos de LLM_MODEL ("google/gemini-2.5-flash").
// Overrides: LLM_INPUT_PRICE_PER_M / LLM_OUTPUT_PRICE_PER_M.
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "google/gemini-2.5-pro": { in: 1.25, out: 10 },
  "google/gemini-2.0-flash": { in: 0.1, out: 0.4 },
  "google/gemini-3-pro": { in: 2, out: 12 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "openai/gpt-4o": { in: 2.5, out: 10 },
  "openai/gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "openai/gpt-4.1": { in: 2, out: 8 },
  "openai/gpt-5": { in: 1.25, out: 10 },
  "openai/gpt-5-mini": { in: 0.25, out: 2 },
  "anthropic/claude-haiku-4.5": { in: 1, out: 5 },
  "anthropic/claude-sonnet-4": { in: 3, out: 15 },
  "anthropic/claude-opus-4": { in: 15, out: 75 },
  "xai/grok-4-fast": { in: 0.2, out: 0.5 },
  "xai/grok-3-mini": { in: 0.3, out: 0.5 },
  "deepseek/deepseek-chat": { in: 0.27, out: 1.1 },
  "deepseek/deepseek-reasoner": { in: 0.55, out: 2.19 },
};

function envPrice(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Custo estimado do turno em USD; undefined se não houver tabela/override. */
export function estimateCostUsd(model: string, usage: TurnUsage): number | undefined {
  const entry =
    PRICE_PER_M[model] ??
    Object.entries(PRICE_PER_M).find(([k]) => model.startsWith(k))?.[1];
  const inPrice = envPrice("LLM_INPUT_PRICE_PER_M") ?? entry?.in;
  const outPrice = envPrice("LLM_OUTPUT_PRICE_PER_M") ?? entry?.out;
  if (inPrice === undefined && outPrice === undefined) return undefined;
  return (usage.inputTokens * (inPrice ?? 0) + usage.outputTokens * (outPrice ?? 0)) / 1e6;
}
