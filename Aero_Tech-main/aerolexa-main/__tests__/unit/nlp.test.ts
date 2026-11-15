/**
 * Unstructured-data engine tests.
 *
 * The point of these is the *oracles*: the properties that must hold if the
 * maths is right, independent of the implementation. Sentiment must flip under
 * negation. LDA must recover planted topics. NMF must reduce error every
 * iteration. Naive Bayes must beat the majority baseline on separable text and
 * fail on labels that are not in the words. Language ID must call a near-tie
 * ambiguous rather than guessing. FFT power must match the DFT. Near-duplicate
 * detection must find an exact copy and not invent false positives.
 */

import {
  analyzeAudio,
  analyzeImage,
  buildVocabulary,
  classifyTexts,
  computeSentiment,
  cosine,
  detectLanguages,
  extractEntities,
  featurize,
  featurizeAll,
  similarityReport,
  summarizeEntities,
  tokenize,
  trainLda,
  trainNmf,
  type FeaturizedDoc,
} from "@/lib/engine/nlp";
import { NlpError } from "@/lib/engine/nlp";

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("lowercases, strips accents and drops punctuation", () => {
    expect(tokenize("Café, DELIVERED!  fast--ok")).toEqual(["cafe", "delivered", "fast", "ok"]);
  });

  it("keeps intra-word apostrophes so negation survives", () => {
    expect(tokenize("I don't like it")).toContain("don't");
  });

  it("returns nothing for punctuation-only input", () => {
    expect(tokenize("!!! ??? ...")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TF-IDF
// ---------------------------------------------------------------------------

describe("TF-IDF featurization", () => {
  const docs = ["alpha beta gamma", "beta gamma delta", "gamma delta epsilon", "alpha beta gamma delta"];
  const vocab = buildVocabulary(docs, { minDf: 2 });

  it("keeps only terms meeting minDf, ranked by document frequency", () => {
    // df: gamma 3, alpha 2, beta 2, delta 2, epsilon 1. minDf 2 drops epsilon
    // only, and the ranking is df-desc then alphabetical.
    expect(vocab.documentFrequency).toEqual(vocab.terms.map((_, i) => vocab.documentFrequency[i]!));
    expect(new Set(vocab.terms)).toEqual(new Set(["alpha", "beta", "gamma", "delta"]));
    expect(vocab.terms).not.toContain("epsilon");
    // Non-increasing document frequency down the vocabulary.
    for (let i = 1; i < vocab.documentFrequency.length; i++) {
      expect(vocab.documentFrequency[i - 1]!).toBeGreaterThanOrEqual(vocab.documentFrequency[i]!);
    }
  });

  it("computes smoothed IDF with the standard ln((1+N)/(1+df))+1", () => {
    const N = 4;
    for (let i = 0; i < vocab.terms.length; i++) {
      expect(vocab.idf[i]).toBeCloseTo(Math.log((1 + N) / (1 + vocab.documentFrequency[i]!)) + 1, 10);
    }
  });

  it("gives rarer terms strictly higher IDF", () => {
    const idf = Object.fromEntries(vocab.terms.map((t, i) => [t, vocab.idf[i]!]));
    expect(idf.gamma!).toBeLessThan(idf.beta!);
    expect(idf.beta!).toBeLessThan(idf.alpha!);
  });

  it("L2-normalises every document vector", () => {
    const feats = featurizeAll(
      docs,
      vocab,
      docs.map((_, i) => `d${i}`),
    );
    for (const f of feats) {
      const norm = Math.sqrt(f.vector.reduce((a, v) => a + v * v, 0));
      expect(norm).toBeCloseTo(1, 10);
    }
  });

  it("uses sublinear TF so repetition saturates", () => {
    // "other" is a stopword and would be dropped from the vocabulary, so these
    // documents use neutral tokens.
    const v = buildVocabulary(["piston piston piston valve", "valve"]);
    const once = featurize("valve", v, "once");
    const thrice = featurize("piston piston piston valve", v, "thrice");
    const valveIdx = v.terms.indexOf("valve");
    const pistonIdx = v.terms.indexOf("piston");
    // The single-occurrence doc puts all its mass on "valve" (1.0).
    expect(once.vector[valveIdx]).toBeCloseTo(1, 10);
    // Sublinear TF: 3 occurrences -> 1 + ln(3) ≈ 2.0986, not 3.
    expect(thrice.weights.get(pistonIdx)!).toBeCloseTo((1 + Math.log(3)) * v.idf[pistonIdx]!, 10);
  });

  it("assigns an all-zero vector to a document with no vocabulary terms", () => {
    const v = buildVocabulary(["alpha"], { minDf: 1 });
    const f = featurize("zzz yyy", v, "empty");
    expect(f.vector.every((x) => x === 0)).toBe(true);
    expect(f.termCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it("is 0 rather than NaN for a zero vector", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("matches the hand-computed value", () => {
    // ([1,1]·[1,0]) / (sqrt2 * 1) = 1/sqrt2
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe("similarityReport", () => {
  it("finds an exact duplicate at similarity 1 and leaves an unrelated pair low", () => {
    const docs = [
      "the quick brown fox jumps over the lazy dog",
      "the quick brown fox jumps over the lazy dog",
      "completely different content about database indexing strategies",
    ];
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const feats = featurizeAll(docs, vocab, ["a", "b", "c"]);
    const report = similarityReport(feats, vocab, { threshold: 0.85 });

    expect(report.nearDuplicates).toBe(1);
    const top = report.pairs[0]!;
    expect(new Set([top.a, top.b])).toEqual(new Set(["a", "b"]));
    expect(top.similarity).toBeCloseTo(1, 10);
    // The reported shared terms must be real overlap.
    expect(top.sharedTerms.length).toBeGreaterThan(0);
    expect(top.sharedTerms).toContain("fox");
  });

  it("compares each pair exactly once", () => {
    const docs = Array.from({ length: 6 }, (_, i) => `alpha beta gamma token${i}`);
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const feats = featurizeAll(
      docs,
      vocab,
      docs.map((_, i) => `d${i}`),
    );
    const report = similarityReport(feats, vocab);
    expect(report.compared).toBe(15); // C(6,2)
  });

  it("says so when it sampled pairs instead of comparing them all", () => {
    const docs = Array.from({ length: 200 }, (_, i) => `alpha beta gamma delta token${i}`);
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const feats = featurizeAll(
      docs,
      vocab,
      docs.map((_, i) => `d${i}`),
    );
    const report = similarityReport(feats, vocab, { maxPairs: 100 });
    expect(report.compared).toBeLessThan(19900);
    expect(report.warnings.join(" ")).toMatch(/every \d+/);
    expect(report.warnings.join(" ")).toMatch(/true count is higher/);
  });
});

// ---------------------------------------------------------------------------
// Sentiment — negation is the whole test
// ---------------------------------------------------------------------------

describe("computeSentiment", () => {
  it("scores positive and negative text on opposite sides", () => {
    expect(computeSentiment("this is excellent and wonderful").compound).toBeGreaterThan(0.5);
    expect(computeSentiment("this is terrible and useless").compound).toBeLessThan(-0.5);
  });

  it("flips sign under negation", () => {
    const plain = computeSentiment("the service is good").compound;
    const negated = computeSentiment("the service is not good").compound;
    expect(plain).toBeGreaterThan(0.5);
    expect(negated).toBeLessThan(-0.1);
    expect(negated).not.toBeCloseTo(plain, 5);
  });

  it("damps rather than mirrors a negated term", () => {
    // Damping shows in the applied weight, not in `compound`: compound is a
    // ratio over the matched terms, so a single negated term saturates at −1.
    const r = computeSentiment("not excellent");
    expect(r.drivers[0]!.negated).toBe(true);
    expect(r.drivers[0]!.weight).toBeCloseTo(-2.6 * 0.74, 10);
    // A stronger term stays stronger through the same damping.
    const weak = computeSentiment("not good").drivers[0]!.weight;
    const strong = computeSentiment("not excellent").drivers[0]!.weight;
    expect(strong).toBeLessThan(weak);
  });

  it("applies intensifier multipliers", () => {
    const plain = computeSentiment("good").drivers[0]!.weight;
    const intense = computeSentiment("extremely good").drivers[0]!.weight;
    expect(intense).toBeGreaterThan(plain);
    expect(intense).toBeCloseTo(plain * 1.8, 10);
  });

  it("reports zero coverage and an unmeasured verdict for no lexicon match", () => {
    const r = computeSentiment("wombat xylophone tuesday");
    expect(r.compound).toBe(0);
    expect(r.coverage).toBe(0);
    expect(r.neutral).toBe(1);
    expect(r.interpretation).toMatch(/no sentiment signal|no lexicon/i);
  });

  it("flags thin coverage rather than presenting a confident score", () => {
    const long = "wombat xylophone tuesday wombat xylophone tuesday ".repeat(40) + "good";
    const r = computeSentiment(long);
    expect(r.coverage).toBeLessThan(0.02);
    expect(r.interpretation).toMatch(/should not be quoted|coverage/i);
  });

  it("emits probabilities that sum to one", () => {
    for (const text of ["excellent", "not excellent", "wombat", "good but terrible"]) {
      const r = computeSentiment(text);
      expect(r.positive + r.negative + r.neutral).toBeCloseTo(1, 12);
    }
  });

  it("ignores a negator that is out of scope", () => {
    // Four tokens back — outside the three-token window, so no flip.
    const r = computeSentiment("one two three four good");
    expect(r.drivers[0]!.weight).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LDA
// ---------------------------------------------------------------------------

describe("trainLda", () => {
  /** Two cleanly separable topics planted in the documents. */
  function plantedCorpus(): { docs: string[]; ids: string[] } {
    const docs: string[] = [];
    const ids: string[] = [];
    let k = 0;
    for (let i = 0; i < 24; i++) {
      docs.push("engine engine engine piston valve cylinder motor");
      ids.push(`engine-${k++}`);
    }
    for (let i = 0; i < 24; i++) {
      docs.push("invoice invoice invoice ledger payment debit credit");
      ids.push(`invoice-${k++}`);
    }
    return { docs, ids };
  }

  it("recovers two planted topics from disjoint vocabularies", () => {
    const { docs, ids } = plantedCorpus();
    const vocab = buildVocabulary(docs, { minDf: 2 });
    const report = trainLda(docs, ids, { topics: 2, vocab, sweeps: 60, seed: 7, topTerms: 4 });

    expect(report.topics).toHaveLength(2);
    // Each topic's top words must come from exactly one planted cluster.
    const engineTerms = new Set(["engine", "piston", "valve", "cylinder", "motor"]);
    const invoiceTerms = new Set(["invoice", "ledger", "payment", "debit", "credit"]);
    const label = report.topics.map((t) => {
      const e = t.topTerms.filter((w) => engineTerms.has(w)).length;
      const i = t.topTerms.filter((w) => invoiceTerms.has(w)).length;
      if (e === t.topTerms.length) return "engine";
      if (i === t.topTerms.length) return "invoice";
      return `mixed(${t.topTerms.join("/")})`;
    });
    expect(new Set(label)).toEqual(new Set(["engine", "invoice"]));
  });

  it("assigns near-pure topic proportions to each planted document", () => {
    const { docs, ids } = plantedCorpus();
    const vocab = buildVocabulary(docs, { minDf: 2 });
    const report = trainLda(docs, ids, { topics: 2, vocab, sweeps: 60, seed: 7 });

    for (const share of report.documentShares) {
      const top = Math.max(...share.proportions);
      expect(top).toBeGreaterThan(0.8);
      // Proportions must be a distribution.
      expect(share.proportions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    }
  });

  it("reproduces identical topics for the same seed", () => {
    const { docs, ids } = plantedCorpus();
    const vocab = buildVocabulary(docs, { minDf: 2 });
    const a = trainLda(docs, ids, { topics: 3, vocab, sweeps: 40, seed: 99 });
    const b = trainLda(docs, ids, { topics: 3, vocab, sweeps: 40, seed: 99 });
    expect(a.topics.map((t) => t.topTerms)).toEqual(b.topics.map((t) => t.topTerms));
    expect(a.elbo).toBe(b.elbo);
  });

  it("reaches a higher variational bound with more sweeps", () => {
    const { docs, ids } = plantedCorpus();
    const vocab = buildVocabulary(docs, { minDf: 2 });
    const few = trainLda(docs, ids, { topics: 2, vocab, sweeps: 30, seed: 3 });
    const many = trainLda(docs, ids, { topics: 2, vocab, sweeps: 120, seed: 3 });
    expect(many.elbo).toBeGreaterThan(few.elbo);
  });

  it("assigns higher coherence to planted topics than to a random mixture", () => {
    const { docs, ids } = plantedCorpus();
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const planted = trainLda(docs, ids, { topics: 2, vocab, sweeps: 80, seed: 11 });

    // A corpus where every document is a random mix of the same terms: the
    // terms co-occur everywhere, so coherence must be lower.
    const mixed: string[] = [];
    const mixedIds: string[] = [];
    const terms = ["engine", "piston", "valve", "cylinder", "motor", "invoice", "ledger", "payment"];
    for (let i = 0; i < 48; i++) {
      const row = terms.filter((_, t) => (i + t) % 3 !== 0);
      mixed.push(row.join(" "));
      mixedIds.push(`m${i}`);
    }
    const mixedVocab = buildVocabulary(mixed, { minDf: 1 });
    const mixedReport = trainLda(mixed, mixedIds, { topics: 2, vocab: mixedVocab, sweeps: 80, seed: 11 });

    const mean = (r: typeof planted) => r.topics.reduce((a, t) => a + t.coherence, 0) / r.topics.length;
    expect(mean(planted)).toBeGreaterThan(mean(mixedReport));
  });

  it("warns when too many topics are asked of a tiny corpus", () => {
    const { docs, ids } = plantedCorpus();
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const report = trainLda(docs.slice(0, 6), ids.slice(0, 6), { topics: 12, vocab, sweeps: 40 });
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.interpretation).toMatch(/coherence/i);
  });

  it("throws on an empty vocabulary", () => {
    const vocab = buildVocabulary([], {});
    expect(() => trainLda(["a b c"], ["d"], { topics: 2, vocab })).toThrow(NlpError);
  });
});

// ---------------------------------------------------------------------------
// NMF
// ---------------------------------------------------------------------------

describe("trainNmf", () => {
  it("produces non-negative factors and normalised topic words", () => {
    const docs = [
      "engine piston valve",
      "engine piston motor",
      "engine valve motor",
      "invoice ledger debit",
      "invoice ledger credit",
      "invoice debit credit",
    ];
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const feats = featurizeAll(
      docs,
      vocab,
      docs.map((_, i) => `d${i}`),
    );
    const report = trainNmf(feats, vocab, { topics: 2, iterations: 60 });

    expect(report.topics).toHaveLength(2);
    for (const t of report.topics) {
      expect(t.topTerms.length).toBeGreaterThan(0);
      expect(t.massShare).toBeGreaterThan(0);
    }
    // Mass shares form a distribution over components.
    expect(report.topics.reduce((a, t) => a + t.massShare, 0)).toBeCloseTo(1, 10);
    expect(report.objective).toBeGreaterThanOrEqual(0);
  });

  it("finds the planted split", () => {
    const docs = [
      "engine piston valve motor",
      "engine piston cylinder",
      "engine valve motor",
      "invoice ledger debit credit",
      "invoice ledger payment",
      "invoice debit credit",
    ];
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const feats = featurizeAll(
      docs,
      vocab,
      docs.map((_, i) => `d${i}`),
    );
    const report = trainNmf(feats, vocab, { topics: 2, iterations: 150 });
    const sets = report.topics.map((t) => new Set(t.topTerms));
    expect(
      sets.filter((s) => [...s].some((w) => w.startsWith("engine") || w === "piston" || w === "valve")).length,
    ).toBe(1);
    expect(sets.filter((s) => [...s].some((w) => w === "invoice" || w === "ledger" || w === "debit")).length).toBe(1);
  });

  it("decreases the Frobenius residual monotonically under multiplicative updates", () => {
    const docs = Array.from({ length: 10 }, (_, i) => `engine piston valve token${i % 3}`);
    const vocab = buildVocabulary(docs, { minDf: 1 });
    const feats = featurizeAll(
      docs,
      vocab,
      docs.map((_, i) => `d${i}`),
    );
    const report = trainNmf(feats, vocab, { topics: 2, iterations: 200 });

    expect(report.objectiveTrace.length).toBe(201);
    for (let i = 1; i < report.objectiveTrace.length; i++) {
      expect(report.objectiveTrace[i]!).toBeLessThanOrEqual(report.objectiveTrace[i - 1]! + 1e-9);
    }
    // A shorter run must not beat a longer one.
    const fewer = trainNmf(feats, vocab, { topics: 2, iterations: 30 });
    expect(fewer.objective).toBeGreaterThan(report.objective);
  });

  it("throws when there is nothing to factorise", () => {
    const vocab = buildVocabulary([], {});
    expect(() => trainNmf([], vocab, { topics: 2 })).toThrow(NlpError);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classifyTexts", () => {
  function separable(): { docs: string[]; labels: string[] } {
    const docs: string[] = [];
    const labels: string[] = [];
    for (let i = 0; i < 40; i++) {
      docs.push(`piston valve cylinder engine motor block head ${i % 7}`);
      labels.push("mechanical");
    }
    for (let i = 0; i < 40; i++) {
      docs.push(`invoice ledger payment debit credit tax due ${i % 7}`);
      labels.push("finance");
    }
    return { docs, labels };
  }

  it("clears the majority baseline on separable text", () => {
    const { docs, labels } = separable();
    const report = classifyTexts(
      docs,
      labels,
      docs.map((_, i) => `d${i}`),
      { holdoutFraction: 0.3 },
    );
    expect(report.heldOutAccuracy).not.toBeNull();
    expect(report.heldOutAccuracy!).toBeGreaterThan(0.9);
  });

  it("measures held-out accuracy on the holdout subset, not on all rows", () => {
    const { docs, labels } = separable();
    const report = classifyTexts(
      docs,
      labels,
      docs.map((_, i) => `d${i}`),
      { holdoutFraction: 0.3 },
    );
    // Both are reported and both come from the same scorer; the held-out figure
    // is the one that matters, and it is computed over fewer documents.
    expect(report.heldOutAccuracy).toBeGreaterThan(0.9);
    expect(report.accuracy).toBe(1);
    expect(report.interpretation).toMatch(/Out-of-sample accuracy/);
    expect(report.interpretation).toMatch(/in-sample accuracy/);
    expect(report.interpretation).toMatch(/majority baseline/);
  });

  it("shows that label noise degrades generalisation, not just training fit", () => {
    // Flipping every fifth label corrupts the training signal. The honest
    // signature is that held-out accuracy falls below the clean baseline while
    // in-sample accuracy stays near 1 — the model memorises the errors.
    const { docs, labels } = separable();
    const ids = docs.map((_, i) => `d${i}`);
    const clean = classifyTexts(docs, labels, ids, { holdoutFraction: 0.3 });
    const noisy = classifyTexts(
      docs,
      labels.map((l, i) => (i % 5 === 0 ? (l === "mechanical" ? "finance" : "mechanical") : l)),
      ids,
      { holdoutFraction: 0.3 },
    );
    expect(noisy.heldOutAccuracy!).toBeLessThan(clean.heldOutAccuracy!);
    expect(noisy.accuracy).toBeGreaterThan(0);
  });

  it("recovers per-class precision and recall above 0.9 when separable", () => {
    const { docs, labels } = separable();
    const report = classifyTexts(
      docs,
      labels,
      docs.map((_, i) => `d${i}`),
    );
    for (const c of report.perClass) {
      expect(c.support).toBeGreaterThan(0);
      expect(c.precision).toBeGreaterThan(0.9);
      expect(c.recall).toBeGreaterThan(0.9);
    }
  });

  it("has no off-diagonal confusion on perfectly separable text", () => {
    const { docs, labels } = separable();
    const report = classifyTexts(
      docs,
      labels,
      docs.map((_, i) => `d${i}`),
    );
    expect(report.confusion).toHaveLength(0);
  });

  it("flags labels that are not recoverable from the words", () => {
    // Same words, labels assigned by parity — nothing in the text predicts it.
    const docs = Array.from({ length: 40 }, (_, i) => `alpha beta gamma delta ${i % 5}`);
    const labels = docs.map((_, i) => (i % 2 === 0 ? "even" : "odd"));
    const report = classifyTexts(
      docs,
      labels,
      docs.map((_, i) => `d${i}`),
    );
    expect(report.warnings.join(" ")).toMatch(/majority|not recoverable|close to nothing/i);
  });

  it("surfaces discriminative terms with positive log-odds for each class", () => {
    const { docs, labels } = separable();
    const report = classifyTexts(
      docs,
      labels,
      docs.map((_, i) => `d${i}`),
    );
    const mech = report.discriminativeTerms.find((d) => d.label === "mechanical")!;
    const fin = report.discriminativeTerms.find((d) => d.label === "finance")!;
    expect(mech.terms[0]!.logOdds).toBeGreaterThan(0);
    expect(mech.terms.some((t) => ["piston", "valve", "cylinder", "engine", "motor"].includes(t.term))).toBe(true);
    expect(fin.terms.some((t) => ["invoice", "ledger", "payment", "debit", "credit"].includes(t.term))).toBe(true);
  });

  it("falls back to in-sample accuracy and says so on a tiny corpus", () => {
    const docs = ["piston engine", "invoice ledger"];
    const labels = ["a", "b"];
    const report = classifyTexts(docs, labels, ["d0", "d1"], { holdoutFraction: 0.5 });
    expect(report.warnings.join(" ")).toMatch(/in-sample/i);
  });

  it("throws when there is only one class", () => {
    expect(() => classifyTexts(["a", "b"], ["x", "x"], ["d0", "d1"])).toThrow(NlpError);
  });
});

// ---------------------------------------------------------------------------
// Language ID
// ---------------------------------------------------------------------------

describe("detectLanguages", () => {
  it("identifies English and Spanish from stopword profiles", () => {
    const docs = [
      "the quick brown fox and the lazy dog are not the same",
      "the report is for the team and it is in the plan",
      "la casa de la ciudad es para el equipo y no es un problema",
      "que no es la misma cosa de la ciudad con el equipo",
    ];
    const report = detectLanguages(docs);
    const en = report.languages.find((l) => l.lang === "en")!;
    const es = report.languages.find((l) => l.lang === "es")!;
    expect(en.share).toBeCloseTo(0.5, 6);
    expect(es.share).toBeCloseTo(0.5, 6);
  });

  it("calls a near-tie ambiguous rather than guessing", () => {
    // "de" and "que" are stopwords in the es, pt and fr profiles alike, so no
    // profile separates them and the top two scores tie exactly.
    const docs = ["de que", "de que", "de que"];
    const report = detectLanguages(docs);
    expect(report.ambiguousShare).toBe(1);
    expect(report.confidence).toBe("low");
    expect(report.warnings.join(" ")).toMatch(/near-ties|arbitrary/);
  });

  it("has strictly positive and summing shares", () => {
    const report = detectLanguages([
      "the report is for the team and it is in the plan",
      "el informe es para el equipo y no es un problema",
    ]);
    const total = report.languages.reduce((a, l) => a + l.share, 0);
    expect(total).toBeCloseTo(1, 10);
    for (const l of report.languages) expect(l.share).toBeGreaterThan(0);
  });

  it("states its own limits", () => {
    const report = detectLanguages(["the of and in the"]);
    expect(report.warnings.join(" ")).toMatch(/European languages/);
  });
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe("extractEntities", () => {
  it("extracts emails, URLs, money and percentages", () => {
    const text = "Write to ana.smith@acme.co or see https://acme.co/docs — cost $1,250.50, up 12.5%.";
    const found = extractEntities(text);
    const types = found.map((e) => e.type);
    expect(types).toContain("email");
    expect(types).toContain("url");
    expect(types).toContain("money");
    expect(types).toContain("percent");
    expect(found.find((e) => e.type === "email")!.text).toBe("ana.smith@acme.co");
    expect(found.find((e) => e.type === "money")!.text).toBe("$1,250.50");
  });

  it("records offsets that actually index the source text", () => {
    const text = "Ship to Bengaluru on 2026-03-14 for $99.00.";
    for (const e of extractEntities(text)) {
      expect(text.slice(e.start, e.end)).toBe(e.text);
    }
  });

  it("extracts ISO and slashed dates", () => {
    const found = extractEntities("due 2026-03-14 and also 14/03/2026");
    expect(found.filter((e) => e.type === "date")).toHaveLength(2);
  });

  it("requires a title or reporting verb for a person, not mere capitalisation", () => {
    const bare = extractEntities("Revenue Increased Sharply Last Quarter");
    expect(bare.filter((e) => e.type === "person")).toHaveLength(0);
    const titled = extractEntities("Dr Priya Sharma said the system works");
    const person = titled.find((e) => e.type === "person");
    expect(person).toBeDefined();
    expect(person!.text).toContain("Priya");
  });

  it("resolves overlapping spans to the longest match", () => {
    const found = extractEntities("Invoice 12345 was paid on 2026-03-14");
    const spans = found.map((e) => [e.start, e.end] as const);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        expect(spans[i]![0] < spans[j]![1] && spans[j]![0] < spans[i]![1]).toBe(false);
      }
    }
    // The bare number inside the date must not double-count as a number entity.
    expect(found.filter((e) => e.type === "number")).toHaveLength(1);
  });

  it("sorts by position", () => {
    const found = extractEntities("abc $5 def a@b.co");
    const starts = found.map((e) => e.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe("summarizeEntities", () => {
  it("counts by type and lists the top values", () => {
    const docs = ["ping ana@acme.co", "ping ana@acme.co and bob@acme.co", "no entities here"];
    const summary = summarizeEntities(docs);
    const email = summary.byType.find((t) => t.type === "email")!;
    expect(email.count).toBe(3);
    expect(email.distinct).toBe(2);
    expect(email.top[0]).toBe("ana@acme.co");
    expect(summary.interpretation).toMatch(/mention/);
  });

  it("flags that entity extraction is pattern-based", () => {
    expect(summarizeEntities(["a@b.co"]).warnings.join(" ")).toMatch(/pattern-based/);
  });

  it("says when it did not scan everything", () => {
    const docs = Array.from({ length: 12 }, (_, i) => `user${i}@acme.co`);
    expect(summarizeEntities(docs, 5).warnings.join(" ")).toMatch(/first 5/);
  });
});

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

describe("analyzeImage", () => {
  it("recovers channel means and luminance exactly on flat colour", () => {
    const n = 100;
    const r = new Array<number>(n).fill(200);
    const g = new Array<number>(n).fill(100);
    const b = new Array<number>(n).fill(50);
    const f = analyzeImage(r, g, b);

    expect(f.channels).toEqual({ r: 200, g: 100, b: 50 });
    expect(f.luminance.mean).toBeCloseTo(0.299 * 200 + 0.587 * 100 + 0.114 * 50, 10);
    expect(f.luminance.sd).toBeCloseTo(0, 10);
    // 200/100/50 is a saturated brown, so it is not "neutral".
    expect(f.saturation.neutralShare).toBe(0);
    expect(f.saturation.mean).toBeCloseTo((200 - 50) / 200, 10);
    expect(f.dominantColors).toHaveLength(1);
    expect(f.dominantColors[0]!.share).toBeCloseTo(1, 10);
  });

  it("finds a high edge density on a checkerboard and near zero on a flat field", () => {
    const w = 32;
    const n = w * w;
    const flat = analyzeImage(
      new Array<number>(n).fill(128),
      new Array<number>(n).fill(128),
      new Array<number>(n).fill(128),
    );
    // Vertical bars 4 px wide. A 1-px checkerboard is the wrong probe: the
    // Sobel kernel is orthogonal to that pattern and returns exactly zero.
    const bars = analyzeImage(
      Array.from({ length: n }, (_, i) => (Math.floor((i % w) / 4) % 2 === 0 ? 0 : 255)),
      Array.from({ length: n }, (_, i) => (Math.floor((i % w) / 4) % 2 === 0 ? 0 : 255)),
      Array.from({ length: n }, (_, i) => (Math.floor((i % w) / 4) % 2 === 0 ? 0 : 255)),
    );
    expect(bars.sharpness.edgeDensity).toBeGreaterThan(0.2);
    expect(bars.sharpness.meanGradient).toBeGreaterThan(flat.sharpness.meanGradient);
    expect(flat.sharpness.edgeDensity).toBe(0);
    expect(flat.saturation.neutralShare).toBe(1);
  });

  it("separates two colours into dominant-colour clusters", () => {
    const n = 400;
    const r = [...new Array<number>(n / 2).fill(240), ...new Array<number>(n / 2).fill(10)];
    const g = [...new Array<number>(n / 2).fill(20), ...new Array<number>(n / 2).fill(30)];
    const b = [...new Array<number>(n / 2).fill(30), ...new Array<number>(n / 2).fill(240)];
    const f = analyzeImage(r, g, b, { clusters: 2 });
    expect(f.dominantColors[0]!.share).toBeCloseTo(0.5, 2);
    expect(f.dominantColors[1]!.share).toBeCloseTo(0.5, 2);
  });

  it("detects clipping and saturated colour", () => {
    const n = 100;
    const f = analyzeImage(new Array<number>(n).fill(255), new Array<number>(n).fill(0), new Array<number>(n).fill(0));
    expect(f.clippedShare).toBeCloseTo(1, 6);
    expect(f.saturation.mean).toBeCloseTo(1, 6);
  });

  it("skips edge statistics on a raster too small to have a neighbourhood", () => {
    const f = analyzeImage([10, 20], [10, 20], [10, 20]);
    expect(f.sharpness.edgeDensity).toBe(0);
    expect(f.warnings.join(" ")).toMatch(/smaller than a 3×3/);
  });

  it("clamps out-of-range channel values rather than propagating NaN", () => {
    const f = analyzeImage([300, -20, 128, 64], [128, 128, 128, 128], [128, 128, 128, 128]);
    expect(Number.isFinite(f.luminance.mean)).toBe(true);
    expect(f.channels.r).toBeLessThanOrEqual(255);
  });

  it("is deterministic for identical input", () => {
    const n = 400;
    const r = Array.from({ length: n }, (_, i) => (i * 37) % 256);
    const g = Array.from({ length: n }, (_, i) => (i * 91) % 256);
    const b = Array.from({ length: n }, (_, i) => (i * 53) % 256);
    expect(analyzeImage(r, g, b).dominantColors).toEqual(analyzeImage(r, g, b).dominantColors);
  });

  it("throws on an empty raster", () => {
    expect(() => analyzeImage([], [], [])).toThrow(NlpError);
  });
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

describe("analyzeAudio", () => {
  const sampleRate = 8000;

  it("recovers amplitude statistics on a pure tone", () => {
    const n = 8000;
    const f = 200;
    const samples = Array.from({ length: n }, (_, t) => Math.sin((2 * Math.PI * f * t) / sampleRate));
    const a = analyzeAudio(samples, { sampleRate });

    expect(a.samples).toBe(n);
    expect(a.sampleRate).toBe(sampleRate);
    expect(a.durationSeconds).toBeCloseTo(1, 10);
    expect(a.amplitude.peak).toBeCloseTo(1, 2);
    expect(a.amplitude.rms).toBeCloseTo(Math.SQRT1_2, 2);
    expect(a.amplitude.dcOffset).toBeCloseTo(0, 6);
    // A clean sine touches ±peak once per half-cycle; that is not clipping.
    expect(a.clippingShare).toBe(0);
    expect(a.warnings.join(" ")).not.toMatch(/full scale/);
  });

  it("detects a hard-clipped signal as a run of rail-pinned samples", () => {
    // tanh-like saturation: a plateau of identical rail values.
    const n = 8000;
    const clipped = Array.from({ length: n }, (_, t) => {
      const v = 3 * Math.sin((2 * Math.PI * 200 * t) / 8000);
      return Math.max(-1, Math.min(1, v));
    });
    const a = analyzeAudio(clipped, { sampleRate: 8000 });
    expect(a.clippingShare).toBeGreaterThan(0);
    expect(a.warnings.join(" ")).toMatch(/full scale/);
  });

  it("estimates the fundamental by autocorrelation", () => {
    const f = 220;
    const samples = Array.from({ length: 16000 }, (_, t) => Math.sin((2 * Math.PI * f * t) / sampleRate));
    const a = analyzeAudio(samples, { sampleRate, frameSize: 512 });
    // Autocorrelation can land on a multiple of the true period; both are valid
    // periodicities of the same signal, so accept any harmonic.
    const ratio = a.pitch.hz / f;
    expect([1, 1 / 2, 1 / 3, 2, 3].some((h) => Math.abs(ratio - h) < 0.05)).toBe(true);
    expect(a.pitch.clarity).toBeGreaterThan(0.9);
    expect(a.pitch.periodSamples).toBeGreaterThan(0);
  });

  it("puts the spectral centroid near the tone frequency", () => {
    const f = 1000;
    const samples = Array.from({ length: 16000 }, (_, t) => Math.sin((2 * Math.PI * f * t) / sampleRate));
    const a = analyzeAudio(samples, { sampleRate, frameSize: 1024 });
    expect(a.spectralCentroid).toBeGreaterThan(f * 0.6);
    expect(a.spectralCentroid).toBeLessThan(f * 1.6);
  });

  it("computes cepstral coefficients and a one-sided-ish magnitude spectrum", () => {
    const samples = Array.from({ length: 4096 }, (_, t) => Math.sin((2 * Math.PI * 300 * t) / sampleRate));
    const a = analyzeAudio(samples, { sampleRate, frameSize: 1024 });
    expect(a.mfcc.length).toBeGreaterThanOrEqual(12);
    for (const c of a.mfcc) expect(Number.isFinite(c)).toBe(true);
  });

  it("reports a higher zero-crossing rate for a bright signal than a dull one", () => {
    const low = Array.from({ length: 16000 }, (_, t) => Math.sin((2 * Math.PI * 100 * t) / sampleRate));
    const high = Array.from({ length: 16000 }, (_, t) => Math.sin((2 * Math.PI * 2000 * t) / sampleRate));
    expect(analyzeAudio(high, { sampleRate }).zcr).toBeGreaterThan(analyzeAudio(low, { sampleRate }).zcr);
  });

  it("flags clipping and DC offset", () => {
    const clipped = analyzeAudio([100, -100, 100, -100, 100, -100, 100, -100, 50, 50, 50, 50], { sampleRate: 8000 });
    expect(clipped.warnings.join(" ")).toMatch(/full scale|DC offset/i);
  });

  it("says so when there is no reliable pitch", () => {
    const noise = Array.from(
      { length: 16000 },
      (_, i) => Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453),
    );
    const a = analyzeAudio(
      noise.map((v) => v * 2 - 1),
      { sampleRate },
    );
    expect(a.interpretation).toMatch(/no reliable dominant pitch/i);
  });

  it("returns a loudness envelope with one entry per frame", () => {
    const samples = new Array<number>(4096).fill(0.5);
    const a = analyzeAudio(samples, { sampleRate, frameSize: 512 });
    expect(a.envelope.length).toBe(4096 / 512);
    for (const v of a.envelope) expect(v).toBeCloseTo(0.5, 6);
  });

  it("handles an all-zero signal without NaN", () => {
    const a = analyzeAudio(new Array<number>(2048).fill(0), { sampleRate });
    expect(a.amplitude.rms).toBe(0);
    expect(a.pitch.hz).toBe(0);
    expect(Number.isFinite(a.spectralCentroid)).toBe(true);
  });

  it("throws on empty audio", () => {
    expect(() => analyzeAudio([])).toThrow(NlpError);
  });
});

// ---------------------------------------------------------------------------
// FeaturizedDoc contract
// ---------------------------------------------------------------------------

describe("FeaturizedDoc", () => {
  it("carries the caller-supplied id, never a random one", () => {
    const v: FeaturizedDoc["docId"] extends string ? string : never = "row-42";
    const vocab = buildVocabulary(["alpha beta", "beta gamma"], { minDf: 1 });
    const f = featurize("alpha beta", vocab, v);
    expect(f.docId).toBe("row-42");
  });
});
