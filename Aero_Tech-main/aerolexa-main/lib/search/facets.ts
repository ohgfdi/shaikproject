/**
 * Faceted search + saved searches — the pure core behind the upgraded
 * /search page and /api/search.
 *
 * Facets: workspace search returns typed hits (Project, Dataset, Report…).
 * This module computes type-facet counts and applies a facet filter — the
 * same shapes the API returns and the page renders, so behaviour is pinned
 * by unit tests without a database.
 *
 * Saved searches: validation + normalization for the persisted rows. A
 * saved search is (query + facet + sort) — reproducible with the same
 * ranking code, never an opaque blob.
 *
 * Search analytics: what queries ran, hit counts, zero-hit queries (the
 * finding-aids signal) and top queries for the workspace — aggregated with
 * pure reducers over the logged rows.
 */

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/** Minimal hit shape shared with the API (SearchHit). */
export interface FacetHit {
  id: string;
  type: string;
  title: string;
  sub?: string;
  href: string;
  date?: string;
}

export interface TypeFacet {
  type: string;
  count: number;
}

/** One facet bucket per hit type, ordered by count desc then name. */
export function countTypeFacets(hits: FacetHit[]): TypeFacet[] {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Hits filtered to the selected facet (empty selection = all hits). */
export function applyTypeFacet(hits: FacetHit[], selectedType: string | null): FacetHit[] {
  if (!selectedType) return hits;
  return hits.filter((h) => h.type === selectedType);
}

/** The canonical set of searchable types (drives the facet chips UI). */
export const SEARCHABLE_TYPES = [
  "Project",
  "Dataset",
  "Analysis",
  "Insight",
  "Notebook",
  "Model",
  "Prompt",
  "Dashboard",
  "Report",
  "Presentation",
] as const;

// ---------------------------------------------------------------------------
// Sort modes
// ---------------------------------------------------------------------------

export type SearchSort = "relevance" | "recent";

/** Sort hits by recency when requested; relevance order is left untouched. */
export function sortHits(hits: FacetHit[], sort: SearchSort): FacetHit[] {
  if (sort !== "recent") return hits;
  return [...hits].sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return tb - ta || a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------

export interface SavedSearchInput {
  query: string;
  type?: string | null;
  sort?: SearchSort;
}

export interface NormalizedSavedSearch {
  query: string;
  type: string | null;
  sort: SearchSort;
}

export interface SavedSearchValidation {
  ok: boolean;
  reason?: string;
  value?: NormalizedSavedSearch;
}

/** Largest query we persist — the palette and page both cap inputs lower. */
export const SAVED_SEARCH_MAX_QUERY = 120;

/**
 * Validate + normalize a save request. Mirrors the API route: trims, caps
 * length, whitelists the facet and sort. `reason` is user-displayable.
 */
export function validateSavedSearch(input: SavedSearchInput): SavedSearchValidation {
  const query = (input.query ?? "").trim();
  if (query.length < 2) return { ok: false, reason: "Search is too short to save (min 2 characters)." };
  if (query.length > SAVED_SEARCH_MAX_QUERY)
    return { ok: false, reason: `Search is too long to save (max ${SAVED_SEARCH_MAX_QUERY} characters).` };
  const type = input.type && (SEARCHABLE_TYPES as readonly string[]).includes(input.type) ? input.type : null;
  const sort: SearchSort = input.sort === "recent" ? "recent" : "relevance";
  return { ok: true, value: { query, type, sort } };
}

/** Serialize to the JSON stored in the DB column. */
export function serializeSavedSearch(v: NormalizedSavedSearch): string {
  return JSON.stringify({ query: v.query, type: v.type, sort: v.sort });
}

/** Parse a stored JSON blob; malformed rows degrade to null (skipped). */
export function parseSavedSearchBlob(raw: string | null | undefined): NormalizedSavedSearch | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const validation = validateSavedSearch({
      query: typeof parsed.query === "string" ? parsed.query : "",
      type: typeof parsed.type === "string" ? parsed.type : null,
      sort: parsed.sort === "recent" ? "recent" : "relevance",
    });
    return validation.ok ? (validation.value ?? null) : null;
  } catch {
    return null;
  }
}

/** The /search URL for a saved search — reproducible, bookmarkable. */
export function savedSearchHref(v: NormalizedSavedSearch): string {
  const params = new URLSearchParams({ q: v.query });
  if (v.type) params.set("type", v.type);
  if (v.sort === "recent") params.set("sort", "recent");
  return `/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Search analytics (pure reducers over logged query rows)
// ---------------------------------------------------------------------------

export interface SearchQueryLogRow {
  query: string;
  hitCount: number;
  at?: Date | string;
}

export interface SearchAnalytics {
  totalQueries: number;
  zeroHitQueries: number;
  zeroHitRate: number;
  topQueries: { query: string; count: number }[];
}

/**
 * Aggregate logged searches. Zero-hit queries are surfaced first-class:
 * they are the "users searched, the workspace has nothing" signal that
 * drives template and naming decisions.
 */
export function aggregateSearchAnalytics(rows: SearchQueryLogRow[]): SearchAnalytics {
  const total = rows.length;
  const zeroHit = rows.filter((r) => r.hitCount === 0).length;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.query.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const topQueries = [...counts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query))
    .slice(0, 10);
  return {
    totalQueries: total,
    zeroHitQueries: zeroHit,
    zeroHitRate: total === 0 ? 0 : Math.round((zeroHit / total) * 100) / 100,
    topQueries,
  };
}
