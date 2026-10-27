import type { Store } from "../store.js";
import type { TicketService } from "../services/ticketService.js";
import type { HelpCenter } from "../services/helpCenter.js";
import type {
  AgentStep,
  CardPayload,
  Conversation,
  Message,
  MessageMeta,
  RealtimeEvent,
  User,
} from "../domain/types.js";

// ─── Contrato dos motores de agent ───────────────────────────────────────────
// Dois motores implementam a mesma interface:
//   • MastraEngine   — LLM de verdade via Mastra + tools (precisa de chave)
//   • ScriptedEngine — pipeline determinístico, mesma UX, zero dependência de
//                      chave (demo offline e testes)
// A escolha é por config; os efeitos colaterais (rascunhos, transferências,
// atualizações de chamado) passam pelos mesmos serviços.

export interface AgentServices {
  store: Store;
  tickets: TicketService;
  help: HelpCenter;
}

export interface AgentTurnInput {
  conversation: Conversation;
  user: User;
  /** Texto da mensagem do funcionário que disparou o turno. */
  userText: string;
  /** Histórico já persistido (inclui a mensagem do usuário). */
  history: Message[];
  /** Id efêmero da bolha "em progresso" no cliente — referência dos eventos de stream. */
  streamMessageId: string;
}

export interface AgentEmit {
  (event: RealtimeEvent): void;
}

export interface AgentResult {
  /** Texto final da resposta do agent. */
  text: string;
  /** Passos executados — exibidos acima da resposta (transparência). */
  steps: AgentStep[];
  /** Cards renderizados junto à resposta (ex.: rascunho + opções). */
  cards?: CardPayload[];
  /** Telemetria do turno (tokens/custo) — persistida na meta da mensagem. */
  meta?: MessageMeta;
}

export interface AgentEngine {
  readonly kind: "mastra" | "scripted";
  run(input: AgentTurnInput, services: AgentServices, emit: AgentEmit): Promise<AgentResult>;
}
