import type { Store } from "../store.js";
import type {
  Ticket,
  TicketDraft,
  TicketKind,
  TicketPriority,
} from "../domain/types.js";
import { computeDueAt, isOverdue } from "../domain/sla.js";
import { keywords, normalize, similarity } from "../domain/text.js";
import { config } from "../config.js";

// ─── Serviço de chamados (simulado) ──────────────────────────────────────────
// Fronteira explícita entre o agent e o "sistema legado". O agent nunca toca o
// banco diretamente: fala com esta classe como falaria com um serviço HTTP.
//
// Para simular a instabilidade do legado, cada operação passa por `chaos()`:
// com probabilidade TICKETS_CHAOS_RATE a chamada atrasa 2–4s ou falha com 503.
// O retry com backoff fica no lado do agent (tool wrapper), como na vida real.

export class LegacyUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("Serviço de chamados indisponível no momento");
    this.name = "LegacyUnavailableError";
  }
}

export interface CreateTicketInput {
  kind: TicketKind;
  title: string;
  description: string;
  category: string;
  subcategory?: string;
  priority: TicketPriority;
  requesterId: string;
  conversationId?: string;
}

export interface TicketView extends Ticket {
  overdue: boolean;
}

export class TicketService {
  constructor(
    private readonly store: Store,
    private readonly chaosRate = config.ticketsChaosRate,
  ) {}

  /** Simula latência + instabilidade intermitente do legado. */
  private async chaos(): Promise<void> {
    if (this.chaosRate <= 0) return;
    const roll = Math.random();
    if (roll < this.chaosRate * 0.5) {
      // falha rápida (503)
      await sleep(120 + Math.random() * 250);
      throw new LegacyUnavailableError();
    }
    if (roll < this.chaosRate) {
      // indisponível por alguns segundos → timeout lento
      await sleep(2000 + Math.random() * 2000);
      throw new LegacyUnavailableError();
    }
    // latência normal do legado
    await sleep(40 + Math.random() * 160);
  }

  private withOverdue(t: Ticket): TicketView {
    const closed = t.status === "resolvido" || t.status === "cancelado";
    return { ...t, overdue: !closed && isOverdue(t.dueAt) };
  }

  async listByRequester(requesterId: string): Promise<TicketView[]> {
    await this.chaos();
    return this.store.ticketsFor(requesterId).map((t) => this.withOverdue(t));
  }

  async listOpen(requesterId: string): Promise<TicketView[]> {
    await this.chaos();
    return this.store.openTicketsFor(requesterId).map((t) => this.withOverdue(t));
  }

  async get(idOrNumber: string): Promise<TicketView | null> {
    await this.chaos();
    const t = this.store.ticket(idOrNumber);
    return t ? this.withOverdue(t) : null;
  }

  async getForRequester(idOrNumber: string, requesterId: string): Promise<TicketView | null> {
    const t = await this.get(idOrNumber);
    // privacidade: um chamado só é visível para quem abriu
    if (!t || t.requesterId !== requesterId) return null;
    return t;
  }

  async create(input: CreateTicketInput): Promise<TicketView> {
    await this.chaos();
    const n = this.store.nextTicketNumber(input.kind);
    const tid = `${input.kind}-${n}`;
    const nowIso = new Date().toISOString();
    const ticket: Ticket = {
      id: tid,
      kind: input.kind,
      title: input.title,
      description: input.description,
      category: input.category as Ticket["category"],
      subcategory: input.subcategory ?? null,
      priority: input.priority,
      status: "aberto",
      requesterId: input.requesterId,
      conversationId: input.conversationId ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
      resolvedAt: null,
      dueAt: computeDueAt(input.priority, new Date()).toISOString(),
    };
    this.store.insertTicket(ticket);
    this.store.addTicketEvent(tid, "Nexo Assist", "Chamado criado pelo Nexo Assist");
    return this.withOverdue(ticket);
  }

  /** Anexa uma atualização do solicitante; reabre se resolvido há ≤7 dias. */
  async addUpdate(
    ticketId: string,
    requesterId: string,
    note: string,
  ): Promise<{ ticket: TicketView; reopened: boolean } | null> {
    await this.chaos();
    const t = this.store.ticket(ticketId);
    if (!t || t.requesterId !== requesterId) return null;

    let reopened = false;
    const patch: Partial<Pick<Ticket, "status" | "resolvedAt" | "dueAt">> = {};
    if (t.status === "resolvido") {
      const resolvedDaysAgo =
        (Date.now() - new Date(t.resolvedAt ?? t.updatedAt).getTime()) / 86_400_000;
      if (resolvedDaysAgo > config.reopenWindowDays) {
        throw new TicketClosedError(t.id);
      }
      patch.status = "aberto";
      patch.resolvedAt = null;
      patch.dueAt = computeDueAt(t.priority, new Date()).toISOString();
      reopened = true;
    }
    if (Object.keys(patch).length) this.store.updateTicket(t.id, patch);
    this.store.addTicketEvent(t.id, "Solicitante (via Nexo Assist)", note);
    const fresh = this.store.ticket(t.id)!;
    return { ticket: this.withOverdue(fresh), reopened };
  }

  /** Busca duplicidade: chamado aberto do mesmo solicitante sobre o mesmo assunto. */
  async findSimilar(
    requesterId: string,
    title: string,
    category: string,
  ): Promise<TicketView | null> {
    await this.chaos();
    const open = this.store.openTicketsFor(requesterId);
    let best: Ticket | null = null;
    let bestScore = 0;
    for (const t of open) {
      let score = similarity(title, `${t.title} ${t.description}`);
      if (normalize(t.category) === normalize(category)) score += 0.15;
      const sharedKeywords = keywords(title).filter((k) =>
        keywords(`${t.title} ${t.description}`).includes(k),
      );
      if (sharedKeywords.length >= 2) score += 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return bestScore >= 0.34 && best ? this.withOverdue(best) : null;
  }

  /** Eventos do histórico (para o painel do analista). */
  async events(ticketId: string) {
    await this.chaos();
    return this.store.ticketEvents(ticketId);
  }
}

export class TicketClosedError extends Error {
  readonly statusCode = 409;
  constructor(ticketId: string) {
    super(
      `O chamado ${ticketId} foi resolvido há mais de ${config.reopenWindowDays} dias e não pode ser reaberto — é preciso abrir um novo.`,
    );
    this.name = "TicketClosedError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Executa uma operação do legado com retry + backoff (usada pelas tools do agent). */
export async function withRetry<T>(
  op: () => Promise<T>,
  onRetry?: (attempt: number) => void,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof LegacyUnavailableError) || attempt === maxAttempts) throw err;
      onRetry?.(attempt);
      await sleep(300 * attempt);
    }
  }
  throw lastErr;
}

// re-export para conveniência
export type { TicketDraft };
