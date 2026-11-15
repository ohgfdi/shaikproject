/**
 * DuckDB performance budget (the file the README cites).
 *
 * The README's performance claims are checked here against the REAL engine on
 * 100,000 rows across the query shapes a real workload hits. A regression in
 * engine performance fails CI instead of silently eroding the budget.
 *
 * Row count and budgets are configurable:
 *   DUCKDB_BENCH_ROWS       (default 100000)
 *   DUCKDB_BENCH_BUDGET_MS  (default 8000 per query shape)
 */
import { disposeDuckDb, runDuckDbSql, type DuckDbDatasetSource } from "@/lib/engine/duckdb/server";

const ROWS = Number(process.env.DUCKDB_BENCH_ROWS ?? 100000);
const BUDGET_MS = Number(process.env.DUCKDB_BENCH_BUDGET_MS ?? 8000);

const columns: { name: string; type: "number" | "string" | "date" }[] = [
  { name: "id", type: "number" },
  { name: "region", type: "string" },
  { name: "channel", type: "string" },
  { name: "revenue", type: "number" },
  { name: "day", type: "date" },
];

function buildRows(n: number): (string | number | null)[][] {
  const rows: (string | number | null)[][] = new Array(n);
  const regions = ["East", "West", "North", "South"];
  const channels = ["Online", "Retail", "Partner"];
  // Deterministic pseudo-random values (cheap LCG) — no rng dependency.
  let s = 123456789;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const start = Date.UTC(2023, 0, 1);
  for (let i = 0; i < n; i++) {
    const day = new Date(start + Math.floor(i / (n / 365)) * 86400000).toISOString().slice(0, 10);
    rows[i] = [
      i + 1,
      regions[Math.floor(next() * regions.length)] as string,
      channels[Math.floor(next() * channels.length)] as string,
      Math.round(next() * 100000) / 100,
      day,
    ];
  }
  return rows;
}

const source: DuckDbDatasetSource = { name: "bench", columns, rows: buildRows(ROWS) };

const shapes: { name: string; sql: string }[] = [
  { name: "full scan + COUNT", sql: "SELECT COUNT(*), SUM(revenue) FROM bench" },
  {
    name: "filter + aggregate",
    sql: "SELECT region, COUNT(*), AVG(revenue) FROM bench WHERE revenue > 1000 GROUP BY region ORDER BY region",
  },
  {
    name: "2-dimension GROUP BY",
    sql: "SELECT region, channel, COUNT(*), SUM(revenue) FROM bench GROUP BY region, channel ORDER BY region, channel",
  },
  {
    name: "window + ORDER BY",
    sql: "SELECT id, revenue, RANK() OVER (ORDER BY revenue DESC) AS rk FROM bench WHERE region = 'East' ORDER BY rk LIMIT 100",
  },
  {
    name: "self-join",
    sql: "SELECT COUNT(*) FROM bench a JOIN bench b ON a.id = b.id AND a.region = b.region",
  },
  {
    name: "capped wide scan",
    sql: "SELECT * FROM bench LIMIT 5000",
  },
];

let engineReady = false;
beforeAll(async () => {
  try {
    // Warm-up + availability probe (also materializes the bench table).
    await runDuckDbSql(columns, source.rows, "SELECT COUNT(*) FROM bench", { rowCap: 1 });
    engineReady = true;
  } catch (err) {
    // DuckDB-wasm cannot initialize in this environment (e.g. no worker
    // support): skip with the reason — earned, like the Postgres suites.
    // eslint-disable-next-line no-console
    console.warn(`duckdb-benchmark: skipping — engine unavailable: ${(err as Error).message}`);
  }
});

afterAll(async () => {
  await disposeDuckDb();
});

describe(`DuckDB performance budget (${ROWS.toLocaleString()} rows, ${BUDGET_MS}ms/query)`, () => {
  it("engine initialized", () => {
    expect(engineReady).toBe(true);
  });

  for (const shape of shapes) {
    it(`${shape.name} within ${BUDGET_MS}ms`, async () => {
      if (!engineReady) return;
      const started = Date.now();
      const res = await runDuckDbSql(columns, source.rows, shape.sql, { rowCap: 5000 });
      const elapsed = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(`[bench] ${shape.name}: ${elapsed}ms (${res.rowCount} rows)`);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });
  }
});
