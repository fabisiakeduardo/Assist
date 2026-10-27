import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { openSse, requireAnalyst, requireEmployee, requireUser, SESSION_COOKIE } from "./server.js";
import type { Store } from "./store.js";
import type { TicketService } from "./services/ticketService.js";
import type { HelpCenter } from "./services/helpCenter.js";
import type { AgentRunner } from "./services/runner.js";
import type { RealtimeHub } from "./realtime.js";
import { OidcClient, oidcPkce } from "./services/oidc.js";
import { randomBytes } from "node:crypto";
import type { Conversation, Message, Ticket, User } from "./domain/types.js";
import { PRIORITY_LABEL, STATUS_LABEL } from "./domain/types.js";
import { confirmDraft, cancelDraft, DraftNotPendingError } from "./services/draftActions.js";
import { STEPS } from "./agent/steps.js";
import { withRetry } from "./services/ticketService.js";
import { fmtAgo } from "./domain/sla.js";
import { z } from "zod";

interface RouteDeps {
  store: Store;
  tickets: TicketService;
  help: HelpCenter;
  runner: AgentRunner;
  hub: RealtimeHub;
  engineKind: string;
  oidc?: OidcClient | undefined;
}

const todayKey = () => new Date().toISOString().slice(0, 10);

// ── throttle de login (proteção no deploy público) ──────────────────────────
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginBuckets = new Map<string, { count: number; resetAt: number }>();

function allowLoginAttempt(ip: string): boolean {
  const now = Date.now();
  const b = loginBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    loginBuckets.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  return ++b.count <= LOGIN_MAX_ATTEMPTS;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, tickets, help, runner, hub } = deps;
  const services = { store, tickets, help };

  // ── auth ──────────────────────────────────────────────────────────────────

  app.post("/auth/login", async (req, reply) => {
    if (!allowLoginAttempt(req.ip)) {
      return reply.code(429).send({
        error: "too_many_attempts",
        detail: "Muitas tentativas de login — aguarde alguns minutos.",
      });
    }
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: "Informe e-mail e senha." });
    }
    const user = store.userByEmail(body.data.email);
    if (!user) {
      return reply.code(401).send({ error: "unknown_user", detail: "Esse e-mail não tem acesso ao service desk." });
    }
    // spec do desafio: qualquer senha entra; com AUTH_ANY_PASSWORD=false, valida o hash
    if (!config.authAnyPassword && !store.verifyPassword(user.id, body.data.password)) {
      return reply.code(401).send({ error: "invalid_password", detail: "Senha incorreta." });
    }
    const token = store.createSession(user.id);
    void reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 14,
    });
    return { user: publicUser(user) };
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.sessionToken) store.deleteSession(req.sessionToken);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // provedores de login habilitados — a tela de login decide o que mostrar
  app.get("/auth/providers", async () => ({
    password: true,
    oidc: deps.oidc ? { label: deps.oidc.cfg.label } : null,
  }));

  // ── SSO (OIDC) — Authorization Code + PKCE ────────────────────────────────
  if (deps.oidc) {
    const oidc = deps.oidc;

    app.get("/auth/oidc/login", async (req, reply) => {
      const state = randomBytes(16).toString("hex");
      const nonce = randomBytes(16).toString("hex");
      const verifier = oidcPkce.newVerifier();
      store.createOidcState(state, nonce, verifier);
      try {
        return reply.redirect(await oidc.authorizationUrl(state, nonce, verifier));
      } catch (err) {
        req.log.error(err, "oidc authorize falhou");
        return reply.redirect("/login?sso=error");
      }
    });

    app.get("/auth/oidc/callback", async (req, reply) => {
      const q = req.query as { code?: string; state?: string; error?: string };
      if (q.error) return reply.redirect(`/login?sso=${encodeURIComponent(q.error)}`);
      if (!q.code || !q.state) {
        return reply.code(400).send({ error: "invalid_callback" });
      }
      const stored = store.consumeOidcState(q.state);
      if (!stored) return reply.redirect("/login?sso=state");
      try {
        const { idToken } = await oidc.exchangeCode(q.code, stored.verifier);
        const identity = await oidc.validateIdToken(idToken, stored.nonce);
        const user = store.userByEmail(identity.email);
        if (!user) return reply.redirect("/login?sso=unknown_user");
        const token = store.createSession(user.id);
        void reply.setCookie(SESSION_COOKIE, token, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          maxAge: 60 * 60 * 24 * 14,
        });
        return reply.redirect("/");
      } catch (err) {
        req.log.error(err, "oidc callback falhou");
        return reply.redirect("/login?sso=error");
      }
    });
  }

  app.get("/me", async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    return { user: publicUser(u), usage: usageOf(store, u), engine: deps.engineKind };
  });

  // ── conversa do funcionário ───────────────────────────────────────────────

  app.get("/conversations/current", async (req, reply) => {
    const u = requireEmployee(req, reply);
    if (!u) return;
    const conv = store.activeConversationFor(u.id) ?? store.createConversation(u.id);
    return { conversation: conversationDto(store, conv) };
  });

  app.get("/conversations/:id", async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const conv = store.conversation((req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (u.role === "employee" && conv.userId !== u.id) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const messages = store.messages(conv.id).map((m) => messageDto(m));
    const draft = store.pendingDraftFor(conv.id);
    return {
      conversation: conversationDto(store, conv),
      messages,
      pendingDraft: draft,
      usage: usageOf(store, u),
      employee: u.role === "analyst" ? publicUser(store.userById(conv.userId)!) : undefined,
    };
  });

  // mensagem do funcionário OU do analista (mesma rota — o papel decide o efeito)
  app.post("/conversations/:id/messages", async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const body = z.object({ text: z.string().min(1).max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const conv = store.conversation((req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: "not_found" });

    if (u.role === "employee") {
      if (conv.userId !== u.id) return reply.code(403).send({ error: "forbidden" });
      if (conv.status === "closed") {
        return reply.code(409).send({ error: "closed", detail: "Conversa encerrada — abra outra." });
      }
      // limite de 30 mensagens/dia
      const used = store.bumpUsage(u.id, todayKey());
      if (used > config.dailyMessageLimit) {
        return reply.code(429).send({
          error: "daily_limit",
          detail: `Limite de ${config.dailyMessageLimit} mensagens por dia atingido.`,
          usage: { used: used - 1, limit: config.dailyMessageLimit },
        });
      }
      const message = store.addMessage({
        conversationId: conv.id,
        sender: "user",
        senderId: u.id,
        text: body.data.text.trim(),
      });
      if (conv.status !== "with_agent") store.bumpUnread(conv.id);
      hub.publish({ type: "message", conversationId: conv.id, message });
      // agent só responde quando a conversa está com ele
      if (conv.status === "with_agent") {
        void runner.runTurn(conv, u, body.data.text.trim()).catch((err) => {
          req.log.error(err, "agent run failed");
        });
      }
      return reply.code(202).send({ message: messageDto(message), usage: usageOf(store, u) });
    }

    // analista respondendo — precisa estar atendendo a conversa
    if (conv.status !== "with_analyst" || conv.analystId !== u.id) {
      return reply.code(409).send({
        error: "not_assigned",
        detail: "Assuma o atendimento para responder.",
      });
    }
    const message = store.addMessage({
      conversationId: conv.id,
      sender: "analyst",
      senderId: u.id,
      text: body.data.text.trim(),
    });
    hub.publish({ type: "message", conversationId: conv.id, message });
    return reply.code(202).send({ message: messageDto(message) });
  });

  // ── rascunho ──────────────────────────────────────────────────────────────

  app.post("/conversations/:id/drafts/:draftId/confirm", async (req, reply) => {
    const u = requireEmployee(req, reply);
    if (!u) return;
    const { id, draftId } = req.params as { id: string; draftId: string };
    const conv = store.conversation(id);
    if (!conv || conv.userId !== u.id) return reply.code(404).send({ error: "not_found" });
    try {
      const { ticket } = await confirmDraft(services, id, draftId);
      const message = store.addMessage({
        conversationId: id,
        sender: "agent",
        text: `Pronto: abri o chamado com prioridade ${PRIORITY_LABEL[ticket.priority].toLowerCase()}. O service desk responde ${slaFor(ticket)}.`,
        steps: [STEPS.createTicket(ticket.id)],
        cards: [{ type: "ticket", ticketId: ticket.id }],
      });
      hub.publish({ type: "message", conversationId: id, message });
      hub.publish({ type: "conversation", conversationId: id });
      return { ticket, message: messageDto(message) };
    } catch (err) {
      if (err instanceof DraftNotPendingError) {
        return reply.code(409).send({ error: "draft_not_pending", detail: err.message });
      }
      return reply.code(503).send({
        error: "legacy_unavailable",
        detail: "O serviço de chamados está instável. Tente de novo em instantes.",
      });
    }
  });

  app.post("/conversations/:id/drafts/:draftId/cancel", async (req, reply) => {
    const u = requireEmployee(req, reply);
    if (!u) return;
    const { id, draftId } = req.params as { id: string; draftId: string };
    const conv = store.conversation(id);
    if (!conv || conv.userId !== u.id) return reply.code(404).send({ error: "not_found" });
    try {
      cancelDraft(services, id, draftId);
      const message = store.addMessage({
        conversationId: id,
        sender: "agent",
        text: "Sem problema — descartei o rascunho. Se mudar de ideia ou aparecer outra coisa de TI, estou por aqui.",
        steps: [],
      });
      hub.publish({ type: "message", conversationId: id, message });
      return { ok: true, message: messageDto(message) };
    } catch (err) {
      if (err instanceof DraftNotPendingError) {
        return reply.code(409).send({ error: "draft_not_pending", detail: err.message });
      }
      throw err;
    }
  });

  // ── SSE ───────────────────────────────────────────────────────────────────

  app.get("/conversations/:id/stream", async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const conv = store.conversation((req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (u.role === "employee" && conv.userId !== u.id) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const sse = openSse(req, reply);
    const off = hub.subscribeConversation(conv.id, (e) => {
      sse.send(e);
      if (e.type === "message" && u.role === "analyst") {
        // analista lendo a conversa → zera pendências
        if (e.message.sender !== "analyst") store.clearUnread(conv.id);
      }
    });
    req.raw.on("close", off);
  });

  app.get("/console/stream", async (req, reply) => {
    const u = requireAnalyst(req, reply);
    if (!u) return;
    const sse = openSse(req, reply);
    const off = hub.subscribeConsole((e) => sse.send(e));
    req.raw.on("close", off);
  });

  // ── chamados do funcionário ───────────────────────────────────────────────

  app.get("/tickets", async (req, reply) => {
    const u = requireEmployee(req, reply);
    if (!u) return;
    try {
      const list = await withRetry(() => tickets.listByRequester(u.id));
      return { tickets: list.map(ticketDto) };
    } catch {
      return reply.code(503).send({ error: "legacy_unavailable" });
    }
  });

  app.get("/tickets/:id", async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const tid = (req.params as { id: string }).id.toUpperCase();
    try {
      const t =
        u.role === "analyst"
          ? await withRetry(() => tickets.get(tid))
          : await withRetry(() => tickets.getForRequester(tid, u.id));
      if (!t) return reply.code(404).send({ error: "not_found" });
      const events = await tickets.events(t.id).catch(() => []);
      return { ticket: ticketDto(t), events };
    } catch {
      return reply.code(503).send({ error: "legacy_unavailable" });
    }
  });

  // ── central de ajuda (debug/demonstração) ────────────────────────────────

  app.get("/help", async (req, reply) => {
    requireUser(req, reply);
    const q = (req.query as { q?: string }).q ?? "";
    return { hits: help.search(q, 5).map((h) => ({ ...h.article, score: h.score })) };
  });

  // ── console do analista ───────────────────────────────────────────────────

  app.get("/console/conversations", async (req, reply) => {
    const u = requireAnalyst(req, reply);
    if (!u) return;
    const filter = (req.query as { filter?: string }).filter ?? "all";
    const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    let convs = store.conversationsForConsole();
    if (filter === "for_you") convs = convs.filter((c) => c.status === "waiting_analyst" || (c.status === "with_analyst" && c.analystId === u.id));
    if (filter === "with_agent") convs = convs.filter((c) => c.status === "with_agent");
    if (filter === "mine") convs = convs.filter((c) => c.analystId === u.id && c.status === "with_analyst");
    const items = convs.map((c) => {
      const owner = store.userById(c.userId)!;
      const last = store.lastMessage(c.id);
      const ticket = c.ticketId ? store.ticket(c.ticketId) : null;
      return {
        ...conversationDto(store, c),
        employee: publicUser(owner),
        lastMessage: last ? messageDto(last) : null,
        ticket: ticket ? ticketDto(ticket) : null,
      };
    });
    const filtered = q
      ? items.filter((i) =>
          `${i.employee?.name} ${i.employee?.email} ${i.lastMessage?.text ?? ""} ${i.ticket?.id ?? ""} ${i.ticket?.title ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : items;
    const counts = {
      for_you: convs.filter((c) => c.status === "waiting_analyst").length,
      with_agent: convs.filter((c) => c.status === "with_agent").length,
      mine: convs.filter((c) => c.analystId === u.id && c.status === "with_analyst").length,
    };
    return { items: filtered, counts };
  });

  app.post("/conversations/:id/assume", async (req, reply) => {
    const u = requireAnalyst(req, reply);
    if (!u) return;
    const conv = store.conversation((req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (conv.status === "closed") return reply.code(409).send({ error: "closed" });
    if (conv.status === "with_analyst" && conv.analystId !== u.id) {
      return reply.code(409).send({ error: "taken", detail: "Outro analista já está atendendo." });
    }
    store.setConversationStatus(conv.id, "with_analyst", { analystId: u.id });
    store.clearUnread(conv.id);
    const sys = store.addMessage({
      conversationId: conv.id,
      sender: "system",
      text: `${u.name} assumiu · agent pausado`,
    });
    hub.publish({ type: "message", conversationId: conv.id, message: sys });
    hub.publish({ type: "conversation", conversationId: conv.id });
    return { conversation: conversationDto(store, store.conversation(conv.id)!) };
  });

  app.post("/conversations/:id/release", async (req, reply) => {
    const u = requireAnalyst(req, reply);
    if (!u) return;
    const conv = store.conversation((req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (conv.analystId !== u.id) return reply.code(403).send({ error: "not_yours" });
    store.setConversationStatus(conv.id, "with_agent", { analystId: null });
    const sys = store.addMessage({
      conversationId: conv.id,
      sender: "system",
      text: `Devolvida ao Nexo Assist`,
    });
    hub.publish({ type: "message", conversationId: conv.id, message: sys });
    // o agent retoma visivelmente — regra "agent pausado → volta a atender"
    const back = store.addMessage({
      conversationId: conv.id,
      sender: "agent",
      text: `Estou de volta! O ${u.name.split(" ")[0]} já cuidou do seu caso. Se ficou alguma dúvida ou surgiu algo novo de TI, me conta.`,
    });
    hub.publish({ type: "message", conversationId: conv.id, message: back });
    hub.publish({ type: "conversation", conversationId: conv.id });
    return { conversation: conversationDto(store, store.conversation(conv.id)!) };
  });

  app.post("/conversations/:id/close", async (req, reply) => {
    const u = requireAnalyst(req, reply);
    if (!u) return;
    const conv = store.conversation((req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (conv.analystId !== u.id && conv.status === "with_analyst") {
      return reply.code(403).send({ error: "not_yours" });
    }
    store.setConversationStatus(conv.id, "closed", { closedAt: new Date().toISOString() });
    const sys = store.addMessage({
      conversationId: conv.id,
      sender: "system",
      text: `Atendimento encerrado por ${u.name}`,
    });
    hub.publish({ type: "message", conversationId: conv.id, message: sys });
    hub.publish({ type: "conversation", conversationId: conv.id });
    return { conversation: conversationDto(store, store.conversation(conv.id)!) };
  });

  // chamados do funcionário para o painel lateral do console
  app.get("/console/users/:userId/tickets", async (req, reply) => {
    const u = requireAnalyst(req, reply);
    if (!u) return;
    const userId = (req.params as { userId: string }).userId;
    const owner = store.userById(userId);
    if (!owner) return reply.code(404).send({ error: "not_found" });
    try {
      const list = await withRetry(() => tickets.listByRequester(userId));
      return {
        employee: publicUser(owner),
        tickets: list.map(ticketDto),
        openCount: list.filter((t) => !["resolvido", "cancelado"].includes(t.status)).length,
        closedCount: list.filter((t) => ["resolvido", "cancelado"].includes(t.status)).length,
      };
    } catch {
      return reply.code(503).send({ error: "legacy_unavailable" });
    }
  });
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    team: u.team,
    supportLevel: u.supportLevel,
    avatarBg: u.avatarBg,
    avatarFg: u.avatarFg,
  };
}

function messageDto(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    sender: m.sender,
    senderId: m.senderId,
    text: m.text,
    steps: m.steps,
    cards: m.cards,
    meta: m.meta,
    createdAt: m.createdAt,
  };
}

type TicketWithOverdue = Ticket & { overdue?: boolean };

function ticketDto(t: TicketWithOverdue) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    description: t.description,
    category: t.category,
    subcategory: t.subcategory,
    priority: t.priority,
    priorityLabel: PRIORITY_LABEL[t.priority],
    status: t.status,
    statusLabel: STATUS_LABEL[t.status],
    requesterId: t.requesterId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    dueAt: t.dueAt,
    overdue: t.overdue ?? false,
    overdueLabel: t.overdue ? "prazo vencido" : null,
    ago: fmtAgo(t.updatedAt),
  };
}

function conversationDto(store: Store, c: Conversation) {
  return {
    id: c.id,
    userId: c.userId,
    analystId: c.analystId,
    analystName: c.analystId ? (store.userById(c.analystId)?.name ?? null) : null,
    status: c.status,
    queue: c.queue,
    handoffSummary: c.handoffSummary,
    handoffReason: c.handoffReason,
    handoffAt: c.handoffAt,
    ticketId: c.ticketId,
    unreadForAnalyst: c.unreadForAnalyst,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    closedAt: c.closedAt,
  };
}

function usageOf(store: Store, u: User) {
  return { used: store.usageToday(u.id, todayKey()), limit: config.dailyMessageLimit };
}

function slaFor(t: Ticket): string {
  switch (t.priority) {
    case "critica":
      return "em até 1 hora";
    case "alta":
      return "em até 4 h úteis";
    case "media":
      return "em até 3 dias úteis";
    default:
      return "em até 5 dias úteis";
  }
}
