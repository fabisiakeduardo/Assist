import type {
  AgentStep,
  CardPayload,
  Conversation,
  QueueLevel,
  TicketDraft,
  TicketKind,
  TicketPriority,
  User,
} from "../domain/types.js";
import { computeDueAt, slaLabel } from "../domain/sla.js";
import type { AgentServices } from "./engine.js";
import { withRetry } from "../services/ticketService.js";
import { STEPS } from "./steps.js";

// ─── Operações do agent sobre o domínio ──────────────────────────────────────
// Cada operação retorna { data, steps, card? }: dados para o agent raciocinar,
// passos para a linha de transparência, e card opcional para a UI.
// O motor Mastra embrulha estas funções em createTool(); o ScriptedEngine
// chama direto — mesmo efeito, mesmo vocabulário de passos.

export interface OpResult<T> {
  data: T;
  steps: AgentStep[];
  card?: CardPayload;
}

export interface TicketListItem {
  id: string;
  title: string;
  status: string;
  priority: TicketPriority;
  updatedAt: string;
  dueAt: string;
  overdue: boolean;
}

export interface TicketDetail extends TicketListItem {
  description: string;
  category: string;
  createdAt: string;
  requesterId: string;
}

export interface HelpHitDto {
  id: string;
  title: string;
  body: string;
}

const ok = <T>(data: T, steps: AgentStep[] = [], card?: CardPayload): OpResult<T> => ({
  data,
  steps,
  ...(card ? { card } : {}),
});

// ── consultas ────────────────────────────────────────────────────────────────

export async function opListTickets(
  services: AgentServices,
  user: User,
): Promise<OpResult<TicketListItem[]>> {
  const tickets = await withRetry(() => services.tickets.listOpen(user.id));
  return ok(
    tickets.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      updatedAt: t.updatedAt,
      dueAt: t.dueAt,
      overdue: t.overdue,
    })),
    [STEPS.consultTickets()],
  );
}

export async function opGetTicket(
  services: AgentServices,
  user: User,
  ticketId: string,
): Promise<OpResult<TicketDetail | { error: "not_found_or_private" }>> {
  const t = await withRetry(() => services.tickets.getForRequester(ticketId, user.id));
  const steps = [STEPS.consultTicket(ticketId.toUpperCase())];
  if (t) steps.push(STEPS.calcDeadline());
  return ok(
    t
      ? {
          id: t.id,
          title: t.title,
          description: t.description,
          category: t.subcategory ? `${t.category} › ${t.subcategory}` : t.category,
          status: t.status,
          priority: t.priority,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          dueAt: t.dueAt,
          overdue: t.overdue,
          requesterId: t.requesterId,
        }
      : { error: "not_found_or_private" },
    steps,
  );
}

export async function opSearchHelp(
  services: AgentServices,
  query: string,
): Promise<OpResult<HelpHitDto[]>> {
  const hits = services.help.search(query, 3);
  return ok(
    hits.map((h) => ({
      id: h.article.id,
      title: h.article.title,
      body: h.article.body,
    })),
    [STEPS.searchHelp()],
  );
}

// ── classificação de prioridade (regras do Anexo A) ──────────────────────────
//
//  Crítica : algo parado para uma equipe ou para a empresa
//  Alta    : impede uma pessoa de trabalhar, OU compromisso no mesmo dia
//  Média   : atrapalha, mas há alternativa
//  Baixa   : pedidos e melhorias sem urgência

export type ImpactScope = "self" | "team" | "company" | "unknown";

export function classifyPriority(input: {
  kind: TicketKind;
  impact: ImpactScope;
  blocksWork: boolean;
  deadlineToday: boolean;
  hasWorkaround: boolean;
}): { priority: TicketPriority; reason: string; dueLabel: string } {
  let priority: TicketPriority;
  let reason: string;

  if ((input.impact === "team" || input.impact === "company") && input.blocksWork) {
    priority = "critica";
    reason = "algo parado para mais de uma pessoa";
  } else if (input.impact === "self" && input.blocksWork) {
    priority = "alta";
    reason = "impede você de trabalhar";
  } else if (input.deadlineToday) {
    priority = "alta";
    reason = "há um compromisso ainda hoje";
  } else if (input.hasWorkaround) {
    priority = "media";
    reason = "atrapalha, mas há alternativa";
  } else if (input.kind === "REQ") {
    priority = "baixa";
    reason = "pedido sem urgência";
  } else {
    priority = "media";
    reason = "impacto pontual sem bloqueio total";
  }

  return { priority, reason, dueLabel: slaLabel(priority) };
}

// ── rascunho ─────────────────────────────────────────────────────────────────

export async function opBuildDraft(
  services: AgentServices,
  conversation: Conversation,
  user: User,
  input: {
    kind: TicketKind;
    title: string;
    description: string;
    category: string;
    priority: TicketPriority;
    affected: string;
  },
): Promise<OpResult<TicketDraft>> {
  // um rascunho pendente por conversa
  const existing = services.store.pendingDraftFor(conversation.id);
  if (existing) services.store.setDraftStatus(existing.id, "cancelled");

  const draft = services.store.insertDraft({
    conversationId: conversation.id,
    kind: input.kind,
    title: input.title,
    description: input.description,
    category: input.category as TicketDraft["category"],
    priority: input.priority,
    affected: input.affected,
    dueAt: computeDueAt(input.priority, new Date()).toISOString(),
  });
  return ok(draft, [STEPS.buildDraft()], { type: "draft", draftId: draft.id });
}

export async function opCheckDuplicates(
  services: AgentServices,
  user: User,
  title: string,
  category: string,
): Promise<OpResult<{ duplicate: TicketListItem | null }>> {
  const similar = await withRetry(() =>
    services.tickets.findSimilar(user.id, title, category),
  );
  return ok(
    {
      duplicate: similar
        ? {
            id: similar.id,
            title: similar.title,
            status: similar.status,
            priority: similar.priority,
            updatedAt: similar.updatedAt,
            dueAt: similar.dueAt,
            overdue: similar.overdue,
          }
        : null,
    },
    [STEPS.checkDuplicates()],
  );
}

// ── atualização de chamado ───────────────────────────────────────────────────

export async function opAddTicketInfo(
  services: AgentServices,
  user: User,
  ticketId: string,
  note: string,
): Promise<OpResult<{ ticket: TicketListItem; reopened: boolean } | { error: "not_found_or_private" }>> {
  const res = await withRetry(() => services.tickets.addUpdate(ticketId, user.id, note));
  if (!res) return ok({ error: "not_found_or_private" }, [STEPS.consultTicket(ticketId)]);
  const t = res.ticket;
  return ok(
    {
      ticket: {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        updatedAt: t.updatedAt,
        dueAt: t.dueAt,
        overdue: t.overdue,
      },
      reopened: res.reopened,
    },
    [res.reopened ? STEPS.reopenTicket(t.id) : STEPS.updateTicket(t.id)],
  );
}

// ── transferência ────────────────────────────────────────────────────────────

export async function opTransfer(
  services: AgentServices,
  conversation: Conversation,
  input: { summary: string; reason: string; queue?: QueueLevel },
): Promise<OpResult<{ queue: QueueLevel }>> {
  const queue = input.queue ?? "N1";
  services.store.setConversationStatus(conversation.id, "waiting_analyst", {
    queue,
    handoffSummary: input.summary,
    handoffReason: input.reason,
    handoffAt: new Date().toISOString(),
  });
  services.store.addMessage({
    conversationId: conversation.id,
    sender: "system",
    text: `Transferida para Suporte ${queue}`,
  });
  return ok({ queue }, [STEPS.transfer()]);
}

// ── helpers de card (só geram payload visual, sem passos) ───────────────────

export function cardOptions(options: string[]): CardPayload {
  return { type: "options", options };
}

export function cardTicketSelector(ticketIds: string[]): CardPayload {
  return { type: "ticket_selector", ticketIds };
}

export function cardTicket(ticketId: string): CardPayload {
  return { type: "ticket", ticketId };
}
