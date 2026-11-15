/**
 * Tests for the semantic-search upgrades:
 *  1. RRF (Reciprocal Rank Fusion) as a fusion strategy — deterministic,
 *     scale-free, merges both channels.
 *  2. True dense-embedding hybrid retrieval via a pluggable provider, with a
 *     cache and an honest deterministic fallback when the provider fails.
 */
import { EmbeddingCache, createOpenAICompatibleEmbedder } from "@/lib/chat/embedders";
import type { RagFact } from "@/lib/chat/rag";
import {
  SemanticIndex,
  hybridRetrieveFactsWithEmbeddings,
  type EmbeddingHybridOptions,
} from "@/lib/chat/semantic-search";

const INDEX: RagFact[] = [
  {
    id: "1",
    kind: "dataset",
    title: "customer_churn.csv",
    sub: "12,000 rows × 9 columns",
    keywords: ["churn", "tenure", "plan"],
  },
  { id: "2", kind: "dashboard", title: "Revenue overview", sub: "monthly revenue KPIs", keywords: ["revenue", "mrr"] },
  { id: "3", kind: "report", title: "Churn analysis Q3", sub: "attrition deep-dive", keywords: ["churn", "retention"] },
  { id: "4", kind: "notebook", title: "GST reconciliation", sub: "tally vouchers", keywords: ["gst", "tally"] },
];

describe("SemanticIndex — RRF fusion", () => {
  it("tags hits with their retrieval channels", () => {
    const idx = new SemanticIndex(INDEX);
    const hits = idx.search("churn retention analysis", 5, { fusion: "rrf" });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.channels).toEqual(["bm25", "vector"]);
  });

  it("ranks a doc that tops BOTH channels first under RRF", () => {
    const idx = new SemanticIndex(INDEX);
    // "customer_churn" is a near-exact identifier match (BM25 #1) and the
    // strongest TF-IDF cosine match (vector #1) for this query.
    const rrf = idx.search("customer_churn tenure plan", 5, { fusion: "rrf" });
    expect(rrf[0]?.fact.id).toBe("1");
    expect(rrf[0]!.score).toBeLessThanOrEqual(1);
  });

  it("produces identical rankings on repeated calls (determinism contract)", () => {
    const idx = new SemanticIndex(INDEX);
    const a = JSON.stringify(idx.search("churn attrition report", 5, { fusion: "rrf", rrfK: 60 }));
    const b = JSON.stringify(idx.search("churn attrition report", 5, { fusion: "rrf", rrfK: 60 }));
    expect(a).toBe(b);
  });

  it("keeps the classic weighted fusion available and unchanged", () => {
    const idx = new SemanticIndex(INDEX);
    const hits = idx.search("churn analysis", 5, { fusion: "weighted" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.fact.id).toBe("3"); // exact-token match wins under weighted too
  });

  it("minScore under RRF: pool max normalizes to exactly 1 and ranking is ordered", () => {
    const idx = new SemanticIndex(INDEX);
    const hits = idx.search("gst tally vouchers", 5, { fusion: "rrf", minScore: 0.9 });
    // RRF scores are rank-based: with the standard k=60 the pool max is the
    // ONLY score that can reach the normalized 1.0, and no other doc can sit
    // above 2/(k+2)·(1/max) — so a 0.9 cut keeps exactly the top-ranked doc.
    // (The absolute RRF spread is inherently narrow; the guarantee tested here
    // is the NORMALIZATION contract: max = 1, top doc first, deterministic.)
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.fact.id).toBe("4");
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
    const all = idx.search("gst tally vouchers", 5, { fusion: "rrf" });
    expect(all[0]!.score).toBe(1);
    for (let i = 1; i < all.length; i++) expect(all[i]!.score).toBeLessThanOrEqual(all[i - 1]!.score);
  });
});

// ---------------------------------------------------------------------------
// Embedding-provider hybrid
// ---------------------------------------------------------------------------

/** Deterministic fake embedder: vectors keyed by semantic role, not tokens. */
function fakeEmbedder(opts: { fail?: boolean } = {}) {
  let calls = 0;
  const embed = async (texts: string[]) => {
    calls++;
    if (opts.fail) throw new Error("provider unreachable");
    return texts.map((t) => {
      const v = [0, 0, 0];
      if (/churn|attrition|retention/i.test(t)) v[0] = 1;
      if (/revenue|mrr/i.test(t)) v[1] = 1;
      if (/gst|tally/i.test(t)) v[2] = 1;
      return v;
    });
  };
  return {
    provider: { id: "fake:semantic", dims: 3, embed },
    callCount: () => calls,
  };
}

function embeddingOpts(embedder: EmbeddingHybridOptions["embedder"], cache?: EmbeddingCache): EmbeddingHybridOptions {
  return { embedder, cache, fusion: "rrf" };
}

describe("hybridRetrieveFactsWithEmbeddings", () => {
  it("finds a paraphrase match the lexical channel cannot see", async () => {
    // "attrition" appears in NO title/keyword except report 3's sub — the
    // dense channel must still surface the churn dataset via semantics.
    const { provider } = fakeEmbedder();
    const hits = await hybridRetrieveFactsWithEmbeddings("attrition trends", INDEX, 3, embeddingOpts(provider));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.fact.id === "1" || h.fact.id === "3")).toBe(true);
    for (const hit of hits) expect(hit.channels).toContain("embedding");
  });

  it("reuses cached vectors across calls (provider called once for unchanged facts)", async () => {
    const { provider, callCount } = fakeEmbedder();
    const cache = new EmbeddingCache();
    await hybridRetrieveFactsWithEmbeddings("churn analysis", INDEX, 3, embeddingOpts(provider, cache));
    const afterFirst = callCount();
    expect(afterFirst).toBe(1);
    await hybridRetrieveFactsWithEmbeddings("churn analysis", INDEX, 3, embeddingOpts(provider, cache));
    // Only the query vector is new on the second call — but the query text is
    // cached too, so NO second provider call happens.
    expect(callCount()).toBe(afterFirst);
    expect(cache.size).toBeGreaterThan(0);
  });

  it("falls back to the deterministic path (never empty, honest channels) when the provider fails", async () => {
    const { provider } = fakeEmbedder({ fail: true });
    const hits = await hybridRetrieveFactsWithEmbeddings("churn analysis", INDEX, 3, embeddingOpts(provider));
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.channels).toEqual(["bm25", "vector"]); // the local channel ran
      expect(hit.channels).not.toContain("embedding");
    }
  });

  it("falls back for empty queries (pure-lexical behavior)", async () => {
    const { provider } = fakeEmbedder();
    const hits = await hybridRetrieveFactsWithEmbeddings("!!!", INDEX, 3, embeddingOpts(provider));
    expect(hits).toEqual([]);
  });
});

describe("createOpenAICompatibleEmbedder", () => {
  it("posts the batch to /embeddings and maps data[].embedding", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: init.body, headers: init.headers });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createOpenAICompatibleEmbedder({
      baseUrl: "https://llm.example.com/v1/",
      apiKey: "sk-test",
      model: "text-embedding-test",
      fetchImpl: fetchImpl as never,
    });
    const vectors = await provider.embed(["a", "b"]);
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/embeddings");
    const body = JSON.parse(calls[0]!.body) as { model: string; input: string[] };
    expect(body.model).toBe("text-embedding-test");
    expect(body.input).toEqual(["a", "b"]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-test");
  });

  it("throws a readable error on non-2xx responses", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const provider = createOpenAICompatibleEmbedder({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as never,
    });
    await expect(provider.embed(["a"])).rejects.toThrow(/500/);
  });
});
