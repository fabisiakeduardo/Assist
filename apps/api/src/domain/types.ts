// ─── Domínio do Nexo Assist ──────────────────────────────────────────────────
// Tipos compartilhados entre serviços, agent e rotas HTTP.

export type UserRole = "employee" | "analyst";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** Time/área do funcionário (ex.: Financeiro) ou fila do analista. */
  team: string;
  /** N1 | N2 — só para analistas. */
  supportLevel: "N1" | "N2" | null;
  /** Cores do avatar (fundo/texto), alinhadas ao protótipo. */
  avatarBg: string;
  avatarFg: string;
}

export type TicketKind = "INC" | "REQ";

export const TICKET_CATEGORIES = [
  "Acesso",
  "Rede e VPN",
  "Hardware",
  "Software",
  "E-mail",
  "Outros",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export type TicketPriority = "critica" | "alta" | "media" | "baixa";

export type TicketStatus =
  | "aberto"
  | "em_andamento"
  | "aguardando_analista"
  | "aguardando_solicitante"
  | "aprovado"
  | "resolvido"
  | "cancelado";

export interface Ticket {
  id: string; // INC-20311 / REQ-10442
  kind: TicketKind;
  title: string;
  description: string;
  category: TicketCategory;
  subcategory: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  requesterId: string;
  /** ISO 8601 */
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Prazo da próxima resposta/atualização; vencido ⇒ atrasado. */
  dueAt: string;
  /** Conversa que originou o chamado, quando houver. */
  conversationId: string | null;
}

export interface TicketEvent {
  id: number;
  ticketId: string;
  actor: string; // nome livre do autor do evento
  text: string;
  createdAt: string;
}

export const OPEN_TICKET_STATUSES: TicketStatus[] = [
  "aberto",
  "em_andamento",
  "aguardando_analista",
  "aguardando_solicitante",
  "aprovado",
];

export const FINAL_TICKET_STATUSES: TicketStatus[] = ["resolvido", "cancelado"];

// ─── Conversas ──────────────────────────────────────────────────────────────

export type ConversationStatus =
  | "with_agent" // agent responde normalmente
  | "waiting_analyst" // transferida, agent pausado, fila do console
  | "with_analyst" // um analista assumiu; agent pausado
  | "closed"; // encerrada pelo analista

export type QueueLevel = "N1" | "N2";

export interface Conversation {
  id: string;
  userId: string;
  analystId: string | null;
  status: ConversationStatus;
  /** Fila para onde foi transferida (N1/N2). */
  queue: QueueLevel | null;
  /** Resumo gerado na transferência. */
  handoffSummary: string | null;
  /** Motivo da transferência, para transparência no console. */
  handoffReason: string | null;
  handoffAt: string | null;
  /** Chamado vinculado à conversa (o "desta conversa" do painel). */
  ticketId: string | null;
  /** Contexto do agent entre turnos (ex.: intake de chamado em andamento). */
  agentContext: Record<string, unknown> | null;
  unreadForAnalyst: number;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
}

export type MessageSender = "user" | "agent" | "analyst" | "system";

/**
 * Um passo visível do agent ("consultou seus chamados").
 * `tool` identifica a operação do domínio e `ms` a latência medida —
 * transparência inspecionável (hover/clique no chip mostra o detalhe).
 */
export interface AgentStep {
  label: string;
  detail?: string;
  tool?: string;
  ms?: number;
}

export type CardPayload =
  | { type: "ticket"; ticketId: string }
  | { type: "ticket_selector"; ticketIds: string[] }
  | { type: "draft"; draftId: string }
  | { type: "options"; options: string[] };

/** Tokens usados num turno do LLM (soma dos steps do engine Mastra). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** Telemetria da mensagem — preenchida nas respostas do agent. */
export interface MessageMeta {
  /** Engine que gerou a resposta ("mastra" | "scripted"). */
  engine?: string;
  /** Modelo do LLM (só Mastra). */
  model?: string;
  /** Tokens consumidos no turno (só Mastra). */
  usage?: TurnUsage;
  /** Custo estimado do turno em USD (tabela agent/pricing + overrides de env). */
  costUsd?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: MessageSender;
  senderId: string | null;
  text: string;
  steps: AgentStep[] | null;
  /** Cards renderizados junto à resposta (card de chamado, seletor, rascunho, opções). */
  cards: CardPayload[] | null;
  /** Telemetria (tokens/custo/engine) — agent com LLM a preenche por turno. */
  meta: MessageMeta | null;
  createdAt: string;
}

// ─── Rascunho de chamado (aguardando confirmação) ───────────────────────────

export type DraftStatus = "pending" | "confirmed" | "cancelled";

export interface TicketDraft {
  id: string;
  conversationId: string;
  kind: TicketKind;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  /** Quem é afetado — ex.: "Somente você", "Equipe Financeiro", "Toda a empresa". */
  affected: string;
  dueAt: string;
  status: DraftStatus;
  ticketId: string | null;
  createdAt: string;
}

// ─── Central de ajuda ───────────────────────────────────────────────────────

export interface HelpArticle {
  id: string;
  title: string;
  body: string;
  keywords: string[];
}

// ─── Eventos em tempo real (SSE) ────────────────────────────────────────────

export type RealtimeEvent =
  | { type: "message"; conversationId: string; message: Message }
  | {
      type: "agent_step";
      conversationId: string;
      /** id temporário da mensagem de agent em progresso */
      messageId: string;
      step: AgentStep;
    }
  | { type: "agent_delta"; conversationId: string; messageId: string; delta: string }
  | { type: "agent_start"; conversationId: string; messageId: string }
  | { type: "agent_end"; conversationId: string; messageId: string }
  | { type: "conversation"; conversationId: string }
  | { type: "conversations_changed" };

// ─── Estruturas auxiliares ──────────────────────────────────────────────────

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  team: string;
  supportLevel: "N1" | "N2" | null;
}

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  critica: "Crítica",
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  aberto: "Aberto",
  em_andamento: "Em andamento",
  aguardando_analista: "Aguardando analista",
  aguardando_solicitante: "Aguardando você",
  aprovado: "Aprovado",
  resolvido: "Resolvido",
  cancelado: "Cancelado",
};
