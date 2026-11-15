/**
 * Brand — the single source of truth for the product name and the browser
 * storage namespace.
 *
 * ## Why this module exists
 *
 * The brand used to be hardcoded as the literal string "Ledgerly" in 194 files
 * and, worse, as a *storage namespace*: cookies, localStorage keys, DuckDB
 * columns, Pyodide globals and service-worker caches. A brand change therefore
 * meant a find-and-replace that silently logged every signed-in user out and
 * orphaned every stored preference.
 *
 * Two rules follow, and they are the whole point of this file:
 *
 * 1. **Never hardcode the product name.** Import `BRAND.name`. A rename is then
 *    a one-line change instead of a 194-file sweep, and the name can never
 *    drift between the landing page, the PWA manifest and the invoice PDF.
 *
 * 2. **Storage keys move forward, never backward.** `brandKey()` mints the
 *    current key; `readBrandCookie()` / `readBrandLocalStorage()` transparently
 *    fall back to the legacy `aerolexa.*` key, and `migrateBrandStorage()`
 *    rewrites it. A rename upgrades users instead of resetting them.
 *
 * ## The rename, for the record
 *
 * The product is self-hosted business intelligence for Indian finance — GST
 * reconciliation against Tally and bank statements — with every engine
 * oracle-validated in CI. The old name ("Aero", "Aero_Tech", and earlier
 * "VertaX" / "AURELIA") contained zero aerospace content and contradicted the
 * SEO keywords the app actually targets (`gst reconciliation tool`,
 * `tally data analysis`, `ca firm software`). See PRODUCT_OVERVIEW.md §18.1.
 */

/** Current brand. Referenced by UI copy, manifests, email and PDF headers. */
export const BRAND = {
  name: "Ledgerly",
  /** Machine-readable slug: storage namespace, image names, URL segments. */
  slug: "ledgerly",
  /** The job the product does, in the buyer's words (SEO + landing hero). */
  wedge: "GST reconciliation",
  tagline: "Reconcile GST the first time, every time.",
  legal: "Ledgerly",
  email: "no-reply@ledgerly.in",
  /**
   * Support/sales inbox used in the UI. Kept separate from `email` so a
   * deployment can point transactional mail at a different domain.
   */
  supportEmail: "support@ledgerly.in",
  /**
   * Trademark and legal attribution for the ledger/books metaphor. Shown in
   * the footer so the "reconcile your books" positioning is defensible.
   */
  legalEntity: "Ledgerly",
} as const;

/**
 * Previous storage namespace. Retained ONLY as a read-fallback so existing
 * installs keep their session and preferences across the rename. Nothing new
 * may be written under this namespace.
 */
export const LEGACY_BRAND_SLUG = "aerolexa";

/** Brand name as it was, for the "you're upgrading" note in the UI. */
export const LEGACY_BRAND_NAME = "Aerolexa";

/**
 * Current storage key for a logical name: `brandKey("theme")` → `"ledgerly.theme"`.
 *
 * Prefer the typed helpers below when reading — they handle the legacy
 * fallback for you.
 */
export function brandKey(name: string): string {
  return `${BRAND.slug}.${name}`;
}

/** The pre-rename counterpart of {@link brandKey}. Read-only, never written. */
export function legacyBrandKey(name: string): string {
  return `${LEGACY_BRAND_SLUG}.${name}`;
}

/**
 * Every logical cookie/localStorage key the product owns. Adding a name here
 * both mints the current key and registers the legacy alias for migration.
 */
export const BRAND_STORAGE_KEYS = {
  session: "session",
  theme: "theme",
  accent: "accent",
  locale: "locale",
  oidcState: "oidc.state",
  oidcVerifier: "oidc.verifier",
  samlRequest: "saml.request",
  tier: "tier",
  installDismissed: "install-dismissed",
} as const;

/** Cookie shape used by `@/lib/auth/cookie-store`. */
type CookieStoreLike = { get(name: string): { value: string } | undefined };

/**
 * Read a brand-namespaced cookie, falling back to the legacy key.
 *
 * This is what keeps the rename from logging out every existing user: the
 * session cookie is written under the new name on next login but is still
 * honoured under the old one until then.
 */
export function readBrandCookie<T>(store: CookieStoreLike, name: string): { value: T; migrated: boolean } | undefined {
  const current = store.get(brandKey(name));
  if (current) return { value: current.value as unknown as T, migrated: false };
  const legacy = store.get(legacyBrandKey(name));
  if (legacy) return { value: legacy.value as unknown as T, migrated: true };
  return undefined;
}

/**
 * Every legacy spelling of a logical name, newest first. The pre-rename
 * namespace was internally inconsistent — cookies used `aerolexa.theme`,
 * localStorage used `aerolexa:tier` — so both separators must be probed.
 */
function legacyBrandKeys(name: string): string[] {
  return [`${LEGACY_BRAND_SLUG}.${name}`, `${LEGACY_BRAND_SLUG}:${name}`];
}

/**
 * Read a brand-namespaced `localStorage` value, falling back to the legacy
 * key. Browser-only; returns undefined during SSR.
 */
export function readBrandLocalStorage(name: string): string | null {
  if (typeof window === "undefined") return null;
  const current = window.localStorage.getItem(brandKey(name));
  if (current !== null) return current;
  for (const legacyKey of legacyBrandKeys(name)) {
    const value = window.localStorage.getItem(legacyKey);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Write a brand-namespaced `localStorage` value and clear every legacy twin.
 * Safe to call during SSR (no-op).
 */
export function writeBrandLocalStorage(name: string, value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(brandKey(name), value);
  for (const legacyKey of legacyBrandKeys(name)) window.localStorage.removeItem(legacyKey);
}

/** Brand-namespaced key for values written directly against `localStorage`. */
export const brandLocalStorageKey = (name: string): string => brandKey(name);

/**
 * One-time client-side migration: copy any legacy `aerolexa.*` / `aerolexa:*`
 * key to its `ledgerly.*` counterpart and drop the original, so nothing dangles.
 *
 * Both separators are matched because the pre-rename namespace was not itself
 * consistent — cookies used `aerolexa.theme` while localStorage used
 * `aerolexa:tier`. The session key is deliberately excluded: it is httpOnly and
 * therefore invisible to this function, and its server-side fallback in
 * `lib/auth/session.ts` is what actually retires it.
 *
 * Runs from the app shell. Idempotent, and a no-op once the legacy keys are
 * gone — which is the steady state.
 */
export function migrateBrandStorage(): void {
  if (typeof window === "undefined") return;
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return; // storage disabled (private mode / blocked cookies) — non-fatal
  }
  // Snapshot first: removing while iterating live keys skips entries.
  const legacyKeys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key) continue;
    if (key.startsWith(`${LEGACY_BRAND_SLUG}.`) || key.startsWith(`${LEGACY_BRAND_SLUG}:`)) {
      legacyKeys.push(key);
    }
  }
  for (const legacyKey of legacyKeys) {
    const name = legacyKey.slice(LEGACY_BRAND_SLUG.length + 1);
    const currentKey = brandKey(name);
    const value = storage.getItem(legacyKey);
    if (value === null) continue;
    // Never clobber a value the user already set post-upgrade.
    if (storage.getItem(currentKey) === null) storage.setItem(currentKey, value);
    storage.removeItem(legacyKey);
  }
}
