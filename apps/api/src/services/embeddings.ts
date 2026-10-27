import { normalize } from "../domain/text.js";

// ─── Embeddings locais (feature hashing) ─────────────────────────────────────
// Vetoriza texto em um espaço de EMBED_DIMS dimensões sem nenhuma dependência
// nem chamada de rede: hashing de features (FNV-1a com sinal) de
//   • unigramas e bigramas de palavras (normalizadas pt-BR)
//   • n-gramas de caractere (3–4) — captura morfologia ("imprimir"/"impressora")
//   • expansão por sinônimos do domínio (wifi ~ "sem fio", senha ~ "credencial")
// O índice aplica IDF aprendido no próprio corpus de artigos e normaliza os
// vetores (L2), então similaridade = produto interno (cosseno).
//
// Determinístico e offline — ideal p/ demo e CI. Um embedder remoto (ex.:
// OpenAI /v1/embeddings) pode trocar isso atrás do mesmo EmbeddingIndex.

export const EMBED_DIMS = 512;

/** FNV-1a 32 bits — hash estável entre processos (não aleatório). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Sinônimos do domínio — expansão dos dois lados (consulta e documento) para o
 * mesmo espaço de features, então "internet sem fio" encosta em "wi-fi".
 * Curado para o service desk; embeddings densos fariam isso sozinhos.
 */
const SYNONYMS: Record<string, string[]> = {
  wifi: ["wireless", "internet", "rede", "sem fio", "conexao"],
  "wi-fi": ["wireless", "internet", "rede", "sem fio", "conexao"],
  internet: ["rede", "conexao", "wifi"],
  vpn: ["rede", "conexao", "remoto", "tunel"],
  rede: ["conexao", "internet"],
  senha: ["password", "credencial", "login", "acesso"],
  credencial: ["senha", "acesso", "login", "password"],
  bloqueada: ["travada", "bloqueio", "lockout"],
  bloqueado: ["travado", "bloqueio", "lockout"],
  travada: ["bloqueada", "bloqueio", "travado"],
  travado: ["bloqueado", "travada", "lento"],
  travando: ["lento", "travado", "lentidao"],
  logar: ["login", "acesso", "entrar"],
  login: ["acesso", "senha", "entrar", "credencial"],
  notebook: ["laptop", "computador", "maquina", "pc"],
  computador: ["notebook", "maquina", "pc", "desktop"],
  lento: ["lentidao", "travando", "demora", "pesado"],
  lentidao: ["lento", "travando", "demora"],
  impressora: ["impressao", "imprimir", "print"],
  imprimir: ["impressao", "impressora", "print"],
  impressao: ["imprimir", "impressora"],
  sincronizar: ["sincroniza", "sincronismo", "atualizar", "sync"],
  sincroniza: ["sincronizar", "sync", "atualizar"],
  email: ["e-mail", "correio", "outlook", "mensagem"],
  outlook: ["email", "e-mail", "correio"],
  celular: ["telefone", "mobile", "smartphone"],
  monitor: ["tela", "display"],
  acesso: ["permissao", "entrar", "login", "acessar"],
  acessar: ["acesso", "entrar", "login"],
  permissao: ["acesso", "autorizacao", "perfil"],
  quarentena: ["spam", "lixo", "bloqueado"],
  spam: ["quarentena", "lixo"],
  equipamento: ["hardware", "monitor", "teclado", "notebook"],
  chamado: ["ticket", "incidente", "solicitacao"],
  software: ["programa", "aplicativo", "app", "sistema"],
  sistema: ["software", "aplicativo", "app"],
  erp: ["sap"],
  sap: ["erp"],
};

/** Sinônimos de frase (bigrama → termos) — ex.: "sem fio" ≡ "wifi". */
const PHRASE_SYNONYMS: Record<string, string[]> = {
  "sem fio": ["wifi", "wi-fi", "wireless", "rede"],
  "nao funciona": ["quebrado", "falha", "erro", "parou"],
  "nao conecta": ["falha", "erro", "conexao", "caiu"],
  "nao imprime": ["impressora", "fila", "impressao"],
  "segundo monitor": ["monitor", "tela", "equipamento"],
  "em casa": ["home office", "remoto"],
  "home office": ["remoto", "casa"],
};

type SparseVec = Map<number, number>;

function addFeat(feats: SparseVec, feat: string, weight: number): void {
  const h = hash32(feat);
  const idx = h % EMBED_DIMS;
  // sinal derivado de outro bit do hash — reduz viés de colisão
  const sign = h & 0x40000000 ? -1 : 1;
  feats.set(idx, (feats.get(idx) ?? 0) + sign * weight);
}

function* wordsOf(text: string): Generator<string> {
  for (const w of normalize(text).split(/[^a-z0-9]+/)) {
    if (w) yield w;
  }
}

/** Extrai o mapa esparso de features de um texto. */
export function featurize(text: string): SparseVec {
  const feats: SparseVec = new Map();
  const words = [...wordsOf(text)];
  for (const w of words) {
    addFeat(feats, `w:${w}`, 1.0);
    // prefixo curto ajuda flexões ("imprim" cobre imprimir/impressora/impressão)
    if (w.length > 5) addFeat(feats, `w:${w.slice(0, 5)}`, 0.35);
    const padded = ` ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      addFeat(feats, `c3:${padded.slice(i, i + 3)}`, 0.3);
    }
    for (let i = 0; i + 4 <= padded.length; i++) {
      addFeat(feats, `c4:${padded.slice(i, i + 4)}`, 0.18);
    }
    for (const syn of SYNONYMS[w] ?? []) {
      addFeat(feats, `w:${syn}`, 0.45);
    }
  }
  for (let i = 0; i + 1 < words.length; i++) {
    addFeat(feats, `b:${words[i]}_${words[i + 1]}`, 0.6);
    for (const syn of PHRASE_SYNONYMS[`${words[i]} ${words[i + 1]}`] ?? []) {
      addFeat(feats, `w:${syn}`, 0.5);
    }
  }
  return feats;
}

function toDense(feats: SparseVec, idf: Float32Array): Float32Array {
  const v = new Float32Array(EMBED_DIMS);
  for (const [idx, w] of feats) v[idx] = w * idf[idx]!;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export interface EmbeddingHit {
  id: string;
  /** similaridade de cosseno em [0, 1] (vetores L2-normalizados). */
  score: number;
}

/**
 * Índice vetorial de um pequeno corpus. Aprende o IDF nos documentos na
 * construção e serve buscas por cosseno. Genérico o suficiente para qualquer
 * coleção de {id, text} — aqui usado com os artigos da central de ajuda.
 */
export class EmbeddingIndex {
  private readonly idf: Float32Array;
  private readonly docs: Array<{ id: string; vec: Float32Array }>;

  constructor(items: Array<{ id: string; text: string }>) {
    const sparse = items.map((it) => ({ id: it.id, f: featurize(it.text) }));
    const df = new Float64Array(EMBED_DIMS);
    for (const { f } of sparse) for (const idx of f.keys()) df[idx]!++;
    const n = sparse.length;
    this.idf = Float32Array.from(df, (d) => Math.log((n + 1) / (d + 1)) + 1);
    this.docs = sparse.map(({ id, f }) => ({ id, vec: toDense(f, this.idf) }));
  }

  embed(text: string): Float32Array {
    return toDense(featurize(text), this.idf);
  }

  /** Cosseno em [0,1] — retorna os `limit` melhores, ordenados. */
  search(text: string, limit = 5): EmbeddingHit[] {
    const q = this.embed(text);
    return this.docs
      .map((d) => ({ id: d.id, score: dot(q, d.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
