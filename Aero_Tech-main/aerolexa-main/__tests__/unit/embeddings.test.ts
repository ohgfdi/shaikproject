/**
 * Embeddings engine — oracle tests.
 *
 * The skip-gram loss has no closed form, so the oracle properties pinned here
 * are the ones that distinguish a REAL trainer from a fake one:
 *
 *  1. Vocabulary: deterministic ordering (count desc, then alphabetical),
 *     minCount filtering, encode() drops out-of-vocab tokens.
 *  2. Pair generation: a 4-token doc with window 2 yields an exact, countable
 *     pair set (hand-listed below).
 *  3. TRAINING SIGNAL: on a toy corpus where "king" co-occurs only with
 *     "crown" and never with "mango", similarity(king, crown) must END UP
 *     HIGHER than similarity(king, mango) — co-occurrence becomes geometry.
 *  4. DETERMINISM: same seed → identical vectors.
 *  5. Numerical safety: cosine handles a zero vector without NaN.
 */

import { buildVocab, cosine, encode, nearest, skipGramPairs, trainWord2vec } from "@/lib/engine/embeddings";

describe("vocabulary", () => {
  it("orders by count desc then alphabetically, honouring minCount", () => {
    const v = buildVocab(["b a b", "c b", "d"], 1);
    expect(v.tokens).toEqual(["b", "a", "c", "d"]);
    const v2 = buildVocab(["b a b", "c b", "d"], 2);
    expect(v2.tokens).toEqual(["b"]);
  });

  it("encodes to ids and drops unknown tokens", () => {
    const v = buildVocab(["b a b"]);
    expect(encode("b zzz a", v)).toEqual([v.index.get("b")!, v.index.get("a")!]);
  });
});

describe("skip-gram pairs", () => {
  it("produces the exact hand-listed pair set for window 2", () => {
    // doc [0, 1, 2, 3], window 2:
    // center 0 → contexts 1, 2
    // center 1 → contexts 0, 2, 3
    // center 2 → contexts 0, 1, 3
    // center 3 → contexts 1, 2
    const pairs = skipGramPairs([0, 1, 2, 3], 2);
    expect(pairs).toHaveLength(10);
    expect(
      pairs
        .filter((p) => p.center === 0)
        .map((p) => p.context)
        .sort(),
    ).toEqual([1, 2]);
    expect(
      pairs
        .filter((p) => p.center === 1)
        .map((p) => p.context)
        .sort(),
    ).toEqual([0, 2, 3]);
    expect(
      pairs
        .filter((p) => p.center === 2)
        .map((p) => p.context)
        .sort(),
    ).toEqual([0, 1, 3]);
    expect(
      pairs
        .filter((p) => p.center === 3)
        .map((p) => p.context)
        .sort(),
    ).toEqual([1, 2]);
  });
});

describe("training signal — co-occurrence becomes geometry", () => {
  // "king" co-occurs with "crown" but never with "mango".
  const corpus = [
    "king wears a crown",
    "the crown sits on the king",
    "a golden crown for the king",
    "king holds the crown high",
    "mango is a sweet fruit",
    "the fruit bowl has a mango",
    "mango juice from the fruit",
  ];

  const train = () => trainWord2vec(corpus, { dim: 8, window: 2, epochs: 60, lr: 0.08, negative: 3, seed: 11 });

  it("ends with similarity(king, crown) ABOVE similarity(king, mango)", () => {
    const model = train();
    const withCrown = cosine(model, "king", "crown");
    const withMango = cosine(model, "king", "mango");
    expect(withCrown).toBeGreaterThan(withMango);
  });

  it("crown ranks among king's nearest neighbours", () => {
    const model = train();
    const top = nearest(model, "king", model.vocab.tokens.length - 1);
    const crownRank = top.findIndex((n) => n.token === "crown");
    expect(crownRank).toBeGreaterThanOrEqual(0);
    // …and mango ranks BELOW crown
    const mangoRank = top.findIndex((n) => n.token === "mango");
    expect(mangoRank).toBeGreaterThan(crownRank);
  });
});

describe("determinism", () => {
  it("the same seed produces identical vectors", () => {
    const corpus = ["a b c", "b c d"];
    const opts = { dim: 4, window: 1, epochs: 5, lr: 0.1, negative: 2, seed: 3 } as const;
    const m1 = trainWord2vec(corpus, opts);
    const m2 = trainWord2vec(corpus, opts);
    expect(JSON.stringify(m1.inVectors)).toBe(JSON.stringify(m2.inVectors));
    expect(JSON.stringify(m1.outVectors)).toBe(JSON.stringify(m2.outVectors));
  });
});

describe("numerical safety", () => {
  it("cosine returns 0 (not NaN) when a vector is zero", () => {
    const model = trainWord2vec(["a b"], { dim: 3, window: 1, epochs: 0, lr: 0.1, negative: 1, seed: 1 });
    // epochs: 0 → output vectors stay zero; pin that cosine still answers.
    const v = model.inVectors[0]!;
    v[0] = 0;
    v[1] = 0;
    v[2] = 0;
    expect(cosine(model, model.vocab.tokens[0]!, model.vocab.tokens[1]!)).toBe(0);
  });
});
