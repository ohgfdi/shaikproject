/**
 * Integration tests for the real DuckDB server engine (worker-thread + wasm).
 *
 * These spin up the actual binding, so they are slower than the pure unit
 * suite — first call pays the wasm init (~1–2 s), afterwards the shared
 * instance is reused. The critical regression under test: result columns of
 * type BIGINT (COUNT, SUM over ints) must transfer correctly — the node
 * worker's serializer chokes on JS BigInt, which the cast wrapper fixes.
 */
import { DuckDbUnavailableError, disposeDuckDb, getDuckDb, runDuckDbSql } from "@/lib/engine/duckdb/server";
import { SqlError } from "@/lib/engine/sql";

const COLUMNS = [
  { name: "region", type: "string" as const },
  { name: "channel", type: "string" as const },
  { name: "units", type: "number" as const },
  { name: "revenue", type: "number" as const },
  { name: "active", type: "boolean" as const },
];

const ROWS = [
  ["East", "Online", 4, 1200, true],
  ["East", "Retail", 2, 980, false],
  ["West", "Online", 5, 1350, true],
  ["West", "Partner", 3, 760, false],
  ["East", "Online", 6, 1500, true],
  ["West", "Retail", 4, 1100, true],
].map((r) => r as (string | number | boolean | null)[]);

const run = (sql: string, opts: { rowCap?: number } = {}) =>
  runDuckDbSql(COLUMNS, ROWS, sql, { rowCap: opts.rowCap ?? 5000 });

beforeAll(async () => {
  // Warm the shared engine once so per-test timing is dominated by the query.
  await getDuckDb();
}, 60_000);

afterAll(async () => {
  await disposeDuckDb();
}, 30_000);

describe("duckdb server engine", () => {
  it("runs a plain SELECT with correct types", async () => {
    const out = await run("SELECT region, revenue FROM sales ORDER BY revenue DESC LIMIT 3");
    expect(out.engine).toBe("duckdb");
    expect(out.rows).toEqual([
      ["East", 1500],
      ["West", 1350],
      ["East", 1200],
    ]);
    expect(out.columns).toEqual([
      { name: "region", type: "string" },
      { name: "revenue", type: "number" },
    ]);
  });

  it("returns COUNT(*) correctly (BIGINT regression)", async () => {
    const out = await run("SELECT COUNT(*) AS n FROM sales");
    expect(out.rows).toEqual([[6]]);
    expect(out.columns).toEqual([{ name: "n", type: "number" }]);
    expect(out.totalMatched).toBe(1);
  });

  it("supports GROUP BY with aggregates and ORDER BY", async () => {
    const out = await run("SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC");
    expect(out.rows).toEqual([
      ["East", 3680],
      ["West", 3210],
    ]);
  });

  it("casts HUGEINT sums over integer columns to numbers", async () => {
    const out = await run("SELECT SUM(units) AS u FROM sales");
    expect(out.rows).toEqual([[24]]);
  });

  it("supports grammar beyond the prototype parser (JOIN, CASE, HAVING, window)", async () => {
    const join = await run(
      "SELECT a.region, b.avg_rev FROM (SELECT DISTINCT region FROM sales) a JOIN (SELECT region, AVG(revenue) AS avg_rev FROM sales GROUP BY region) b ON a.region = b.region ORDER BY a.region",
    );
    expect(join.rows).toEqual([
      ["East", 1226.6666666666667],
      ["West", 1070],
    ]);

    const caseOut = await run(
      "SELECT region, CASE WHEN revenue > 1000 THEN 'high' ELSE 'low' END AS tier, COUNT(*) OVER () AS total FROM sales ORDER BY region, revenue LIMIT 100",
    );
    expect(caseOut.rows).toHaveLength(6);
    expect(caseOut.columns.some((c) => c.name === "tier" && c.type === "string")).toBe(true);
    expect(caseOut.columns.some((c) => c.name === "total" && c.type === "number")).toBe(true);
    expect(caseOut.totalMatched).toBe(6);
  });

  it("round-trips strings containing commas and quotes", async () => {
    const out = await run("SELECT region FROM sales WHERE region = 'East' AND channel = 'Online'");
    expect(out.rows).toEqual([["East"], ["East"]]);
    // Values with commas/quotes survive the typed-CSV load path.
    const weird = await runDuckDbSql(
      [{ name: "label", type: "string" as const }],
      [['a,"b"'], ["plain"]],
      "SELECT label FROM t ORDER BY label",
    );
    expect(weird.rows).toEqual([['a,"b"'], ["plain"]]);
  });

  it("caps results at rowCap and reports exact totals (truncation)", async () => {
    const out = await run("SELECT region FROM sales ORDER BY region", { rowCap: 2 });
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.totalMatched).toBe(6);
  });

  it("rejects DDL/DML and non-SELECT statements via the shared guard", async () => {
    for (const bad of ["DROP TABLE sales", "DELETE FROM sales", "INSERT INTO sales VALUES (1)"]) {
      await expect(run(bad)).rejects.toThrow(SqlError);
    }
    await expect(run("SELECT 1; SELECT 2")).rejects.toThrow(SqlError);
  });

  it("translates binder errors into friendly SqlErrors", async () => {
    await expect(run("SELECT nope FROM sales")).rejects.toThrow(/nope/);
    // The engine loads the dataset under the queried table name, so a truly
    // missing table only surfaces when a second table is referenced.
    await expect(run("SELECT * FROM sales a JOIN other b ON a.region = b.region")).rejects.toThrow(
      /other|does not exist/,
    );
    const err = await run("SELECT nope FROM sales").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqlError);
  });

  it("propagates DuckDbUnavailableError only for init failures", async () => {
    // The engine is already warm here, so this guards the error class itself.
    expect(new DuckDbUnavailableError(new Error("boom")).message).toContain("DuckDB engine unavailable");
  });
});
