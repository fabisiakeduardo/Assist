import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { HelpCenter } from "../src/services/helpCenter.js";
import type { HelpSearchMode } from "../src/config.js";
import { HELP_EVAL_SCENARIOS } from "./helpDataset.js";

// ─── Avaliação de relevância da central de ajuda ─────────────────────────────
// Mede hit@1, hit@3 e MRR por cenário, comparando o modo lexical legado com a
// busca híbrida (embeddings locais + lexical). O resultado vai para o console
// e para uma seção do EVAL.md gerado pelo run.ts.

export interface ModeMetrics {
  hit1: number;
  hit3: number;
  rr: number; // soma de reciprocal ranks (MRR = rr / queries)
}

export interface ScenarioReport {
  id: string;
  title: string;
  queries: number;
  metrics: Record<HelpSearchMode, ModeMetrics>;
}

export const HELP_EVAL_MODES: HelpSearchMode[] = ["lexical", "hybrid"];

const emptyMetrics = (): ModeMetrics => ({ hit1: 0, hit3: 0, rr: 0 });

/** Atualiza `m` com o rank do primeiro artigo esperado (ou miss). */
function score(hits: string[], expect: string[], m: ModeMetrics): number | null {
  const rank = hits.findIndex((id) => expect.includes(id));
  if (rank === 0) m.hit1++;
  if (rank >= 0) {
    m.hit3++;
    m.rr += 1 / (rank + 1);
    return rank;
  }
  return null;
}

export function runHelpEval(verbose = true): {
  scenarios: ScenarioReport[];
  overall: Record<HelpSearchMode, ModeMetrics>;
} {
  const overall = Object.fromEntries(
    HELP_EVAL_MODES.map((m) => [m, emptyMetrics()]),
  ) as Record<HelpSearchMode, ModeMetrics>;

  // um banco+índice por modo — o EmbeddingIndex é cacheado por instância
  const centers = HELP_EVAL_MODES.map((mode) => {
    const store = new Store(openMemoryDb());
    seed(store);
    return { mode, help: new HelpCenter(store, mode) };
  });

  const scenarios: ScenarioReport[] = [];
  for (const scenario of HELP_EVAL_SCENARIOS) {
    const metrics = Object.fromEntries(
      HELP_EVAL_MODES.map((m) => [m, emptyMetrics()]),
    ) as Record<HelpSearchMode, ModeMetrics>;

    for (const query of scenario.queries) {
      for (const { mode, help } of centers) {
        const ids = help.search(query.q, 3).map((h) => h.article.id);
        const rank = score(ids, query.expect, metrics[mode]);
        score(ids, query.expect, overall[mode]);
        if (verbose && rank === null) {
          console.log(`    ✗ ${scenario.id} · "${query.q}" → sem hit (${mode})`);
        }
      }
    }
    scenarios.push({
      id: scenario.id,
      title: scenario.title,
      queries: scenario.queries.length,
      metrics,
    });
  }
  return { scenarios, overall };
}

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;
const f2 = (n: number) => n.toFixed(2);

/** Bloco markdown para anexar ao EVAL.md. */
export function helpEvalMarkdown(): string {
  const { scenarios, overall } = runHelpEval(false);
  const total = scenarios.reduce((s, sc) => s + sc.queries, 0);
  const row = (m: ModeMetrics, d: number) =>
    `${pct(m.hit1, d)} / ${pct(m.hit3, d)} / ${f2(m.rr / d)}`;
  const rows = scenarios
    .map(
      (sc) =>
        `| \`${sc.id}\` | ${sc.title} | ${sc.queries} | ${row(sc.metrics.lexical, sc.queries)} | ${row(sc.metrics.hybrid, sc.queries)} |`,
    )
    .join("\n");
  return `## Relevância da central de ajuda (embeddings)

Dataset de ${total} consultas em ${scenarios.length} cenários (eval/helpDataset.ts), com
paráfrases propositais. Métricas: **hit@1 / hit@3 / MRR** — o modo \`hybrid\`
combina embeddings locais (feature hashing + IDF, services/embeddings.ts) com
o score lexical; \`lexical\` é o modo anterior (\`HELP_SEARCH_MODE=lexical\`).

| Cenário | Tema | Consultas | lexical | hybrid |
| --- | --- | --- | --- | --- |
${rows}
| **TOTAL** | — | ${total} | ${row(overall.lexical, total)} | ${row(overall.hybrid, total)} |
`;
}

// execução direta: `tsx eval/helpEval.ts`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { scenarios, overall } = runHelpEval();
  const total = scenarios.reduce((s, sc) => s + sc.queries, 0);
  for (const mode of HELP_EVAL_MODES) {
    const m = overall[mode];
    console.log(
      `\n${mode}: hit@1 ${pct(m.hit1, total)} · hit@3 ${pct(m.hit3, total)} · MRR ${f2(m.rr / total)}`,
    );
  }
}
