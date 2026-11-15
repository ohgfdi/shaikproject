/**
 * Faceted search + saved searches + analytics — the pure core of the
 * search upgrade. Pinned without a database: the API routes compose these
 * helpers over Prisma rows.
 */

import {
  SEARCHABLE_TYPES,
  aggregateSearchAnalytics,
  applyTypeFacet,
  countTypeFacets,
  parseSavedSearchBlob,
  savedSearchHref,
  serializeSavedSearch,
  sortHits,
  validateSavedSearch,
  type FacetHit,
} from "@/lib/search/facets";

const HITS: FacetHit[] = [
  { id: "1", type: "Dashboard", title: "Sales dashboard", href: "/dashboards/1", date: "2026-09-20T10:00:00Z" },
  { id: "2", type: "Dashboard", title: "Ops dashboard", href: "/dashboards/2", date: "2026-09-25T10:00:00Z" },
  { id: "3", type: "Dataset", title: "sales.csv", href: "/datasets/3", date: "2026-09-01T10:00:00Z" },
  { id: "4", type: "Report", title: "Q3 report", href: "/reports/4", date: "2026-09-15T10:00:00Z" },
];

describe("search facets — counting and filtering", () => {
  it("counts one facet per type, ordered by count desc then name", () => {
    expect(countTypeFacets(HITS)).toEqual([
      { type: "Dashboard", count: 2 },
      { type: "Dataset", count: 1 },
      { type: "Report", count: 1 },
    ]);
  });

  it("returns [] for an empty hit list", () => {
    expect(countTypeFacets([])).toEqual([]);
  });

  it("filters hits to the selected facet; null = all", () => {
    expect(applyTypeFacet(HITS, "Dashboard").map((h) => h.id)).toEqual(["1", "2"]);
    expect(applyTypeFacet(HITS, null)).toHaveLength(4);
    expect(applyTypeFacet(HITS, "Notebook")).toEqual([]);
  });

  it("declares the canonical searchable types", () => {
    expect(SEARCHABLE_TYPES).toContain("Dataset");
    expect(SEARCHABLE_TYPES).toHaveLength(10);
  });
});

describe("search facets — sort", () => {
  it("sort=recent orders by date desc", () => {
    const sorted = sortHits(HITS, "recent");
    expect(sorted.map((h) => h.id)).toEqual(["2", "1", "4", "3"]);
  });

  it("relevance leaves the engine's ranking untouched", () => {
    expect(sortHits(HITS, "relevance")).toEqual(HITS);
  });
});

describe("saved searches — validation", () => {
  it("accepts a valid query and whitelists facet + sort", () => {
    const v = validateSavedSearch({ query: "  gst recon  ", type: "Dashboard", sort: "recent" });
    expect(v.ok).toBe(true);
    expect(v.value).toEqual({ query: "gst recon", type: "Dashboard", sort: "recent" });
  });

  it("rejects queries shorter than 2 chars or longer than the cap", () => {
    expect(validateSavedSearch({ query: "a" }).ok).toBe(false);
    expect(validateSavedSearch({ query: "x".repeat(121) }).ok).toBe(false);
    expect(validateSavedSearch({ query: "x".repeat(120) }).ok).toBe(true);
  });

  it("drops unknown facet types instead of erroring", () => {
    const v = validateSavedSearch({ query: "valid query", type: "NotAType" });
    expect(v.ok).toBe(true);
    expect(v.value?.type).toBeNull();
  });

  it("coerces anything-but-recent to relevance", () => {
    expect(validateSavedSearch({ query: "valid query", sort: "recent" }).value?.sort).toBe("recent");
    expect(validateSavedSearch({ query: "valid query" }).value?.sort).toBe("relevance");
  });
});

describe("saved searches — serialization round-trip", () => {
  it("round-trips through the JSON blob", () => {
    const v = validateSavedSearch({ query: "churn", type: "Report", sort: "recent" }).value!;
    const parsed = parseSavedSearchBlob(serializeSavedSearch(v));
    expect(parsed).toEqual(v);
  });

  it("degrades malformed blobs to null", () => {
    expect(parseSavedSearchBlob(null)).toBeNull();
    expect(parseSavedSearchBlob("not json")).toBeNull();
    expect(parseSavedSearchBlob(JSON.stringify({ query: "a" }))).toBeNull(); // too short
  });

  it("builds the reproducible /search URL", () => {
    expect(savedSearchHref({ query: "gst recon", type: "Dashboard", sort: "recent" })).toBe(
      "/search?q=gst+recon&type=Dashboard&sort=recent",
    );
    expect(savedSearchHref({ query: "plain", type: null, sort: "relevance" })).toBe("/search?q=plain");
  });
});

describe("search analytics — aggregation", () => {
  it("totals queries, zero-hits and the zero-hit rate", () => {
    const a = aggregateSearchAnalytics([
      { query: "revenue", hitCount: 5, at: new Date() },
      { query: "revenue", hitCount: 3, at: new Date() },
      { query: "zzz nothing", hitCount: 0, at: new Date() },
    ]);
    expect(a.totalQueries).toBe(3);
    expect(a.zeroHitQueries).toBe(1);
    expect(a.zeroHitRate).toBeCloseTo(0.33, 2);
    // Zero-hit queries still count as queries — they're the finding-aids signal.
    expect(a.topQueries).toEqual([
      { query: "revenue", count: 2 },
      { query: "zzz nothing", count: 1 },
    ]);
  });

  it("handles an empty log", () => {
    const a = aggregateSearchAnalytics([]);
    expect(a).toEqual({ totalQueries: 0, zeroHitQueries: 0, zeroHitRate: 0, topQueries: [] });
  });

  it("normalizes case and whitespace for the top-query counts", () => {
    const a = aggregateSearchAnalytics([
      { query: "Revenue", hitCount: 1, at: new Date() },
      { query: "  revenue ", hitCount: 1, at: new Date() },
      { query: "REVENUE", hitCount: 1, at: new Date() },
    ]);
    expect(a.topQueries).toEqual([{ query: "revenue", count: 3 }]);
  });
});
