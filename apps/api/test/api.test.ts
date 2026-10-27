import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { TicketService } from "../src/services/ticketService.js";
import { HelpCenter } from "../src/services/helpCenter.js";
import { RealtimeHub } from "../src/realtime.js";
import { AgentRunner } from "../src/services/runner.js";
import { ScriptedEngine } from "../src/agent/scripted.js";
import { buildServer, SESSION_COOKIE } from "../src/server.js";
import { registerRoutes } from "../src/routes.js";
import { config } from "../src/config.js";

// ─── integração HTTP via fastify.inject (sem porta) ──────────────────────────

let app: FastifyInstance;
let store: Store;

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${c!.value}`;
}

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "demo" },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeAll(async () => {
  store = new Store(openMemoryDb());
  seed(store);
  const tickets = new TicketService(store, 0);
  const help = new HelpCenter(store);
  const hub = new RealtimeHub();
  const engine = new ScriptedEngine({ stepMs: 0, wordMs: 0 });
  const runner = new AgentRunner({ store, tickets, help }, engine, hub);
  app = await buildServer({ store });
  // mesma montagem da produção: rotas sob /api
  await app.register(
    async (api) => {
      registerRoutes(api, { store, tickets, help, runner, hub, engineKind: "scripted" });
    },
    { prefix: "/api" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("auth", () => {
  it("login com e-mail corporativo cria sessão", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ana.souza@nexo.com.br", password: "x" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.name).toBe("Ana Souza");
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(true);
  });

  it("e-mail desconhecido → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ninguem@nexo.com.br", password: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("sem sessão → 401 em rotas protegidas", async () => {
    const res = await app.inject({ method: "GET", url: "/api/conversations/current" });
    expect(res.statusCode).toBe(401);
  });

  it("funcionário não acessa o console do analista", async () => {
    const cookie = await login("ana.souza@nexo.com.br");
    const res = await app.inject({
      method: "GET",
      url: "/api/console/conversations",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("privacidade de chamados", () => {
  it("chamado de outro funcionário → 404 (não revela existência)", async () => {
    const cookie = await login("ana.souza@nexo.com.br");
    const bruno = store.userByEmail("bruno.tavares@nexo.com.br")!;
    const foreign = store.ticketsFor(bruno.id)[0]!;

    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${foreign.id}`,
      headers: { cookie },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("próprio chamado → 200 com detalhes", async () => {
    const cookie = await login("ana.souza@nexo.com.br");
    const ana = store.userByEmail("ana.souza@nexo.com.br")!;
    const mine = store.ticketsFor(ana.id)[0]!;

    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${mine.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket.id).toBe(mine.id);
  });
});

describe("conversa e limite de uso", () => {
  it("current cria/reusa conversa ativa", async () => {
    const cookie = await login("ana.souza@nexo.com.br");
    const r1 = await app.inject({ method: "GET", url: "/api/conversations/current", headers: { cookie } });
    const r2 = await app.inject({ method: "GET", url: "/api/conversations/current", headers: { cookie } });
    expect(r1.json().conversation.id).toBe(r2.json().conversation.id);
  });

  it("limite diário de mensagens → 429", async () => {
    const cookie = await login("carla.mendes@nexo.com.br");
    const carla = store.userByEmail("carla.mendes@nexo.com.br")!;
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < config.dailyMessageLimit; i++) store.bumpUsage(carla.id, day);

    const conv = store.activeConversationFor(carla.id) ?? store.createConversation(carla.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: { cookie },
      payload: { text: "ainda tem limite?" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("daily_limit");
  });
});

describe("fluxo de rascunho via HTTP", () => {
  it("rascunho confirmado pela rota cria o chamado", async () => {
    const cookie = await login("diego.ramos@nexo.com.br");
    const convRes = await app.inject({ method: "GET", url: "/api/conversations/current", headers: { cookie } });
    const convId = convRes.json().conversation.id as string;

    // dirige a conversa até um rascunho existir (engine roda async no servidor)
    async function send(text: string) {
      await app.inject({
        method: "POST",
        url: `/api/conversations/${convId}/messages`,
        headers: { cookie },
        payload: { text },
      });
      // espera o turno do agent terminar (fila serial por conversa)
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const c = await app.inject({ method: "GET", url: `/api/conversations/${convId}`, headers: { cookie } });
        const msgs = c.json().messages as Array<{ sender: string }>;
        if (msgs[msgs.length - 1]?.sender === "agent") return c.json();
      }
      throw new Error("agent não respondeu a tempo");
    }

    await send("A impressora do andar 3 não imprime nada, papel novo e ligada.");
    await send("Não resolveu — abrir chamado");
    const withDraft = await send("Só eu. Sem pressa, é para amanhã.");
    expect(withDraft.pendingDraft).toBeTruthy();

    const draftId = withDraft.pendingDraft.id as string;
    const confirm = await app.inject({
      method: "POST",
      url: `/api/conversations/${convId}/drafts/${draftId}/confirm`,
      headers: { cookie },
      payload: {},
    });
    expect(confirm.statusCode).toBe(200);
    const ticketId = confirm.json().ticket?.id ?? confirm.json().ticketId;
    expect(ticketId).toMatch(/^(INC|REQ)-\d+$/);
  });
});
