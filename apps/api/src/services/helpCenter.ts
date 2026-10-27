import type { Store } from "../store.js";
import type { HelpArticle } from "../domain/types.js";
import { keywords, normalize } from "../domain/text.js";
import { EmbeddingIndex } from "./embeddings.js";
import { config, type HelpSearchMode } from "../config.js";

// ─── Central de ajuda ────────────────────────────────────────────────────────
// Busca híbrida (padrão): score lexical (keywords + título) + similaridade de
// embeddings locais (services/embeddings.ts — feature hashing + IDF). A parte
// vetorial pega paráfrases e morfologia que o léxico perde ("internet sem fio"
// → artigo de wi-fi); a parte lexical preserva a força das keywords curadas.
// HELP_SEARCH_MODE: hybrid | vector | lexical — o último reproduz o
// comportamento original para comparação na avaliação de relevância.

export interface HelpHit {
  article: HelpArticle;
  score: number;
  /** Similaridade de cosseno [0,1] do índice de embeddings (inspecionável). */
  similarity?: number;
}

// peso do cosseno no score híbrido — um match vetorial forte (~0.7) vale
// aproximadamente um acerto de keyword curada (+2)
const VECTOR_WEIGHT = 3;
// piso de similaridade para um artigo entrar só pela via vetorial
const MIN_SIMILARITY = 0.1;

export class HelpCenter {
  private index: EmbeddingIndex | null = null;

  constructor(
    private readonly store: Store,
    private readonly mode: HelpSearchMode = config.helpSearchMode,
  ) {}

  private vectorIndex(): EmbeddingIndex {
    if (!this.index) {
      this.index = new EmbeddingIndex(
        this.store
          .articles()
          .map((a) => ({
            id: a.id,
            text: `${a.title} ${a.title} ${a.keywords.join(" ")} ${a.body}`,
          })),
      );
    }
    return this.index;
  }

  /** Score lexical do modo legado (keywords + corpo + título). */
  private lexicalScore(query: string, qk: string[], a: HelpArticle): number {
    const hay = keywords(`${a.title} ${a.body} ${a.keywords.join(" ")}`);
    let score = 0;
    for (const k of qk) {
      if (a.keywords.includes(k)) score += 2;
      else if (hay.includes(k)) score += 1;
      else if (hay.some((h) => h.startsWith(k) || k.startsWith(h))) score += 0.5;
    }
    if (normalize(a.title).includes(normalize(query)) && query.length > 4) score += 3;
    return score;
  }

  search(query: string, limit = 3): HelpHit[] {
    const qk = keywords(query);
    if (qk.length === 0) return [];

    const simById =
      this.mode === "lexical"
        ? new Map<string, number>()
        : new Map(this.vectorIndex().search(query, 10).map((h) => [h.id, h.score]));

    const hits: HelpHit[] = [];
    for (const a of this.store.articles()) {
      const lex = this.mode === "vector" ? 0 : this.lexicalScore(query, qk, a);
      const sim = simById.get(a.id) ?? 0;
      const score = this.mode === "vector" ? sim : lex + sim * VECTOR_WEIGHT;
      if (lex > 0 || sim >= MIN_SIMILARITY) {
        hits.push({ article: a, score, similarity: sim });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  get(articleId: string): HelpArticle | null {
    return this.store.articles().find((a) => a.id === articleId) ?? null;
  }
}
