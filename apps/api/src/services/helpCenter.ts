import type { Store } from "../store.js";
import type { HelpArticle } from "../domain/types.js";
import { keywords, normalize } from "../domain/text.js";

// ─── Central de ajuda ────────────────────────────────────────────────────────
// Busca lexical simples (título + keywords + corpo). Para o volume do desafio
// (5–10 artigos) é suficiente e previsível; troca futura por embeddings
// ficaria atrás desta mesma interface.

export interface HelpHit {
  article: HelpArticle;
  score: number;
}

export class HelpCenter {
  constructor(private readonly store: Store) {}

  search(query: string, limit = 3): HelpHit[] {
    const qk = keywords(query);
    if (qk.length === 0) return [];
    const hits: HelpHit[] = [];
    for (const a of this.store.articles()) {
      const hay = keywords(`${a.title} ${a.body} ${a.keywords.join(" ")}`);
      let score = 0;
      for (const k of qk) {
        if (a.keywords.includes(k)) score += 2;
        else if (hay.includes(k)) score += 1;
        else if (hay.some((h) => h.startsWith(k) || k.startsWith(h))) score += 0.5;
      }
      if (normalize(a.title).includes(normalize(query)) && query.length > 4) score += 3;
      if (score > 0) hits.push({ article: a, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  get(articleId: string): HelpArticle | null {
    return this.store.articles().find((a) => a.id === articleId) ?? null;
  }
}
