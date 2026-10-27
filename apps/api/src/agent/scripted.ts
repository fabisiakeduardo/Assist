import type { AgentEmit, AgentEngine, AgentResult, AgentServices, AgentTurnInput } from "./engine.js";
import type {
  AgentStep,
  CardPayload,
  Conversation,
  Message,
  TicketKind,
  TicketPriority,
  User,
} from "../domain/types.js";
import { PRIORITY_LABEL, STATUS_LABEL } from "../domain/types.js";
import { fmtAgo, fmtDayMonthTime, fmtTime, slaLabel } from "../domain/sla.js";
import { normalize, keywords, squash } from "../domain/text.js";
import {
  classifyPriority,
  opAddTicketInfo,
  opBuildDraft,
  opCheckDuplicates,
  opGetTicket,
  opListTickets,
  opSearchHelp,
  opTransfer,
  type ImpactScope,
  type StepEmitter,
} from "./tools.js";
import { confirmDraft, DraftNotPendingError } from "../services/draftActions.js";
import { STEPS } from "./steps.js";

// ─── ScriptedEngine ──────────────────────────────────────────────────────────
// Pipeline determinístico que reproduz o comportamento esperado do agent —
// mesmas tools, mesmos passos, mesmos cards — sem depender de LLM. Serve para
// demo offline e como base determinística dos testes de fluxo.
//
// O estado entre turnos fica em conversation.agentContext (persistido) e no
// card da última mensagem do agent (opções/seletor/rascunho pendentes), então
// a conversa sobrevive a restart exatamente como a do motor Mastra.

interface IntakeDraft {
  kind: TicketKind;
  title: string;
  description: string;
  category: string;
  impact: ImpactScope | null;
  blocksWork: boolean;
  deadlineToday: boolean;
  hasWorkaround: boolean;
}

interface Ctx {
  pending?: "impact" | "note" | "post_help" | "dup_add_info" | "closed_reopen";
  intake?: IntakeDraft;
  noteTicketId?: string;
  pendingNote?: string;
  helpQuery?: string;
}

const TICKET_RE = /\b(INC|REQ)-?(\d{4,6})\b/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ScriptedEngine implements AgentEngine {
  readonly kind = "scripted" as const;

  /** Ritmo artificial para o streaming parecer vivo (0 em testes). */
  constructor(private readonly pace = { stepMs: 220, wordMs: 14 }) {}

  async run(input: AgentTurnInput, services: AgentServices, emit: AgentEmit): Promise<AgentResult> {
    // passos emitidos ao vivo pelas ops (ex.: retry do legado) não são re-emitidos
    const emitted = new Set<AgentStep>();
    const emitStep: StepEmitter = (step) => {
      emitted.add(step);
      emit({
        type: "agent_step",
        conversationId: input.conversation.id,
        messageId: input.streamMessageId,
        step,
      });
    };
    const result = await this.produce(input, services, emitStep);
    for (const step of result.steps) {
      if (emitted.has(step)) continue;
      emitStep(step);
      if (this.pace.stepMs) await sleep(this.pace.stepMs);
    }
    if (this.pace.wordMs) {
      const words = result.text.split(/(\s+)/);
      for (const w of words) {
        emit({
          type: "agent_delta",
          conversationId: input.conversation.id,
          messageId: input.streamMessageId,
          delta: w,
        });
        if (w.trim()) await sleep(this.pace.wordMs);
      }
    }
    return result;
  }

  private async produce(
    input: AgentTurnInput,
    services: AgentServices,
    emit: StepEmitter,
  ): Promise<AgentResult> {
    const ctx = (input.conversation.agentContext ?? {}) as Ctx;
    const text = input.userText;
    const n = normalize(text);

    // caminhos de estado primeiro (respostas a perguntas do agent)
    if (ctx.pending === "impact" && ctx.intake) {
      return this.answerImpact(input, services, emit, ctx, text);
    }
    if (ctx.pending === "note" && ctx.noteTicketId) {
      return this.addNote(input, services, emit, ctx, text);
    }
    if (ctx.pending === "dup_add_info" && ctx.noteTicketId) {
      if (wants(n)) return this.addNote(input, services, emit, ctx, text, true);
      services.store.setAgentContext(input.conversation.id, null);
    }
    if (ctx.pending === "post_help") {
      if (solved(n)) {
        services.store.setAgentContext(input.conversation.id, null);
        return finish("Ótimo! Se precisar de mais alguma coisa de TI, é só chamar.", []);
      }
      if (wantsAnalyst(text)) return this.transfer(input, services, "o funcionário pediu um analista");
      services.store.setAgentContext(input.conversation.id, null);
      const intake = ctx.intake;
      if (intake) {
        // retomada do relato original — incorpora info nova que veio junto
        if (!isOptionPick(input, n) && text.trim().length > 12) {
          intake.description += ` — ${text.trim()}`;
        }
        if (intake.impact === null) {
          services.store.setAgentContext(input.conversation.id, {
            pending: "impact",
            intake,
          } satisfies Ctx);
          return {
            text: "Beleza, vou abrir um chamado então. Para classificar direito: quem está sendo afetado?",
            steps: [],
            cards: [{ type: "options", options: ["Só eu", "Minha equipe", "Toda a empresa", "Não sei"] }],
          };
        }
        return this.buildDraftFrom(input, services, intake, []);
      }
      return this.startIntake(input, services, emit, ctx.helpQuery ?? text, true);
    }
    if (ctx.pending === "closed_reopen") {
      // o chamado estava resolvido há >7 dias — o usuário decide se abre um novo
      services.store.setAgentContext(input.conversation.id, null);
      if (wants(n) || /abrir|novo|chamado/.test(n)) {
        return this.startIntake(input, services, emit, ctx.pendingNote ?? text, true);
      }
      return finish("Sem problema. Se surgir qualquer outra coisa de TI, estou por aqui.", []);
    }

    // rascunho pendente: confirmar / cancelar / editar
    const pendingDraft = services.store.pendingDraftFor(input.conversation.id);
    if (pendingDraft) {
      if (cancelIntent(n)) {
        services.store.setDraftStatus(pendingDraft.id, "cancelled");
        return finish(
          "Sem problema — descartei o rascunho. Se mudar de ideia ou aparecer outra coisa de TI, estou por aqui.",
          [],
        );
      }
      if (confirmIntent(n)) {
        return this.confirm(input, services, pendingDraft.id);
      }
      // intenções claras não viram correção — o rascunho continua aguardando
      if (wantsAnalyst(text)) {
        return this.transfer(input, services, "o funcionário pediu um analista");
      }
      if (isOffTopic(n)) return this.offTopic();
      const refWhileDraft = text.match(TICKET_RE);
      if (isStatusQuery(n) || refWhileDraft) {
        const res = refWhileDraft
          ? await this.ticketDetail(input, services, emit, `${refWhileDraft[1]!.toUpperCase()}-${refWhileDraft[2]}`)
          : await this.statusFlow(input, services, emit);
        return {
          ...res,
          text: `${res.text}\n\n(O rascunho do chamado continua aqui — é só confirmar ou pedir ajuste.)`,
        };
      }
      // texto ambíguo enquanto o rascunho espera = correção
      return this.reviseDraft(input, services, pendingDraft.id, text);
    }

    // respostas a opções rápidas do turno anterior
    const lastAgent = [...input.history].reverse().find((m) => m.sender === "agent");
    const lastOptions = lastAgent?.cards?.find((c) => c.type === "options");
    const lastTicket = lastAgent?.cards?.find((c) => c.type === "ticket");
    if (lastOptions && lastTicket) {
      const tid = (lastTicket as { ticketId: string }).ticketId;
      if (/adicionar|acrescentar/.test(n)) {
        services.store.setAgentContext(input.conversation.id, {
          pending: "note",
          noteTicketId: tid,
        } satisfies Ctx);
        return finish(`Claro — o que você quer acrescentar no ${tid}?`, []);
      }
      if (/n[aã]o,?\s*obrigad|deixa|depois/.test(n)) {
        return finish("Combinado. Qualquer coisa, estou por aqui.", []);
      }
    }

    // intenções diretas
    if (wantsAnalyst(text)) return this.transfer(input, services, "o funcionário pediu um analista");
    if (isOffTopic(n)) return this.offTopic();
    if (isGreeting(n)) return finish(`Oi, ${firstName(input.user.name)}! Sou o Nexo Assist. Me conta o que está acontecendo — dúvida, problema ou chamado — e eu resolvo com você.`, []);
    if (isThanks(n)) return finish("Por nada! Se precisar de mais alguma coisa de TI, é só chamar.", []);

    const ticketRef = text.match(TICKET_RE);
    if (ticketRef) {
      return this.ticketDetail(input, services, emit, `${ticketRef[1]!.toUpperCase()}-${ticketRef[2]}`);
    }
    if (isStatusQuery(n)) return this.statusFlow(input, services, emit);
    if (isSelectorPick(input)) return this.selectorPick(input, services, emit, text);

    // pergunta how-to → central de ajuda primeiro
    if (isQuestion(n)) return this.helpFlow(input, services, text);

    // padrão: relato de problema → intake de chamado (com dedup + ajuda)
    return this.startIntake(input, services, emit, text);
  }

  // ── confirmação de rascunho via texto ─────────────────────────────────────

  private async confirm(
    input: AgentTurnInput,
    services: AgentServices,
    draftId: string,
  ): Promise<AgentResult> {
    try {
      const { ticket } = await confirmDraft(services, input.conversation.id, draftId);
      const steps = [STEPS.createTicket(ticket.id)];
      return {
        text: `Pronto: abri o chamado com prioridade ${PRIORITY_LABEL[ticket.priority].toLowerCase()}. O service desk responde ${slaLabel(ticket.priority)}.`,
        steps,
        cards: [{ type: "ticket", ticketId: ticket.id }],
      };
    } catch (err) {
      if (err instanceof DraftNotPendingError) {
        return finish("Esse rascunho já não está mais ativo — posso montar outro se quiser.", []);
      }
      return finish(
        "O serviço de chamados está instável agora e não consegui concluir a criação. Quer que eu tente de novo?",
        [STEPS.legacyDown()],
      );
    }
  }

  private async reviseDraft(
    input: AgentTurnInput,
    services: AgentServices,
    draftId: string,
    note: string,
  ): Promise<AgentResult> {
    const draft = services.store.draft(draftId)!;
    const n = normalize(note);
    const category = inferCategory(note) ?? draft.category;
    const urgency = detectUrgency(n) || undefined;
    const { priority } = classifyPriority({
      kind: draft.kind,
      impact: draft.affected === "Somente você" ? "self" : draft.affected === "Toda a empresa" ? "company" : "team",
      blocksWork: urgency?.blocks ?? draft.priority === "alta",
      deadlineToday: urgency?.today ?? draft.priority === "alta",
      hasWorkaround: urgency?.workaround ?? false,
    });
    const newDraft = await opBuildDraft(services, input.conversation, input.user, {
      kind: draft.kind,
      title: draft.title,
      description: `${draft.description} ${note.trim()}`,
      category,
      priority: n.includes("urgente") || urgency?.today ? "alta" : priority,
      affected: draft.affected,
    });
    return {
      text: "Atualizei o rascunho com o que você disse — confere de novo antes de eu criar:",
      steps: newDraft.steps,
      ...(newDraft.card ? { cards: [newDraft.card] } : {}),
    };
  }

  // ── intake de novo chamado ────────────────────────────────────────────────

  private async startIntake(
    input: AgentTurnInput,
    services: AgentServices,
    emit: StepEmitter,
    report: string,
    skipHelpOffer = false,
  ): Promise<AgentResult> {
    const steps: AgentStep[] = [];
    const n = normalize(report);

    const search = await opSearchHelp(services, report);
    steps.push(...search.steps);

    const list = await opListTickets(services, input.user, emit);
    steps.push(...list.steps);

    const kind = inferKind(n, report);
    const category = inferCategory(report) ?? "Outros";
    const urgency = detectUrgency(n);
    const intake: IntakeDraft = {
      kind,
      title: makeTitle(report),
      description: report.trim(),
      category,
      impact: inferImpact(n), // o relato já pode dizer quem é afetado
      blocksWork: urgency.blocks,
      deadlineToday: urgency.today,
      hasWorkaround: urgency.workaround,
    };

    // duplicidade primeiro (regra do Anexo A)
    const dup = await opCheckDuplicates(services, input.user, intake.title, category, emit);
    steps.push(...dup.steps);
    const dupTicket = dup.data.duplicate as { id: string; title: string; status: string } | null;
    if (dupTicket) {
      services.store.setAgentContext(input.conversation.id, {
        pending: "dup_add_info",
        noteTicketId: dupTicket.id,
        pendingNote: intake.description,
      } satisfies Ctx);
      return {
        text: `Antes de abrir outro, olha o que encontrei: você já tem um chamado aberto sobre isso (${dupTicket.id} — "${dupTicket.title}"). Em vez de duplicar, posso acrescentar essas informações nele. Faço isso?`,
        steps,
        cards: [{ type: "options", options: ["Sim, adicionar lá", "Não, quero falar com um analista"] }],
      };
    }

    // artigo que resolve direto? responde e pergunta se resolveu
    // (exceção: crise — empresa/equipe parada não deve ser desviada para FAQ)
    const critical = intake.impact !== null && intake.impact !== "self" && intake.blocksWork;
    const hit = search.data[0];
    if (!critical && !skipHelpOffer && hit && hitApplies(hit, n) && !asksToOpen(n)) {
      services.store.setAgentContext(input.conversation.id, {
        pending: "post_help",
        helpQuery: report,
        intake,
      } satisfies Ctx);
      return {
        text: `${hit.body}\n\nIsso resolve o seu caso? Se não, já deixo um chamado pronto pra você.`,
        steps,
        cards: [{ type: "options", options: ["Sim, resolveu", "Não resolveu — abrir chamado", "Falar com um analista"] }],
      };
    }

    // falta o impacto → pergunta com opções rápidas
    if (intake.impact === null) {
      services.store.setAgentContext(input.conversation.id, {
        pending: "impact",
        intake,
      } satisfies Ctx);
      const kbNote = hit ? `O artigo "${hit.title}" não cobre o seu cenário, então vou abrir um chamado. ` : "";
      return {
        text: `${kbNote}Para classificar direito: quem está sendo afetado?`,
        steps,
        cards: [{ type: "options", options: ["Só eu", "Minha equipe", "Toda a empresa", "Não sei"] }],
      };
    }

    return this.buildDraftFrom(input, services, intake, steps);
  }

  private async answerImpact(
    input: AgentTurnInput,
    services: AgentServices,
    emit: StepEmitter,
    ctx: Ctx,
    answer: string,
  ): Promise<AgentResult> {
    const intake = ctx.intake!;
    const n = normalize(answer);
    if (n.includes("empresa") || n.includes("toda")) intake.impact = "company";
    else if (n.includes("equipe") || n.includes("time")) intake.impact = "team";
    else if (n.includes("sei")) intake.impact = "unknown";
    else intake.impact = "self";
    // a resposta pode trazer urgência/nova info junto ("só eu, tenho reunião às 14h")
    const urgency = detectUrgency(n);
    intake.blocksWork = intake.blocksWork || urgency.blocks;
    intake.deadlineToday = intake.deadlineToday || urgency.today;
    intake.hasWorkaround = intake.hasWorkaround || urgency.workaround;
    if (answer.trim().length > 30) intake.description += ` — ${answer.trim()}`;

    services.store.setAgentContext(input.conversation.id, null);
    return this.buildDraftFrom(input, services, intake, [STEPS.classifyPriority(), STEPS.consultSla()]);
  }

  private async buildDraftFrom(
    input: AgentTurnInput,
    services: AgentServices,
    intake: IntakeDraft,
    steps: AgentStep[],
  ): Promise<AgentResult> {
    const { priority, reason } = classifyPriority({
      kind: intake.kind,
      impact: intake.impact ?? "self",
      blocksWork: intake.blocksWork,
      deadlineToday: intake.deadlineToday,
      hasWorkaround: intake.hasWorkaround,
    });
    const affectedLabel =
      intake.impact === "team"
        ? `Sua equipe (${input.user.team || "seu time"})`
        : intake.impact === "company"
          ? "Toda a empresa"
          : intake.impact === "unknown"
            ? "A confirmar"
            : "Somente você";

    const draft = await opBuildDraft(services, input.conversation, input.user, {
      kind: intake.kind,
      title: intake.title,
      description: intake.description,
      category: intake.category,
      priority,
      affected: affectedLabel,
    });
    steps.push(...draft.steps);

    const why = intake.deadlineToday
      ? "por causa do seu compromisso ainda hoje"
      : `porque ${reason}`;
    return {
      text: `Coloquei prioridade ${PRIORITY_LABEL[priority].toLowerCase()} ${why} — a resposta chega ${slaLabel(priority)}. Confira antes de eu criar:`,
      steps,
      ...(draft.card ? { cards: [draft.card] } : {}),
    };
  }

  // ── status / detalhe de chamado ───────────────────────────────────────────

  private async statusFlow(input: AgentTurnInput, services: AgentServices, emit: StepEmitter): Promise<AgentResult> {
    const res = await opListTickets(services, input.user, emit);
    const tickets = res.data as Array<{ id: string; title: string; status: string; updatedAt: string; overdue: boolean }>;
    if (tickets.length === 0) {
      return {
        text: "Você não tem nenhum chamado aberto agora. Quer que eu abra um? Me conta o que está acontecendo.",
        steps: res.steps,
      };
    }
    if (tickets.length === 1) {
      return this.ticketDetail(input, services, emit, tickets[0]!.id, res.steps);
    }
    const lines = tickets.map((t) => `${t.id} — ${t.title}`).join("\n");
    return {
      text: `Você tem ${tickets.length} chamados abertos. Sobre qual deles quer saber?`,
      steps: res.steps,
      cards: [{ type: "ticket_selector", ticketIds: tickets.map((t) => t.id) }],
    };
  }

  private async selectorPick(input: AgentTurnInput, services: AgentServices, emit: StepEmitter, text: string): Promise<AgentResult> {
    // última mensagem do agent era um seletor → o texto é a escolha
    const list = await opListTickets(services, input.user, emit);
    const tickets = list.data as Array<{ id: string; title: string }>;
    const pick =
      tickets.find((t) => normalize(text).includes(normalize(t.id))) ??
      tickets.find((t) => normalize(text).includes(normalize(t.title).slice(0, 24)));
    if (!pick) {
      return this.statusFlow(input, services, emit);
    }
    return this.ticketDetail(input, services, emit, pick.id, list.steps);
  }

  private async ticketDetail(
    input: AgentTurnInput,
    services: AgentServices,
    emit: StepEmitter,
    ticketId: string,
    steps: AgentStep[] = [],
  ): Promise<AgentResult> {
    const res = await opGetTicket(services, input.user, ticketId);
    steps.push(...res.steps);
    const t = res.data;
    if ("error" in t) {
      return {
        text: `Não encontrei o chamado ${ticketId} entre os seus — só consigo ver chamados que você abriu. Quer que eu liste os seus?`,
        steps,
      };
    }
    const statusLabel = STATUS_LABEL[t.status as keyof typeof STATUS_LABEL] ?? t.status;
    let summary = `${t.id} — "${t.title}" está ${statusLabel.toLowerCase()}, prioridade ${PRIORITY_LABEL[t.priority as TicketPriority].toLowerCase()}. Última atualização ${fmtAgo(t.updatedAt)}.`;
    const ticketCard: CardPayload = { type: "ticket", ticketId: t.id };
    if (t.status === "resolvido") {
      summary += " Se o problema voltou, posso acrescentar uma atualização — isso reabre o chamado se ele foi resolvido há até 7 dias.";
      return {
        text: summary,
        steps,
        cards: [
          ticketCard,
          { type: "options", options: ["Adicionar informação", "Não, obrigado"] },
        ],
      };
    }
    if (t.overdue) {
      summary += ` O prazo de resposta já venceu (${fmtDayMonthTime(t.dueAt)}) — quer que eu chame um analista?`;
      return {
        text: summary,
        steps,
        cards: [
          ticketCard,
          {
            type: "options",
            options: ["Falar com um analista", "Adicionar informação", "Não, obrigado"],
          },
        ],
      };
    }
    return {
      text: summary,
      steps,
      cards: [ticketCard],
    };
  }

  // ── nota em chamado existente ─────────────────────────────────────────────

  private async addNote(
    input: AgentTurnInput,
    services: AgentServices,
    emit: StepEmitter,
    ctx: Ctx,
    text: string,
    skipConfirm = false,
  ): Promise<AgentResult> {
    const tid = ctx.noteTicketId!;
    const nn = normalize(text);
    if (!skipConfirm && nn.length < 120 && !wants(nn) && ctx.pending === "dup_add_info") {
      // resposta ambígua → confirma
      return {
        text: `Quer que eu acrescente isso no ${tid}?`,
        steps: [],
        cards: [{ type: "options", options: ["Sim, adicionar lá", "Não, deixa pra lá"] }],
      };
    }
    const note = ctx.pendingNote ?? text;
    const res = await opAddTicketInfo(services, input.user, tid, note, emit);
    services.store.setAgentContext(input.conversation.id, null);
    const errKind = "error" in res.data ? res.data.error : null;
    if (errKind === "closed_window") {
      // fora da janela de 7 dias — oferece abrir um chamado novo com a mesma nota
      services.store.setAgentContext(input.conversation.id, {
        pending: "closed_reopen",
        noteTicketId: tid,
        pendingNote: note,
      } satisfies Ctx);
      return {
        text: `O ${tid} já foi resolvido há mais de 7 dias e não dá pra reabrir — mas posso abrir um chamado novo com essas informações. Quer que eu monte o rascunho?`,
        steps: res.steps,
        cards: [{ type: "options", options: ["Sim, abrir novo chamado", "Não, obrigado"] }],
      };
    }
    if (errKind) {
      return { text: `Não consegui atualizar o ${tid}. Quer tentar de novo em instantes?`, steps: res.steps };
    }
    const data = res.data as { ticket: { id: string }; reopened: boolean };
    return {
      text: data.reopened
        ? `Reabri o ${tid} e acrescentei suas informações — ele volta para a fila com o prazo recalculado.`
        : `Atualizei o ${tid} com o que você contou — o analista vai ver na próxima atualização.`,
      steps: res.steps,
      cards: [{ type: "ticket", ticketId: tid }],
    };
  }

  // ── central de ajuda ──────────────────────────────────────────────────────

  private async helpFlow(input: AgentTurnInput, services: AgentServices, query: string): Promise<AgentResult> {
    const res = await opSearchHelp(services, query);
    const hit = (res.data as Array<{ title: string; body: string }>)[0];
    if (!hit) {
      return {
        text: "Não encontrei nada na central de ajuda sobre isso. Se for um problema de TI, me conta mais detalhes que eu abro um chamado.",
        steps: res.steps,
      };
    }
    services.store.setAgentContext(input.conversation.id, {
      pending: "post_help",
      helpQuery: query,
    } satisfies Ctx);
    return {
      text: `${hit.body}\n\nIsso responde? Se ainda estiver com problema, eu abro um chamado pra você.`,
      steps: res.steps,
      cards: [{ type: "options", options: ["Sim, resolveu", "Não resolveu — abrir chamado"] }],
    };
  }

  // ── transferência ─────────────────────────────────────────────────────────

  private async transfer(
    input: AgentTurnInput,
    services: AgentServices,
    reason: string,
  ): Promise<AgentResult> {
    const convo = services.store.conversation(input.conversation.id)!;
    const ticket = convo.ticketId ? await services.tickets.get(convo.ticketId).catch(() => null) : null;
    const queue = ticket?.priority === "critica" || ticket?.overdue ? "N2" : "N1";
    const summary = buildSummary(input, ticket?.id);
    await opTransfer(services, input.conversation, { summary, reason, queue });
    return {
      text: `Encaminhei para o Suporte ${queue}. Um analista vai falar com você em até 2 h úteis — enquanto isso, fico pausado por aqui.`,
      steps: [STEPS.transfer()],
    };
  }

  private offTopic(): AgentResult {
    return {
      text: "Sou o assistente do service desk de TI — consigo ajudar com tecnologia: equipamento, acesso, e-mail, rede e softwares. Assuntos de RH, financeiro ou facilities seguem por outros canais. Tem algo de TI em que eu possa ajudar?",
      steps: [],
    };
  }
}

// ─── detecção de intenção (heurísticas pt-BR) ────────────────────────────────

const firstName = (name: string) => name.split(" ")[0] ?? name;

const finish = (text: string, steps: AgentStep[], card?: CardPayload): AgentResult => ({
  text,
  steps,
  ...(card ? { cards: [card] } : {}),
});

function isGreeting(n: string): boolean {
  return /^(oi|ola|olá|opa|eai|e ai|bom dia|boa tarde|boa noite|hey|hello|tudo bem|tudo bom)[\s!.?]*$/.test(n.trim());
}

function isThanks(n: string): boolean {
  return /obrigad|valeu|show|perfeito|resolveu|deu certo|top/.test(n) && n.length < 60;
}

function wantsAnalyst(text: string): boolean {
  const n = normalize(text);
  return (
    /\banalist/.test(n) ||
    /\batendent/.test(n) ||
    /falar com (alguem|uma pessoa|pessoa|humano)/.test(n) ||
    /pessoa de verdade|humano/.test(n)
  );
}

function isStatusQuery(n: string): boolean {
  return (
    /status|andamento|como (esta|vai|tá|ta) (o|meu)|meu(s)? chamado|meus chamados|atualizacao do chamado|novidade/.test(n) &&
    !/abrir|criar|novo chamado/.test(n)
  );
}

function isQuestion(n: string): boolean {
  return (
    /^(como|onde|quando|qual|quanto|por que|porque|posso|consigo|tem como)/.test(n.trim()) ||
    /\?$/.test(n.trim()) ||
    /como faco|como faço|como configur|horario|onde fica|e possivel/.test(n)
  );
}

const OFFTOPIC = /ferias|salario|holerite|contra-?cheque|beneficio|vale (refeicao|alimentacao|transporte)|vr\b|vt\b|plano de saude|odontolog|ar condicionado|estacionamento|reforma|pintura|demiss|admiss|rescis|recrutamento|entrevista|aluguel|boleto|nota fiscal|reembolso|cafeteri|lanche/;

function isOffTopic(n: string): boolean {
  // só desvia se não houver marcadores claros de TI junto
  if (OFFTOPIC.test(n) && !/vpn|senha|email|e-mail|notebook|computador|sistema|rede|acesso|software|sap|teams|outlook|impressora|monitor|internet|wifi|wi-fi|login/.test(n)) {
    return true;
  }
  return false;
}

function confirmIntent(n: string): boolean {
  return /confirma|pode (abrir|criar|seguir|mandar)|cria|abre|isso|ok|perfeito|bora|manda|pode sim|sim,?\s*(pode|por favor|confirma)|^sim[.!]?$|tudo certo|esta certo|correto/.test(n) && !cancelIntent(n);
}

function cancelIntent(n: string): boolean {
  return /cancela|deixa (pra la|quieto)|esquece|nao quero|não quero|desisto|desistir|nao precisa|não precisa|descarta|descartar/.test(n);
}

function isOptionPick(input: AgentTurnInput, n: string): boolean {
  const lastAgent = [...input.history].reverse().find((m) => m.sender === "agent");
  const options =
    (lastAgent?.cards?.find((c) => c.type === "options") as { options?: string[] } | undefined)
      ?.options ?? [];
  const sn = squash(n);
  return options.some((o) => squash(o) === sn);
}

function solved(n: string): boolean {
  if (/n[aã]o (resolveu|funcionou|deu)|nao adiantou|piorou/.test(n)) return false;
  return /sim|resolveu|deu certo|funcionou|obrigad|valeu|show|perfeito/.test(n);
}

function wants(n: string): boolean {
  return /sim|pode|quero|bora|ok|isso|adiciona|acrescenta/.test(n);
}

function isSelectorPick(input: AgentTurnInput): boolean {
  const lastAgent = [...input.history].reverse().find((m) => m.sender === "agent");
  return lastAgent?.cards?.some((c) => c.type === "ticket_selector") === true;
}

function asksToOpen(n: string): boolean {
  return /abrir|abra|abre|criar|cria|novo chamado|registrar/.test(n);
}

// ── inferência de campos do chamado ─────────────────────────────────────────

const CATEGORY_MAP: Array<[RegExp, string]> = [
  [/vpn|rede|wi-?fi|internet|conex[aã]o|proxy|firewall/, "Rede e VPN"],
  [/senha|acesso|permiss[aã]o|login|logar|entrar|pasta|sharepoint|perfil|bloquead[ao]/, "Acesso"],
  [/notebook|monitor|teclado|mouse|fone|headset|impressora|terminal|equipamento|cabo|carregador|computador|desktop|tela|webcam|dock/, "Hardware"],
  [/outlook|e-?mail/, "E-mail"],
  [/software|sistema|sap|teams|excel|word|windows|app|aplicativo|programa|antiv[ií]rus|office|powerpoint|licen[cç]a/, "Software"],
];

function inferCategory(text: string): string | null {
  const n = normalize(text);
  for (const [re, cat] of CATEGORY_MAP) if (re.test(n)) return cat;
  return null;
}

const REQUEST_SIGNALS = /preciso de|quero (um|uma|solicitar|pedir)|gostaria de|solicitar|pedido|solicita[cç][aã]o|novo (monitor|notebook|teclado|fone|equipamento)|segundo monitor|licen[cç]a|acesso ao|acesso [aà]/;
const BROKEN_SIGNALS = /n[aã]o funciona|erro|travad|parou|fora do ar|lento|lentid[aã]o|quebrou|falha|falhando|bloquead|caiu|caindo|n[aã]o (abre|liga|conecta|imprime|sincroniza|reconhece|carrega|entra|acessa)|sem (acesso|sinal|som|imagem)/;

function inferKind(n: string, raw: string): TicketKind {
  const broken = BROKEN_SIGNALS.test(n);
  const request = REQUEST_SIGNALS.test(n);
  if (request && !broken) return "REQ";
  return "INC";
}

/** Impacto dito no próprio relato ("todo mundo", "minha equipe inteira"). */
function inferImpact(n: string): ImpactScope | null {
  if (
    /toda a empresa|empresa (toda|inteira)|todo mundo|ningu[eé]m.{0,25}(trabalhar|acessar|consegue|funciona)|geral|parou (para )?todos|v[aá]rias pessoas/.test(
      n,
    )
  ) {
    return "company";
  }
  if (/minha equipe|meu time|nossa equipe|nosso time|equipe (toda|inteira)|setor (todo|inteiro)/.test(n)) {
    return "team";
  }
  return null;
}

interface Urgency {
  today: boolean;
  blocks: boolean;
  workaround: boolean;
}

function detectUrgency(n: string): Urgency {
  return {
    today: /hoje|agora|urgente|j[aá]|reuni[aã]o|apresenta[cç][aã]o|deadline|at[ée] (as|a)|amanh[ãa] cedo|cliente|fechamento/.test(n),
    blocks: /n[aã]o consigo trabalhar|imposs[ií]vel trabalhar|sem conseguir trabalhar|ningu[eé]m.{0,25}trabalhar|travou tudo|nada funciona|totalmente parado|parou tudo|tudo parou|impede|sem acesso nenhum|n[aã]o abre nada/.test(n),
    workaround: /mas d[aá] pra|consigo usar|por enquanto (uso|uso o|da pra)|alternativa|celular pessoal|improvis|outro (computador|notebook|caminho|jeito)/.test(n),
  };
}

function makeTitle(report: string): string {
  const clean = report.trim().replace(/\s+/g, " ");
  if (clean.length <= 72) return clean.charAt(0).toUpperCase() + clean.slice(1);
  const cut = clean.slice(0, 72);
  const lastSpace = cut.lastIndexOf(" ");
  return (cut.slice(0, lastSpace > 40 ? lastSpace : 72) + "…").replace(/^./, (c) => c.toUpperCase());
}

function hitApplies(hit: { body: string; title: string }, n: string): boolean {
  // regra especial do seed: artigo do erro 809 só vale para Windows 10
  if (hit.title.includes("809") && (n.includes("windows 11") || n.includes("win 11"))) return false;
  return true;
}

function buildSummary(input: AgentTurnInput, ticketId?: string | null): string {
  const recent = input.history.slice(-6);
  const userBits = recent
    .filter((m) => m.sender === "user")
    .map((m) => m.text)
    .join(" · ")
    .slice(0, 400);
  const ref = ticketId ? ` Chamado: ${ticketId}.` : "";
  return `${firstName(input.user.name)} (${input.user.team || "—"}): ${userBits || input.userText}.${ref}`;
}
