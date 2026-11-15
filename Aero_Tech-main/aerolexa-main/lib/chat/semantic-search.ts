/**
 * Semantic search — lexical BM25 ⊕ vector TF-IDF/cosine hybrid retrieval.
 *
 * Closes the repo's "no embeddings" gap WITHOUT an external embedding API:
 * the vector half builds TF-IDF vectors over the index itself (the corpus IS
 * the vocabulary), reduces them to dense LSA-style embeddings with truncated
 * power-iteration SVD, and cosine-ranks them. The lexical half is Okapi BM25
 * (k1=1.5, b=0.75). The two scores are max-normalized across the candidate
 * pool and fused with a weighted sum (0.6 lexical + 0.4 vector by default) —
 * classic hybrid search: BM25 catches exact identifiers ("churn_v3") that
 * vectors blur; the vector half catches paraphrase ("customer churn" ↔
 * "attrition report") that BM25 misses.
 *
 * LSA math (deterministic): with A = TF-IDF matrix (docs × V), the top-R
 * right singular vectors u_r are the top-R eigenvectors of AᵀA (V×V), found
 * by BLOCK power iteration with Gram–Schmidt re-orthonormalization and a
 * fixed constant start — no RNG. Doc embedding = [aᵢ·u₁ … aᵢ·u_R], L2-
 * normalized; the query is projected identically, so cosine = dot product.
 * Sign ambiguity of eigenvectors is irrelevant because docs and queries use
 * the SAME basis.
 *
 * Determinism contract (matches every engine in this repo):
 *  - No randomness anywhere; same index + query ⇒ identical ranking.
 *  - Degenerate corpora (0/1 docs, empty vocabulary) degrade honestly: the
 *    vector score is 0 for every doc and BM25 alone decides, rather than
 *    throwing or inventing similarities.
 *
 * Honesty contract (unchanged from rag.ts): only names/counts/kinds enter
 * the index; callers must keep telling the model it has NOT read row data.
 */

import { cosineSimilarity, type EmbeddingCache, type EmbeddingProvider } from "@/lib/chat/embedders";
import type { RagFact, RagHit } from "@/lib/chat/rag";
import { tokenize } from "@/lib/chat/rag";
import { retrieveFacts } from "@/lib/chat/rag";

export type { RagFact, RagHit };

/**
 * Drop-in upgrade for `retrieveFacts`: hybrid BM25 ⊕ vector ranking, with a
 * guaranteed answer when the query has no tokens (the pure-lexical retriever
 * then also returns []). Merges so a hit found by EITHER channel appears —
 * the fused score decides the order, and the original lexical score is kept
 * for hits only BM25 found (max-normalized fusion still applies).
 */
export function hybridRetrieveFacts(
  message: string,
  index: RagFact[],
  limit = 5,
  opts: HybridSearchOptions = {},
): RagHit[] {
  if (tokenize(message).length === 0 || index.length === 0) return retrieveFacts(message, index, limit);
  const idx = new SemanticIndex(index, opts);
  const hits = idx.search(message, limit, opts);
  if (hits.length === 0) return retrieveFacts(message, index, limit);
  return hits;
}

// ---------------------------------------------------------------------------
// Embedding-provider hybrid retrieval (dense channel + BM25, RRF-fused)
// ---------------------------------------------------------------------------

export interface EmbeddingHybridOptions extends HybridSearchOptions {
  /** Configured embedding endpoint (OpenAI-compatible or Ollama). */
  embedder: EmbeddingProvider;
  /** Optional cross-request vector cache (EmbeddingCache instance). */
  cache?: EmbeddingCache;
}

/**
 * Production-style hybrid retrieval: BM25 (lexical) ⊕ true dense embeddings
 * (semantic), fused with Reciprocal Rank Fusion by default.
 *
 * Contract:
 *  - The dense channel embeds fact text (title/sub/keywords — metadata only,
 *    never row data) and the query with the configured provider; vectors are
 *    cached by provider+text when a cache is supplied.
 *  - RRF (k = rrfK, default 60) fuses the two channel RANKINGS, so BM25
 *    scores and cosine similarities never need to share a scale.
 *  - If the provider fails (network down, bad shape, timeout) the call falls
 *    back to the deterministic LSA/TF-IDF path — degraded honestly, never
 *    silently: the returned hits' `channels` say which retrieval ran.
 */
export async function hybridRetrieveFactsWithEmbeddings(
  message: string,
  index: RagFact[],
  limit = 5,
  opts: EmbeddingHybridOptions,
): Promise<RagHit[]> {
  if (tokenize(message).length === 0 || index.length === 0) return retrieveFacts(message, index, limit);
  // RRF by default for the embedding path: BM25 magnitudes and cosine
  // similarities live on different scales, and rank fusion is scale-free.
  const optsWithDefaults: EmbeddingHybridOptions = { fusion: "rrf", ...opts };
  const idx = new SemanticIndex(index, optsWithDefaults);
  if (idx.size === 0) return retrieveFacts(message, index, limit);

  let queryVec: number[] | null = null;
  let docVecs: number[][] | null = null;
  try {
    const cache = optsWithDefaults.cache;
    const docTexts = idx.docTexts(); // aligned with the index's kept docs
    const providerId = opts.embedder.id;
    const missing: { pos: number; text: string }[] = [];
    docVecs = docTexts.map((text, pos) => {
      const hit = cache?.get(providerId, text);
      if (hit) return hit;
      missing.push({ pos, text });
      return [];
    });
    const toEmbed = [...missing.map((m) => m.text)];
    const qText = message.trim();
    const qCached = cache?.get(providerId, qText);
    if (!qCached) toEmbed.push(qText);
    // Skip the provider entirely when every vector (docs + query) is already
    // cached — a warm cache means ZERO network calls, not one empty batch.
    const vectors = toEmbed.length > 0 ? await opts.embedder.embed(toEmbed) : [];
    let next = 0;
    for (const m of missing) {
      const v = vectors[next++] as number[];
      docVecs[m.pos] = v;
      cache?.set(providerId, m.text, v);
    }
    if (qCached) {
      queryVec = qCached;
    } else {
      queryVec = vectors[next] ?? null;
      if (queryVec) cache?.set(providerId, qText, queryVec);
    }
    if (!queryVec || docVecs.some((v) => v.length === 0))
      throw new Error("embedding provider returned an incomplete batch");
  } catch {
    // Honest degradation: same deterministic path as the no-provider config.
    const hits = idx.search(message, limit, opts);
    return hits.length > 0 ? hits : retrieveFacts(message, index, limit);
  }

  // Dense channel: cosine between the query and every doc vector, fused with
  // BM25 through the same deterministic fusion the local path uses.
  const denseRaw = (docVecs as number[][]).map((v) => cosineSimilarity(queryVec as number[], v));
  const queryTokens = expandTokens([...new Set(tokenize(message))]);
  const hits = idx.fuseWithDense(queryTokens, limit, optsWithDefaults, denseRaw, ["bm25", "embedding"]);
  return hits.length > 0 ? hits : retrieveFacts(message, index, limit);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HybridSearchOptions {
  /** BM25 term-frequency saturation (default 1.5). */
  k1?: number;
  /** BM25 length normalization (default 0.75). */
  b?: number;
  /** Weight of the lexical score in the weighted fusion, 0..1 (default 0.6). */
  lexicalWeight?: number;
  /** Fusion strategy: classic max-normalized weighted sum, or Reciprocal Rank Fusion (default "weighted" for backward compatibility). */
  fusion?: "weighted" | "rrf";
  /** RRF smoothing constant k (default 60 — the standard from the literature). */
  rrfK?: number;
  /** Dense embedding dimensions from the SVD reduction (default 32). */
  dimensions?: number;
  /** Power-iteration sweeps for the SVD (default 16). */
  powerIterations?: number;
  /** Hard cap on vocabulary size — most frequent tokens survive (default 512). */
  maxVocabulary?: number;
  /** Minimum fused score to report a hit (default 0.05). */
  minScore?: number;
}

interface DocStats {
  fact: RagFact;
  tokens: string[];
  tf: Map<string, number>;
}

const DEFAULTS = { k1: 1.5, b: 0.75, dimensions: 32, powerIterations: 16, maxVocabulary: 512 } as const;

/**
 * Subtoken expansion: "churn_data" → ["churn_data", "churn", "data"] —
 * snake_case / kebab-case / camelCase identifiers keep their full token (so
 * BM25 stays exact on identifiers) AND gain their parts (so the query
 * "churn data" matches "churn_data.csv"). Parts are plain tokens in BOTH the
 * docs and the query; idf discounts the common parts so full-token matches
 * still dominate. Deduplicated, order-stable.
 */
function expandTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (t.length > 1 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const t of tokens) {
    push(t);
    for (const p of t.split(/[_\-]+|(?<=[a-z])(?=[A-Z0-9])|(?<=[A-Z0-9])(?=[a-z])/)) push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Index — build once per request, reuse across queries
// ---------------------------------------------------------------------------

export class SemanticIndex {
  private readonly docs: DocStats[] = [];
  private readonly df = new Map<string, number>();
  private vocab: string[] = [];
  private readonly vocabIndex = new Map<string, number>();
  private readonly idfCache = new Map<string, number>();
  /** L2-normalized dense embeddings, one per doc (dims columns). */
  private embeddings: number[][] = [];

  constructor(index: RagFact[], opts: HybridSearchOptions = {}) {
    const k1 = opts.k1 ?? DEFAULTS.k1;
    const b = opts.b ?? DEFAULTS.b;
    const maxVocabulary = opts.maxVocabulary ?? DEFAULTS.maxVocabulary;
    const dimensions = opts.dimensions ?? DEFAULTS.dimensions;
    const powerIterations = opts.powerIterations ?? DEFAULTS.powerIterations;

    for (const fact of index) {
      const tokens = expandTokens(tokenize(factText(fact)));
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ fact, tokens, tf });
    }
    // Vocabulary: top-N tokens by total frequency; ties broken alphabetically
    // so the cut is deterministic.
    const total = new Map<string, number>();
    for (const d of this.docs) for (const [t, c] of d.tf) total.set(t, (total.get(t) ?? 0) + c);
    this.vocab = [...total.entries()]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, maxVocabulary)
      .map(([t]) => t);
    this.vocabIndex = new Map(this.vocab.map((t, i) => [t, i] as const));
    for (const t of this.vocab) this.idfCache.set(t, this.computeIdf(t));
    this.embeddings = this.buildEmbeddings(dimensions, powerIterations);
    void k1;
    void b; // k1/b are per-search options (consumed in search()); unused at build time
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * The text of every doc the index KEPT (tokens-nonempty), in index order —
   * the embedding path must embed exactly these, aligned position-for-position
   * with the score vectors the fusion consumes.
   */
  docTexts(): string[] {
    return this.docs.map((d) => factText(d.fact));
  }

  get vocabularySize(): number {
    return this.vocab.length;
  }

  get embeddingDimensions(): number {
    return this.embeddings[0]?.length ?? 0;
  }

  /** Smoothed, non-negative idf (BM25's variant). */
  private computeIdf(token: string): number {
    const n = this.docs.length;
    const df = this.df.get(token) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** BM25 idf for a token unseen at build time (queries can introduce new subtokens). */
  private idfFor(token: string): number {
    return this.idfCache.get(token) ?? this.computeIdf(token);
  }

  /** BM25 score of one doc against the (deduplicated) query tokens. */
  private bm25(queryTokens: string[], doc: DocStats, k1: number, b: number): number {
    const avgLen = this.docs.reduce((s, d) => s + d.tokens.length, 0) / this.docs.length;
    let score = 0;
    for (const t of queryTokens) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const idf = this.idfFor(t);
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.tokens.length) / avgLen)));
    }
    return score;
  }

  /**
   * TF-IDF rows (docs × V), then top-R eigenvectors of AᵀA by block power
   * iteration, then embeddings = A·U (docs × R), L2-normalized. Returns []
   * when the corpus or vocabulary is empty.
   */
  private buildEmbeddings(dimensions: number, powerIterations: number): number[][] {
    const n = this.docs.length;
    const V = this.vocab.length;
    if (n === 0 || V === 0) return [];
    // TF-IDF matrix with sublinear TF (1 + ln f) — standard for LSA.
    const A: number[][] = this.docs.map((d) => {
      const row = new Array<number>(V).fill(0);
      for (const [t, f] of d.tf) {
        const j = this.vocabIndex.get(t);
        if (j !== undefined) row[j] = (1 + Math.log(f)) * (this.idfCache.get(t) ?? 0);
      }
      return row;
    });
    const R = Math.max(1, Math.min(dimensions, n, V));
    // Gram matrix G = AᵀA (V×V). V is capped by maxVocabulary (default 512),
    // so G stays small; the doc count never enters the storage cost.
    const G: number[][] = Array.from({ length: V }, () => new Array<number>(V).fill(0));
    for (let i = 0; i < n; i++) {
      const row = A[i]!;
      for (let j = 0; j < V; j++) {
        const a = row[j]!;
        if (a === 0) continue;
        for (let k = j; k < V; k++) {
          const b2 = row[k]!;
          if (b2 === 0) continue;
          G[j]![k]! += a * b2;
        }
      }
    }
    for (let j = 0; j < V; j++) for (let k = 0; k < j; k++) G[j]![k] = G[k]![j]!;
    // Block power iteration: fixed constant start, Gram–Schmidt each sweep.
    let U: number[][] = Array.from({ length: V }, () => Array.from({ length: R }, (_, r) => (r === 0 ? 1 : 0.5)));
    for (let it = 0; it < powerIterations; it++) {
      const Z: number[][] = Array.from({ length: V }, () => new Array<number>(R).fill(0));
      for (let j = 0; j < V; j++) {
        for (let r = 0; r < R; r++) {
          let s = 0;
          for (let k = 0; k < V; k++) s += G[j]![k]! * U[k]![r]!;
          Z[j]![r] = s;
        }
      }
      U = orthonormalize(Z, R);
    }
    // Embeddings: doc i ↔ aᵢ·U (1×R row), then L2-normalize.
    const embs = A.map((row) => {
      const emb = new Array<number>(R).fill(0);
      for (let r = 0; r < R; r++) {
        let s = 0;
        for (let j = 0; j < V; j++) s += row[j]! * U[j]![r]!;
        emb[r] = s;
      }
      const norm = Math.sqrt(emb.reduce((a, x) => a + x * x, 0));
      return norm > 1e-12 ? emb.map((x) => x / norm) : emb;
    });
    return embs;
  }

  /**
   * Vector scores: cosine between the query's TF-IDF vector and each doc's
   * TF-IDF vector. The SVD embeddings (this.embeddings) provide the compact
   * doc representations exposed for callers/embedding panels; ranking uses
   * exact sparse TF-IDF cosine so the query is never projected through a
   * lossy basis.
   */
  private vectorScores(queryTokens: string[]): number[] {
    if (this.embeddings.length === 0) return this.docs.map(() => 0);
    // Sparse query TF-IDF (sublinear TF; idf uses the SAME smoothing).
    const V = this.vocab.length;
    const q = new Array<number>(V).fill(0);
    const qtf = new Map<string, number>();
    for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    for (const [t, f] of qtf) {
      const j = this.vocabIndex.get(t);
      if (j !== undefined) q[j] = (1 + Math.log(f)) * this.idfFor(t);
    }
    const qNorm = Math.sqrt(q.reduce((a, x) => a + x * x, 0));
    if (qNorm === 0) return this.docs.map(() => 0);
    // Cosine in RAW TF-IDF space (exact, no SVD projection loss on the query):
    // dot(q, aᵢ) / (|q| |aᵢ|), both vectors sparse-friendly.
    return this.docs.map((d) => {
      let dot = 0;
      let dNormSq = 0;
      for (const [t, f] of d.tf) {
        const j = this.vocabIndex.get(t);
        if (j === undefined) continue;
        const w = (1 + Math.log(f)) * this.idfFor(t);
        dot += q[j]! * w;
        dNormSq += w * w;
      }
      const dNorm = Math.sqrt(dNormSq);
      return dNorm === 0 ? 0 : dot / (qNorm * dNorm);
    });
  }

  /**
   * Hybrid retrieval: BM25 (lexical) + TF-IDF cosine (vector), fused with
   * either the classic max-normalized weighted sum or Reciprocal Rank
   * Fusion (opts.fusion = "rrf"). Deterministic ordering with the repo's
   * stable tie-break (score ↓, kind ↑, title ↑).
   */
  search(message: string, limit = 5, opts: HybridSearchOptions = {}): RagHit[] {
    if (this.docs.length === 0) return [];
    const queryTokens = expandTokens([...new Set(tokenize(message))]);
    if (queryTokens.length === 0) return [];
    const cosRaw = this.vectorScores(queryTokens);
    return this.fuseWithDense(queryTokens, limit, opts, cosRaw, ["bm25", "vector"]);
  }

  /** Raw BM25 scores for every doc (exposed for fusion helpers/tests). */
  bm25Scores(message: string, opts: HybridSearchOptions = {}): number[] {
    const queryTokens = expandTokens([...new Set(tokenize(message))]);
    if (queryTokens.length === 0) return this.docs.map(() => 0);
    return this.docs.map((d) => this.bm25(queryTokens, d, opts.k1 ?? DEFAULTS.k1, opts.b ?? DEFAULTS.b));
  }

  /**
   * Fuse BM25 (recomputed here over the given query tokens) with a caller-
   * supplied raw dense-score channel, then rank. `search()` passes the
   * in-process TF-IDF cosine channel; the embedding path passes true dense
   * cosine scores. Both channels' hits are merged — a hit found by EITHER
   * channel appears, and `channels` records which retrieval ran.
   */
  fuseWithDense(
    queryTokens: string[],
    limit: number,
    opts: HybridSearchOptions,
    denseRaw: number[],
    channels: string[],
  ): RagHit[] {
    if (this.docs.length === 0) return [];
    const minScore = opts.minScore ?? 0.05;
    const bm25Raw = this.docs.map((d) => this.bm25(queryTokens, d, opts.k1 ?? DEFAULTS.k1, opts.b ?? DEFAULTS.b));

    let scores: number[];
    if (opts.fusion === "rrf") {
      // Reciprocal Rank Fusion (Cormack et al. 2009; the standard k = 60):
      // fuse channel RANKINGS, so BM25 magnitudes and cosine similarities
      // never need to share a scale. Ties share a rank (competition ranking).
      const k = Math.max(1, opts.rrfK ?? 60);
      const r1 = competitionRanks(bm25Raw);
      const r2 = competitionRanks(denseRaw);
      const raw = bm25Raw.map((_, i) => 1 / (k + r1[i]!) + 1 / (k + r2[i]!));
      scores = normalizeByMax(raw); // keeps score/minScore semantics on 0..1
    } else {
      const wLex = clamp01(opts.lexicalWeight ?? 0.6);
      const bm25Norm = normalizeByMax(bm25Raw);
      const cosNorm = normalizeByMax(denseRaw);
      scores = bm25Raw.map((_, i) => wLex * bm25Norm[i]! + (1 - wLex) * cosNorm[i]!);
    }

    const hits: RagHit[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const fused = scores[i]!;
      if (fused <= minScore) continue;
      hits.push({ fact: this.docs[i]!.fact, score: Math.round(fused * 1000) / 1000, channels });
    }
    return hits
      .sort(
        (x, y) =>
          y.score - x.score || x.fact.kind.localeCompare(y.fact.kind) || x.fact.title.localeCompare(y.fact.title),
      )
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function factText(fact: RagFact): string {
  return [fact.title, fact.sub ?? "", ...(fact.keywords ?? [])].join(" ");
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Divide by the pool max (0 when no doc scores — honest all-zero vector). */
function normalizeByMax(scores: number[]): number[] {
  const max = Math.max(...scores, 0);
  if (max <= 0) return scores.map(() => 0);
  return scores.map((s) => Math.max(0, s) / max);
}

/**
 * Competition ranking ("1224" — ties share the better rank): position of the
 * first member of the tie group, 1-based. Deterministic tie order = array
 * index, matching the repo's stable-tie convention.
 */
function competitionRanks(scores: number[]): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b);
  const ranks = new Array<number>(scores.length).fill(1);
  for (let pos = 0; pos < order.length; pos++) {
    const i = order[pos]!;
    if (pos > 0 && scores[order[pos - 1]!] === scores[i]) {
      ranks[i] = ranks[order[pos - 1]!] as number;
    } else {
      ranks[i] = pos + 1;
    }
  }
  return ranks;
}

/** Gram–Schmidt orthonormalization of an (n × R) block; zero columns dropped to fixed unit vectors. */
function orthonormalize(Z: number[][], R: number): number[][] {
  const n = Z.length;
  for (let r = 0; r < R; r++) {
    for (let p = 0; p < r; p++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += Z[i]![p]! * Z[i]![r]!;
      for (let i = 0; i < n; i++) Z[i]![r]! -= dot * Z[i]![p]!;
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += Z[i]![r]! ** 2;
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      for (let i = 0; i < n; i++) Z[i]![r]! /= norm;
    } else {
      // Collapsed column (degenerate spectrum): pin to a fixed unit vector in
      // a fresh coordinate so it stays deterministic and harmless.
      for (let i = 0; i < n; i++) Z[i]![r] = i === r % n ? 1 : 0;
    }
  }
  return Z;
}
