import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { HelpCenter } from "../src/services/helpCenter.js";
import { EmbeddingIndex, EMBED_DIMS, featurize } from "../src/services/embeddings.js";

// ─── embeddings locais + busca híbrida da central de ajuda ───────────────────

function stack(mode: "hybrid" | "vector" | "lexical" = "hybrid") {
  const store = new Store(openMemoryDb());
  seed(store);
  return new HelpCenter(store, mode);
}

describe("EmbeddingIndex", () => {
  const docs = [
    { id: "a", text: "VPN com erro 809 — conexão não responde no Windows" },
    { id: "b", text: "Impressora não imprime — fila travada no printserver" },
    { id: "c", text: "Horário do service desk — segunda a sexta das 8h às 18h" },
  ];
  const index = new EmbeddingIndex(docs);

  it("produz vetores densos normalizados (L2 = 1)", () => {
    const v = index.embed("qualquer texto de teste");
    expect(v.length).toBe(EMBED_DIMS);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("é determinístico — mesmo texto, mesmo vetor", () => {
    const a = index.embed("erro 809 na vpn");
    const b = index.embed("erro 809 na vpn");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("documento relevante ranqueia acima dos demais", () => {
    const hits = index.search("vpn erro 809");
    expect(hits[0]!.id).toBe("a");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("paráfrase por morfologia aproxima o documento certo", () => {
    // "imprimir"/"impressão" dividem n-gramas com "imprime"/"impressora"
    const hits = index.search("não consigo mandar impressão");
    expect(hits[0]!.id).toBe("b");
  });

  it("featurize expande sinônimos do domínio", () => {
    const wifi = featurize("wifi");
    const semFio = featurize("internet sem fio");
    let shared = 0;
    for (const k of wifi.keys()) if (semFio.has(k)) shared++;
    expect(shared).toBeGreaterThan(0);
  });
});

describe("HelpCenter híbrido", () => {
  it("consulta literal acha o artigo certo", () => {
    const help = stack("hybrid");
    const hits = help.search("VPN erro 809");
    expect(hits[0]!.article.id).toBe("kb-001");
    expect(hits[0]!.similarity).toBeGreaterThan(0);
  });

  it("paráfrase sem overlap lexical ainda acha via embeddings", () => {
    const help = stack("hybrid");
    const hits = help.search("internet sem fio não funciona no notebook");
    expect(hits[0]!.article.id).toBe("kb-005");
  });

  it("modo lexical continua funcionando (compatibilidade)", () => {
    const help = stack("lexical");
    const hits = help.search("VPN erro 809");
    expect(hits[0]!.article.id).toBe("kb-001");
    expect(hits[0]!.similarity).toBe(0);
  });

  it("modo vector acha por similaridade pura", () => {
    const help = stack("vector");
    const hits = help.search("impressora travada");
    expect(hits[0]!.article.id).toBe("kb-008");
  });

  it("consulta vazia retorna zero hits", () => {
    expect(stack().search("a de o em")).toEqual([]);
  });
});
