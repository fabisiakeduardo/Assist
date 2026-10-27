import { EventEmitter } from "node:events";
import type { RealtimeEvent } from "./domain/types.js";

// ─── Hub de eventos em tempo real ────────────────────────────────────────────
// Pub/Sub em memória alimentando os endpoints SSE. Por conversa (chat do
// funcionário e do analista) e um canal global para a lista do console.

export class RealtimeHub {
  private readonly bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(500);
  }

  publish(event: RealtimeEvent): void {
    if (event.type === "conversations_changed") {
      this.bus.emit("console", event);
      return;
    }
    this.bus.emit(`conv:${event.conversationId}`, event);
    // a lista do console também muda quando mensagens/status chegam
    if (event.type === "message" || event.type === "conversation") {
      this.bus.emit("console", { type: "conversations_changed" } as RealtimeEvent);
    }
  }

  subscribeConversation(conversationId: string, listener: (e: RealtimeEvent) => void): () => void {
    const channel = `conv:${conversationId}`;
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  subscribeConsole(listener: (e: RealtimeEvent) => void): () => void {
    this.bus.on("console", listener);
    return () => this.bus.off("console", listener);
  }
}
