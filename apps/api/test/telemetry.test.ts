import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { addUsage, estimateCostUsd, toTurnUsage } from "../src/agent/telemetry.js";

// ─── telemetria: usage do LLM + custo estimado + meta persistida ─────────────

describe("toTurnUsage", () => {
  it("normaliza usage do AI SDK (campos opcionais)", () => {
    expect(
      toTurnUsage({ inputTokens: 120, outputTokens: 45, totalTokens: 165, reasoningTokens: 10 }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      reasoningTokens: 10,
    });
  });

  it("calcula total quando o provider não reporta", () => {
    expect(toTurnUsage({ inputTokens: 10, outputTokens: 5 })).toMatchObject({
      totalTokens: 15,
    });
  });

  it("retorna undefined sem nenhum campo numérico", () => {
    expect(toTurnUsage({})).toBeUndefined();
    expect(toTurnUsage(null)).toBeUndefined();
    expect(toTurnUsage({ inputTokens: "nope" })).toBeUndefined();
  });
});

describe("addUsage", () => {
  it("soma steps de um turno multi-step", () => {
    const total = addUsage(
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      { inputTokens: 80, outputTokens: 30, totalTokens: 110, reasoningTokens: 5 },
    );
    expect(total).toMatchObject({ inputTokens: 180, outputTokens: 50, totalTokens: 230 });
    expect(total.reasoningTokens).toBe(5);
  });
});

describe("estimateCostUsd", () => {
  it("modelo conhecido → custo por tabela (gemini-2.5-flash: $0.30/$2.50 por 1M)", () => {
    const cost = estimateCostUsd("google/gemini-2.5-flash", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      totalTokens: 1_100_000,
    });
    expect(cost).toBeCloseTo(0.3 + 0.25, 6);
  });

  it("modelo desconhecido sem override → undefined", () => {
    expect(
      estimateCostUsd("acme/modelo-x", { inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
    ).toBeUndefined();
  });
});

describe("meta na mensagem", () => {
  it("addMessage persiste meta e message() a devolve", () => {
    const store = new Store(openMemoryDb());
    seed(store);
    const ana = store.userByEmail("ana.souza@nexo.com.br")!;
    const conv = store.createConversation(ana.id);
    const m = store.addMessage({
      conversationId: conv.id,
      sender: "agent",
      text: "resposta",
      meta: {
        engine: "mastra",
        model: "google/gemini-2.5-flash",
        usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 },
        costUsd: 0.00057,
      },
    });
    const fresh = store.message(m.id)!;
    expect(fresh.meta?.engine).toBe("mastra");
    expect(fresh.meta?.usage?.totalTokens).toBe(1020);
    expect(fresh.meta?.costUsd).toBeCloseTo(0.00057);
  });

  it("mensagens antigas sem meta → meta null", () => {
    const store = new Store(openMemoryDb());
    seed(store);
    const ana = store.userByEmail("ana.souza@nexo.com.br")!;
    const conv = store.createConversation(ana.id);
    const m = store.addMessage({ conversationId: conv.id, sender: "user", text: "oi" });
    expect(store.message(m.id)!.meta).toBeNull();
  });
});
