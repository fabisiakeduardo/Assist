import { describe, expect, it, beforeEach } from "vitest";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { LegacyUnavailableError, TicketService } from "../src/services/ticketService.js";
import type { RealtimeEvent } from "../src/domain/types.js";
import { HelpCenter } from "../src/services/helpCenter.js";
import { ScriptedEngine } from "../src/agent/scripted.js";
import type { AgentResult, AgentServices } from "../src/agent/engine.js";
import type { Conversation, User } from "../src/domain/types.js";

// ─── engine determinístico contra banco em memória + seed real ───────────────

function makeStack() {
  const store = new Store(openMemoryDb());
  seed(store);
  const services: AgentServices = {
    store,
    tickets: new TicketService(store, 0),
    help: new HelpCenter(store),
  };
  const engine = new ScriptedEngine({ stepMs: 0, wordMs: 0 });
  return { store, services, engine };
}

type Stack = ReturnType<typeof makeStack>;

/** Imita o AgentRunner: persiste a msg do usuário, roda o turno, persiste a resposta. */
async function turn(
  stack: Stack,
  conv: Conversation,
  user: User,
  text: string,
  emit: (e: RealtimeEvent) => void = () => {},
): Promise<AgentResult> {
  stack.store.addMessage({ conversationId: conv.id, sender: "user", senderId: user.id, text });
  const result = await stack.engine.run(
    {
      conversation: stack.store.conversation(conv.id)!,
      user,
      userText: text,
      history: stack.store.messages(conv.id),
      streamMessageId: "test",
    },
    stack.services,
    emit,
  );
  stack.store.addMessage({
    conversationId: conv.id,
    sender: "agent",
    text: result.text,
    steps: result.steps,
    cards: result.cards ?? null,
  });
  return result;
}

const anaOf = (s: Stack) => s.store.userByEmail("ana.souza@nexo.com.br")!;

describe("fluxo de novo chamado (intake → impacto → rascunho → confirmação)", () => {
  let stack: Stack;
  let conv: Conversation;
  let ana: User;

  beforeEach(() => {
    stack = makeStack();
    ana = anaOf(stack);
    conv = stack.store.createConversation(ana.id);
  });

  it("relato com erro 809 → artigo da central + opções", async () => {
    const r = await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.");
    expect(r.text).toContain("809");
    const opts = r.cards?.find((c) => c.type === "options");
    expect(opts).toBeTruthy();
    expect((opts as { options: string[] }).options.join(" ")).toContain("abrir chamado");
    // não deve ter criado rascunho ainda — a ajuda vem antes
    expect(stack.store.pendingDraftFor(conv.id)).toBeNull();
  });

  it("'Não resolveu — abrir chamado' retoma o intake e pergunta o impacto", async () => {
    await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.");
    const r = await turn(stack, conv, ana, "Não resolveu — abrir chamado");
    expect(r.text).toContain("quem está sendo afetado");
    expect(r.text).not.toContain("Ótimo");
  });

  it("fluxo completo até o chamado criado", async () => {
    await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.");
    await turn(stack, conv, ana, "Não resolveu — abrir chamado");
    const draftTurn = await turn(stack, conv, ana, "Só eu. Tenho reunião com um cliente às 14h e preciso da VPN funcionando.");

    expect(draftTurn.cards?.some((c) => c.type === "draft")).toBe(true);
    const draft = stack.store.pendingDraftFor(conv.id)!;
    expect(draft.priority).toBe("alta"); // compromisso ainda hoje
    expect(draft.title).toContain("VPN");
    expect(draft.description).not.toContain("abrir chamado");

    const done = await turn(stack, conv, ana, "Sim, pode criar");
    const card = done.cards?.find((c) => c.type === "ticket") as { ticketId: string } | undefined;
    expect(card?.ticketId).toMatch(/^INC-\d+$/);
    const ticket = stack.store.ticket(card!.ticketId)!;
    expect(ticket.requesterId).toBe(ana.id);
    expect(ticket.status).toBe("aberto");
    expect(stack.store.draft(draft.id)!.status).toBe("confirmed");
  });

  it("chamado sem rascunho não é criado — confirmação é obrigatória", async () => {
    await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.");
    await turn(stack, conv, ana, "Não resolveu — abrir chamado");
    await turn(stack, conv, ana, "Só eu.");
    // sem "pode criar" → nenhum ticket novo além dos seeds
    const mine = stack.store.ticketsFor(ana.id).map((t) => t.id);
    const before = mine.length;
    await turn(stack, conv, ana, "Cancela, deixa quieto");
    expect(stack.store.ticketsFor(ana.id).length).toBe(before);
    expect(stack.store.pendingDraftFor(conv.id)).toBeNull();
  });
});

describe("deduplicação", () => {
  it("segundo relato do mesmo problema oferece atualizar o chamado aberto", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.");
    await turn(stack, conv, ana, "Não resolveu — abrir chamado");
    await turn(stack, conv, ana, "Só eu. Tenho reunião com um cliente às 14h.");
    const created = await turn(stack, conv, ana, "Sim, pode criar");
    const tid = (created.cards!.find((c) => c.type === "ticket") as { ticketId: string }).ticketId;

    const dup = await turn(stack, conv, ana, "A VPN continua caindo, ainda o erro 809");
    expect(dup.text).toContain("já tem um chamado aberto");
    expect(dup.text).toContain(tid);
    expect(stack.store.ticketsFor(ana.id).filter((t) => t.title.includes("VPN")).length).toBe(1);

    const added = await turn(stack, conv, ana, "Sim, adicionar lá");
    expect(added.text).toContain("Atualizei");
    const events = stack.store.ticketEvents(tid);
    expect(events.some((e) => e.text.includes("VPN"))).toBe(true);
  });
});

describe("transferência para analista", () => {
  it("pedido explícito transfere com resumo e pausa o agent", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem.");
    const r = await turn(stack, conv, ana, "Quero falar com um analista");
    expect(r.text).toContain("analista");

    const fresh = stack.store.conversation(conv.id)!;
    expect(fresh.status).toBe("waiting_analyst");
    expect(fresh.handoffSummary).toBeTruthy();
    expect(stack.store.messages(conv.id).some((m) => m.sender === "system")).toBe(true);
  });
});

describe("consulta de status e seletor", () => {
  it("'como estão meus chamados?' lista os abertos com seletor", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    const r = await turn(stack, conv, ana, "Como estão meus chamados?");
    const sel = r.cards?.find((c) => c.type === "ticket_selector") as { ticketIds: string[] } | undefined;
    expect(sel).toBeTruthy();
    expect(sel!.ticketIds.length).toBeGreaterThan(1);
  });

  it("detalhe de chamado citado por id", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);
    const tid = stack.store.openTicketsFor(ana.id)[0]!.id;

    const r = await turn(stack, conv, ana, `Como está o ${tid}?`);
    expect(r.text).toContain(tid);
    expect(r.cards?.some((c) => c.type === "ticket")).toBe(true);
  });

  it("chamado de outra pessoa não é revelado (privacidade)", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);
    const bruno = stack.store.userByEmail("bruno.tavares@nexo.com.br")!;
    const foreign = stack.store.ticketsFor(bruno.id)[0];
    if (!foreign) return; // seed garante tickets do Bruno

    const r = await turn(stack, conv, ana, `Como está o ${foreign.id}?`);
    expect(r.text).toContain("chamados que você abriu");
    expect(r.text).not.toContain(foreign.title);
  });
});

describe("escopo e casos especiais", () => {
  it("pergunta de RH/financeiro é redirecionada", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    const r = await turn(stack, conv, ana, "Quando cai o pagamento do salário deste mês?");
    expect(r.text).not.toContain("chamado");
    expect(r.text.toLowerCase()).toMatch(/ti|tecnologia|service desk/);
  });

  it("Windows 11 + erro 809: artigo do Windows 10 não é oferecido", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    const r = await turn(stack, conv, ana, "Meu notebook com Windows 11 mostra erro 809 na VPN");
    // não deve oferecer o artigo (que só cobre Win10) — vai direto ao intake
    expect(r.text).not.toContain("resolve na maioria dos casos");
    expect(r.text).toContain("afetado");
  });

  it("saudação simples responde com apresentação", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    const r = await turn(stack, conv, ana, "Oi");
    expect(r.text).toContain("Nexo Assist");
    expect(r.text).toContain("Ana");
  });
});

describe("rascunho pendente vs. novas intenções", () => {
  it("pergunta de status com rascunho pendente responde o status (não vira correção)", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    await turn(stack, conv, ana, "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.");
    await turn(stack, conv, ana, "Não resolveu — abrir chamado");
    await turn(stack, conv, ana, "Só eu. Tenho reunião com um cliente às 14h.");
    expect(stack.store.pendingDraftFor(conv.id)).toBeTruthy();

    const r = await turn(stack, conv, ana, "Como estão meus chamados?");
    expect(r.cards?.some((c) => c.type === "ticket_selector")).toBe(true);
    expect(r.text).toContain("rascunho");
    // o rascunho continua pendente — não foi descartado nem "corrigido" com a pergunta
    expect(stack.store.pendingDraftFor(conv.id)).toBeTruthy();
  });
});

describe("chamado resolvido", () => {
  it("resolvido há mais de 7 dias não reabre — oferece novo chamado", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    const detail = await turn(stack, conv, ana, "Como está o INC-19877?");
    expect(detail.text).toContain("resolvido");
    expect(
      (detail.cards?.find((c) => c.type === "options") as { options: string[] }).options,
    ).toContain("Adicionar informação");

    await turn(stack, conv, ana, "Adicionar informação");
    const r = await turn(stack, conv, ana, "O Outlook parou de sincronizar de novo hoje");
    expect(r.text).toContain("mais de 7 dias");
    expect(
      (r.cards?.find((c) => c.type === "options") as { options: string[] }).options.join(" "),
    ).toContain("abrir novo chamado");
    // o passo registra o motivo — transparência do que aconteceu
    expect(r.steps.some((s) => s.tool === "atualizar_chamado" && s.detail?.includes("7 dias"))).toBe(true);
    expect(stack.store.ticket("INC-19877")!.status).toBe("resolvido");

    // aceita → abre intake de chamado novo com a nota como relato
    const next = await turn(stack, conv, ana, "Sim, abrir novo chamado");
    expect(next.text).toContain("afetado");
  });

  it("resolvido dentro da janela reabre com a atualização", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    // REQ-10442 vira "resolvido" há 2 dias (dentro da janela de 7)
    stack.store.updateTicket("REQ-10442", {
      status: "resolvido",
      resolvedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });

    const detail = await turn(stack, conv, ana, "Como está o REQ-10442?");
    expect(detail.text).toContain("resolvido");
    await turn(stack, conv, ana, "Adicionar informação");
    const r = await turn(stack, conv, ana, "O monitor chegou com defeito no cabo");
    expect(r.text).toContain("Reabri");
    expect(stack.store.ticket("REQ-10442")!.status).toBe("aberto");
  });
});

describe("transparência dos passos", () => {
  it("passos carregam tool + latência medida", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    const r = await turn(stack, conv, ana, "Como estão meus chamados?");
    expect(r.steps.length).toBeGreaterThan(0);
    expect(r.steps.every((s) => typeof s.tool === "string" && s.tool.length > 0)).toBe(true);
    expect(r.steps.some((s) => typeof s.ms === "number" && s.ms! >= 1)).toBe(true);
  });

  it("instabilidade do legado emite passo de retry ao vivo e o persiste", async () => {
    const stack = makeStack();
    const ana = anaOf(stack);
    const conv = stack.store.createConversation(ana.id);

    // primeira chamada ao legado falha (503 simulado), a segunda funciona
    let calls = 0;
    const orig = stack.services.tickets.listOpen.bind(stack.services.tickets);
    stack.services.tickets.listOpen = async (id: string) => {
      if (++calls === 1) throw new LegacyUnavailableError();
      return orig(id);
    };

    const emitted: RealtimeEvent[] = [];
    const r = await turn(stack, conv, ana, "Como estão meus chamados?", (e) => emitted.push(e));

    const retryEvents = emitted.filter(
      (e) => e.type === "agent_step" && e.step.tool === "retry",
    );
    expect(retryEvents.length).toBe(1);
    // também fica persistido na mensagem → visível no console do analista
    expect(r.steps.some((s) => s.tool === "retry")).toBe(true);
  });
});
