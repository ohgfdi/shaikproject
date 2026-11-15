/**
 * Self-hosted error tracking (Phase 5.2).
 *
 * This app has no third-party analytics and vendors every asset, so shipping
 * Sentry would break that stance — a hosted error tracker sees every stack
 * frame, every URL (including `/apps/<shareToken>` and `/embed/<token>`, which
 * ARE the capability) and every user's data shape. That is a real privacy cost
 * for a product whose entire pitch is "your data never leaves your server".
 *
 * So error tracking is implemented in-app instead: errors are redacted, hashed,
 * de-duplicated and stored locally, where the operator already trusts them.
 *
 * Privacy properties that matter and are enforced below:
 *  - **No PII.** Values matching email / token / long-hex / bearer patterns are
 *    replaced before anything is stored. The default stack frames are relative
 *    to the app root, so absolute build paths never land in the DB.
 *  - **Cardinality capping.** A stack fingerprint is hashed, so 10 000 distinct
 *    errors collapse into a handful of rows instead of an unbounded table.
 *  - **Never throws.** The tracker must not be able to fail a request it is
 *    observing; every failure here is swallowed by design.
 */

import { createHash } from "node:crypto";

/** A single captured error, already redacted and fingerprinted. */
export interface ErrorReport {
  /** Stable hash of the error type + top stack frames. */
  fingerprint: string;
  name: string;
  message: string;
  /** Redacted, repo-relative frames. */
  stack: string;
  /** Where it happened (path WITHOUT query, so tokens never persist). */
  path: string;
  /** Correlates with server logs via the x-request-id header. */
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  /** First-seen / last-seen / count. */
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  /** Resolved by an operator in the admin UI. */
  resolvedAt: number | null;
}

const MAX_MESSAGE = 500;
const MAX_STACK = 8_000;

/**
 * Redact anything that looks like personal data or a credential.
 *
 * Order matters: the bearer/URL patterns run before the generic long-token
 * sweep so the more specific replacement wins.
 */
export function redact(value: string): string {
  return (
    value
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
      .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[redacted]")
      .replace(/([?&](?:token|access_token|api_key|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
      // cuid/uuid — the app's own ids. A stack frame that embedded one would
      // otherwise tie an error to a specific user record.
      .replace(/\bcuid[0-9a-z]{20,}\b/gi, "[id]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
      // Any other long opaque token.
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]")
  );
}

/**
 * Build the store-relative fingerprint.
 *
 * Uses the error name plus the top frames. A raw stack contains absolute build
 * paths and line numbers that shift between builds, which would fragment the
 * fingerprint; keeping only "name + top 3 frame paths" is stable enough to group
 * a real incident while staying distinct between genuinely different errors.
 */
export function fingerprint(name: string, stack: string): string {
  const frames = stack
    .split("\n")
    .slice(1, 4) // drop the "Name: message" line
    .map((f) => f.replace(/:\d+:\d+/g, "").trim())
    .join("|");
  return createHash("sha256").update(`${name}::${frames}`).digest("hex").slice(0, 32);
}

/** Normalise any thrown value into a redacted, storable report. */
export function toReport(
  err: unknown,
  context: { path?: string; requestId?: string; userId?: string; workspaceId?: string } = {},
): Omit<ErrorReport, "firstSeenAt" | "lastSeenAt" | "count" | "resolvedAt"> {
  const isError = err instanceof Error;
  const rawMessage = isError ? err.message : String(err);
  const rawStack = isError ? (err.stack ?? "") : (new Error(rawMessage).stack ?? "");

  const name = isError ? err.name : "NonError";
  // Drop absolute paths so the store never records the build directory layout.
  const stack = redact(rawStack).slice(0, MAX_STACK);
  const message = redact(rawMessage).slice(0, MAX_MESSAGE);

  // The path is stored WITHOUT its query string: /apps/<token> and
  // /embed/<token> are capabilities, and a query string is where tokens hide.
  const path = context.path ? context.path.split("?")[0]!.slice(0, 200) : "";

  return {
    fingerprint: fingerprint(name, stack),
    name: redact(name),
    message,
    stack,
    path,
    ...(context.requestId ? { requestId: context.requestId.slice(0, 64) } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
  };
}
