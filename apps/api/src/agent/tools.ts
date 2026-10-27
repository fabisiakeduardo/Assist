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
import { config } from "../config.js";
import { TicketClosedError, withRetry } from "../services/ticketService.js";
import { STEPS } from "./steps.js";

// ─── Operações do agent sobre o domínio ──────────────────────────────────────
// Cada operação retorna { data, steps, card? }: dados para o agent raciocinar,
// passos para a linha de transparência, e card opcional para a UI.
// O motor Mastra embrulha estas funções em createTool(); o ScriptedEngine
// chama direto — mesmo efeito, mesmo vocabulário de passos.
//
// Cada passo carrega a latência medida (ms); as retries do legado são
// emitidas AO VIVO via StepEmitter (além de voltarem em `steps`, para que
// fiquem persistidas na mensagem e visíveis no console do analista).

/** Emite um passo para o SSE no instante em que acontece (ex.: retry do legado). */
export type StepEmitter = (step: AgentStep) => void;

const elapsed = (t0: number) => Math.max(1, Math.round(performance.now() - t0));
const withMs = (step: AgentStep, t0: number): AgentStep => ({ ...step, ms: elapsed(t0) });

function retryStep(attempt: number, steps: AgentStep[], emit?: StepEmitter): void {
  const step = STEPS.retryLegacy(attempt);
  steps.push(step);
  emit?.(step);
}

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
  emit?: StepEmitter,
): Promise<OpResult<TicketListItem[]>> {
  const steps: AgentStep[] = [];
  const t0 = performance.now();
  const tickets = await withRetry(
    () => services.tickets.listOpen(user.id),
    (attempt) => retryStep(attempt, steps, emit),
  );
  steps.push(withMs(STEPS.consultTickets(), t0));
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
    steps,
  );
}

export async function opGetTicket(
  services: AgentServices,
  user: User,
  ticketId: string,
  emit?: StepEmitter,
): Promise<OpResult<TicketDetail | { error: "not_found_or_private" }>> {
  const steps: AgentStep[] = [];
  const t0 = performance.now();
  const t = await withRetry(
    () => services.tickets.getForRequester(ticketId, user.id),
    (attempt) => retryStep(attempt, steps, emit),
  );
  steps.push(withMs(STEPS.consultTicket(ticketId.toUpperCase()), t0));
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
  const t0 = performance.now();
  const hits = services.help.search(query, 3);
  const top = hits[0];
  const step = withMs(STEPS.searchHelp(), t0);
  step.detail = top ? `${top.article.id} · ${top.article.title}` : "nenhum artigo relevante";
  return ok(
    hits.map((h) => ({
      id: h.article.id,
      title: h.article.title,
      body: h.article.body,
    })),
    [step],
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

  const t0 = performance.now();
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
  return ok(draft, [withMs(STEPS.buildDraft(), t0)], { type: "draft", draftId: draft.id });
}

export async function opCheckDuplicates(
  services: AgentServices,
  user: User,
  title: string,
  category: string,
  emit?: StepEmitter,
): Promise<OpResult<{ duplicate: TicketListItem | null }>> {
  const steps: AgentStep[] = [];
  const t0 = performance.now();
  const similar = await withRetry(
    () => services.tickets.findSimilar(user.id, title, category),
    (attempt) => retryStep(attempt, steps, emit),
  );
  steps.push(withMs(STEPS.checkDuplicates(), t0));
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
    steps,
  );
}

// ── atualização de chamado ───────────────────────────────────────────────────

export type AddTicketInfoData =
  | { ticket: TicketListItem; reopened: boolean }
  | { error: "not_found_or_private" }
  | { error: "closed_window"; ticketId: string; resolvedDaysAgo: number };

export async function opAddTicketInfo(
  services: AgentServices,
  user: User,
  ticketId: string,
  note: string,
  emit?: StepEmitter,
): Promise<OpResult<AddTicketInfoData>> {
  const steps: AgentStep[] = [];
  const t0 = performance.now();
  let res;
  try {
    res = await withRetry(
      () => services.tickets.addUpdate(ticketId, user.id, note),
      (attempt) => retryStep(attempt, steps, emit),
    );
  } catch (err) {
    // chamado resolvido há mais de 7 dias: resposta explicável, não crash
    if (err instanceof TicketClosedError) {
      const t = services.store.ticket(ticketId);
      const days = t?.resolvedAt
        ? (Date.now() - new Date(t.resolvedAt).getTime()) / 86_400_000
        : config.reopenWindowDays + 1;
      steps.push(withMs(STEPS.closedTooOld(ticketId, days), t0));
      return ok({ error: "closed_window", ticketId, resolvedDaysAgo: days }, steps);
    }
    throw err;
  }
  if (!res) {
    steps.push(withMs(STEPS.consultTicket(ticketId), t0));
    return ok({ error: "not_found_or_private" }, steps);
  }
  const t = res.ticket;
  steps.push(withMs(res.reopened ? STEPS.reopenTicket(t.id) : STEPS.updateTicket(t.id), t0));
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
    steps,
  );
}

// ── transferência ────────────────────────────────────────────────────────────

export async function opTransfer(
  services: AgentServices,
  conversation: Conversation,
  input: { summary: string; reason: string; queue?: QueueLevel },
): Promise<OpResult<{ queue: QueueLevel }>> {
  const queue = input.queue ?? "N1";
  const t0 = performance.now();
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
  return ok({ queue }, [withMs(STEPS.transfer(), t0)]);
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
