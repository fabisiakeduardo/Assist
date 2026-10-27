import { Agent } from "@mastra/core/agent";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { config } from "../config.js";
import type { AgentEmit, AgentEngine, AgentResult, AgentServices, AgentTurnInput } from "./engine.js";
import type { AgentStep, CardPayload } from "../domain/types.js";
import {
  cardOptions,
  cardTicket,
  cardTicketSelector,
  classifyPriority,
  opAddTicketInfo,
  opBuildDraft,
  opCheckDuplicates,
  opGetTicket,
  opListTickets,
  opSearchHelp,
  opTransfer,
  type StepEmitter,
} from "./tools.js";
import { stepForTool, STEPS } from "./steps.js";
import { SYSTEM_PROMPT } from "./prompt.js";

// ─── MastraEngine ────────────────────────────────────────────────────────────
// O agent de verdade: Mastra Agent + tools sobre os serviços do domínio.
// Cada tool call aparece como passo visível ("consultou seus chamados") — a
// transparência sai do stream de eventos do Mastra (tool-call/tool-error).
// Efeitos colaterais (rascunho, transferência) são idênticos aos do
// ScriptedEngine porque usam as mesmas operações de agent/tools.ts.

const CATEGORIES = [
  "Acesso",
  "Rede e VPN",
  "Hardware",
  "Software",
  "E-mail",
  "Outros",
] as const;

export class MastraEngine implements AgentEngine {
  readonly kind = "mastra" as const;

  async run(input: AgentTurnInput, services: AgentServices, emit: AgentEmit): Promise<AgentResult> {
    const steps: AgentStep[] = [];
    const collectedCards: CardPayload[] = [];
    const toolNames: string[] = [];
    // passos ao vivo: retries do legado chegam pela StepEmitter das ops e já
    // entram em `steps` (persistem na mensagem + aparecem no console)
    const emitStep: StepEmitter = (step) => {
      steps.push(step);
      emit({
        type: "agent_step",
        conversationId: input.conversation.id,
        messageId: input.streamMessageId,
        step,
      });
    };

    const tools = {
      listar_chamados: createTool({
        id: "listar_chamados",
        description:
          "Lista os chamados ABERTOS do funcionário atual (id, título, status, prioridade, prazo, vencido). Use antes de falar de status e antes de abrir chamado.",
        inputSchema: z.object({}).strict(),
        execute: async () => (await opListTickets(services, input.user, emitStep)).data,
      }),
      detalhar_chamado: createTool({
        id: "detalhar_chamado",
        description:
          "Detalha UM chamado do funcionário (status, prioridade, datas, prazo, se está vencido). Aceita o número INC-XXXXX ou REQ-XXXXX.",
        inputSchema: z.object({ ticketId: z.string().describe("Número do chamado, ex.: INC-20311") }),
        execute: async ({ ticketId }) =>
          (await opGetTicket(services, input.user, ticketId, emitStep)).data,
      }),
      buscar_ajuda: createTool({
        id: "buscar_ajuda",
        description:
          "Busca na central de ajuda artigos sobre a dúvida/problema. Use para perguntas de como fazer ou sintomas conhecidos.",
        inputSchema: z.object({ consulta: z.string() }),
        execute: async ({ consulta }) => (await opSearchHelp(services, consulta)).data,
      }),
      classificar_prioridade: createTool({
        id: "classificar_prioridade",
        description:
          "Calcula a prioridade oficial (critica/alta/media/baixa) e o prazo do SLA a partir do impacto e urgência informados pelo funcionário.",
        inputSchema: z.object({
          tipo: z.enum(["INC", "REQ"]),
          impacto: z
            .enum(["self", "team", "company", "unknown"])
            .describe("self=só ele, team=equipe, company=empresa"),
          bloqueia_trabalho: z.boolean().describe("impede a pessoa/equipe de trabalhar"),
          prazo_hoje: z.boolean().describe("há compromisso ainda hoje"),
          tem_alternativa: z.boolean().describe("existe alternativa/contorno"),
        }),
        execute: async (args) =>
          classifyPriority({
            kind: args.tipo,
            impact: args.impacto,
            blocksWork: args.bloqueia_trabalho,
            deadlineToday: args.prazo_hoje,
            hasWorkaround: args.tem_alternativa,
          }),
      }),
      verificar_duplicidade: createTool({
        id: "verificar_duplicidade",
        description:
          "Verifica se já existe chamado aberto do funcionário sobre o mesmo problema. OBRIGATÓRIO antes de montar_rascunho.",
        inputSchema: z.object({
          titulo: z.string(),
          categoria: z.enum(CATEGORIES),
        }),
        execute: async ({ titulo, categoria }) =>
          (await opCheckDuplicates(services, input.user, titulo, categoria, emitStep)).data,
      }),
      montar_rascunho: createTool({
        id: "montar_rascunho",
        description:
          "Cria o RASCUNHO de chamado para confirmação do funcionário (card com Confirmar/Editar/Cancelar). Não cria o chamado — isso só acontece após confirmação explícita. Chame verificar_duplicidade antes.",
        inputSchema: z.object({
          tipo: z.enum(["INC", "REQ"]),
          titulo: z.string().max(80),
          descricao: z.string(),
          categoria: z.enum(CATEGORIES),
          prioridade: z.enum(["critica", "alta", "media", "baixa"]),
          afetados: z.string().describe("Ex.: 'Somente você', 'Equipe X', 'Toda a empresa'"),
        }),
        execute: async (args) => {
          const res = await opBuildDraft(services, input.conversation, input.user, {
            kind: args.tipo,
            title: args.titulo,
            description: args.descricao,
            category: args.categoria,
            priority: args.prioridade,
            affected: args.afetados,
          });
          collectedCards.push(res.card!);
          return { rascunhoId: res.data.id, aguardando: "confirmacao do funcionario" };
        },
      }),
      oferecer_opcoes: createTool({
        id: "oferecer_opcoes",
        description:
          "Mostra botões de resposta rápida sob a sua mensagem (2–4 opções curtas). Use para perguntas fechadas (impacto, sim/não).",
        inputSchema: z.object({ opcoes: z.array(z.string()).min(2).max(4) }),
        execute: async ({ opcoes }) => {
          collectedCards.push(cardOptions(opcoes));
          return { ok: true };
        },
      }),
      oferecer_seletor_chamados: createTool({
        id: "oferecer_seletor_chamados",
        description:
          "Mostra a lista dos chamados abertos para o funcionário escolher um (quando ele tem vários e não disse qual).",
        inputSchema: z.object({ chamados: z.array(z.string()).describe("Ids INC-/REQ- na ordem") }),
        execute: async ({ chamados }) => {
          collectedCards.push(cardTicketSelector(chamados));
          return { ok: true };
        },
      }),
      mostrar_chamado: createTool({
        id: "mostrar_chamado",
        description: "Anexa o card detalhado de um chamado à sua resposta (após detalhar_chamado).",
        inputSchema: z.object({ ticketId: z.string() }),
        execute: async ({ ticketId }) => {
          collectedCards.push(cardTicket(ticketId.toUpperCase()));
          return { ok: true };
        },
      }),
      atualizar_chamado: createTool({
        id: "atualizar_chamado",
        description:
          "Acrescenta uma nota do funcionário a um chamado existente (e reabre se resolvido há até 7 dias).",
        inputSchema: z.object({
          ticketId: z.string(),
          nota: z.string().describe("Resumo do que o funcionário acrescentou"),
        }),
        execute: async ({ ticketId, nota }) =>
          (await opAddTicketInfo(services, input.user, ticketId.toUpperCase(), nota, emitStep)).data,
      }),
      transferir_analista: createTool({
        id: "transferir_analista",
        description:
          "Transfere a conversa para um analista humano (você fica pausado). Use quando o funcionário pede, caso crítico, chamado vencido ou você sem segurança. Gere um resumo útil do caso.",
        inputSchema: z.object({
          resumo: z.string().describe("Resumo do caso para o analista"),
          motivo: z.string().describe("por que está transferindo"),
          fila: z.enum(["N1", "N2"]).describe("N2 para críticos/vencidos, senão N1"),
        }),
        execute: async ({ resumo, motivo, fila }) =>
          (await opTransfer(services, input.conversation, {
            summary: resumo,
            reason: motivo,
            queue: fila,
          })).data,
      }),
    };

    const agent = new Agent({
      id: "nexo-assist",
      name: "Nexo Assist",
      instructions: SYSTEM_PROMPT,
      model: config.llmModel,
      tools,
    });

    const messages = buildModelMessages(input);
    const stream = await agent.stream(messages as MessageListInput, {
      maxSteps: 8,
      modelSettings: { temperature: config.llmTemperature },
    });

    // latência por tool: casa tool-call → tool-result pelo toolCallId
    const pendingCalls = new Map<string, { step: AgentStep | null; t0: number }>();

    let text = "";
    for await (const chunk of stream.fullStream) {
      const c = chunk as { type: string; payload?: Record<string, unknown> };
      if (c.type === "text-delta") {
        const delta = (c.payload as { text?: string }).text ?? "";
        text += delta;
        emit({
          type: "agent_delta",
          conversationId: input.conversation.id,
          messageId: input.streamMessageId,
          delta,
        });
      } else if (c.type === "tool-call") {
        const p = c.payload as { toolName?: string; args?: unknown; toolCallId?: string };
        const name = p.toolName ?? "";
        toolNames.push(name);
        const step = stepForTool(name, p.args, null);
        pendingCalls.set(String(p.toolCallId ?? name), { step, t0: performance.now() });
        if (step) emitStep(step);
      } else if (c.type === "tool-result") {
        const p = c.payload as { toolCallId?: string; toolName?: string };
        const rec = pendingCalls.get(String(p.toolCallId ?? p.toolName ?? ""));
        if (rec?.step && rec.step.ms === undefined) {
          rec.step.ms = Math.max(1, Math.round(performance.now() - rec.t0));
        }
      } else if (c.type === "tool-error") {
        emitStep(STEPS.legacyDown());
      }
    }

    const lastTool = toolNames[toolNames.length - 1] ?? "";
    return {
      text: text.trim() || fallbackText(lastTool),
      steps: dedupeSteps(steps),
      ...(collectedCards.length ? { cards: collectedCards } : {}),
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildModelMessages(input: AgentTurnInput): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: `Funcionário: ${input.user.name} <${input.user.email}> · time: ${input.user.team || "—"}. Responda sempre em pt-BR.`,
    },
  ];
  // últimas ~24 mensagens de contexto (custo consciente)
  for (const m of input.history.slice(-24)) {
    if (m.sender === "user") msgs.push({ role: "user", content: m.text });
    else if (m.sender === "agent") {
      const suffix = m.cards?.length ? `\n[card exibido: ${JSON.stringify(m.cards)}]` : "";
      msgs.push({ role: "assistant", content: m.text + suffix });
    } else if (m.sender === "analyst") {
      msgs.push({ role: "system", content: `[analista humano] ${m.text}` });
    } else {
      msgs.push({ role: "system", content: `[sistema] ${m.text}` });
    }
  }
  return msgs;
}

function dedupeSteps(steps: AgentStep[]): AgentStep[] {
  const seen = new Set<string>();
  return steps.filter((s) => {
    const k = s.label + (s.detail ?? "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function fallbackText(lastTool: string): string {
  return lastTool
    ? "Pronto — fiz o que você pediu. Precisa de mais alguma coisa?"
    : "Desculpa, não consegui processar isso. Pode reformular?";
}
