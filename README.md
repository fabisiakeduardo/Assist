# Nexo Assist

Agent de service desk de TI para ~2.000 funcionários: responde dúvidas de TI,
busca na central de ajuda, abre/atualiza chamados **somente após confirmação**,
evita duplicados, calcula prioridade/SLA e transfere para analistas quando
precisa — com interface de funcionário e console de atendente fiéis ao
protótipo do Anexo C.

## Como rodar

Pré-requisito: **Node ≥ 22.5** (a API usa `node:sqlite`, embutido — zero deps
nativas). Desenvolvido e testado no Node 26.

```bash
npm install
npm run dev        # sobe API (:4100) + web (:5100) juntos
```

ou separado:

```bash
npm run dev:api    # http://localhost:4100
npm run dev:web    # http://localhost:5100
```

Abra `http://localhost:5100`:

| Papel        | Login                        | Tela      |
| ------------ | ---------------------------- | --------- |
| Funcionária  | `ana.souza@nexo.com.br`      | `/chat`   |
| Analista N2  | `rafael.lima@nexo.com.br`    | `/console` |

Qualquer senha funciona (demo). O banco SQLite é criado e semeado em
`apps/api/data/nexo.db` na primeira execução — apague-o para re-seed.

```bash
npm test           # vitest (41 testes: SLA, engine, rotas)
npm run typecheck  # tsc nos dois apps
npm run build      # build de produção
```

## O que o agent faz (Anexo A)

- **Escopo só de TI** — RH/financeiro/facilities são redirecionados com jeito.
- **Central de ajuda primeiro** — busca lexical sobre os artigos; só pergunta
  "resolveu?" e oferece abrir chamado.
- **Rascunho + confirmação** — nunca cria/atualiza chamado sem o funcionário
  confirmar (botão ou "pode criar" no texto).
- **Dedup** — chamado aberto sobre o mesmo assunto → oferece acrescentar info
  no existente em vez de duplicar. Resolvido há ≤7 dias reabre com a update.
- **Prioridade/SLA** — matriz: empresa/equipe parada = crítica (1h corrida),
  uma pessoa bloqueada ou compromisso hoje = alta (4h úteis), workaround =
  média (3 dias úteis), pedido sem urgência = baixa (5 dias úteis). Horário
  útil seg–sex 08–18h.
- **Transferência** — pedido explícito, urgência ou baixa confiança →
  `waiting_analyst` com resumo do caso; **o agent pausa** enquanto o analista
  atende e volta quando ele devolve.
- **Privacidade** — chamado só é detalhado para quem abriu.
- **Transparência** — cada resposta carrega `steps` ("consultou seus chamados",
  "buscou na central de ajuda", "calculou o prazo"…) exibidos na UI.
- **Limite de uso** — 30 mensagens/dia por funcionário (429 depois disso).

## Arquitetura

```
apps/
  api/   Fastify + node:sqlite   — auth, conversas, rascunhos, SSE, console
    src/
      domain/    tipos, SLA (horário útil), normalização pt-BR
      agent/     AgentEngine (interface), tools compartilhadas,
                 scripted.ts (determinístico), mastra.ts (LLM)
      services/  TicketService (legado simulado c/ caos+retry),
                 HelpCenter, AgentRunner (fila por conversa), draftActions
      db.ts      schema + migração (node:sqlite)
      store.ts   mapeadores + persistência
      routes.ts  REST + SSE
  web/   Vite + React + TS       — SPA fiel ao protótipo
    src/pages     Login / EmployeeChat / Profile / Console
    src/components Cards (draft, ticket, seletor, opções), Shell, ícones
    src/styles.css tokens do .pen (cores, raios, tipografia)
```

### Decisões-chave

- **Duas engines, uma interface.** `AgentEngine.run(input, services, emit)`
  produz `{text, steps, cards}` para `ScriptedEngine` (regex/heurísticas
  determinísticas + máquina de estados em `agent_context`) e `MastraEngine`
  (Mastra `Agent` + `createTool` zod + stream de deltas). `AGENT_ENGINE=auto`
  usa Mastra se houver chave, senão scripted — a demo roda 100% offline.
- **Tools compartilhadas.** As mesmas operações (`opSearchHelp`,
  `opCheckDuplicates`, `opBuildDraft`, `opAddTicketInfo`, `opTransfer`…) são
  chamadas pelo scripted e expostas como tools ao LLM — comportamento
  idêntico, só muda quem dirige a conversa.
- **`TicketService` como fronteira do "legado".** O agent nunca toca o banco
  para chamados: passa por um serviço que simula latência/503s
  (`TICKETS_CHAOS_RATE`) e as tools fazem retry com backoff — como seria com
  um sistema real.
- **Estado da conversa em `agent_context`.** O que o scripted precisa lembrar
  entre turnos (rascunho em curso, pergunta pendente, ticket para anotação)
  fica persistido na conversa — restart não perde o fio.
- **Fila por conversa.** `AgentRunner` serializa turnos por `conversationId` —
  duas mensagens rápidas não disputam contexto.
- **SSE** para streaming (steps + deltas + mensagem final) e para o console
  (`conversations_changed` revalida a lista).
- **`node:sqlite` em vez de better-sqlite3** — zero build nativo (Windows),
  transações síncronas e WAL persistindo tudo em um arquivo.
- **Vite SPA em vez de Next.js** — o PRD sugere "Next.js ou React"; sem SSR
  necessário, Vite é mais leve e o proxy `/api` resolve dev.

### Trade-offs assumidos

- Busca da central de ajuda é lexical (keywords + Jaccard) — previsível para
  ~10 artigos; trocável por embeddings atrás da mesma interface.
- Auth é demo (cookie de sessão, qualquer senha). A fronteira já isola
  `requireUser`/`requireEmployee`/`requireAnalyst` para plugar SSO real.
- Dedup é por similaridade de título+categoria do mesmo solicitante —
  conservadora (threshold 0.34) para não fundir assuntos distintos.
- O scripted engine cobre os fluxos do desafio; para conversas abertas de
  verdade, `AGENT_ENGINE=mastra` + `OPENAI_API_KEY` liga o LLM.

## Variáveis de ambiente

Veja `.env.example` (copie para `apps/api/.env`). Principais:

| Var                  | Padrão                 | Uso                                        |
| -------------------- | ---------------------- | ------------------------------------------ |
| `AGENT_ENGINE`       | `auto`                 | `mastra` · `scripted` · `auto`             |
| `LLM_MODEL`          | `openai/gpt-4o-mini`   | modelo do engine Mastra                    |
| `OPENAI_API_KEY` …   | —                      | chave do provider (ativa o modo Mastra)    |
| `PORT`               | `4100`                 | porta da API                               |
| `DATABASE_FILE`      | `./data/nexo.db`       | arquivo SQLite                             |
| `TICKETS_CHAOS_RATE` | `0.12`                 | instabilidade do legado (0 = desligado)    |
| `DAILY_MESSAGE_LIMIT`| `30`                   | mensagens/dia por funcionário              |

## Rotas principais

```
POST /auth/login                      GET  /me
GET  /conversations/current           GET  /conversations/:id
POST /conversations/:id/messages      GET  /conversations/:id/stream (SSE)
POST /conversations/:id/drafts/:draftId/confirm | /cancel
GET  /tickets                         GET  /tickets/:id
GET  /console/conversations?filter=…&q=…        GET /console/stream (SSE)
POST /conversations/:id/assume | /release | /close
GET  /console/users/:userId/tickets
```
