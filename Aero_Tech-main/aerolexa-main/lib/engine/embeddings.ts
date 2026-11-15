/**
 * Embeddings / vector space — skip-gram word2vec with negative sampling.
 *
 * The missing piece behind "vector/LLM training": a real embedding trainer.
 * Vocabulary → token ids → skip-gram pairs with a fixed context window →
 * trained by SGD with negative sampling (the Mikolov objective), all
 * deterministic (seeded PRNG for initialisation, sampling and pair order —
 * never Math.random). Similarity is cosine over the trained vectors, with
 * the denominator guarded so zero vectors can never produce NaN.
 *
 * Honest scale: this trains real embeddings for corpus-sized vocabularies in
 * process — it is not a transformer LLM and the header says so.
 */

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export interface Vocab {
  /** id → token */
  tokens: string[];
  /** token → id */
  index: Map<string, number>;
  counts: number[];
}

const TOKEN_RE = /[a-z0-9']+/g;

export function buildVocab(texts: readonly string[], minCount = 1): Vocab {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const toks = text.toLowerCase().match(TOKEN_RE) ?? [];
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const tokens = [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  if (tokens.length === 0) throw new EmbeddingError("Corpus produced an empty vocabulary.");
  return {
    tokens,
    index: new Map(tokens.map((t, i) => [t, i])),
    counts: tokens.map((t) => counts.get(t)!),
  };
}

export function encode(text: string, vocab: Vocab): number[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? [])
    .map((t) => vocab.index.get(t))
    .filter((v): v is number => v !== undefined);
}

// ---------------------------------------------------------------------------
// Skip-gram pairs with a fixed window
// ---------------------------------------------------------------------------

export interface SkipGramPair {
  center: number;
  context: number;
}

export function skipGramPairs(doc: readonly number[], window: number): SkipGramPair[] {
  if (window < 1) throw new EmbeddingError("Window must be >= 1.");
  const pairs: SkipGramPair[] = [];
  for (let i = 0; i < doc.length; i++) {
    for (let d = 1; d <= window; d++) {
      if (i - d >= 0) pairs.push({ center: doc[i]!, context: doc[i - d]! });
      if (i + d < doc.length) pairs.push({ center: doc[i]!, context: doc[i + d]! });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Training — SGD with negative sampling
// ---------------------------------------------------------------------------

export interface Word2vecOptions {
  dim: number;
  window: number;
  epochs: number;
  lr: number;
  negative: number;
  seed: number;
}

export interface Word2vecModel {
  vocab: Vocab;
  dim: number;
  /** Input (center) vectors: [vocab][dim]. */
  inVectors: number[][];
  /** Output (context) vectors: [vocab][dim]. */
  outVectors: number[][];
  options: Word2vecOptions;
}

const gauss = (rnd: () => number): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** dot product */
const dot = (a: readonly number[], b: readonly number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

export function trainWord2vec(texts: readonly string[], opts: Word2vecOptions): Word2vecModel {
  const vocab = buildVocab(texts);
  if (opts.dim < 2) throw new EmbeddingError("dim must be >= 2.");
  const V = vocab.tokens.length;

  // Unigram table for negative sampling: proportional to count^(3/4).
  const powCounts = vocab.counts.map((c) => Math.pow(c, 0.75));
  const totalPow = powCounts.reduce((s, c) => s + c, 0);
  const cum: number[] = [];
  let acc = 0;
  for (const c of powCounts) {
    acc += c / totalPow;
    cum.push(acc);
  }

  const rnd = (() => {
    // Same mulberry32 as the neural-net engine.
    let a = opts.seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const inVectors: number[][] = Array.from({ length: V }, () =>
    Array.from({ length: opts.dim }, () => (gauss(rnd) * 0.5) / opts.dim),
  );
  const outVectors: number[][] = Array.from({ length: V }, () => Array.from({ length: opts.dim }, () => 0));

  const sampleNegative = (): number => {
    const r = rnd();
    // binary search over the cumulative unigram table
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const docs = texts.map((t) => encode(t, vocab));
  let pairCache: SkipGramPair[] = [];

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    pairCache = [];
    for (const doc of docs) pairCache.push(...skipGramPairs(doc, opts.window));
    // Deterministic order: seeded shuffle.
    for (let i = pairCache.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = pairCache[i]!;
      pairCache[i] = pairCache[j]!;
      pairCache[j] = tmp;
    }
    for (const { center, context } of pairCache) {
      const vC = inVectors[center]!;
      const gradAcc = new Array(opts.dim).fill(0);
      // Positive target.
      const uO = outVectors[context]!;
      const score = sigmoid(dot(vC, uO));
      const g = score - 1;
      for (let d = 0; d < opts.dim; d++) {
        gradAcc[d]! += g * uO[d]!;
        uO[d]! -= opts.lr * g * vC[d]!;
      }
      // Negatives.
      for (let k = 0; k < opts.negative; k++) {
        const neg = sampleNegative();
        if (neg === context) continue;
        const uN = outVectors[neg]!;
        const sN = sigmoid(dot(vC, uN));
        const gN = sN; // label 0 → gradient σ(v·u) − 0
        for (let d = 0; d < opts.dim; d++) {
          gradAcc[d]! += gN * uN[d]!;
          uN[d]! -= opts.lr * gN * vC[d]!;
        }
      }
      for (let d = 0; d < opts.dim; d++) vC[d]! -= opts.lr * gradAcc[d]!;
    }
  }
  return { vocab, dim: opts.dim, inVectors, outVectors, options: { ...opts } };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function cosine(model: Word2vecModel, a: string, b: string): number {
  const ia = model.vocab.index.get(a);
  const ib = model.vocab.index.get(b);
  if (ia === undefined || ib === undefined) throw new EmbeddingError(`Unknown token: ${ia === undefined ? a : b}`);
  const va = model.inVectors[ia]!;
  const vb = model.inVectors[ib]!;
  const denom = Math.sqrt(dot(va, va)) * Math.sqrt(dot(vb, vb));
  if (denom === 0) return 0;
  return dot(va, vb) / denom;
}

export interface Neighbour {
  token: string;
  sim: number;
}

/** Top-k nearest tokens by cosine similarity over the input vectors. */
export function nearest(model: Word2vecModel, token: string, k = 5): Neighbour[] {
  const idx = model.vocab.index.get(token);
  if (idx === undefined) throw new EmbeddingError(`Unknown token: ${token}`);
  const v = model.inVectors[idx]!;
  const norm = Math.sqrt(dot(v, v));
  const sims = model.vocab.tokens.map((t, i) => {
    if (i === idx) return { token: t, sim: 1 };
    const w = model.inVectors[i]!;
    const denom = norm * Math.sqrt(dot(w, w));
    return { token: t, sim: denom === 0 ? 0 : dot(v, w) / denom };
  });
  return sims.sort((a, b) => b.sim - a.sim).slice(1, k + 1);
}
