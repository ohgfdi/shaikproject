/**
 * Cache-Control policy for API responses.
 *
 * This app is a multi-tenant BI tool: almost every endpoint returns another
 * customer's data, so the DEFAULT must be "never cache". Only responses that
 * are genuinely public — a published artifact addressed by an unguessable
 * share token — are safe to let a shared cache (CDN, corporate proxy) keep.
 *
 * Two distinct things are easy to conflate and both matter here:
 *
 *  - `public` — a shared proxy/CDN may store this. Only safe for the published
 *    artifact endpoints, whose URL *is* the capability.
 *  - `private, no-store` — the browser must not write this to disk and must not
 *    reuse it. This is the default for every authenticated response.
 *
 * The published endpoints deliberately use a SHORT public max-age rather than
 * a long one: unpublishing must take effect promptly, so a stale share link
 * cannot keep rendering for minutes. `must-revalidate` closes the gap for
 * clients that already hold a copy.
 */

/** Never cached anywhere. The default for authenticated/user-specific data. */
export const NO_STORE = "private, no-store, max-age=0";

/**
 * Published artifacts (dashboard / report / notebook share links).
 *
 * `s-maxage` lets a CDN hold it briefly while `max-age=0` keeps browsers from
 * doing so — a viewer's own browser always revalidates, but a burst of viewers
 * on the same link is served from the edge instead of hammering the database.
 */
export const PUBLIC_ARTIFACT_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300, must-revalidate";

/**
 * Immutable-ish public metadata (the OpenAPI spec, Swagger UI shell). Safe to
 * cache hard: it changes only on a deploy, and a stale spec for an hour is
 * preferable to re-serialising it per request.
 */
export const PUBLIC_STATIC_CACHE = "public, max-age=3600";

/** The ResponseInit to pass to `ok(...)` for a given policy. */
export function cacheInit(policy: string): ResponseInit {
  return { headers: { "Cache-Control": policy } };
}
