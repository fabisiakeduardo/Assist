import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentStep,
  CardPayload,
  Conversation,
  ConversationStatus,
  HelpArticle,
  Message,
  MessageMeta,
  MessageSender,
  QueueLevel,
  Ticket,
  TicketCategory,
  TicketDraft,
  TicketEvent,
  TicketKind,
  TicketPriority,
  TicketStatus,
  User,
} from "./domain/types.js";

// ─── Store: única camada que fala SQL. Os serviços operam em tipos de domínio ─

const now = () => new Date().toISOString();
const id = () => randomUUID();

// ── mappers ──────────────────────────────────────────────────────────────────

function toUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    email: r.email as string,
    name: r.name as string,
    role: r.role as User["role"],
    team: (r.team as string) ?? "",
    supportLevel: (r.support_level as User["supportLevel"]) ?? null,
    avatarBg: r.avatar_bg as string,
    avatarFg: r.avatar_fg as string,
  };
}

function toTicket(r: Record<string, unknown>): Ticket {
  return {
    id: r.id as string,
    kind: r.kind as TicketKind,
    title: r.title as string,
    description: r.description as string,
    category: r.category as TicketCategory,
    subcategory: (r.subcategory as string) ?? null,
    priority: r.priority as TicketPriority,
    status: r.status as TicketStatus,
    requesterId: r.requester_id as string,
    conversationId: (r.conversation_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    resolvedAt: (r.resolved_at as string) ?? null,
    dueAt: r.due_at as string,
  };
}

function toMessage(r: Record<string, unknown>): Message {
  const steps = r.steps as string | null;
  const card = r.card as string | null;
  const meta = r.meta as string | null;
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    sender: r.sender as MessageSender,
    senderId: (r.sender_id as string) ?? null,
    text: r.text as string,
    steps: steps ? (JSON.parse(steps) as AgentStep[]) : null,
    cards: card ? (JSON.parse(card) as CardPayload[]) : null,
    meta: meta ? (JSON.parse(meta) as MessageMeta) : null,
    createdAt: r.created_at as string,
  };
}

function toConversation(r: Record<string, unknown>): Conversation {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    analystId: (r.analyst_id as string) ?? null,
    status: r.status as ConversationStatus,
    queue: (r.queue as QueueLevel) ?? null,
    handoffSummary: (r.handoff_summary as string) ?? null,
    handoffReason: (r.handoff_reason as string) ?? null,
    handoffAt: (r.handoff_at as string) ?? null,
    ticketId: (r.ticket_id as string) ?? null,
    agentContext: r.agent_context ? JSON.parse(r.agent_context as string) : null,
    unreadForAnalyst: Number(r.unread_for_analyst ?? 0),
    lastMessageAt: r.last_message_at as string,
    createdAt: r.created_at as string,
    closedAt: (r.closed_at as string) ?? null,
  };
}

function toDraft(r: Record<string, unknown>): TicketDraft {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    kind: r.kind as TicketKind,
    title: r.title as string,
    description: r.description as string,
    category: r.category as TicketCategory,
    priority: r.priority as TicketPriority,
    affected: r.affected as string,
    dueAt: r.due_at as string,
    status: r.status as TicketDraft["status"],
    ticketId: (r.ticket_id as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function toTicketEvent(r: Record<string, unknown>): TicketEvent {
  return {
    id: Number(r.id),
    ticketId: r.ticket_id as string,
    actor: r.actor as string,
    text: r.text as string,
    createdAt: r.created_at as string,
  };
}

// ── API do store ─────────────────────────────────────────────────────────────

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  // usuários & sessões
  userByEmail(email: string): User | null {
    const r = this.db
      .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
      .get(email.trim());
    return r ? toUser(r as Record<string, unknown>) : null;
  }

  userById(userId: string): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    return r ? toUser(r as Record<string, unknown>) : null;
  }

  insertUser(u: Omit<User, "id"> & { id?: string }): User {
    const userId = u.id ?? id();
    this.db
      .prepare(
        `INSERT INTO users (id,email,name,role,team,support_level,avatar_bg,avatar_fg)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(userId, u.email, u.name, u.role, u.team, u.supportLevel, u.avatarBg, u.avatarFg);
    return this.userById(userId)!;
  }

  /** Grava hash scrypt (formato "salt$hash" em hex). */
  setPassword(userId: string, password: string): void {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    this.db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(`${salt}$${hash}`, userId);
  }

  /** Verifica senha com comparação em tempo constante. */
  verifyPassword(userId: string, password: string): boolean {
    const r = this.db.prepare("SELECT password_hash FROM users WHERE id=?").get(userId) as
      | { password_hash: string | null }
      | undefined;
    if (!r?.password_hash) return false;
    const [salt, expected] = r.password_hash.split("$");
    if (!salt || !expected) return false;
    const actual = scryptSync(password, salt, 64);
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
  }

  createSession(userId: string): string {
    const token = randomUUID();
    this.db.prepare("INSERT INTO sessions (token,user_id) VALUES (?,?)").run(token, userId);
    return token;
  }

  userBySession(token: string): User | null {
    const r = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token);
    return r ? toUser(r as Record<string, unknown>) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  // estados do fluxo OIDC (vida curta — consumidos uma vez)
  createOidcState(state: string, nonce: string, verifier: string): void {
    this.db
      .prepare("INSERT INTO oidc_states (state,nonce,verifier) VALUES (?,?,?)")
      .run(state, nonce, verifier);
  }

  /** Consome o state (apaga) e devolve nonce+verifier; expira em 10 min. */
  consumeOidcState(state: string): { nonce: string; verifier: string } | null {
    this.db
      .prepare("DELETE FROM oidc_states WHERE created_at < datetime('now', '-10 minutes')")
      .run();
    const r = this.db
      .prepare("DELETE FROM oidc_states WHERE state = ? RETURNING nonce, verifier")
      .get(state) as { nonce: string; verifier: string } | undefined;
    return r ?? null;
  }

  // conversas
  createConversation(userId: string): Conversation {
    const cid = id();
    this.db
      .prepare("INSERT INTO conversations (id,user_id,status) VALUES (?,?, 'with_agent')")
      .run(cid, userId);
    return this.conversation(cid)!;
  }

  conversation(cid: string): Conversation | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(cid);
    return r ? toConversation(r as Record<string, unknown>) : null;
  }

  /** Conversa ativa (não encerrada) mais recente do funcionário. */
  activeConversationFor(userId: string): Conversation | null {
    const r = this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE user_id = ? AND status != 'closed'
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .get(userId);
    return r ? toConversation(r as Record<string, unknown>) : null;
  }

  conversationsFor(userId: string): Conversation[] {
    return this.db
      .prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY last_message_at DESC")
      .all(userId)
      .map((r) => toConversation(r as Record<string, unknown>));
  }

  /** Lista do console: ordena aguardando atendente primeiro, depois por atividade. */
  conversationsForConsole(): Conversation[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations
         ORDER BY CASE status
             WHEN 'waiting_analyst' THEN 0
             WHEN 'with_analyst' THEN 1
             WHEN 'with_agent' THEN 2
             ELSE 3 END,
           last_message_at DESC`,
      )
      .all()
      .map((r) => toConversation(r as Record<string, unknown>));
  }

  setConversationStatus(
    cid: string,
    status: ConversationStatus,
    extra: {
      analystId?: string | null;
      queue?: QueueLevel | null;
      handoffSummary?: string | null;
      handoffReason?: string | null;
      handoffAt?: string | null;
      closedAt?: string | null;
      ticketId?: string | null;
    } = {},
  ): void {
    const c = this.conversation(cid);
    if (!c) return;
    this.db
      .prepare(
        `UPDATE conversations SET status=?, analyst_id=?, queue=?, handoff_summary=?,
           handoff_reason=?, handoff_at=?, closed_at=?, ticket_id=? WHERE id=?`,
      )
      .run(
        status,
        extra.analystId !== undefined ? extra.analystId : c.analystId,
        extra.queue !== undefined ? extra.queue : c.queue,
        extra.handoffSummary !== undefined ? extra.handoffSummary : c.handoffSummary,
        extra.handoffReason !== undefined ? extra.handoffReason : c.handoffReason,
        extra.handoffAt !== undefined ? extra.handoffAt : c.handoffAt,
        extra.closedAt !== undefined ? extra.closedAt : c.closedAt,
        extra.ticketId !== undefined ? extra.ticketId : c.ticketId,
        cid,
      );
  }

  linkTicket(cid: string, ticketId: string): void {
    this.db.prepare("UPDATE conversations SET ticket_id=? WHERE id=?").run(ticketId, cid);
  }

  setAgentContext(cid: string, ctx: Record<string, unknown> | null): void {
    this.db
      .prepare("UPDATE conversations SET agent_context=? WHERE id=?")
      .run(ctx ? JSON.stringify(ctx) : null, cid);
  }

  touchConversation(cid: string): void {
    this.db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(now(), cid);
  }

  bumpUnread(cid: string, by = 1): void {
    this.db
      .prepare("UPDATE conversations SET unread_for_analyst = unread_for_analyst + ? WHERE id=?")
      .run(by, cid);
  }

  clearUnread(cid: string): void {
    this.db.prepare("UPDATE conversations SET unread_for_analyst = 0 WHERE id=?").run(cid);
  }

  // mensagens
  addMessage(input: {
    conversationId: string;
    sender: MessageSender;
    senderId?: string | null;
    text: string;
    steps?: AgentStep[] | null;
    cards?: CardPayload[] | null;
    meta?: MessageMeta | null;
    createdAt?: string;
  }): Message {
    const mid = id();
    const created = input.createdAt ?? now();
    this.db
      .prepare(
        `INSERT INTO messages (id,conversation_id,sender,sender_id,text,steps,card,meta,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        mid,
        input.conversationId,
        input.sender,
        input.senderId ?? null,
        input.text,
        input.steps ? JSON.stringify(input.steps) : null,
        input.cards ? JSON.stringify(input.cards) : null,
        input.meta ? JSON.stringify(input.meta) : null,
        created,
      );
    this.touchConversation(input.conversationId);
    return this.message(mid)!;
  }

  message(mid: string): Message | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(mid);
    return r ? toMessage(r as Record<string, unknown>) : null;
  }

  updateMessage(mid: string, patch: { text?: string; steps?: AgentStep[]; cards?: CardPayload[] }): void {
    const m = this.message(mid);
    if (!m) return;
    this.db
      .prepare("UPDATE messages SET text=?, steps=?, card=? WHERE id=?")
      .run(
        patch.text ?? m.text,
        patch.steps !== undefined ? JSON.stringify(patch.steps) : m.steps ? JSON.stringify(m.steps) : null,
        patch.cards !== undefined ? JSON.stringify(patch.cards) : m.cards ? JSON.stringify(m.cards) : null,
        mid,
      );
  }

  messages(cid: string, limit = 200): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT ?")
      .all(cid, limit)
      .map((r) => toMessage(r as Record<string, unknown>));
  }

  lastMessage(cid: string): Message | null {
    const r = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(cid);
    return r ? toMessage(r as Record<string, unknown>) : null;
  }

  // chamados
  insertTicket(t: Ticket): void {
    this.db
      .prepare(
        `INSERT INTO tickets
           (id,kind,title,description,category,subcategory,priority,status,requester_id,
            conversation_id,created_at,updated_at,resolved_at,due_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id,
        t.kind,
        t.title,
        t.description,
        t.category,
        t.subcategory,
        t.priority,
        t.status,
        t.requesterId,
        t.conversationId,
        t.createdAt,
        t.updatedAt,
        t.resolvedAt,
        t.dueAt,
      );
  }

  ticket(tid: string): Ticket | null {
    const r = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(tid.toUpperCase());
    return r ? toTicket(r as Record<string, unknown>) : null;
  }

  updateTicket(tid: string, patch: Partial<Pick<Ticket, "status" | "priority" | "description" | "title" | "resolvedAt" | "dueAt">>): void {
    const t = this.ticket(tid);
    if (!t) return;
    this.db
      .prepare(
        `UPDATE tickets SET status=?, priority=?, description=?, title=?, resolved_at=?, due_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? t.status,
        patch.priority ?? t.priority,
        patch.description ?? t.description,
        patch.title ?? t.title,
        patch.resolvedAt !== undefined ? patch.resolvedAt : t.resolvedAt,
        patch.dueAt ?? t.dueAt,
        now(),
        t.id,
      );
  }

  ticketsFor(requesterId: string): Ticket[] {
    return this.db
      .prepare("SELECT * FROM tickets WHERE requester_id = ? ORDER BY created_at DESC")
      .all(requesterId)
      .map((r) => toTicket(r as Record<string, unknown>));
  }

  openTicketsFor(requesterId: string): Ticket[] {
    return this.ticketsFor(requesterId).filter(
      (t) => !["resolvido", "cancelado"].includes(t.status),
    );
  }

  addTicketEvent(ticketId: string, actor: string, text: string): void {
    this.db
      .prepare("INSERT INTO ticket_events (ticket_id,actor,text) VALUES (?,?,?)")
      .run(ticketId, actor, text);
  }

  ticketEvents(ticketId: string): TicketEvent[] {
    return this.db
      .prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, id")
      .all(ticketId)
      .map((r) => toTicketEvent(r as Record<string, unknown>));
  }

  /** Sequência de numeração INC-XXXXX / REQ-XXXXX (persistente). */
  nextTicketNumber(prefix: TicketKind): number {
    this.db
      .prepare("INSERT INTO ticket_seq (prefix,next) VALUES (?,20000) ON CONFLICT(prefix) DO NOTHING")
      .run(prefix);
    const r = this.db
      .prepare("UPDATE ticket_seq SET next = next + 1 WHERE prefix = ? RETURNING next")
      .get(prefix) as { next: number } | undefined;
    return r?.next ?? 20001;
  }

  // rascunhos
  insertDraft(d: Omit<TicketDraft, "id" | "status" | "ticketId" | "createdAt">): TicketDraft {
    const did = id();
    this.db
      .prepare(
        `INSERT INTO drafts (id,conversation_id,kind,title,description,category,priority,affected,due_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(did, d.conversationId, d.kind, d.title, d.description, d.category, d.priority, d.affected, d.dueAt);
    return this.draft(did)!;
  }

  draft(did: string): TicketDraft | null {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(did);
    return r ? toDraft(r as Record<string, unknown>) : null;
  }

  pendingDraftFor(cid: string): TicketDraft | null {
    const r = this.db
      .prepare(
        "SELECT * FROM drafts WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(cid);
    return r ? toDraft(r as Record<string, unknown>) : null;
  }

  setDraftStatus(did: string, status: TicketDraft["status"], ticketId?: string): void {
    this.db
      .prepare("UPDATE drafts SET status=?, ticket_id=COALESCE(?, ticket_id) WHERE id=?")
      .run(status, ticketId ?? null, did);
  }

  // central de ajuda
  insertArticle(a: HelpArticle): void {
    this.db
      .prepare("INSERT OR REPLACE INTO help_articles (id,title,body,keywords) VALUES (?,?,?,?)")
      .run(a.id, a.title, a.body, JSON.stringify(a.keywords));
  }

  articles(): HelpArticle[] {
    return this.db
      .prepare("SELECT * FROM help_articles ORDER BY id")
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id as string,
          title: row.title as string,
          body: row.body as string,
          keywords: JSON.parse((row.keywords as string) ?? "[]") as string[],
        };
      });
  }

  // uso diário
  usageToday(userId: string, day: string): number {
    const r = this.db
      .prepare("SELECT count AS c FROM usage_counters WHERE user_id=? AND day=?")
      .get(userId, day) as { c: number } | undefined;
    return r?.c ?? 0;
  }

  bumpUsage(userId: string, day: string): number {
    this.db
      .prepare(
        `INSERT INTO usage_counters (user_id,day,count) VALUES (?,?,1)
         ON CONFLICT(user_id,day) DO UPDATE SET count = count + 1`,
      )
      .run(userId, day);
    return this.usageToday(userId, day);
  }
}
