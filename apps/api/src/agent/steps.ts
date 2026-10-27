import type { AgentStep } from "../domain/types.js";

// ─── Rótulos dos passos do agent ─────────────────────────────────────────────
// Os passos são exibidos acima de cada resposta ("consultou seus chamados",
// "classificou a prioridade"). Este módulo centraliza o mapeamento
// tool → rótulo pt-BR para que as duas engines descrevam o mesmo vocabulário.
// Cada passo carrega o nome da tool que o gerou — inspecionável na UI e no
// console do analista.

export const STEPS = {
  consultTickets: (): AgentStep => ({
    label: "consultou seus chamados",
    tool: "listar_chamados",
  }),
  consultTicket: (tid: string): AgentStep => ({
    label: `consultou o ${tid}`,
    tool: "detalhar_chamado",
  }),
  searchHelp: (): AgentStep => ({ label: "buscou na central de ajuda", tool: "buscar_ajuda" }),
  classifyPriority: (): AgentStep => ({
    label: "classificou a prioridade",
    tool: "classificar_prioridade",
  }),
  consultSla: (): AgentStep => ({ label: "consultou o SLA", tool: "prazo_sla" }),
  checkDuplicates: (): AgentStep => ({
    label: "verificou duplicidade",
    tool: "verificar_duplicidade",
  }),
  buildDraft: (): AgentStep => ({ label: "montou o rascunho", tool: "montar_rascunho" }),
  createTicket: (tid: string): AgentStep => ({
    label: `criou o ${tid}`,
    tool: "criar_chamado",
  }),
  updateTicket: (tid: string): AgentStep => ({
    label: `atualizou o ${tid}`,
    tool: "atualizar_chamado",
  }),
  reopenTicket: (tid: string): AgentStep => ({
    label: `reabriu o ${tid}`,
    tool: "atualizar_chamado",
  }),
  transfer: (): AgentStep => ({
    label: "transferiu para um analista",
    tool: "transferir_analista",
  }),
  calcDeadline: (): AgentStep => ({ label: "calculou o prazo", tool: "prazo_sla" }),
  retryLegacy: (attempt: number): AgentStep => ({
    label: "serviço de chamados instável",
    detail: `nova tentativa (${attempt}/3)`,
    tool: "retry",
  }),
  legacyDown: (): AgentStep => ({
    label: "serviço de chamados indisponível",
    detail: "vai tentar de novo em instantes",
    tool: "legacy",
  }),
  closedTooOld: (tid: string, days: number): AgentStep => ({
    label: `${tid} resolvido há ${Math.floor(days)} dias`,
    detail: "reabertura fora da janela de 7 dias",
    tool: "atualizar_chamado",
  }),
} as const;

/** Rótulo para o resultado de uma tool do motor Mastra. */
export function stepForTool(toolId: string, args: unknown, result: unknown): AgentStep | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const r = (result ?? {}) as Record<string, unknown>;
  switch (toolId) {
    case "listar_chamados":
      return STEPS.consultTickets();
    case "detalhar_chamado":
      return STEPS.consultTicket(String(a.ticketId ?? r.id ?? "chamado"));
    case "buscar_ajuda":
      return STEPS.searchHelp();
    case "classificar_prioridade":
      return STEPS.classifyPriority();
    case "prazo_sla":
      return STEPS.consultSla();
    case "verificar_duplicidade":
      return STEPS.checkDuplicates();
    case "montar_rascunho":
      return STEPS.buildDraft();
    case "atualizar_chamado":
      return STEPS.updateTicket(String(a.ticketId ?? "chamado"));
    case "transferir_analista":
      return STEPS.transfer();
    default:
      return null; // tools puramente visuais (opções, seletor) não viram passo
  }
}
