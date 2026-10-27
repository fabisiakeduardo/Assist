import type { Store } from "../src/store.js";
import type { Conversation, User } from "../src/domain/types.js";

// ─── Cenários de avaliação do agent ──────────────────────────────────────────
// Cada cenário é uma sequência de mensagens do funcionário e expectativas por
// turno (texto, passos/tools, cards e efeitos no banco). Rodam contra o
// ScriptedEngine — determinístico, então o resultado é reproduzível em CI.

export interface CheckCtx {
  store: Store;
  conv: Conversation;
  user: User;
}

export interface TurnExpect {
  /** trechos/padrões que DEVEM aparecer na resposta do agent */
  text?: Array<RegExp | string>;
  /** padrões que NÃO podem aparecer */
  notText?: Array<RegExp | string>;
  /** tools que devem constar nos passos (transparência) */
  tools?: string[];
  /** tipo de card esperado no turno */
  card?: "options" | "ticket" | "ticket_selector" | "draft";
  /** efeito colateral esperado — retorna true ou a descrição da falha */
  check?: (ctx: CheckCtx) => true | string;
}

export interface ScenarioTurn {
  user: string;
  expect?: TurnExpect;
}

export interface Scenario {
  id: string;
  title: string;
  /** o que o cenário cobre — aparece no relatório */
  covers: string;
  /** prepara o banco antes do primeiro turno (ex.: marcar chamado resolvido) */
  setup?: (store: Store) => void;
  turns: ScenarioTurn[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "help-first",
    title: "Central de ajuda antes de abrir chamado",
    covers: "pergunta how-to → artigo da central + oferta, sem rascunho ainda",
    turns: [
      {
        user: "Como configuro a VPN da empresa no celular?",
        expect: {
          tools: ["buscar_ajuda"],
          card: "options",
          text: [/resolve|central|ajuda|passo/i],
          check: ({ store, conv }) =>
            store.pendingDraftFor(conv.id) === null
              ? true
              : "rascunho criado antes da hora — a ajuda devia vir primeiro",
        },
      },
      {
        user: "Sim, resolveu",
        expect: { text: [/precisar|chamar|por aqui/i] },
      },
    ],
  },
  {
    id: "intake-confirm",
    title: "Relato → impacto → rascunho → confirmação → chamado",
    covers: "intake com dedup + ajuda, prioridade 'alta' por compromisso hoje, criação só após confirmar",
    turns: [
      {
        user: "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.",
        expect: { tools: ["buscar_ajuda"], text: [/809|VPN/] },
      },
      { user: "Não resolveu — abrir chamado", expect: { text: [/afetado/], card: "options" } },
      {
        user: "Só eu. Tenho reunião com um cliente às 14h e preciso da VPN.",
        expect: {
          card: "draft",
          tools: ["montar_rascunho"],
          text: [/alta/i],
        },
      },
      {
        user: "Sim, pode criar",
        expect: {
          tools: ["criar_chamado"],
          card: "ticket",
          text: [/abri o chamado/i],
          check: ({ store, conv }) =>
            store.conversation(conv.id)!.ticketId
              ? true
              : "nenhum chamado foi vinculado à conversa",
        },
      },
    ],
  },
  {
    id: "dedup",
    title: "Deduplicação oferece atualizar chamado existente",
    covers: "regra do Anexo A — não duplicar chamado aberto do mesmo assunto",
    turns: [
      {
        user: "A pasta Financeiro do SharePoint continua sem acesso pra mim",
        expect: {
          tools: ["verificar_duplicidade"],
          text: [/já tem um chamado|INC-20298/],
          card: "options",
        },
      },
      {
        user: "Sim, adicionar lá",
        expect: {
          tools: ["atualizar_chamado"],
          text: [/Atualizei|acrescent/i],
          check: ({ store }) =>
            store.ticketEvents("INC-20298").some((e) => /SharePoint|acesso/i.test(e.text))
              ? true
              : "nenhum evento foi acrescentado ao INC-20298",
        },
      },
    ],
  },
  {
    id: "privacy",
    title: "Chamado de outra pessoa não é revelado",
    covers: "privacidade — funcionário só enxerga os próprios chamados",
    turns: [
      {
        user: "Como está o INC-20501?",
        expect: {
          text: [/chamados que você abriu/i],
          notText: [/expedição|fora do ar/i],
          tools: ["detalhar_chamado"],
        },
      },
    ],
  },
  {
    id: "sla-critical",
    title: "Empresa parada → prioridade crítica",
    covers: "matriz de prioridade — impacto company + bloqueio = crítica (SLA 1h)",
    turns: [
      {
        // o relato já diz quem é afetado — o agent vai direto ao rascunho
        user: "O sistema SAP caiu pra todo mundo — ninguém da empresa consegue trabalhar",
        expect: {
          card: "draft",
          text: [/cr[ií]tica/i],
          check: ({ store, conv }) => {
            const d = store.pendingDraftFor(conv.id);
            return d?.priority === "critica"
              ? true
              : `prioridade do rascunho = ${d?.priority ?? "nenhum rascunho"}`;
          },
        },
      },
      {
        user: "Sim, pode criar",
        expect: { tools: ["criar_chamado"], card: "ticket" },
      },
    ],
  },
  {
    id: "transfer",
    title: "Pedido explícito transfere e pausa o agent",
    covers: "transferência com resumo + status waiting_analyst",
    turns: [
      {
        user: "Quero falar com um analista",
        expect: {
          tools: ["transferir_analista"],
          text: [/analista|Suporte N/i],
          check: ({ store, conv }) => {
            const c = store.conversation(conv.id)!;
            return c.status === "waiting_analyst" && c.handoffSummary
              ? true
              : `status=${c.status}, resumo=${c.handoffSummary ?? "ausente"}`;
          },
        },
      },
    ],
  },
  {
    id: "resolved-old",
    title: "Chamado resolvido há >7 dias → oferece novo (não reabre)",
    covers: "janela de reabertura do Anexo A — fora dela, novo rascunho",
    turns: [
      {
        user: "Como está o INC-19877?",
        expect: { text: [/resolvido/], tools: ["detalhar_chamado"] },
      },
      { user: "Adicionar informação", expect: { text: [/acrescent/i] } },
      {
        user: "O Outlook parou de sincronizar de novo hoje de manhã",
        expect: {
          text: [/mais de 7 dias/i],
          card: "options",
          tools: ["atualizar_chamado"],
          check: ({ store }) =>
            store.ticket("INC-19877")!.status === "resolvido"
              ? true
              : "INC-19877 foi reaberto indevidamente",
        },
      },
      {
        user: "Sim, abrir novo chamado",
        expect: { text: [/afetado|rascunho/i] },
      },
    ],
  },
  {
    id: "resolved-recent",
    title: "Chamado resolvido há ≤7 dias reabre com a nota",
    covers: "janela de reabertura — dentro dela, reabre e recalcula prazo",
    setup: (s) =>
      s.updateTicket("REQ-10442", {
        status: "resolvido",
        resolvedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
    turns: [
      { user: "Como está o REQ-10442?", expect: { text: [/resolvido/] } },
      { user: "Adicionar informação", expect: { text: [/acrescent/i] } },
      {
        user: "O monitor chegou mas veio sem o cabo DisplayPort",
        expect: {
          text: [/Reabri/i],
          check: ({ store }) =>
            store.ticket("REQ-10442")!.status === "aberto" ? true : "REQ-10442 não reabriu",
        },
      },
    ],
  },
  {
    id: "off-topic",
    title: "Assunto fora de TI é redirecionado",
    covers: "escopo — RH/financeiro/facilities não entram no service desk",
    turns: [
      {
        user: "Quando sai o pagamento e o vale refeição deste mês?",
        expect: {
          text: [/TI|tecnologia|service desk/i],
          notText: [/chamado criado|abri o chamado/i],
        },
      },
    ],
  },
  {
    id: "draft-pending-status",
    title: "Pergunta de status com rascunho pendente não vira correção",
    covers: "estado — intenção clara nova não é engolida pelo rascunho",
    turns: [
      {
        user: "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.",
        expect: { card: "options" },
      },
      { user: "Não resolveu — abrir chamado", expect: { text: [/afetado/] } },
      { user: "Só eu.", expect: { card: "draft" } },
      {
        user: "Como estão meus chamados?",
        expect: {
          card: "ticket_selector",
          text: [/rascunho/i],
        },
      },
    ],
  },
  {
    id: "win11-809",
    title: "Windows 11 + erro 809 não oferece artigo do Win10",
    covers: "filtro de aplicabilidade da central — o artigo só cobre Windows 10",
    turns: [
      {
        user: "Meu notebook com Windows 11 mostra erro 809 na VPN",
        expect: {
          notText: [/resolve na maioria/i],
          text: [/afetado/],
        },
      },
    ],
  },
];
