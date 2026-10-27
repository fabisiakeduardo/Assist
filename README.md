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
npm test           # vitest — 76 testes (SLA, fluxos do agent, OIDC, escalonamento, rotas HTTP)
npm run eval       # 11 cenários de conversa → relatório em apps/api/eval/EVAL.md
npm run eval:help  # relevância da busca da central (lexical vs embeddings) → mesma EVAL.md
npm run typecheck  # tsc nos dois apps
npm run build      # build de produção (api dist/ + web dist/)
npm run test:e2e   # Playwright + axe — sobe API+Vite e dirige um Chromium (10 specs)
```

Para o `test:e2e`, instale o navegador uma vez: `npx playwright install chromium`.

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
- **Central de ajuda primeiro** — busca **híbrida**: lexical + embeddings
  locais (n-gramas + IDF + sinônimos do domínio, determinística e offline);
  só pergunta "resolveu?" e oferece abrir chamado. `HELP_SEARCH_MODE=lexical`
  volta ao modo antigo. **Exceção:** crise (empresa/equipe parada) vai direto
  ao rascunho — FAQ não é resposta para outage.
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
- **Telemetria de LLM** — no motor Mastra, cada mensagem carrega `meta` com
  engine, modelo, uso de tokens (entrada/saída/cached/reasoning) e **custo
  estimado em USD** por tabela de preços — visível discretamente no console.
- **Escalonamento por SLA** — um job (`ESCALATION_INTERVAL_SEC`) re-transfere
  para **N2** conversas `waiting_analyst` cujo chamado vinculado venceu o prazo
  ou que esperam além de `ESCALATION_WAIT_MINUTES`: grava mensagem de sistema,
  evento no histórico do chamado e atualiza o console via SSE.
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
                 HelpCenter + embeddings.ts (busca híbrida), AgentRunner
                 (fila por conversa), draftActions, escalation.ts (job SLA→N2),
                 oidc.ts (SSO: discovery + PKCE + JWKS, sem deps)
      db.ts      schema + migração (node:sqlite)
      store.ts   mapeadores + persistência (+ senha scrypt)
      routes.ts  REST + SSE + auth/OIDC (montadas sob /api)
    eval/        scenarios.ts + run.ts → EVAL.md
                 helpDataset.ts + helpEval.ts (relevância da busca)
  web/   Vite + React + TS
    src/pages     Login / EmployeeChat / Profile / Console
    src/components Cards, Shell, ícones, StepsLine (chips expansíveis)
    src/styles.css tokens do .pen (cores, raios, tipografia)
e2e/   Playwright + axe — specs de login/chat/console/a11y
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
  `AUTH_ANY_PASSWORD`, documentado em vez de fingido. Para produção há ainda
  o **SSO via OIDC** (abaixo) — a senha vira só o fallback.
- **Embeddings locais, não remotos.** A busca da central mistura score lexical
  com similaridade de cosseno de vetores n-gram/IDF gerados em memória —
  resolve paráfrases sem adicionar banco vetorial nem chamada de API, e
  mantém o modo offline determinístico (mais contexto em `eval/EVAL.md`).
- **OIDC sem SDK.** `services/oidc.ts` implementa discovery
  (`.well-known`), Authorization Code + PKCE S256 e validação do `id_token`
  via JWKS com `node:crypto` (RS256/384/512 e ES256/384/512). O e-mail do IdP
  mapeia para o usuário local; a sessão continua o cookie `nexo_sid` — os
  guards (`requireUser`/`requireAnalyst`) não mudam.
- **Escalonamento como job isolado.** `runEscalationTick` é uma função pura
  sobre `Store`+`RealtimeHub` (testável sem timer); o `EscalationJob` só agenda
  o intervalo (`unref`'d) e é testado por chamadas de tick.

### Trade-offs assumidos

- Os embeddings são n-gram/IDF locais (não um modelo semântico) — suficiente
  para paráfrases do domínio em ~10 artigos; `HELP_SEARCH_MODE` permite
  comparar lexical/vector/hybrid e trocar depois atrás da mesma interface.
- Dedup é por similaridade de título+categoria do mesmo solicitante —
  conservadora (threshold 0.34) para não fundir assuntos distintos.
- O scripted engine cobre os fluxos do desafio; para conversas abertas de
  verdade, `AGENT_ENGINE=mastra` + chave do provider liga o LLM.
- O sistema de chamados é simulado in-process; a fronteira `TicketService`
  já isola onde um cliente HTTP real entraria.

## Qualidade

- **76 testes vitest**: SLA em horário útil (20), fluxos do agent fim-a-fim
  contra banco em memória (17 — intake, dedup, privacidade, reabertura,
  transparência de passos, retry do legado), rotas HTTP (9 — auth, 401/403,
  limite diário, confirm de rascunho), busca da central (10), telemetria
  tokens/custo (8), escalonamento SLA→N2 (5) e **SSO OIDC ponta a ponta contra
  um IdP fake com RSA de verdade** (7 — PKCE, assinatura, nonce, erros).
- **11 cenários de avaliação** (`npm run eval`): conversas multi-turno com
  assertivas de texto, tools, cards e efeitos no banco → `apps/api/eval/EVAL.md`;
  mais a avaliação de relevância da central (`npm run eval:help`) comparando
  lexical × embeddings por cenário.
- **10 specs Playwright + axe** (`npm run test:e2e`): login (funcionária,
  analista, erro, guard), fluxo completo de chat (ajuda → impacto → rascunho →
  confirmação → chamado criado), console do analista (fila N1/N2, assumir,
  responder) e auditoria axe **zero violações** nas três telas.
- **CI** (`.github/workflows/ci.yml`): typecheck + testes + avaliação + build +
  Playwright/a11y.

## Variáveis de ambiente

Veja `.env.example` (copie para `apps/api/.env`). Principais:

| Var                  | Padrão                    | Uso                                        |
| -------------------- | ------------------------- | ------------------------------------------ |
| `AGENT_ENGINE`       | `auto`                    | `mastra` · `scripted` · `auto`             |
| `LLM_MODEL`          | `google/gemini-2.5-flash` | modelo do engine Mastra (router)           |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` | — | chave do provider (ativa o modo Mastra) |
| `AUTH_ANY_PASSWORD`  | `true`                    | `false` = valida scrypt (senha `nexo123`)  |
| `HELP_SEARCH_MODE`   | `hybrid`                  | `hybrid` · `vector` · `lexical`            |
| `ESCALATION_INTERVAL_SEC` | `30`               | intervalo do job de escalonamento (s)      |
| `ESCALATION_WAIT_MINUTES` | `60`               | espera máx. em `waiting_analyst` (min)     |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` | —           | habilita o botão de SSO na tela de login   |
| `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` / `OIDC_SCOPES` / `OIDC_LABEL` | — | detalhes do client OIDC (PKCE sempre) |
| `PORT`               | `4100`                    | porta da API                               |
| `DATABASE_FILE`      | `./data/nexo.db`          | arquivo SQLite (`:memory:` funciona)       |
| `TICKETS_CHAOS_RATE` | `0.12`                    | instabilidade do legado (0 = desligado)    |
| `DAILY_MESSAGE_LIMIT`| `30`                      | mensagens/dia por funcionário              |

## Rotas principais (todas sob `/api`)

```
POST /api/auth/login                      GET  /api/auth/providers
GET  /api/auth/oidc/login                 GET  /api/auth/oidc/callback
GET  /api/me
GET  /api/conversations/current           GET  /api/conversations/:id
POST /api/conversations/:id/messages      GET  /api/conversations/:id/stream (SSE)
POST /api/conversations/:id/drafts/:draftId/confirm | /cancel
GET  /api/tickets                         GET  /api/tickets/:id
GET  /api/console/conversations?filter=…&q=…    GET  /api/console/stream (SSE)
POST /api/conversations/:id/assume | /release | /close
GET  /api/console/users/:userId/tickets
GET  /health (fora do /api, p/ healthcheck de plataforma)
```

## Roadmap — entregue ✅

- **Embeddings na central de ajuda** — busca híbrida lexical+vetorial local
  (`services/embeddings.ts`), avaliação de relevância por cenário em
  `eval/helpEval.ts` (hit@3 100% vs 91% lexical → `EVAL.md`).
- **Telemetria de tokens/custo** — `agent/telemetry.ts` normaliza o
  `stream.usage` do Mastra (input/output/cached/reasoning) e estima USD por
  modelo; vai na `meta` da mensagem e aparece no console do analista.
- **Escalonamento automático por SLA** — `services/escalation.ts`: job que
  re-transfere para N2 (chamado vencido ou espera > limite), com mensagem de
  sistema, auditoria no chamado e SSE; fila N1/N2 visível no console.
- **SSO real (OIDC)** — `services/oidc.ts`: discovery + Authorization Code +
  PKCE + JWKS/RS256-ES512 sem dependência, rotas `/auth/oidc/login|callback`
  e `/auth/providers`, botão na tela de login, testes com IdP fake (RSA).
  O cookie de sessão segue sendo a fronteira dos guards — o OIDC substitui
  a verificação de senha.
- **A11y auditada + UI** — `e2e/` com Playwright: 10 specs (login, chat com
  confirmação de chamado, console, axe nas 3 telas, zero violações) + CI.

### Próximos passos possíveis

- Embeddings semânticos reais (modelo externo) atrás da mesma interface.
- Provisionamento SCIM para criar usuários a partir do IdP.
- Rotação/revogação de sessões e refresh tokens OIDC.
