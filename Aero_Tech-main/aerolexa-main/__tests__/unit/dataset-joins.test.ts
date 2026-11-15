import { validateJoinMapping, type JoinMapping } from "@/lib/engine/dataset-joins";
import { disposeDuckDb, runDuckDbSqlMany } from "@/lib/engine/duckdb/server";
import type { SqlValue } from "@/lib/types";

const customers = {
  name: "customers",
  columns: [
    { name: "id", type: "number" as const },
    { name: "name", type: "string" as const },
  ],
  rows: [
    [1, "Ada"],
    [2, "Lin"],
  ] as SqlValue[][],
};
const orders = {
  name: "orders",
  columns: [
    { name: "customer_id", type: "number" as const },
    { name: "amount", type: "number" as const },
  ],
  rows: [
    [1, 10],
    [1, 12],
    [3, 7],
  ] as SqlValue[][],
};

afterAll(async () => {
  // Release the DuckDB hybrid runtime so jest can exit (worker threads / MessagePorts).
  await disposeDuckDb();
});

describe("multi-dataset DuckDB queries", () => {
  it("registers both datasets in one session and joins them", async () => {
    const result = await runDuckDbSqlMany([customers, orders], {
      sql: "SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.name ORDER BY c.name",
      rowCap: 10,
    });

    expect(result.rows).toEqual([["Ada", 22]]);
    expect(result.rowCount).toBe(1);
  });

  it("accepts a SQL-derived table alias for a single dataset (backward compatibility)", async () => {
    // The SQL Lab registers a single dataset under both its own name and the
    // table name referenced by the query (e.g. `FROM sales`), so pre-existing
    // queries keep working alongside the dataset-named UI prefill.
    const result = await runDuckDbSqlMany(
      [
        { name: "e2e_revenue", columns: customers.columns, rows: customers.rows },
        { name: "sales", columns: customers.columns, rows: customers.rows },
      ],
      { sql: "SELECT name FROM sales WHERE id = 2", rowCap: 10 },
    );

    expect(result.rows).toEqual([["Lin"]]);
  });
});

describe("join mapping validation", () => {
  it("warns on type mismatch and low match rate", () => {
    const mapping: JoinMapping = {
      leftDatasetId: "customers",
      leftColumn: "id",
      leftType: "number",
      rightDatasetId: "orders",
      rightColumn: "customer_id",
      rightType: "string",
      leftValues: [1, 2],
      rightValues: ["3", "4"],
    };
    const result = validateJoinMapping(mapping);
    expect(result.typeMismatch).toBe(true);
    expect(result.matchRate).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/type/i), expect.stringMatching(/unmatched/i)]),
    );
  });
});
