/**
 * Unit tests for the retrieval reranker (lib/chat/rerank.ts).
 *
 * Oracles: exact BM25 arithmetic against the hand-computed Okapi formula,
 * coverage as a plain ratio, minimal-window proximity on constructed token
 * streams, the fixed logistic fusion weights, monotonicity properties, the
 * stable tie-break ordering, and honest skips of candidates missing from the
 * index.
 */
import type { RagFact, RagHit } from "@/lib/chat/rag";
import { minQuerySpan, Reranker } from "@/lib/chat/rerank";

const fact = (id: string, title: string, sub?: string, keywords?: string[]): RagFact => ({
  id,
  kind: "dataset",
  title,
  sub,
  keywords,
});
const hit = (f: RagFact, score = 1): RagHit => ({ fact: f, score });

describe("minQuerySpan", () => {
  it("returns 1/ln(span + e) for a hand-computed window", () => {
    // "q a q b" with query [q, b]: both terms present; the sweep finds the
    // tightest covering window. Occurrences: q@0, q@2, b@3 → best window
    // q@2..b@3 → span = 3 − 2 + 1 = 2 → 1/ln(2 + e).
    const span = minQuerySpan(["q", "b"], ["q", "a", "q", "b"]);
    expect(span).toBeCloseTo(1 / Math.log(2 + Math.E), 12);
  });

  it("scores adjacency highest", () => {
    const adjacent = minQuerySpan(["a", "b"], ["x", "a", "b", "x"]);
    const scattered = minQuerySpan(["a", "b"], ["a", "x", "x", "x", "x", "x", "b"]);
    // a@1, b@2 → span 2 → 1/ln(2 + e).
    expect(adjacent).toBeCloseTo(1 / Math.log(2 + Math.E), 12);
    expect(scattered).toBeLessThan(adjacent);
    expect(scattered).toBeGreaterThan(0);
  });

  it("returns 0 when any query term is missing (honest worst proximity)", () => {
    expect(minQuerySpan(["a", "z"], ["a", "a", "b"])).toBe(0);
    expect(minQuerySpan(["a"], [])).toBe(0);
    expect(minQuerySpan([], ["a", "b"])).toBe(0);
  });

  it("finds the minimal window across repeats", () => {
    // a@0, b@1 and a@9, b@10 — tightest window is 0..1 → span 2.
    const s = minQuerySpan(["a", "b"], ["a", "b", "x", "x", "x", "x", "x", "x", "x", "a", "b"]);
    expect(s).toBeCloseTo(1 / Math.log(2 + Math.E), 12);
  });
});

describe("Reranker", () => {
  const index: RagFact[] = [
    fact("1", "churn model", "customers at risk", ["churn", "risk"]),
    fact("2", "sales report", "monthly revenue by region", ["sales", "revenue"]),
    fact("3", "churn and sales combined dashboard", "everything everywhere"),
  ];
  const reranker = new Reranker(index);

  it("indexes only docs with tokens and exposes the size", () => {
    expect(reranker.size).toBe(3);
    expect(new Reranker([fact("e", "", undefined, [])]).size).toBe(0);
  });

  it("computes BM25 exactly against the Okapi formula", () => {
    // Doc "churn model customers at risk" after rag tokenize: [churn, model,
    // customers, at, risk] — 5 tokens ("at" survives: length 2 > 1).
    const query = "churn";
    const out = reranker.rerank(query, [hit(index[0]!)], 5);
    expect(out.length).toBe(1);
    const k1 = 1.5;
    const b = 0.75;
    const n = 3;
    const df = 2; // "churn" appears in docs 1 and 3
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    // Doc TEXT = title + sub + keywords (the reranker indexes factText):
    //   doc1: "churn model customers at risk" + [churn, risk] → 7 tokens, f(churn) = 2
    //   doc2: "sales report monthly revenue by region" + [sales, revenue] → 8 tokens
    //   doc3: "churn and sales combined dashboard everything everywhere" → 7 tokens
    const f = 2;
    const len = 7;
    const avgLen = (7 + 8 + 7) / 3;
    const bm25 = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    expect(out[0]!.features.bm25).toBeCloseTo(Number(bm25.toFixed(3)), 9);
    // Coverage: 1 of 1 distinct query terms present.
    expect(out[0]!.features.coverage).toBe(1);
    // Squashed BM25 fed into the fixed logistic: z = −1.5 + 3·(1−e^{−bm25}) + 2.5·1 + 1.5·proximity.
    const bm25Norm = 1 - Math.exp(-bm25);
    const proximity = minQuerySpan(["churn"], ["churn", "model", "customers", "at", "risk", "churn", "risk"]);
    const z = -1.5 + 3 * bm25Norm + 2.5 * 1 + 1.5 * proximity;
    expect(out[0]!.score).toBeCloseTo(Number((1 / (1 + Math.exp(-z))).toFixed(3)), 9);
    expect(out[0]!.firstStageScore).toBe(1);
    expect(out[0]!.fact.id).toBe("1");
  });

  it("prefers full coverage and tight proximity over partial overlap", () => {
    const query = "churn sales";
    const out = reranker.rerank(query, [hit(index[2]!), hit(index[1]!), hit(index[0]!)], 5);
    // Doc 3 contains BOTH terms → coverage 1; docs 1/2 have coverage 0.5.
    expect(out[0]!.fact.id).toBe("3");
    expect(out[0]!.features.coverage).toBe(1);
    const partial = out.find((o) => o.fact.id === "1")!;
    expect(partial.features.coverage).toBe(0.5);
    expect(partial.features.proximity).toBe(0); // "sales" missing → worst proximity
  });

  it("orders strictly by score, then kind, then title on ties", () => {
    const a = fact("a", "alpha doc", "same words here");
    const b = fact("b", "beta doc", "same words here");
    const rr = new Reranker([a, b]);
    const q = "words";
    const hits = [hit(b), hit(a)]; // first stage prefers b
    const out = rr.rerank(q, hits, 5);
    // Identical features → identical scores → tie broken by title: "alpha" < "beta".
    expect(out.map((o) => o.fact.id)).toEqual(["a", "b"]);
    // The first-stage order does NOT leak into the reranked order.
    expect(out.map((o) => o.firstStageScore)).toEqual([1, 1]);
  });

  it("applies limit, minScore and reports provenance channels", () => {
    const out = reranker.rerank("churn", [hit(index[0]!, 0.9), hit(index[2]!, 0.5)], 1);
    expect(out.length).toBe(1);
    expect(out[0]!.channels).toEqual([]);
    const withChannels = reranker.rerank("churn", [{ fact: index[0]!, score: 0.9, channels: ["bm25", "vector"] }], 5);
    expect(withChannels[0]!.channels).toEqual(["bm25", "vector"]);
    const strict = reranker.rerank("churn", [hit(index[0]!)], 5, { minScore: 0.999999 });
    expect(strict.length).toBe(0);
  });

  it("skips candidates that are not in the index (honestly)", () => {
    const ghost = fact("ghost", "invisible doc");
    const out = reranker.rerank("invisible doc", [hit(ghost), hit(index[0]!)], 5);
    expect(out.length).toBe(1);
    expect(out[0]!.fact.id).toBe("1");
  });

  it("returns [] for an empty/token-free query", () => {
    expect(reranker.rerank("!!", [hit(index[0]!)], 5)).toEqual([]);
    expect(reranker.rerank("", [hit(index[0]!)], 5)).toEqual([]);
  });

  it("honors custom k1/b weights deterministically", () => {
    const q = "churn";
    const h = [hit(index[0]!)];
    const base = reranker.rerank(q, h, 5);
    const tuned = reranker.rerank(q, h, 5, { k1: 1.2, b: 0.3, weights: [-1, 4, 2, 1] });
    // Different hyperparameters ⇒ different (deterministic) scores.
    expect(tuned[0]!.score).not.toBeCloseTo(base[0]!.score, 3);
    expect(tuned[0]!.score).toBeGreaterThan(0);
    expect(tuned[0]!.score).toBeLessThan(1);
  });

  it("is deterministic across runs (byte-identical ranking)", () => {
    const q = "churn sales risk";
    const hs = [hit(index[2]!), hit(index[0]!), hit(index[1]!)];
    const run = () =>
      reranker
        .rerank(q, hs, 5)
        .map((o) => [o.fact.id, o.score, o.features.bm25, o.features.coverage, o.features.proximity].join("|"))
        .join(";");
    expect(run()).toBe(run());
  });
});
