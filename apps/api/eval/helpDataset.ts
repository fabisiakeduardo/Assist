// ─── Dataset de relevância da central de ajuda ──────────────────────────────
// Cenários temáticos com consultas (paráfrases inclusas) e os ids de artigo
// aceitos como resposta correta. Alimenta a avaliação de relevância que roda
// junto do `npm run eval` — mede hit@1, hit@3 e MRR por cenário.

export interface HelpEvalQuery {
  q: string;
  /** ids de artigo considerados corretos para a consulta */
  expect: string[];
}

export interface HelpEvalScenario {
  id: string;
  title: string;
  queries: HelpEvalQuery[];
}

export const HELP_EVAL_SCENARIOS: HelpEvalScenario[] = [
  {
    id: "vpn-809",
    title: "VPN / erro 809",
    queries: [
      { q: "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.", expect: ["kb-001"] },
      { q: "vpn caindo com erro 809 no windows", expect: ["kb-001"] },
      { q: "conexão vpn não responde", expect: ["kb-001", "kb-005"] },
    ],
  },
  {
    id: "horario",
    title: "Horário de atendimento",
    queries: [
      { q: "qual o horário de atendimento do service desk?", expect: ["kb-002"] },
      { q: "até que horas o suporte funciona?", expect: ["kb-002"] },
    ],
  },
  {
    id: "senha",
    title: "Senha bloqueada / esquecida",
    queries: [
      { q: "minha senha da rede foi bloqueada depois de várias tentativas", expect: ["kb-003"] },
      { q: "esqueci minha senha, como redefinir", expect: ["kb-003"] },
      { q: "credencial travada, não consigo logar", expect: ["kb-003", "kb-009"] },
    ],
  },
  {
    id: "lento",
    title: "Notebook lento pós-update",
    queries: [
      { q: "notebook muito lento depois da atualização do windows", expect: ["kb-004"] },
      { q: "computador travando e pesado desde o update", expect: ["kb-004"] },
    ],
  },
  {
    id: "wifi",
    title: "Wi-Fi corporativo",
    queries: [
      { q: "o wi-fi da empresa não conecta de jeito nenhum", expect: ["kb-005"] },
      { q: "internet sem fio não funciona no meu notebook", expect: ["kb-005"] },
    ],
  },
  {
    id: "outlook-cel",
    title: "Outlook no celular",
    queries: [
      { q: "o outlook parou de sincronizar no celular", expect: ["kb-006"] },
      { q: "não chegam e-mails novos no app do telefone", expect: ["kb-006", "kb-010"] },
    ],
  },
  {
    id: "pedido",
    title: "Pedido de equipamento/software",
    queries: [
      { q: "como faço para pedir um segundo monitor", expect: ["kb-007"] },
      { q: "quero solicitar uma licença de software", expect: ["kb-007"] },
    ],
  },
  {
    id: "impressora",
    title: "Impressora",
    queries: [
      { q: "a impressora do andar não imprime nada", expect: ["kb-008"] },
      { q: "fila de impressão travada, mando imprimir e não sai", expect: ["kb-008"] },
    ],
  },
  {
    id: "sap",
    title: "Acesso ao SAP",
    queries: [
      { q: "como consigo acesso ao SAP?", expect: ["kb-009"] },
      { q: "preciso do perfil para o módulo FI do erp", expect: ["kb-009"] },
    ],
  },
  {
    id: "quarentena",
    title: "E-mail na quarentena",
    queries: [
      { q: "e-mails de um fornecedor válido estão caindo na quarentena", expect: ["kb-010"] },
      { q: "mensagens legítimas indo para o spam", expect: ["kb-010"] },
    ],
  },
];
