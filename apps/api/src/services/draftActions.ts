import type { AgentServices } from "../agent/engine.js";
import type { Ticket, TicketDraft } from "../domain/types.js";
import { withRetry } from "./ticketService.js";

// ─── Confirmação / cancelamento de rascunho ──────────────────────────────────
// Único caminho que transforma rascunho em chamado — usado pelo botão
// "Confirmar" da UI e pela resposta textual "pode confirmar". O agent nunca
// cria chamado direto: a regra "só depois da confirmação" é arquitetural.

export class DraftNotPendingError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("Este rascunho não está mais aguardando confirmação.");
    this.name = "DraftNotPendingError";
  }
}

export async function confirmDraft(
  services: AgentServices,
  conversationId: string,
  draftId: string,
): Promise<{ draft: TicketDraft; ticket: Ticket }> {
  const draft = services.store.draft(draftId);
  if (!draft || draft.conversationId !== conversationId) {
    throw new DraftNotPendingError();
  }
  if (draft.status !== "pending") throw new DraftNotPendingError();

  const conv = services.store.conversation(conversationId)!;
  const ticket = await withRetry(() =>
    services.tickets.create({
      kind: draft.kind,
      title: draft.title,
      description: draft.description,
      category: draft.category,
      priority: draft.priority,
      requesterId: conv.userId,
      conversationId,
    }),
  );

  services.store.setDraftStatus(draftId, "confirmed", ticket.id);
  services.store.linkTicket(conversationId, ticket.id);
  return { draft, ticket };
}

export function cancelDraft(
  services: AgentServices,
  conversationId: string,
  draftId: string,
): TicketDraft {
  const draft = services.store.draft(draftId);
  if (!draft || draft.conversationId !== conversationId || draft.status !== "pending") {
    throw new DraftNotPendingError();
  }
  services.store.setDraftStatus(draftId, "cancelled");
  return services.store.draft(draftId)!;
}
