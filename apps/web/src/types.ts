// DTOs espelhando as respostas da API (apps/api/src/routes.ts)

export type Role = "employee" | "analyst";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  team: string;
  supportLevel: "N1" | "N2" | null;
  avatarBg: string;
  avatarFg: string;
}

export interface AgentStep {
  label: string;
  detail?: string;
  tool?: string;
  ms?: number;
}

export type CardPayload =
  | { type: "options"; options: string[] }
  | { type: "ticket"; ticketId: string }
  | { type: "ticket_selector"; ticketIds: string[] }
  | { type: "draft"; draftId: string };

export type MessageSender = "user" | "agent" | "analyst" | "system";

export interface Message {
  id: string;
  conversationId: string;
  sender: MessageSender;
  senderId: string | null;
  text: string;
  steps: AgentStep[] | null;
  cards: CardPayload[] | null;
  createdAt: string;
}

export type ConversationStatus =
  | "with_agent"
  | "waiting_analyst"
  | "with_analyst"
  | "closed";

export interface Conversation {
  id: string;
  userId: string;
  analystId: string | null;
  status: ConversationStatus;
  queue: "N1" | "N2" | null;
  handoffSummary: string | null;
  handoffReason: string | null;
  handoffAt: string | null;
  ticketId: string | null;
  unreadForAnalyst: number;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
}

export interface ConsoleConversation extends Conversation {
  employee: PublicUser;
  lastMessage: Message | null;
  ticket: Ticket | null;
}

export type Priority = "critica" | "alta" | "media" | "baixa";

export interface Ticket {
  id: string;
  kind: "INC" | "REQ";
  title: string;
  description: string;
  category: string;
  subcategory: string | null;
  priority: Priority;
  priorityLabel: string;
  status: string;
  statusLabel: string;
  requesterId: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  dueAt: string;
  overdue: boolean;
  overdueLabel: string | null;
  ago: string;
}

export interface TicketDraft {
  id: string;
  conversationId: string;
  kind: "INC" | "REQ";
  title: string;
  description: string;
  category: string;
  priority: Priority;
  affected: string;
  dueAt: string;
  status: "pending" | "confirmed" | "cancelled";
  ticketId: string | null;
  createdAt: string;
}

export interface Usage {
  used: number;
  limit: number;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  pendingDraft: TicketDraft | null;
  usage: Usage;
  employee?: PublicUser;
}

export interface ConsoleList {
  items: ConsoleConversation[];
  counts: { for_you: number; with_agent: number; mine: number };
}

// eventos realtime (SSE)
export type RealtimeEvent =
  | { type: "message"; conversationId: string; message: Message }
  | { type: "agent_start"; conversationId: string; messageId: string }
  | { type: "agent_step"; conversationId: string; messageId: string; step: AgentStep }
  | { type: "agent_delta"; conversationId: string; messageId: string; delta: string }
  | { type: "agent_end"; conversationId: string; messageId: string }
  | { type: "conversation"; conversationId: string }
  | { type: "conversations_changed" };
