/**
 * Cross-replica bus — multi-replica safety without an external broker.
 *
 * Two hazards appear when one app instance becomes many:
 *
 * 1. RATE LIMITS. The in-memory store is per-process: N replicas multiply the
 *    effective limit by N and an attacker round-robins across them. The bus
 *    accumulates consumption per window in the shared database, and every
 *    replica reconciles its local counter against that ledger, so the
 *    cluster-wide budget cannot be exceeded by more than one in-flight
 *    request per replica (the same 1×N relaxation any eventually-consistent
 *    limiter — Redis included — exhibits under concurrency).
 *
 * 2. COLLAB DIVERGENCE. Collab rooms are in-memory Y.Docs, so two replicas
 *    serving the same notebook would split the peers into two disjoint rooms
 *    and their debounced whole-JSON persists would last-writer-wins over each
 *    other, silently losing keystrokes. The bus relays every applied Yjs
 *    update through the shared database (Yjs updates are commutative and
 *    idempotent, so at-least-once delivery converges) and replays peers'
 *    unseen updates into each replica's doc.
 *
 * Everything here FAILS OPEN to the in-process behavior when the database is
 * unreachable: a limiter reconciliation error just skips that sync; a relay
 * publish error is swallowed (the local room still works; cross-replica peers
 * resync on their next poll). A database outage must degrade amenities, never
 * take the API down.
 */

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";

/** Identity of this process within the deployment (per boot). */
export const REPLICA_ID = `r_${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Collaborative update relay (Yjs updates, base64)
// ---------------------------------------------------------------------------

/** How often connected peers poll for cross-replica updates. */
export const RELAY_POLL_MS = 2_000;
/** Relay rows older than this are pruned; live rooms re-sync well inside it. */
const RELAY_TTL_MS = 10 * 60_000;
/** Yjs updates are small (deltas); a hard cap keeps one request bounded. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Publish an applied Yjs update so other replicas can replay it into their
 * room. Fire-and-forget: the local room is already correct.
 */
export async function publishCollabUpdate(notebookId: string, update: Uint8Array): Promise<void> {
  if (update.byteLength > MAX_PAYLOAD_BYTES) return; // absurd payload — never relay it
  try {
    await prisma.collaborativeUpdate.create({
      data: { notebookId, replicaId: REPLICA_ID, payload: Buffer.from(update).toString("base64") },
    });
  } catch {
    // Fail open: cross-replica peers re-sync on their next poll/join.
  }
}

/**
 * Fetch relayed updates for a notebook that THIS replica did not publish,
 * oldest first, then opportunistically prune stale rows.
 */
export async function fetchRemoteCollabUpdates(notebookId: string): Promise<Uint8Array[]> {
  try {
    const rows = await prisma.collaborativeUpdate.findMany({
      // notIn also excludes the reserved ledger replica, so even a notebookId
      // that collides with the ledger keyspace can never leak ledger JSON
      // into the Yjs update stream.
      where: { notebookId, replicaId: { notIn: [REPLICA_ID, LEDGER_REPLICA] } },
      orderBy: { id: "asc" },
      take: 500,
    });
    void pruneRelay();
    return rows.map((r) => new Uint8Array(Buffer.from(r.payload, "base64")));
  } catch {
    return [];
  }
}

/** Delete relay rows older than the TTL (best-effort, from any replica). */
async function pruneRelay(): Promise<void> {
  try {
    await prisma.collaborativeUpdate.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - RELAY_TTL_MS) } },
    });
  } catch {
    // another replica already pruned, or the DB is down — either is fine
  }
}

/**
 * Merge a batch of remote updates into a room doc. Returns the merged full
 * state when anything changed, so callers can fan out a convergence update.
 */
export function mergeRemoteUpdates(
  doc: { applyUpdate: (u: Uint8Array) => void },
  updates: Uint8Array[],
): { changed: boolean; merged?: Uint8Array } {
  let changed = false;
  for (const u of updates) {
    try {
      doc.applyUpdate(u);
      changed = true;
    } catch {
      // A corrupt relay row must not poison the room — skip it.
    }
  }
  return { changed };
}

// ---------------------------------------------------------------------------
// Rate-limit window ledger (cross-replica consumption accounting)
// ---------------------------------------------------------------------------

// Storage: rows in CollaborativeUpdate keyed by a reserved notebookId
// keyspace — one relay table, one indexing scheme, no extra migration.
// Printable-only (cuid() notebook ids are alphanumeric, so "__rl__" can never
// collide), because NUL bytes in TEXT are driver-hostile.
const LEDGER_PREFIX = "__rl__|";
const LEDGER_REPLICA = "__ledger"; // replicaId marker so relay reads filter these out trivially
const RATE_LEDGER_TTL_MS = 60 * 60_000; // longest window (upload) + slack

type Ledger = Record<string, { count: number; resetAt: number }>;

function encodeLedger(ledger: Ledger): string {
  return JSON.stringify(ledger);
}

function decodeLedger(raw: string): Ledger {
  try {
    const parsed = JSON.parse(raw) as Ledger;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function ledgerRowKey(bucketName: string, key: string): string {
  // The "__rl__|" prefix keeps this disjoint from any real cuid() notebook id.
  return `${LEDGER_PREFIX}${bucketName}|${key}`;
}

/**
 * Per-rowKey write serialization. `checkRateLimit` fires reconciliation
 * fire-and-forget, so two syncs for the same window can be in flight at once;
 * if both pass the `findFirst → create` path they plant two ledger rows and
 * the newest-id row decides what later readers merge into — a later-synced
 * LOWER count would then regress the cluster budget from the visible truth.
 * Chaining per rowKey keeps a replica's own writes ordered; cross-replica
 * races still relax by at most the in-flight 1×N the doc comment above
 * acknowledges.
 */
const rowLocks = new Map<string, Promise<unknown>>();

/**
 * Merge local consumption into the shared ledger and return the cluster-wide
 * window state for the requested bucket+key. The merge is monotone per
 * window: every replica pushes its consumption in and reads back at least
 * what it contributed, so the cluster budget cannot be exceeded by more than
 * the in-flight requests racing one sync (the same 1×N relaxation any
 * eventually-consistent limiter exhibits under concurrency).
 */
export async function syncRateLimitWindow(
  bucketName: string,
  key: string,
  localCount: number,
  windowMs: number,
  now: number = Date.now(),
  onError?: (err: unknown) => void,
): Promise<{ count: number; resetAt: number }> {
  const rowKey = ledgerRowKey(bucketName, key);
  const previous = rowLocks.get(rowKey) ?? Promise.resolve();
  const chain: Promise<{ count: number; resetAt: number }> = previous
    .then(() => mergeRateLimitWindow(key, rowKey, localCount, windowMs, now, onError))
    .catch(() => {
      // mergeRateLimitWindow already fail-opens via onError; never let a
      // rejected promise poison the chain for the next caller.
      return { count: localCount, resetAt: now + windowMs };
    })
    .finally(() => {
      // Drop the lock once no further sync is chained behind this one, so
      // the map can never grow unbounded.
      if (rowLocks.get(rowKey) === chain) rowLocks.delete(rowKey);
    });
  rowLocks.set(rowKey, chain);
  return await chain;
}

async function mergeRateLimitWindow(
  key: string,
  rowKey: string,
  localCount: number,
  windowMs: number,
  now: number,
  onError?: (err: unknown) => void,
): Promise<{ count: number; resetAt: number }> {
  const entry = { count: localCount, resetAt: now + windowMs };
  try {
    const existing = await prisma.collaborativeUpdate.findFirst({
      where: { notebookId: rowKey },
      orderBy: { id: "desc" },
      select: { id: true, payload: true },
    });
    if (!existing) {
      // First sync for this window — seed the ledger row.
      await prisma.collaborativeUpdate.create({
        data: { notebookId: rowKey, replicaId: LEDGER_REPLICA, payload: encodeLedger({ [key]: entry }) },
      });
      return entry;
    }
    const ledger = decodeLedger(existing.payload);
    const shared = ledger[key];
    // Expired window: the local counter restarts it.
    if (!shared || shared.resetAt <= now) {
      await prisma.collaborativeUpdate.update({
        where: { id: existing.id },
        data: { payload: encodeLedger({ [key]: entry }) },
      });
      return entry;
    }
    // Live window: cluster count = max(shared ledger, local).
    const count = Math.max(shared.count, localCount);
    const merged = { count, resetAt: shared.resetAt };
    if (count !== shared.count) {
      await prisma.collaborativeUpdate.update({
        where: { id: existing.id },
        data: { payload: encodeLedger({ ...ledger, [key]: merged }) },
      });
    }
    return merged;
  } catch (err) {
    // DB unavailable: report the local state — fail open to single-replica
    // behavior rather than erroring the request. The caller is notified via
    // onError so the degradation can be surfaced (it is still fail-open).
    onError?.(err);
    return entry;
  }
}

/**
 * Periodic GC of ledger rows whose windows expired everywhere. Pruned by
 * createdAt (the row's own start-of-window clock), best-effort.
 */
export async function pruneRateLimitLedger(now: number = Date.now()): Promise<void> {
  try {
    await prisma.collaborativeUpdate.deleteMany({
      where: {
        notebookId: { startsWith: LEDGER_PREFIX },
        createdAt: { lt: new Date(now - RATE_LEDGER_TTL_MS) },
      },
    });
  } catch {
    // Best-effort GC.
  }
}

// Reserved keyspace marker — exported for tests to assert relay reads never
// see ledger rows (they filter by notebookId equality, so they can't).
export const _internals = { LEDGER_PREFIX, LEDGER_REPLICA, RATE_LEDGER_TTL_MS };
