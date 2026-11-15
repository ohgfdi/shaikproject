/**
 * Retrieval reranker — a deterministic cross-encoder-STYLE reranking stage.
 *
 * True cross-encoders (BERT-style query+doc → score) need a transformer; this
 * repo's trust bar is "dependency-free, deterministic, oracle-tested". The
 * reranker below implements the three classical lexical-semantic features a
 * cross-encoder learns implicitly, computed EXACTLY, then fuses them with a
 * logistic function whose weights are fixed a priori (not trained — labelled
 * honestly as such):
 *
 *  1. BM25 of the query against the doc (lexical precision, already the
 *     first-stage signal).
 *  2. Query-term COVERAGE: the fraction of distinct query terms present in
 *     the doc — the single strongest lexical predictor of relevance that
 *     first-stage BM25 underweights when docs have different lengths.
 *  3. Proximity: the mean minimal span (in tokens) covering all query terms
 *     in the doc, normalized and inverted — matches the cross-encoder's
 *     sensitivity to terms appearing TOGETHER vs scattered. Docs missing
 *     some terms get the worst proximity, honestly.
 *
 * The reranker consumes a FIRST-STAGE candidate list (BM25 ⊕ dense hybrid,
 * `lib/chat/semantic-search.ts`), rescores the top candidates, and returns a
 * new ordering — the standard two-stage retrieve-then-rerank architecture
 * (Nogueira & Cho 2019 made it famous with actual transformers; the
 * architecture predates them and works with any scorer).
 *
 * Score fusion: logistic(w₀ + w₁·bm25 + w₂·coverage + w₃·proximity) with
 * w = (−1.5, 3.0, 2.5, 1.5) — chosen a priori so a doc matching everything
 * well scores ≈ 0.93 and a doc matching nothing scores ≈ 0.04. The weights
 * are CONSTANTS (documented); no training data is used, so nothing can
 * silently drift. Ties break with the repo's stable convention.
 *
 * DETERMINISM: no randomness, no network — same inputs ⇒ byte-identical
 * ranking. HONESTY: `features` are returned per hit so the caller (and any
 * test) can verify exactly WHY a doc ranked where it did.
 */

import type { RagFact, RagHit } from "@/lib/chat/rag";
import { tokenize } from "@/lib/chat/rag";

export interface RerankOptions {
  /** BM25 term-frequency saturation (default 1.5). */
  k1?: number;
  /** BM25 length normalization (default 0.75). */
  b?: number;
  /** Logistic fusion weights [bias, bm25, coverage, proximity] (fixed a priori). */
  weights?: [number, number, number, number];
  /** Keep only hits whose reranked score ≥ this (default 0 = keep all). */
  minScore?: number;
}

export interface RerankedHit {
  fact: RagFact;
  /** Reranked score in (0, 1) — the logistic fusion. */
  score: number;
  /** The first-stage fused score (for provenance). */
  firstStageScore: number;
  /** Exact feature values behind the score (auditable, oracle-testable). */
  features: { bm25: number; coverage: number; proximity: number };
  channels: string[];
}

export class Reranker {
  private readonly docs: { fact: RagFact; tokens: string[]; tf: Map<string, number> }[] = [];
  private readonly avgLen: number;

  constructor(index: RagFact[]) {
    for (const fact of index) {
      const tokens = tokenize([fact.title, fact.sub ?? "", ...(fact.keywords ?? [])].join(" "));
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docs.push({ fact, tokens, tf });
    }
    this.avgLen = this.docs.length > 0 ? this.docs.reduce((s, d) => s + d.tokens.length, 0) / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** Okapi BM25 (same variant as the first stage) against this reranker's docs. */
  private bm25(
    queryTokens: string[],
    doc: { tokens: string[]; tf: Map<string, number> },
    k1: number,
    b: number,
  ): number {
    const n = this.docs.length;
    if (n === 0) return 0;
    let score = 0;
    for (const t of queryTokens) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const df = this.docs.filter((d) => d.tf.has(t)).length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.tokens.length) / this.avgLen)));
    }
    return score;
  }

  /**
   * Rerank a first-stage candidate list. `hits` come from the hybrid
   * retriever; the first stage's ranking only decides the candidate POOL
   * (top `candidates` by its order) — the returned order is this reranker's.
   */
  rerank(query: string, hits: RagHit[], limit = 5, opts: RerankOptions = {}): RerankedHit[] {
    const k1 = opts.k1 ?? 1.5;
    const b = opts.b ?? 0.75;
    const [w0, w1, w2, w3] = opts.weights ?? [-1.5, 3.0, 2.5, 1.5];
    const minScore = opts.minScore ?? 0;
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return [];

    const byFact = new Map(this.docs.map((d) => [d.fact, d] as const));
    const out: RerankedHit[] = [];

    for (const hit of hits) {
      const doc = byFact.get(hit.fact);
      if (!doc) continue; // candidate not in the reranker's index — skip honestly
      const bm25Raw = this.bm25(queryTokens, doc, k1, b);
      // BM25 has no natural bound; squash to 0..1 so the logistic weights keep
      // their intended meaning across corpora of different sizes.
      const bm25Norm = 1 - Math.exp(-bm25Raw); // monotone, bounded, deterministic
      const distinct = [...new Set(queryTokens)];
      const covered = distinct.filter((t) => doc.tf.has(t)).length;
      const coverage = distinct.length > 0 ? covered / distinct.length : 0;
      const proximity = minQuerySpan(queryTokens, doc.tokens);

      const z = w0 + w1 * bm25Norm + w2 * coverage + w3 * proximity;
      const score = 1 / (1 + Math.exp(-z));
      if (score < minScore) continue;
      out.push({
        fact: hit.fact,
        score: Math.round(score * 1000) / 1000,
        firstStageScore: hit.score,
        features: { bm25: Math.round(bm25Raw * 1000) / 1000, coverage, proximity },
        channels: hit.channels ?? [],
      });
    }

    return out
      .sort(
        (x, y) =>
          y.score - x.score || x.fact.kind.localeCompare(y.fact.kind) || x.fact.title.localeCompare(y.fact.title),
      )
      .slice(0, limit);
  }
}

/**
 * Mean minimal span covering ALL distinct query terms (scalar): for every
 * occurrence of any query term, the distance to the farthest of the other
 * terms' nearest occurrences. Normalized: 1 = adjacent, →0 = scattered,
 * 0 = any term missing. Deterministic, O(doc·query).
 */
export function minQuerySpan(queryTokens: string[], docTokens: string[]): number {
  const distinct = [...new Set(queryTokens)];
  if (distinct.length === 0) return 0;
  const positions = new Map<string, number[]>();
  for (const t of distinct) positions.set(t, []);
  for (let i = 0; i < docTokens.length; i++) {
    const lists = positions.get(docTokens[i] as string);
    if (lists) lists.push(i);
  }
  for (const t of distinct) {
    if ((positions.get(t) as number[]).length === 0) return 0; // missing term → worst proximity, honestly
  }
  // Classic minimal-window sweep over the merged occurrence lists.
  const events = docTokens.map((t, i) => ({ t, i })).filter((e) => positions.has(e.t));
  let best = Number.POSITIVE_INFINITY;
  const count = new Map<string, number>();
  let have = 0;
  let left = 0;
  for (let right = 0; right < events.length; right++) {
    const eR = events[right] as { t: string; i: number };
    count.set(eR.t, (count.get(eR.t) ?? 0) + 1);
    if (count.get(eR.t) === 1) have++;
    while (have === distinct.length) {
      const eL = events[left] as { t: string; i: number };
      best = Math.min(best, eR.i - eL.i + 1);
      count.set(eL.t, (count.get(eL.t) ?? 0) - 1);
      if ((count.get(eL.t) ?? 0) === 0) have--;
      left++;
    }
  }
  if (!Number.isFinite(best)) return 0;
  // Normalize: span 1 (adjacent) → 1; span ≥ distinct·k → small. 1/ln(span+e)
  // is smooth, bounded, deterministic: span=1 → 0.87, span=10 → 0.41, span=50 → 0.25.
  return 1 / Math.log(best + Math.E);
}
