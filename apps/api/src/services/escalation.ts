import type { Store } from "../store.js";
import type { RealtimeHub } from "../realtime.js";
import type { Conversation } from "../domain/types.js";
import { isOverdue } from "../domain/sla.js";
import { config } from "../config.js";

// ─── Escalonamento automático por SLA ────────────────────────────────────────
// Job periódico: conversas `waiting_analyst` cujo SLA estourou são re-elevadas
// para a fila N2 — seja porque o chamado vinculado venceu o prazo, seja porque
// a espera na fila passou de ESCALATION_WAIT_MINUTES. A re-transferência vira
// mensagem de sistema na conversa + evento SSE, e fica registrada no histórico
// do chamado (auditoria).

export interface EscalationHit {
  conversationId: string;
  ticketId: string | null;
  reason: string;
}

function isFinalStatus(status: string): boolean {
  return status === "resolvido" || status === "cancelado";
}

/** Um tick do job — exportado para testes; retorna o que escalonou. */
export function runEscalationTick(
  store: Store,
  hub: RealtimeHub,
  now = new Date(),
): EscalationHit[] {
  const waitMs = config.escalationWaitMinutes * 60_000;
  const hits: EscalationHit[] = [];

  for (const conv of store.conversationsForConsole()) {
    if (conv.status !== "waiting_analyst") continue;
    if (conv.queue === "N2") continue; // já está no nível máximo

    const ticket = conv.ticketId ? store.ticket(conv.ticketId) : null;
    const ticketOverdue =
      ticket && !isFinalStatus(ticket.status) && isOverdue(ticket.dueAt, now);
    const waitedTooLong =
      conv.handoffAt !== null && now.getTime() - new Date(conv.handoffAt).getTime() > waitMs;
    if (!ticketOverdue && !waitedTooLong) continue;

    const reason = ticketOverdue
      ? `SLA do ${ticket!.id} vencido`
      : `espera na fila acima de ${config.escalationWaitMinutes} min`;
    escalate(store, hub, conv, ticket?.id ?? null, reason);
    hits.push({ conversationId: conv.id, ticketId: ticket?.id ?? null, reason });
  }
  return hits;
}

function escalate(
  store: Store,
  hub: RealtimeHub,
  conv: Conversation,
  ticketId: string | null,
  reason: string,
): void {
  store.setConversationStatus(conv.id, "waiting_analyst", {
    queue: "N2",
    handoffReason: `${conv.handoffReason ?? "transferida"} · escalonada (${reason})`,
  });
  store.bumpUnread(conv.id);
  if (ticketId) {
    store.addTicketEvent(ticketId, "Nexo Assist", `Conversa escalonada para N2 — ${reason}`);
  }
  const message = store.addMessage({
    conversationId: conv.id,
    sender: "system",
    text: `Escalonada automaticamente para Suporte N2 — ${reason}`,
  });
  hub.publish({ type: "message", conversationId: conv.id, message });
  hub.publish({ type: "conversation", conversationId: conv.id });
}

/** Intervalo que roda o tick — iniciado no bootstrap da API (unref'd). */
export class EscalationJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    private readonly hub: RealtimeHub,
    private readonly intervalMs = config.escalationIntervalSec * 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        const hits = runEscalationTick(this.store, this.hub);
        for (const h of hits) {
          console.log(`[escalation] ${h.conversationId} → N2 (${h.reason})`);
        }
      } catch (err) {
        console.error("[escalation] tick falhou:", err);
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
