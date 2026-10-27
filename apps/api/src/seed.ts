import type { Store } from "./store.js";
import type { Ticket, TicketPriority, TicketStatus } from "./domain/types.js";
import { computeDueAt } from "./domain/sla.js";

// ─── Dados de exemplo (Anexo B) ──────────────────────────────────────────────
// Idempotente: só semeia se o banco estiver vazio.

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const days = (d: number) => ago(d * 24 * 60);

export function seed(store: Store): void {
  if (store.userByEmail("ana.souza@nexo.com.br")) return;

  // ── Funcionários ──────────────────────────────────────────────────────────
  const ana = store.insertUser({
    email: "ana.souza@nexo.com.br",
    name: "Ana Souza",
    role: "employee",
    team: "Financeiro",
    supportLevel: null,
    avatarBg: "#DCE9F7",
    avatarFg: "#0062C4",
  });
  const bruno = store.insertUser({
    email: "bruno.tavares@nexo.com.br",
    name: "Bruno Tavares",
    role: "employee",
    team: "Operações",
    supportLevel: null,
    avatarBg: "#E6E1F7",
    avatarFg: "#5B3FC4",
  });
  const carla = store.insertUser({
    email: "carla.mendes@nexo.com.br",
    name: "Carla Mendes",
    role: "employee",
    team: "Comercial",
    supportLevel: null,
    avatarBg: "#F6E3D3",
    avatarFg: "#9A4A12",
  });
  const diego = store.insertUser({
    email: "diego.ramos@nexo.com.br",
    name: "Diego Ramos",
    role: "employee",
    team: "Produto",
    supportLevel: null,
    avatarBg: "#D9F0E4",
    avatarFg: "#146B43",
  });
  const elisa = store.insertUser({
    email: "elisa.prado@nexo.com.br",
    name: "Elisa Prado",
    role: "employee",
    team: "Design",
    supportLevel: null,
    avatarBg: "#FBE3EA",
    avatarFg: "#A31E51",
  });
  const fabio = store.insertUser({
    email: "fabio.nunes@nexo.com.br",
    name: "Fábio Nunes",
    role: "employee",
    team: "Jurídico",
    supportLevel: null,
    avatarBg: "#E3EAF6",
    avatarFg: "#2F4FA3",
  });
  const gabriela = store.insertUser({
    email: "gabriela.rocha@nexo.com.br",
    name: "Gabriela Rocha",
    role: "employee",
    team: "RH",
    supportLevel: null,
    avatarBg: "#F0E9D9",
    avatarFg: "#7A5B16",
  });

  // ── Analistas ─────────────────────────────────────────────────────────────
  const rafael = store.insertUser({
    email: "rafael.lima@nexo.com.br",
    name: "Rafael Lima",
    role: "analyst",
    team: "Service desk",
    supportLevel: "N2",
    avatarBg: "#DCE9F7",
    avatarFg: "#0062C4",
  });
  const joana = store.insertUser({
    email: "joana.prado@nexo.com.br",
    name: "Joana Prado",
    role: "analyst",
    team: "Service desk",
    supportLevel: "N1",
    avatarBg: "#E6E1F7",
    avatarFg: "#5B3FC4",
  });

  // Senha demo "nexo123" para todos — usada quando AUTH_ANY_PASSWORD=false.
  // Enquanto a flag está ligada (spec do desafio), qualquer senha entra.
  for (const u of [ana, bruno, carla, diego, elisa, fabio, gabriela, rafael, joana]) {
    store.setPassword(u.id, "nexo123");
  }

  // ── Central de ajuda ──────────────────────────────────────────────────────
  const articles: Array<[string, string, string, string[]]> = [
    [
      "kb-001",
      "VPN com erro 809",
      "O erro 809 indica que a conexão VPN não respondeu. No Windows 10, reinstale o cliente de VPN pelo Portal de Softwares e reinicie o computador — isso resolve na maioria dos casos. No Windows 11 ou se o erro persistir, abra um chamado: é preciso liberar a porta no firewall da estação.",
      ["vpn", "erro", "809", "windows", "conexao", "rede"],
    ],
    [
      "kb-002",
      "Horário do service desk",
      "O service desk atende de segunda a sexta, das 8h às 18h. Chamados com prioridade crítica têm plantão 24 horas, todos os dias.",
      ["horario", "atendimento", "service", "desk", "plantao", "funcionamento"],
    ],
    [
      "kb-003",
      "Senha bloqueada ou esquecida",
      "Depois de 5 tentativas erradas a senha da rede é bloqueada por 30 minutos. Para desbloquear antes disso, ou se esqueceu a senha, peça a redefinição pelo Nexo Assist ou abra um chamado de Acesso — a senha provisória vai para o seu e-mail em até 5 minutos.",
      ["senha", "bloqueada", "esqueci", "redefinir", "acesso", "login"],
    ],
    [
      "kb-004",
      "Notebook lento após atualização",
      "Se o notebook ficou lento depois de uma atualização do Windows, reinicie e rode o diagnóstico 'Desempenho' no Portal de Softwares. Se continuar lento, abra um chamado de Hardware informando quando começou — pode ser necessário reverter a atualização.",
      ["notebook", "lento", "lentidao", "atualizacao", "windows", "desempenho"],
    ],
    [
      "kb-005",
      "Wi-Fi corporativo não conecta",
      "Use a rede NEXO-CORP com seu e-mail e senha da rede. Se o certificado expirou, remova a rede nas configurações de Wi-Fi e conecte de novo. Visitantes devem usar a rede NEXO-GUEST — a senha fica na recepção.",
      ["wifi", "wi-fi", "rede", "internet", "conectar", "corporativo"],
    ],
    [
      "kb-006",
      "Outlook não sincroniza no celular",
      "Quando o Outlook para de sincronizar no celular, remova e adicione a conta novamente no app. Se o erro persistir, verifique se o app está atualizado e se o MFA foi concluído — o bloqueio costuma ser a autenticação pendente.",
      ["outlook", "email", "celular", "sincroniza", "mfa", "mobile"],
    ],
    [
      "kb-007",
      "Como pedir equipamento ou software",
      "Pedidos de equipamento (monitor, teclado, notebook novo) e de software são requisições, não incidentes. Abra um chamado do tipo Requisição descrevendo o que precisa e a justificativa — a aprovação do gestor acontece dentro do próprio chamado.",
      ["equipamento", "software", "monitor", "pedido", "requisicao", "solicitar", "notebook"],
    ],
    [
      "kb-008",
      "Impressora não imprime",
      "Verifique se a impressora está na rede NEXO-CORP (impressoras na guest não aparecem). Remova e adicione a impressora pelo caminho \\\\printserver\\nome. Fila travada? Cancele os documentos pendentes. Se continuar, abra um chamado de Hardware.",
      ["impressora", "imprimir", "fila", "print", "papel"],
    ],
    [
      "kb-009",
      "Acesso ao SAP",
      "O acesso ao SAP depende de perfil aprovado pelo gestor da área. Abra uma Requisição na categoria Acesso informando o módulo necessário (FI, MM, RH...). Depois de aprovado, o acesso é liberado em até 1 dia útil.",
      ["sap", "acesso", "perfil", "modulo", "erp"],
    ],
    [
      "kb-010",
      "E-mail caindo na quarentena",
      "Mensagens suspeitas ficam na quarentena por 15 dias. Você recebe um resumo diário às 9h; dali dá para liberar falsos positivos. Se um remetente legítimo cai sempre na quarentena, abra um chamado de E-mail para adicioná-lo à lista segura.",
      ["email", "quarentena", "spam", "mensagem", "bloqueado"],
    ],
  ];
  for (const [aid, title, body, kws] of articles) {
    store.insertArticle({ id: aid, title, body, keywords: kws });
  }

  // ── Chamados ──────────────────────────────────────────────────────────────
  const mk = (
    idT: string,
    requesterId: string,
    kind: Ticket["kind"],
    title: string,
    description: string,
    category: Ticket["category"],
    priority: TicketPriority,
    status: TicketStatus,
    createdAt: string,
    updatedAt: string,
    resolvedAt: string | null = null,
    subcategory: string | null = null,
  ): Ticket => ({
    id: idT,
    kind,
    title,
    description,
    category,
    subcategory,
    priority,
    status,
    requesterId,
    conversationId: null,
    createdAt,
    updatedAt,
    resolvedAt,
    dueAt: computeDueAt(priority, new Date(createdAt)).toISOString(),
  });

  // Ana — do protótipo: 3 abertos + 2 encerrados
  store.insertTicket(
    mk(
      "INC-20311",
      ana.id,
      "INC",
      "Notebook lento após atualização do Windows",
      "Lentidão geral desde a atualização de 15/10. Reiniciar e rodar o diagnóstico da central não resolveu.",
      "Hardware",
      "media",
      "aguardando_analista",
      days(6),
      days(5),
      null,
      "Notebook",
    ),
  );
  store.insertTicket(
    mk(
      "INC-20298",
      ana.id,
      "INC",
      "Acesso à pasta Financeiro no SharePoint",
      "Sem permissão na pasta Financeiro desde a migração de sexta. Preciso dela para o fechamento do mês.",
      "Acesso",
      "alta",
      "em_andamento",
      days(4),
      ago(60 * 26),
    ),
  );
  store.insertTicket(
    mk(
      "REQ-10442",
      ana.id,
      "REQ",
      "Segundo monitor para home office",
      "Requisição de um segundo monitor 24\" para a estação de home office, aprovada pelo gestor.",
      "Hardware",
      "baixa",
      "aprovado",
      days(13),
      days(7),
    ),
  );
  store.insertTicket(
    mk(
      "INC-19877",
      ana.id,
      "INC",
      "Outlook não sincroniza no celular",
      "O Outlook parou de sincronizar no celular após troca de senha. Resolvido recriando a conta no app.",
      "E-mail",
      "media",
      "resolvido",
      days(55),
      days(55),
      days(55),
    ),
  );
  store.insertTicket(
    mk(
      "INC-19410",
      ana.id,
      "INC",
      "Troca de senha da rede",
      "Senha da rede expirada — redefinida com o service desk.",
      "Acesso",
      "baixa",
      "resolvido",
      days(108),
      days(108),
      days(108),
    ),
  );

  // Bruno — chamado crítico em aberto (para conversa "agent pediu ajuda")
  store.insertTicket(
    mk(
      "INC-20501",
      bruno.id,
      "INC",
      "Terminal da expedição fora do ar",
      "O terminal de coleta da expedição não liga desde a manhã — 6 pessoas paradas.",
      "Hardware",
      "critica",
      "em_andamento",
      ago(120),
      ago(30),
    ),
  );

  // Carla — chamado de acesso
  store.insertTicket(
    mk(
      "REQ-10510",
      carla.id,
      "REQ",
      "Acesso ao SAP — módulo Comercial",
      "Preciso de acesso de leitura ao módulo Comercial do SAP para acompanhar pedidos ainda hoje.",
      "Acesso",
      "alta",
      "aberto",
      ago(90),
      ago(90),
    ),
  );

  // Elisa — chamado recente criado pelo agent
  store.insertTicket(
    mk(
      "INC-20519",
      elisa.id,
      "INC",
      "Fone USB não reconhecido no Teams",
      "O fone USB-C para de aparecer no Teams depois de alguns minutos em chamada.",
      "Hardware",
      "media",
      "aberto",
      ago(10),
      ago(10),
    ),
  );

  // Gabriela — resolvido ontem
  store.insertTicket(
    mk(
      "REQ-10502",
      gabriela.id,
      "REQ",
      "Senha do Wi-Fi para visitantes",
      "Enviada a senha da rede NEXO-GUEST para recepção de visitantes.",
      "Rede e VPN",
      "baixa",
      "resolvido",
      days(1.2),
      days(1),
      days(1),
    ),
  );

  // ── Conversas de exemplo para o console ───────────────────────────────────

  // Carla — transferida, aguardando atendente (prioridade alta, SLA correndo)
  const convCarla = store.createConversation(carla.id);
  store.setConversationStatus(convCarla.id, "waiting_analyst", {
    queue: "N1",
    handoffSummary:
      "Funcionária precisa de acesso ao módulo Comercial do SAP ainda hoje. REQ-10510 aberto em aberto com prioridade alta.",
    handoffReason: "pedido do funcionário",
    handoffAt: ago(35),
    ticketId: "REQ-10510",
  });
  store.addMessage({
    conversationId: convCarla.id,
    sender: "user",
    senderId: carla.id,
    text: "Preciso de acesso ao SAP ainda hoje",
    createdAt: ago(37),
  });
  store.addMessage({
    conversationId: convCarla.id,
    sender: "agent",
    text: "Vi que você já tem a requisição REQ-10510 em aberto. Como é para hoje, vou chamar um analista para destravar isso agora — pode ser?",
    steps: [{ label: "consultou seus chamados" }],
    createdAt: ago(36),
  });
  store.addMessage({
    conversationId: convCarla.id,
    sender: "user",
    senderId: carla.id,
    text: "Pode sim, por favor",
    createdAt: ago(35.5),
  });
  store.addMessage({
    conversationId: convCarla.id,
    sender: "agent",
    text: "Encaminhei para o Suporte N1. Um analista fala com você em instantes — fique por aqui.",
    steps: [{ label: "transferiu para um analista" }],
    createdAt: ago(35),
  });
  store.addMessage({
    conversationId: convCarla.id,
    sender: "system",
    text: `Transferida para Suporte N1`,
    createdAt: ago(35),
  });
  store.bumpUnread(convCarla.id, 1);

  // Bruno — transferida pelo agent por baixa confiança
  const convBruno = store.createConversation(bruno.id);
  store.setConversationStatus(convBruno.id, "waiting_analyst", {
    queue: "N2",
    handoffSummary:
      "Terminal da expedição fora do ar afetando 6 pessoas (INC-20501, crítica). O agent não teve segurança para orientar o procedimento remoto.",
    handoffReason: "o agent não teve segurança para decidir",
    handoffAt: ago(52),
    ticketId: "INC-20501",
  });
  store.addMessage({
    conversationId: convBruno.id,
    sender: "user",
    senderId: bruno.id,
    text: "O terminal da expedição não liga e já tentei de tudo",
    createdAt: ago(54),
  });
  store.addMessage({
    conversationId: convBruno.id,
    sender: "agent",
    text: "Vou chamar um analista para isso — é um caso que precisa de acesso físico ao equipamento e eu prefiro não arriscar um procedimento errado.",
    steps: [
      { label: "consultou seus chamados" },
      { label: "buscou na central de ajuda" },
      { label: "transferiu para um analista" },
    ],
    createdAt: ago(52),
  });
  store.bumpUnread(convBruno.id, 2);

  // Diego — conversa com o agent (ativa)
  const convDiego = store.createConversation(diego.id);
  store.addMessage({
    conversationId: convDiego.id,
    sender: "user",
    senderId: diego.id,
    text: "O Teams caiu no meio da daily, o que eu faço?",
    createdAt: ago(4),
  });
  store.addMessage({
    conversationId: convDiego.id,
    sender: "agent",
    text: "Vi que o Teams de toda a empresa está instável agora — já existe um incidente aberto com prioridade crítica. Quer que eu te avise quando normalizar, ou prefere abrir um chamado para o seu caso?",
    steps: [{ label: "consultou seus chamados" }, { label: "buscou na central de ajuda" }],
    createdAt: ago(3.5),
  });

  // Elisa — conversa com o agent, chamado criado
  const convElisa = store.createConversation(elisa.id);
  store.linkTicket(convElisa.id, "INC-20519");
  store.addMessage({
    conversationId: convElisa.id,
    sender: "user",
    senderId: elisa.id,
    text: "Meu fone USB some do Teams no meio das calls",
    createdAt: ago(11),
  });
  store.addMessage({
    conversationId: convElisa.id,
    sender: "agent",
    text: "Pronto: abri o chamado INC-20519 com prioridade média. O service desk responde em até 3 dias úteis.",
    steps: [
      { label: "consultou seus chamados" },
      { label: "montou o rascunho" },
      { label: "criou o INC-20519" },
    ],
    cards: [{ type: "ticket", ticketId: "INC-20519" }],
    createdAt: ago(10),
  });

  // Fábio — resolvida pelo agent
  const convFabio = store.createConversation(fabio.id);
  store.setConversationStatus(convFabio.id, "closed", { closedAt: ago(20) });
  store.addMessage({
    conversationId: convFabio.id,
    sender: "user",
    senderId: fabio.id,
    text: "Não consigo imprimir no andar 3",
    createdAt: ago(26),
  });
  store.addMessage({
    conversationId: convFabio.id,
    sender: "agent",
    text: "A fila da impressora do andar 3 estava travada — cancelei os documentos pendentes. Tenta de novo e me fala se saiu?",
    steps: [{ label: "buscou na central de ajuda" }],
    createdAt: ago(24),
  });
  store.addMessage({
    conversationId: convFabio.id,
    sender: "user",
    senderId: fabio.id,
    text: "Isso resolveu, obrigado!",
    createdAt: ago(21),
  });
}
