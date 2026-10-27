import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { TicketService } from "../src/services/ticketService.js";
import { HelpCenter } from "../src/services/helpCenter.js";
import { ScriptedEngine } from "../src/agent/scripted.js";
import type { AgentResult, AgentServices } from "../src/agent/engine.js";
import { SCENARIOS, type Scenario, type TurnExpect } from "./scenarios.js";

// ─── Runner de avaliação ─────────────────────────────────────────────────────
// Executa os cenários contra o ScriptedEngine (determinístico — sem LLM, sem
// rede) e grava o relatório em eval/EVAL.md. Sai com código 1 se algo falhar,
// então pode rodar em CI junto dos testes.

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(here, "EVAL.md");

function stack() {
  const store = new Store(openMemoryDb());
  seed(store);
  const services: AgentServices = {
    store,
    tickets: new TicketService(store, 0), // sem caos — a avaliação é determinística
    help: new HelpCenter(store),
  };
  return { store, services, engine: new ScriptedEngine({ stepMs: 0, wordMs: 0 }) };
}

const match = (text: string, p: RegExp | string) =>
  typeof p === "string" ? text.includes(p) : p.test(text);

function checkTurn(
  expect: TurnExpect | undefined,
  result: AgentResult,
  ctx: { store: Store; convId: string; userId: string },
): string[] {
  if (!expect) return [];
  const fails: string[] = [];
  for (const p of expect.text ?? []) {
    if (!match(result.text, p)) fails.push(`texto não contém ${p}`);
  }
  for (const p of expect.notText ?? []) {
    if (match(result.text, p)) fails.push(`texto NÃO deveria conter ${p}`);
  }
  for (const tool of expect.tools ?? []) {
    if (!result.steps.some((s) => s.tool === tool)) fails.push(`passo da tool "${tool}" ausente`);
  }
  if (expect.card && !result.cards?.some((c) => c.type === expect.card)) {
    fails.push(`card "${expect.card}" ausente`);
  }
  if (expect.check) {
    const conv = ctx.store.conversation(ctx.convId)!;
    const user = ctx.store.userById(ctx.userId)!;
    const r = expect.check({ store: ctx.store, conv, user });
    if (r !== true) fails.push(`efeito: ${r}`);
  }
  return fails;
}

interface ScenarioResult {
  scenario: Scenario;
  failures: Array<{ turn: number; user: string; problems: string[] }>;
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const { store, services, engine } = stack();
  scenario.setup?.(store);
  const user = store.userByEmail("ana.souza@nexo.com.br")!;
  const conv = store.createConversation(user.id);
  const failures: ScenarioResult["failures"] = [];

  for (const [i, t] of scenario.turns.entries()) {
    store.addMessage({ conversationId: conv.id, sender: "user", senderId: user.id, text: t.user });
    const result = await engine.run(
      {
        conversation: store.conversation(conv.id)!,
        user,
        userText: t.user,
        history: store.messages(conv.id),
        streamMessageId: `eval-${i}`,
      },
      services,
      () => {},
    );
    store.addMessage({
      conversationId: conv.id,
      sender: "agent",
      text: result.text,
      steps: result.steps,
      cards: result.cards ?? null,
    });
    const problems = checkTurn(t.expect, result, { store, convId: conv.id, userId: user.id });
    if (problems.length) {
      failures.push({ turn: i + 1, user: t.user, problems });
      break; // turnos seguintes dependem do estado — para na primeira falha
    }
  }
  return { scenario, failures };
}

const results: ScenarioResult[] = [];
for (const s of SCENARIOS) {
  const r = await runScenario(s);
  results.push(r);
  const ok = r.failures.length === 0;
  console.log(`${ok ? "✓" : "✗"} ${s.id} — ${s.title}`);
  for (const f of r.failures) {
    for (const p of f.problems) console.log(`    turno ${f.turn} (“${f.user}”): ${p}`);
  }
}

const passed = results.filter((r) => r.failures.length === 0).length;
console.log(`\n${passed}/${results.length} cenários passando`);

// ── relatório ────────────────────────────────────────────────────────────────

const rows = results
  .map((r) => {
    const status = r.failures.length === 0 ? "✅ passa" : `❌ turno ${r.failures[0]!.turn}`;
    return `| \`${r.scenario.id}\` | ${r.scenario.title} | ${r.scenario.covers} | ${status} |`;
  })
  .join("\n");

const md = `# Avaliação do agent (\`npm run eval\`)

> Gerado em ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · engine \`scripted\` (determinístico, sem LLM).

Cada cenário simula uma conversa real do funcionário contra a stack completa
(store + TicketService + HelpCenter + engine) e verifica texto, passos de
transparência, cards e efeitos colaterais no banco.

| Cenário | O que exercita | Cobre | Resultado |
| --- | --- | --- | --- |
${rows}

**${passed}/${results.length} cenários passando.**
`;

writeFileSync(REPORT, md);
console.log(`relatório → ${path.relative(process.cwd(), REPORT)}`);

if (passed !== results.length) process.exit(1);
