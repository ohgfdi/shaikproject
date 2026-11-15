/**
 * Connector resilience — retry with exponential backoff + full jitter, and a
 * bounded-concurrency parallel pull pool.
 *
 * Closes the connectors' biggest operational gap: a single transient failure
 * (connection reset, rate limit, 502 from a gateway) used to fail an entire
 * sync. Pulls are read-only idempotent SELECTs, so retrying the WHOLE pull is
 * always safe — no partial state to unwind.
 *
 * Determinism contract: backoff delays use FULL JITTER (AWS recipe) over an
 * exponential cap — `sleep = rand() * min(cap, base * 2^attempt)` — with the
 * RNG and the sleep function INJECTED so tests are deterministic and no
 * engine output ever depends on the jitter (only WHEN a retry happens does).
 *
 * Classification is conservative by design: only errors that are transient
 * with high probability (network resets, timeouts, 429, 5xx) are retried.
 * Everything else — auth failures, bad configs, missing tables, malformed
 * input — fails immediately with the engine's own message.
 */

import { ConnectorError } from "./errors";

/** Errors with this name (thrown below) are always retried. */
export class TransientConnectorError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TransientConnectorError";
  }
}

const TRANSIENT_MESSAGE_PATTERNS = [
  /econnreset/i,
  /econnaborted/i,
  /etimedout/i,
  /timeout (exceeded|expired)|connect timeout|query timeout/i,
  /eai_again/i,
  /socket hang up/i,
  /rate limit|too many requests/i,
  /temporarily unavailable/i,
  /bad gateway|gateway timeout|service unavailable|internal server error/i,
];

/**
 * Conservative transient classification: ConnectorError with a retryable HTTP
 * status, a recognized network/rate-limit message, or an explicit
 * TransientConnectorError. Unknown errors are NOT retried (fail fast).
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TransientConnectorError) return true;
  if (err instanceof ConnectorError) {
    const status = (err as unknown as { status?: number }).status;
    if (typeof status === "number") {
      if (status === 408 || status === 429) return true;
      if (status >= 500 && status <= 599) return true;
    }
    return TRANSIENT_MESSAGE_PATTERNS.some((p) => p.test(err.message));
  }
  if (err instanceof Error) return TRANSIENT_MESSAGE_PATTERNS.some((p) => p.test(err.message));
  return false;
}

export interface RetryOptions {
  /** Retry attempts AFTER the initial try (default 2 → up to 3 executions). */
  retries?: number;
  /** Base backoff cap in ms for attempt 0 (default 250). */
  baseDelayMs?: number;
  /** Maximum backoff cap in ms (default 8_000). */
  maxDelayMs?: number;
  /** Injectable sleep (tests pass an instantaneous recorder). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG (tests pin sequences). */
  rand?: () => number;
  /** Override transient classification (e.g. to retry a custom error type). */
  isTransient?: (err: unknown) => boolean;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with exponential backoff + full jitter on transient failures.
 * The LAST error is rethrown when attempts are exhausted — callers always see
 * the engine's own final message, never a swallowed one.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 2);
  const base = Math.max(1, opts.baseDelayMs ?? 250);
  const maxCap = Math.max(base, opts.maxDelayMs ?? 8_000);
  const sleep = opts.sleep ?? sleepDefault;
  const rand = opts.rand ?? Math.random;
  const transient = opts.isTransient ?? isTransientError;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !transient(err)) throw err;
      const cap = Math.min(maxCap, base * 2 ** attempt);
      const delay = Math.max(1, Math.floor(rand() * cap));
      await sleep(delay);
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded-concurrency parallel pull pool
// ---------------------------------------------------------------------------

export interface PoolTaskResult<T> {
  /** Task index → value, aligned with the input order. */
  values: T[];
  /** Index + error for every failed task (order preserved). */
  failures: { index: number; error: string }[];
}

/**
 * Run async tasks with a hard cap on concurrent executions. Results keep
 * INPUT order; failures are captured per-task (the pool never throws).
 * Tasks are pulled lazily: as soon as one worker finishes it takes the next
 * pending index, so slow tasks don't stall the tail.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PoolTaskResult<T>> {
  const n = tasks.length;
  const values = new Array<T>(n);
  const failures: { index: number; error: string }[] = [];
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, n));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= n) return;
      try {
        values[index] = await tasks[index]!();
      } catch (err) {
        failures.push({ index, error: err instanceof Error && err.message ? err.message : String(err) });
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { values, failures };
}
