import { randomUUID } from "node:crypto";
import type { AgentEmit, AgentEngine, AgentServices } from "../agent/engine.js";
import type { RealtimeHub } from "../realtime.js";
import type { Conversation, Message, User } from "../domain/types.js";

// ─── Runner do agent ─────────────────────────────────────────────────────────
// Recebe a mensagem do funcionário e produz a resposta do agent, transmitindo
// passos e deltas em tempo real. Só roda quando a conversa está com o agent —
// a regra "o agent não responde enquanto está com um analista" fica aqui.

export class AgentRunner {
  constructor(
    private readonly services: AgentServices,
    private readonly engine: AgentEngine,
    private readonly hub: RealtimeHub,
  ) {}

  /** Um turno por vez por conversa — o contexto do turno N lê o estado do turno N-1. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Executa um turno do agent para a conversa. Chamado pelo route handler. */
  runTurn(conversation: Conversation, user: User, userText: string): Promise<Message> {
    const prev = this.queues.get(conversation.id) ?? Promise.resolve();
    const job = prev.then(() => this.doRun(conversation, user, userText));
    this.queues.set(
      conversation.id,
      job.catch(() => undefined),
    );
    return job;
  }

  private async doRun(conversation: Conversation, user: User, userText: string): Promise<Message> {
    const { store } = this.services;
    const emit: AgentEmit = (e) => this.hub.publish(e);
    const streamMessageId = randomUUID();

    emit({ type: "agent_start", conversationId: conversation.id, messageId: streamMessageId });
    try {
      const result = await this.engine.run(
        {
          conversation: store.conversation(conversation.id) ?? conversation,
          user,
          userText,
          history: store.messages(conversation.id),
          streamMessageId,
        },
        this.services,
        emit,
      );

      const message = store.addMessage({
        conversationId: conversation.id,
        sender: "agent",
        text: result.text,
        steps: result.steps,
        cards: result.cards ?? null,
      });
      emit({ type: "agent_end", conversationId: conversation.id, messageId: streamMessageId });
      this.hub.publish({ type: "message", conversationId: conversation.id, message });
      return message;
    } catch (err) {
      const message = store.addMessage({
        conversationId: conversation.id,
        sender: "agent",
        text: "Tive uma instabilidade agora — o serviço de chamados ou o modelo podem ter oscilado. Pode repetir, por favor?",
        steps: [{ label: "ocorreu um erro inesperado", detail: "tente novamente" }],
      });
      emit({ type: "agent_end", conversationId: conversation.id, messageId: streamMessageId });
      this.hub.publish({ type: "message", conversationId: conversation.id, message });
      console.error("[agent] erro no turno:", err);
      return message;
    }
  }
}
