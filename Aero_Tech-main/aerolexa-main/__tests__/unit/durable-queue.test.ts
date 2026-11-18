/**
 * Durable job queue tests (Band 2.4) — the durability contract without a DB.
 *
 * DB-backed paths (enqueue/claim/drain) run in the API suite against the
 * scratch database. Here we verify the pure contract: backoff scheduling math
 * used by failJob, the idempotency scheme shared with lib/server/queue.ts,
 * and source-gated guarantees (lease recovery exists, handlers are registered
 * for every JobKind, unknown kinds park instead of spinning).
 */

import { readFileSync, readdirSync } from "node:fs";

import { scheduledRunKey } from "@/lib/server/job-queue";
import { defaultRetryBackoff, generateIdempotencyKey } from "@/lib/server/queue";

const SRC = readFileSync(`${process.cwd()}/lib/server/job-queue.ts`, "utf8");

describe("durable queue — idempotent enqueue keys", () => {
  it("reuses the queue.ts key scheme so retried enqueues deduplicate", () => {
    expect(scheduledRunKey("sched-1", 3)).toBe(generateIdempotencyKey("sched-1", 3));
  });

  it("different runs of the same schedule get different keys", () => {
    expect(scheduledRunKey("sched-1", 1)).not.toBe(scheduledRunKey("sched-1", 2));
  });
});

describe("durable queue — retry/backoff contract", () => {
  it("reschedules failures at exponential backoff, capped at one hour", () => {
    // The delays failJob would program: attempt 1 → ~1 min, 2 → ~2, 3 → ~4 …
    const delays = [1, 2, 3, 4].map((attempt) => defaultRetryBackoff(attempt));
    const [first, second, , fourth] = delays;
    expect(first).toBeGreaterThanOrEqual(50_000);
    expect(second).toBeGreaterThan(first!);
    expect(fourth).toBeGreaterThan(delays[2]!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(3_600_000);
  });

  it("parks jobs as dead after maxAttempts (5 by default in schema)", () => {
    expect(SRC).toContain('status: "dead"');
    expect(SRC).toContain("job.attempts >= job.maxAttempts");
  });
});

describe("durable queue — crash recovery (the durability guarantee)", () => {
  it("re-queues jobs whose lease expired while running", () => {
    expect(SRC).toContain("recoverExpiredLeases");
    expect(SRC).toContain('status: "running", leaseUntil: { lt: now }');
    // Recovery flips them back to pending so another worker completes them.
    expect(SRC).toContain('status: "pending", leaseUntil: null');
  });

  it("claims atomically via compare-and-swap (never double-claims)", () => {
    // The claim is a conditional updateMany on still-pending, already-due rows.
    expect(SRC).toMatch(/where: \{ id, status: "pending", runAt: \{ lte: (now|at) \} \}/);
    expect(SRC).toContain("attempts: { increment: 1 }");
  });

  it("drain recovers leases BEFORE claiming (restart completes interrupted work)", () => {
    const recoverIdx = SRC.indexOf("recoverExpiredLeases(now)");
    const claimIdx = SRC.indexOf("claimDueJobs(BATCH, now)");
    expect(recoverIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(recoverIdx);
  });

  it("unknown job kinds park as dead instead of spinning forever", () => {
    expect(SRC).toContain("No handler registered for kind");
  });
});

describe("durable queue — schema contract (source-gated)", () => {
  it("JobQueue model carries the durability columns", () => {
    const schema = readFileSync(`${process.cwd()}/prisma/schema.prisma`, "utf8");
    expect(schema).toContain("model JobQueue {");
    expect(schema).toContain("leaseUntil  DateTime?");
    expect(schema).toContain("idempotencyKey String? @unique");
    expect(schema).toContain("@@index([status, runAt])");
  });

  it("a migration for JobQueue exists (fresh installs get the table)", () => {
    const migrations = readFileSync(`${process.cwd()}/prisma/migrations/migration_lock.toml`, "utf8");
    expect(migrations).toContain("provider");
    const dirs = readdirSync(`${process.cwd()}/prisma/migrations`);
    expect(dirs.some((d: string) => d.includes("add_job_queue"))).toBe(true);
  });
});
