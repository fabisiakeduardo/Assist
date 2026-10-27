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

**Demo:** qualquer senha funciona (`AUTH_ANY_PASSWORD=true`, exigência do
desafio). Com `AUTH_ANY_PASSWORD=false` a senha real é validada (scrypt +
comparação em tempo constante) — a senha semeada para todos os usuários é
`nexo123`. Há throttle de 10 tentativas de login a cada 5 min por IP.

O banco SQLite é criado e semeado em `apps/api/data/nexo.db` na primeira
execução — `npm run db:reset` apaga e re-seeda.

```bash
npm test           # vitest — 46 testes (SLA, fluxos do agent, rotas HTTP)
npm run eval       # 11 cenários de conversa → relatório em apps/api/eval/EVAL.md
npm run typecheck  # tsc nos dois apps
npm run build      # build de produção (api dist/ + web dist/)
```

## Deploy (modo produção)

`npm run build && node apps/api/dist/index.js` — a API serve o front em
`apps/web/dist` (SPA fallback) e expõe as rotas sob `/api`. Um `Dockerfile`
multi-stage gera a imagem única; `.dockerignore` exclui node_modules/dbs.
Headers de segurança via `@fastify/helmet` (CSP same-origin, SSE ok).

## Roteiro de demo (3 min)

1. **Login como Ana** → "Meu notebook não conecta na VPN desde ontem. Erro 809."
   → o agent busca na central, mostra o artigo e pergunta se resolveu.
2. "Não resolveu — abrir chamado" → pergunta de impacto com opções rápidas →
   rascunho com prioridade/SLA → **Confirmar** cria o INC.
3. Repita o mesmo relato → o agent detecta o chamado aberto e oferece
   **atualizar em vez de duplicar**.
4. "Como está o INC-19877?" → resolvido há 55 dias → "Adicionar informação"
   mostra a regra dos 7 dias virando oferta de **novo** chamado.
5. "Quero falar com um analista" → conversa aparece "Para você" no console.
6. **Login como Rafael** → assume, vê os passos do agent acima das respostas,
   responde, "Devolver ao agent" → o Nexo se reapresenta para a Ana.
7. Clique nos chips de passos → detalhe inspecionável (tool + latência). Em
   `TICKETS_CHAOS_RATE=0.5` as retries do legado aparecem ao vivo.

## O que o agent faz (Anexo A)

- **Escopo só de TI** — RH/financeiro/facilities são redirecionados com jeito.
- **Central de ajuda primeiro** — busca lexical sobre os artigos; só pergunta
  "resolveu?" e oferece abrir chamado. **Exceção:** crise (empresa/equipe
  parada) vai direto ao rascunho — FAQ não é resposta para outage.
- **Rascunho + confirmação** — nunca cria/atualiza chamado sem o funcionário
  confirmar (botão ou "pode criar" no texto). Rascunho pendente não engole
  intenções novas (ex.: "como estão meus chamados?" responde o status e o
  rascunho continua esperando).
- **Dedup** — chamado aberto sobre o mesmo assunto → oferece acrescentar info
  no existente em vez de duplicar. Resolvido há ≤7 dias reabre com a update;
  **>7 dias → explica a regra e oferece chamado novo**.
- **Prioridade/SLA** — matriz: empresa/equipe parada = crítica (1h corrida),
  uma pessoa bloqueada ou compromisso hoje = alta (4h úteis), workaround =
  média (3 dias úteis), pedido sem urgência = baixa (5 dias úteis). Horário
  útil seg–sex 08–18h. O relato já pode trazer o impacto ("caiu pra todo
  mundo") — o agent vai direto ao rascunho.
- **Transferência** — pedido explícito, urgência ou baixa confiança →
  `waiting_analyst` com resumo do caso; **o agent pausa** enquanto o analista
  atende e **se reapresenta** quando ele devolve.
- **Privacidade** — chamado só é detalhado para quem abriu.
- **Transparência** — cada resposta carrega `steps` estruturados:
  rótulo + tool + latência medida + detalhe. Chips são expansíveis na UI,
  aparecem no console do analista e **retries do legado chegam ao vivo via SSE**.
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
      store.ts   mapeadores + persistência (+ senha scrypt)
      routes.ts  REST + SSE (montadas sob /api)
    eval/        scenarios.ts + run.ts → EVAL.md
  web/   Vite + React + TS       — SPA fiel ao protótipo
    src/pages     Login / EmployeeChat / Profile / Console
    src/components Cards, Shell, ícones, StepsLine (chips expansíveis)
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
  (`TICKETS_CHAOS_RATE`) e as tools fazem retry com backoff **visível** —
  cada tentativa vira um passo no stream e fica persistida na mensagem.
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
- **Rotas sob `/api` em dev e prod** — mesmo caminho nos dois modos; em
  produção a própria API serve o build do front (deploy de um serviço só).
- **Auth real atrás de flag** — o desafio pede "qualquer senha"; implementei
  scrypt de verdade + throttle e deixei o comportamento demo atrás de
  `AUTH_ANY_PASSWORD`, documentado em vez de fingido.

### Trade-offs assumidos

- Busca da central de ajuda é lexical (keywords + Jaccard) — previsível para
  ~10 artigos; trocável por embeddings atrás da mesma interface.
- Dedup é por similaridade de título+categoria do mesmo solicitante —
  conservadora (threshold 0.34) para não fundir assuntos distintos.
- O scripted engine cobre os fluxos do desafio; para conversas abertas de
  verdade, `AGENT_ENGINE=mastra` + chave do provider liga o LLM.
- O sistema de chamados é simulado in-process; a fronteira `TicketService`
  já isola onde um cliente HTTP real entraria.

## Qualidade

- **46 testes vitest**: SLA em horário útil (20), fluxos do agent fim-a-fim
  contra banco em memória (17 — intake, dedup, privacidade, reabertura,
  transparência de passos, retry do legado) e rotas HTTP (9 — auth, 401/403,
  limite diário, confirm de rascunho).
- **11 cenários de avaliação** (`npm run eval`): conversas multi-turno com
  assertivas de texto, tools, cards e efeitos no banco → `apps/api/eval/EVAL.md`.
- **CI** (`.github/workflows/ci.yml`): typecheck + testes + avaliação + build.

## Variáveis de ambiente

Veja `.env.example` (copie para `apps/api/.env`). Principais:

| Var                  | Padrão                    | Uso                                        |
| -------------------- | ------------------------- | ------------------------------------------ |
| `AGENT_ENGINE`       | `auto`                    | `mastra` · `scripted` · `auto`             |
| `LLM_MODEL`          | `google/gemini-2.5-flash` | modelo do engine Mastra (router)           |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` | — | chave do provider (ativa o modo Mastra) |
| `AUTH_ANY_PASSWORD`  | `true`                    | `false` = valida scrypt (senha `nexo123`)  |
| `PORT`               | `4100`                    | porta da API                               |
| `DATABASE_FILE`      | `./data/nexo.db`          | arquivo SQLite                             |
| `TICKETS_CHAOS_RATE` | `0.12`                    | instabilidade do legado (0 = desligado)    |
| `DAILY_MESSAGE_LIMIT`| `30`                      | mensagens/dia por funcionário              |

## Rotas principais (todas sob `/api`)

```
POST /api/auth/login                      GET  /api/me
GET  /api/conversations/current           GET  /api/conversations/:id
POST /api/conversations/:id/messages      GET  /api/conversations/:id/stream (SSE)
POST /api/conversations/:id/drafts/:draftId/confirm | /cancel
GET  /api/tickets                         GET  /api/tickets/:id
GET  /api/console/conversations?filter=…&q=…    GET  /api/console/stream (SSE)
POST /api/conversations/:id/assume | /release | /close
GET  /api/console/users/:userId/tickets
GET  /health (fora do /api, p/ healthcheck de plataforma)
```

## Com mais tempo (roadmap)

- **Embeddings na central de ajuda** + avaliação de relevância por cenário.
- **Telemetria de tokens/custo** por turno do Mastra na meta da mensagem.
- **Escalonamento automático** por SLA vencido (job que re-transfere para N2).
- **SSO real** (OIDC) no lugar do cookie de sessão — a fronteira de guards
  já está isolada.
- **A11y auditada** (axe) e testes de UI com Playwright.
