// Normalização para buscas e comparações pt-BR (remove acentos, minúsculas).

const DIACRITICS = /[̀-ͯ]/g;

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .trim();
}

/** Normaliza e remove toda pontuação — para comparar texto digitado com opções/botões. */
export function squash(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOPWORDS = new Set(
  (
    "a o e de da do das dos em no na nos nas um uma uns umas para por com sem " +
    "ao aos à às que se sua seu suas seus meu minha meus é foi ser estar " +
    "eu voce você ele ela nos nós mais menos muito nao não sim"
  ).split(" "),
);

/** Tokens relevantes (sem stopwords), normalizados. */
export function keywords(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Similaridade simples por conjunto de palavras (Jaccard). */
export function similarity(a: string, b: string): number {
  const ka = new Set(keywords(a));
  const kb = new Set(keywords(b));
  if (ka.size === 0 || kb.size === 0) return 0;
  let inter = 0;
  for (const w of ka) if (kb.has(w)) inter++;
  return inter / (ka.size + kb.size - inter);
}
