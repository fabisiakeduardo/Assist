import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { RealtimeHub } from "../src/realtime.js";
import { runEscalationTick } from "../src/services/escalation.js";
import type { RealtimeEvent } from "../src/domain/types.js";

// ─── job de escalonamento por SLA vencido ────────────────────────────────────

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const future = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

function stack() {
  const store = new Store(openMemoryDb());
  seed(store);
  const hub = new RealtimeHub();
  const events: RealtimeEvent[] = [];
  hub.subscribeConsole((e) => events.push(e));
  return { store, hub, events };
}

function waitingConv(store: Store, userId: string, queue: "N1" | "N2" | null, handoffAt: string, ticketId?: string) {
  const conv = store.createConversation(userId);
  store.setConversationStatus(conv.id, "waiting_analyst", {
    queue,
    handoffSummary: "resumo",
    handoffReason: "pedido do funcionário",
    handoffAt,
    ...(ticketId ? { ticketId } : {}),
  });
  return conv;
}

const anaId = (s: Store) => s.userByEmail("ana.souza@nexo.com.br")!.id;

describe("escalonamento por SLA", () => {
  it("conversa N1 com chamado vencido sobe para N2 com mensagem de sistema", () => {
    const { store, hub, events } = stack();
    const conv = waitingConv(store, anaId(store), "N1", ago(10), "INC-20298");
    store.updateTicket("INC-20298", { dueAt: ago(5) }); // venceu há 5 min

    const hits = runEscalationTick(store, hub);

    expect(hits.map((h) => h.conversationId)).toEqual([conv.id]);
    const fresh = store.conversation(conv.id)!;
    expect(fresh.queue).toBe("N2");
    expect(fresh.handoffReason).toContain("escalonada");
    expect(fresh.unreadForAnalyst).toBe(1);
    const last = store.lastMessage(conv.id)!;
    expect(last.sender).toBe("system");
    expect(last.text).toContain("N2");
    expect(last.text).toContain("INC-20298");
    // evento SSE avisando o console
    expect(events.some((e) => e.type === "conversations_changed")).toBe(true);
    // auditoria no histórico do chamado
    expect(store.ticketEvents("INC-20298").some((e) => /escalonada/i.test(e.text))).toBe(true);
  });

  it("chamado dentro do prazo e espera curta → não escala", () => {
    const { store, hub } = stack();
    waitingConv(store, anaId(store), "N1", ago(5), "INC-20298");
    store.updateTicket("INC-20298", { dueAt: future(120) });
    expect(runEscalationTick(store, hub)).toEqual([]);
    expect(store.conversation(store.activeConversationFor(anaId(store))!.id)!.queue).toBe("N1");
  });

  it("espera longa sem chamado vinculado também escala", () => {
    const { store, hub } = stack();
    const conv = waitingConv(store, anaId(store), "N1", ago(120));
    const hits = runEscalationTick(store, hub);
    expect(hits.map((h) => h.conversationId)).toEqual([conv.id]);
    expect(store.conversation(conv.id)!.queue).toBe("N2");
  });

  it("conversa já em N2 não é re-escalonada (sem mensagem duplicada)", () => {
    const { store, hub } = stack();
    const conv = waitingConv(store, anaId(store), "N2", ago(500), "INC-20298");
    store.updateTicket("INC-20298", { dueAt: ago(5) });
    const before = store.messages(conv.id).length;
    expect(runEscalationTick(store, hub)).toEqual([]);
    expect(store.messages(conv.id).length).toBe(before);
  });

  it("conversa com o agent não é tocada, mesmo com chamado vencido", () => {
    const { store, hub } = stack();
    const conv = store.createConversation(anaId(store)); // with_agent
    store.linkTicket(conv.id, "INC-20298");
    store.updateTicket("INC-20298", { dueAt: ago(5) });
    expect(runEscalationTick(store, hub)).toEqual([]);
    expect(store.conversation(conv.id)!.status).toBe("with_agent");
  });
});
