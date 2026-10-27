import type {
  ConsoleList,
  Conversation,
  ConversationDetail,
  Message,
  PublicUser,
  Ticket,
  TicketDraft,
  Usage,
} from "./types";

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    ...(init ?? {}),
    ...(init?.body ? { headers: { "Content-Type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let detail: string | undefined;
    try {
      const body = await res.json();
      code = body.error ?? code;
      detail = body.detail;
    } catch {
      /* corpo vazio */
    }
    throw new ApiError(res.status, code, detail);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  login: (email: string, password: string) =>
    post<{ user: PublicUser }>("/auth/login", { email, password }),
  logout: () => post<{ ok: true }>("/auth/logout"),
  me: () => req<{ user: PublicUser; usage: Usage; engine: string }>("/me"),

  currentConversation: () =>
    req<{ conversation: Conversation }>("/conversations/current"),
  conversation: (id: string) => req<ConversationDetail>(`/conversations/${id}`),
  sendMessage: (id: string, text: string) =>
    post<{ message: Message; usage: Usage }>(`/conversations/${id}/messages`, { text }),
  confirmDraft: (convId: string, draftId: string) =>
    post<{ ticket: Ticket; message: Message }>(
      `/conversations/${convId}/drafts/${draftId}/confirm`,
    ),
  cancelDraft: (convId: string, draftId: string) =>
    post<{ ok: boolean; message: Message }>(
      `/conversations/${convId}/drafts/${draftId}/cancel`,
    ),

  tickets: () => req<{ tickets: Ticket[] }>("/tickets"),
  ticket: (id: string) => req<{ ticket: Ticket; events: Array<{ id: number; actor: string; text: string; createdAt: string }> }>(`/tickets/${id}`),
  help: (q: string) =>
    req<{ hits: Array<{ id: string; title: string; body: string; score: number }> }>(
      `/help?q=${encodeURIComponent(q)}`,
    ),

  // console do analista
  consoleConversations: (filter?: string, q?: string) =>
    req<ConsoleList>(
      `/console/conversations?${new URLSearchParams({
        ...(filter ? { filter } : {}),
        ...(q ? { q } : {}),
      })}`,
    ),
  assume: (convId: string) =>
    post<{ conversation: Conversation }>(`/conversations/${convId}/assume`),
  release: (convId: string) =>
    post<{ conversation: Conversation }>(`/conversations/${convId}/release`),
  close: (convId: string) =>
    post<{ conversation: Conversation }>(`/conversations/${convId}/close`),
  userTickets: (userId: string) =>
    req<{ employee: PublicUser; tickets: Ticket[]; openCount: number; closedCount: number }>(
      `/console/users/${userId}/tickets`,
    ),

  // SSE
  streamUrl: (convId: string) => `${BASE}/conversations/${convId}/stream`,
  consoleStreamUrl: () => `${BASE}/console/stream`,
};
