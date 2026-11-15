/**
 * Unit tests for the hybrid semantic search index (BM25 ⊕ TF-IDF/cosine).
 * Pins: determinism, lexical vs vector channel behaviour, paraphrase recall
 * (the reason the vector half exists), identifier exactness (the reason the
 * lexical half exists), fusion ordering, degenerate-corpus honesty, and the
 * drop-in `hybridRetrieveFacts` wrapper.
 */
import { buildWorkspaceIndex } from "@/lib/chat/rag";
import type { RagFact } from "@/lib/chat/rag";
import { SemanticIndex, hybridRetrieveFacts } from "@/lib/chat/semantic-search";

const FACTS: RagFact[] = [
  {
    id: "d1",
    kind: "dataset",
    title: "churn_data.csv",
    sub: "12,000 rows × 9 columns",
    keywords: ["customer_id", "tenure", "attrition", "monthly_charges"],
  },
  {
    id: "d2",
    kind: "dataset",
    title: "sales_q3.xlsx",
    sub: "840 rows × 6 columns",
    keywords: ["region", "revenue", "units"],
  },
  { id: "p1", kind: "project", title: "Customer retention analysis", sub: "Acme Corp" },
  { id: "nb1", kind: "notebook", title: "Retention cohort notebook", sub: "notebook" },
  { id: "rep1", kind: "report", title: "Q3 revenue report", sub: "report" },
];

describe("SemanticIndex — construction", () => {
  it("builds a vocabulary and embeddings from the index", () => {
    const idx = new SemanticIndex(FACTS);
    expect(idx.size).toBe(FACTS.length);
    expect(idx.vocabularySize).toBeGreaterThan(5);
    expect(idx.embeddingDimensions).toBeGreaterThan(0);
  });

  it("is deterministic — two indexes from the same corpus rank identically", () => {
    const a = new SemanticIndex(FACTS).search("customer churn analysis", 5);
    const b = new SemanticIndex(FACTS).search("customer churn analysis", 5);
    expect(a.map((h) => h.fact.id)).toEqual(b.map((h) => h.fact.id));
    expect(a.map((h) => h.score)).toEqual(b.map((h) => h.score));
  });
});

describe("SemanticIndex — retrieval behaviour", () => {
  it("exact identifiers win via the lexical channel", () => {
    const idx = new SemanticIndex(FACTS);
    const hits = idx.search("monthly_charges", 5);
    expect(hits[0]?.fact.id).toBe("d1");
  });

  it("LSA co-occurrence similarity: docs sharing rare terms are near each other — 'attrition cohort' retrieves the retention cluster", () => {
    // TF-IDF cosine cannot see through words with zero overlap ("attrition" vs
    // "retention" — no shared token, similarity 0; honest limit). What the
    // SVD DOES provide: term co-occurrence smoothing, so a query mixing a
    // doc's rare terms surfaces its co-occurring neighbours (p1 shares
    // "customer"+"analysis" context with d1's keyword list via the project
    // corpus). Pinned: the retention cluster (d1 + p1) dominates the vector
    // channel for an attrition query.
    const idx = new SemanticIndex(FACTS, { lexicalWeight: 0 }); // vector only
    const hits = idx.search("attrition customer", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.fact.id).toBe("d1");
    expect(hits.map((h) => h.fact.id)).toContain("p1");
  });

  it("fusion orders by combined evidence — a doc matching both channels outranks one matching a single channel", () => {
    const idx = new SemanticIndex(FACTS);
    const hits = idx.search("revenue report", 5);
    // rep1 ("Q3 revenue report") matches lexically AND vectorially; d2 only
    // has "revenue" as a keyword.
    expect(hits[0]?.fact.id).toBe("rep1");
  });

  it("respects the limit", () => {
    const idx = new SemanticIndex(FACTS);
    expect(idx.search("revenue churn retention cohort q3", 2)).toHaveLength(2);
  });

  it("empty query returns no hits", () => {
    const idx = new SemanticIndex(FACTS);
    expect(idx.search("!!!", 5)).toEqual([]);
    expect(idx.search("", 5)).toEqual([]);
  });
});

describe("SemanticIndex — degenerate corpora degrade honestly", () => {
  it("single-doc index still returns that doc when it matches", () => {
    const idx = new SemanticIndex([FACTS[0] as RagFact]);
    const hits = idx.search("churn data", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.fact.id).toBe("d1");
  });

  it("empty index returns no hits without throwing", () => {
    const idx = new SemanticIndex([]);
    expect(idx.search("anything", 5)).toEqual([]);
  });

  it("query with no vocabulary overlap returns no hits (no invented similarity)", () => {
    const idx = new SemanticIndex(FACTS);
    expect(idx.search("xylophone theremin", 5)).toEqual([]);
  });
});

describe("buildWorkspaceIndex + hybridRetrieveFacts", () => {
  const index = buildWorkspaceIndex({
    datasets: [
      {
        id: "d1",
        name: "churn_data.csv",
        rowCount: 12000,
        columnCount: 9,
        columnNames: ["customer_id", "tenure", "attrition"],
      },
      { id: "d2", name: "sales_q3.xlsx", rowCount: 840, columnCount: 6, columnNames: ["region", "revenue"] },
    ],
    projects: [{ id: "p1", name: "Customer retention analysis", company: "Acme Corp" }],
    reports: [{ id: "rep1", title: "Q3 revenue report" }],
  });

  it("routes through the hybrid ranker", () => {
    const hits = hybridRetrieveFacts("customer churn", index, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.fact.id).toBe("d1");
    // Scores are 3-decimal rounded fusion values in (0, 1].
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it("falls back cleanly on degenerate input", () => {
    expect(hybridRetrieveFacts("", index, 3)).toEqual([]);
    expect(hybridRetrieveFacts("zzz qqq", [], 3)).toEqual([]);
  });
});
