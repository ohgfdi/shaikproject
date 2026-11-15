/**
 * Command-palette core — the deterministic, dependency-free pieces of the
 * ⌘K palette (ROADMAP 7.1), split from the component so they can be gated
 * by unit tests without rendering.
 *
 * Scoring is simple subsequence ranking over the title: prefix > substring >
 * subsequence > no match. Deterministic (no Math.random, no locale traps),
 * fast enough for the ≤60 hits the search API returns.
 */

/** Subsequence match score: 0 = no match; higher = better. Deterministic. */
export function scoreQuery(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  const idx = t.indexOf(q);
  if (idx === 0) return 100; // prefix match
  if (idx > 0) return 60 - Math.min(idx, 30); // substring, earlier is better
  // subsequence
  let ti = 0;
  let hits = 0;
  for (let qi = 0; qi < q.length && ti < t.length; qi++) {
    while (ti < t.length && t[ti] !== q[qi]) ti++;
    if (ti < t.length) {
      hits++;
      ti++;
    }
  }
  return hits === q.length ? 20 : 0;
}

/** Minimal hit shape shared with the component (SearchHit). */
export interface PaletteHit {
  id: string;
  type: string;
  title: string;
  sub?: string;
  href: string;
}

/** Rank search hits against the query; drops non-matches, best first. */
export function rankHits<T extends PaletteHit>(query: string, hits: T[]): T[] {
  const q = query.trim();
  if (q.length === 0) return [];
  return hits
    .map((h) => ({ h, s: Math.max(scoreQuery(q, h.title), scoreQuery(q, h.sub ?? "") * 0.5) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.h.id.localeCompare(y.h.id)) // stable tie-break
    .map((x) => x.h);
}
