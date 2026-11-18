/**
 * Tests for the connector resilience layer (lib/engine/connectors/retry.ts):
 * transient classification, exponential backoff with full jitter (injectable
 * sleep/rand for determinism), fail-fast on permanent errors, and the
 * bounded-concurrency pool's ordering + failure isolation guarantees.
 */
import type { ConnectorConfig } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { pullConnectorTables, type PulledTable } from "@/lib/engine/connectors/pull";
import {
  TransientConnectorError,
  isTransientError,
  runWithConcurrency,
  withRetry,
} from "@/lib/engine/connectors/retry";

function recordedSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { delays, sleep };
}

describe("isTransientError", () => {
  it("classifies network and rate-limit failures as transient", () => {
    expect(isTransientError(new Error("Connection reset by peer: ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("query ETIMEDOUT after 30000ms"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new ConnectorError("rate limited", { status: 429 }))).toBe(true);
    expect(isTransientError(new ConnectorError("bad gateway", { status: 502 }))).toBe(true);
    expect(isTransientError(new ConnectorError("gateway timeout", { status: 504 }))).toBe(true);
    expect(isTransientError(new TransientConnectorError("flaky"))).toBe(true);
  });

  it("never retries permanent failures", () => {
    expect(isTransientError(new ConnectorError("auth failed", { status: 401 }))).toBe(false);
    expect(isTransientError(new ConnectorError("undefined table", { status: 404 }))).toBe(false);
    expect(isTransientError(new ConnectorError("bad config", { status: 400 }))).toBe(false);
    expect(isTransientError(new Error("permission denied for table"))).toBe(false);
    expect(isTransientError("not even an error")).toBe(false);
  });
});

describe("withRetry", () => {
  it("retries transient failures and succeeds within the attempt budget", async () => {
    const { delays, sleep } = recordedSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("ECONNRESET mid-pull");
        return "ok";
      },
      { retries: 3, sleep, rand: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays.length).toBe(2);
    // Full jitter over exponential caps (base 250: caps 250, 500; rand 0.5).
    expect(delays[0]).toBe(125);
    expect(delays[1]).toBe(250);
  });

  it("rethrows the LAST engine error when attempts are exhausted", async () => {
    const { sleep } = recordedSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`ECONNRESET attempt ${calls}`);
        },
        { retries: 2, sleep, rand: () => 0 },
      ),
    ).rejects.toThrow(/attempt 3/);
    expect(calls).toBe(3);
  });

  it("fails fast on permanent errors (no retry, no sleep)", async () => {
    const { delays, sleep } = recordedSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ConnectorError("undefined table", { status: 404 });
        },
        { retries: 5, sleep, rand: () => 0.5 },
      ),
    ).rejects.toThrow(/undefined table/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("caps the backoff at maxDelayMs and never sleeps negative", async () => {
    const { delays, sleep } = recordedSleep();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new TransientConnectorError("flaky");
        return true;
      },
      { retries: 5, baseDelayMs: 1000, maxDelayMs: 1200, sleep, rand: () => 1 },
    );
    expect(delays).toEqual([1000, 1200, 1200]); // caps clamp, never exceed
  });
});

describe("runWithConcurrency", () => {
  it("preserves input order in results regardless of completion order", async () => {
    const tasks = [100, 10, 50, 1].map(
      (delay, i) => () => new Promise<string>((resolve) => setTimeout(() => resolve(`task-${i}-${delay}`), delay)),
    );
    const { values, failures } = await runWithConcurrency(tasks, 4);
    expect(values).toEqual(["task-0-100", "task-1-10", "task-2-50", "task-3-1"]);
    expect(failures).toEqual([]);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return true;
    });
    await runWithConcurrency(tasks, 3);
    expect(peak).toBe(3);
  });

  it("isolates failures per task and reports them with the original index", async () => {
    const tasks = [
      async () => "a",
      async () => {
        throw new Error("boom-1");
      },
      async () => "c",
      async () => {
        throw new ConnectorError("undefined table", { status: 404 });
      },
    ];
    const { values, failures } = await runWithConcurrency(tasks, 2);
    expect(values[0]).toBe("a");
    expect(values[2]).toBe("c");
    expect(values[1]).toBeUndefined();
    expect(values[3]).toBeUndefined();
    expect(failures.map((f) => f.index).sort()).toEqual([1, 3]);
    expect(failures.find((f) => f.index === 3)!.error).toMatch(/undefined table/);
  });

  it("handles an empty task list and a concurrency larger than the list", async () => {
    expect(await runWithConcurrency([], 4)).toEqual({ values: [], failures: [] });
    const { values } = await runWithConcurrency([async () => 1, async () => 2], 10);
    expect(values).toEqual([1, 2]);
  });
});

describe("pullConnectorTables — bounded-concurrency batch pulls", () => {
  const config = {
    kind: "postgres",
    postgres: { host: "h", port: 5432, database: "d", user: "u", password: "p" },
  } as unknown as ConnectorConfig;

  function fakePuller(results: Map<string, PulledTableOrError>, concurrencySeen: { current: number; peak: number }) {
    return async (
      _config: ConnectorConfig,
      schema: string,
      table: string,
      _limit: number,
      _incremental?: { column: string; since: string | number },
      retry?: { retries?: number; sleep?: (ms: number) => Promise<void>; rand?: () => number },
    ) => {
      // Honor the retry wrapper the real puller uses, so retry counts are testable.
      return withRetry(
        async () => {
          concurrencySeen.current++;
          concurrencySeen.peak = Math.max(concurrencySeen.peak, concurrencySeen.current);
          concurrencySeen.current--;
          const key = `${schema}.${table}`;
          const outcome = results.get(key);
          if (outcome === "throw-transient") throw new Error("ECONNRESET");
          if (outcome === "throw-permanent") throw new ConnectorError("undefined table", { status: 404 });
          if (!outcome) throw new Error(`unexpected table ${key}`);
          return outcome as PulledTable;
        },
        { retries: retry?.retries, sleep: retry?.sleep, rand: retry?.rand },
      );
    };
  }
  type PulledTableOrError =
    | {
        columns: { name: string; type: string }[];
        rows: (string | number | boolean | null)[][];
        totalRows: number;
        truncated: boolean;
      }
    | "throw-transient"
    | "throw-permanent";

  function table(n: number) {
    return { columns: [{ name: "id", type: "number" }], rows: [[n]], totalRows: 1, truncated: false };
  }

  it("pulls every table, isolating failures from successes", async () => {
    const results = new Map<string, PulledTableOrError>([
      ["public.invoices", table(1)],
      ["public.ghost", "throw-permanent"],
      ["public.ledgers", table(3)],
    ]);
    const seen = { current: 0, peak: 0 };
    const res = await pullConnectorTables(
      config,
      [
        { schema: "public", table: "invoices" },
        { schema: "public", table: "ghost" },
        { schema: "public", table: "ledgers" },
      ],
      { retries: 0, sleep: async () => undefined, rand: () => 0 },
      fakePuller(results, seen),
    );
    expect(Object.keys(res.tables).sort()).toEqual(["public.invoices", "public.ledgers"]);
    expect(res.tables["public.invoices"]!.rows[0]).toEqual([1]);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ key: "public.ghost", table: "ghost" });
    expect(res.failures[0]!.error).toMatch(/undefined table/);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("retries transient per-table failures via the puller's retry policy", async () => {
    let attempts = 0;
    const seen = { current: 0, peak: 0 };
    const puller = async () => {
      attempts++;
      if (attempts < 3) throw new Error("ETIMEDOUT");
      return table(9);
    };
    const res = await pullConnectorTables(
      config,
      [{ schema: "public", table: "flaky" }],
      { retries: 3, sleep: async () => undefined, rand: () => 0, concurrency: 1 },
      puller as unknown as Parameters<typeof pullConnectorTables>[3],
    );
    expect(attempts).toBe(3);
    expect(res.failures).toHaveLength(0);
    expect(res.tables["public.flaky"]!.rows[0]).toEqual([9]);
    void seen;
  });

  it("respects the concurrency cap across the batch", async () => {
    let inFlight = 0;
    let peak = 0;
    const puller = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return table(1);
    };
    const requests = Array.from({ length: 8 }, (_, i) => ({ schema: "public", table: `t${i}` }));
    await pullConnectorTables(
      config,
      requests,
      { retries: 0, concurrency: 3 },
      puller as unknown as Parameters<typeof pullConnectorTables>[3],
    );
    expect(peak).toBe(3);
  });
});
