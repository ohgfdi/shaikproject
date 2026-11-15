/**
 * Unit tests for the DuckDB query path helpers:
 *   - shared.ts  (CSV serialization, DESCRIBE → cast wrapper, arrow conversion)
 *   - sql.ts     (read-only guard + table extraction used by both DuckDB engines)
 *
 * These are pure, dependency-free tests — the real wasm engine has its own
 * integration suite (duckdb-server.test.ts).
 */
import {
  arrowRowToValues,
  buildCastSelect,
  buildCsvColumns,
  buildDatasetCsv,
  describeToColumns,
  duckDbErrorMessage,
  duckDbType,
  isCompositeDuckDbType,
  isNumericDuckDbType,
  quotedIdentifier,
  toSqlResultSet,
  type DuckDbArrowResult,
} from "@/lib/engine/duckdb/shared";
import { assertReadOnlySql, SqlError, sqlFromTable } from "@/lib/engine/sql";

describe("quotedIdentifier", () => {
  it("wraps identifiers in double quotes and escapes embedded quotes", () => {
    expect(quotedIdentifier("sales")).toBe('"sales"');
    expect(quotedIdentifier('we"ird')).toBe('"we""ird"');
    expect(quotedIdentifier("(revenue + 1)")).toBe('"(revenue + 1)"');
  });
});

describe("duckDbType", () => {
  it("maps Ledgerly column types to DuckDB CSV types", () => {
    expect(duckDbType("number")).toBe("DOUBLE");
    expect(duckDbType("boolean")).toBe("BOOLEAN");
    expect(duckDbType("string")).toBe("VARCHAR");
    expect(duckDbType("date")).toBe("VARCHAR"); // dates stay verbatim strings
  });
});

describe("buildDatasetCsv", () => {
  const cols = [
    { name: "region", type: "string" as const },
    { name: "revenue", type: "number" as const },
    { name: "active", type: "boolean" as const },
  ];

  it("writes a typed header and cells", () => {
    const csv = buildDatasetCsv(cols, [
      ["north", 100, true],
      ["south", 1.5, false],
      [null, null, null],
    ]);
    expect(csv).toBe(["region,revenue,active", "north,100,true", "south,1.5,false", ",,"].join("\n"));
  });

  it("quotes strings containing separators, quotes or newlines", () => {
    const csv = buildDatasetCsv(
      [{ name: "note", type: "string" as const }],
      [["plain"], ["has,comma"], ['has"quote'], ["line\nbreak"]],
    );
    expect(csv).toBe(["note", "plain", '"has,comma"', '"has""quote"', '"line\nbreak"'].join("\n"));
  });

  it("emits empty fields for non-finite numbers and keeps numbers verbatim", () => {
    const csv = buildDatasetCsv([{ name: "v", type: "number" as const }], [[Number.NaN], [Infinity], [0.5]]);
    expect(csv).toBe(["v", "", "", "0.5"].join("\n"));
  });
});

describe("buildCsvColumns", () => {
  it("builds the read_csv_auto column map with escaped names", () => {
    expect(
      buildCsvColumns([
        { name: "revenue", type: "number" },
        { name: "o'brien", type: "string" },
      ]),
    ).toBe("{'revenue': 'DOUBLE', 'o''brien': 'VARCHAR'}");
  });
});

describe("describeToColumns + type predicates", () => {
  it("parses DESCRIBE rows into {name, type} pairs", () => {
    const rows = [
      { column_name: "n", column_type: "BIGINT" },
      { column_name: "region", column_type: "VARCHAR" },
      { column_name: "untyped", column_type: null },
    ];
    expect(describeToColumns(rows as unknown as Record<string, unknown>[])).toEqual([
      { name: "n", type: "BIGINT" },
      { name: "region", type: "VARCHAR" },
    ]);
  });

  it("classifies numeric and composite DuckDB types", () => {
    for (const t of ["BIGINT", "HUGEINT", "INTEGER", "DOUBLE", "DECIMAL", "ubigint"]) {
      expect(isNumericDuckDbType(t)).toBe(true);
    }
    for (const t of ["VARCHAR", "BOOLEAN", "DATE", "TIMESTAMP", "UUID"]) {
      expect(isNumericDuckDbType(t)).toBe(false);
    }
    expect(isCompositeDuckDbType("INTEGER[]")).toBe(true);
    expect(isCompositeDuckDbType("STRUCT(a INTEGER)")).toBe(true);
    expect(isCompositeDuckDbType("MAP(VARCHAR, INTEGER)")).toBe(true);
    expect(isCompositeDuckDbType("VARCHAR")).toBe(false);
  });
});

describe("buildCastSelect", () => {
  it("casts numeric columns to DOUBLE, flattens composites, passes others through", () => {
    const sql = buildCastSelect(
      "SELECT COUNT(*) AS n, region, tags FROM sales GROUP BY region",
      [
        { name: "n", type: "BIGINT" },
        { name: "region", type: "VARCHAR" },
        { name: "tags", type: "VARCHAR[]" },
      ],
      5000,
    );
    expect(sql).toContain('CAST("n" AS DOUBLE) AS "n"');
    expect(sql).toContain('"region"');
    expect(sql).toContain('CAST("tags" AS VARCHAR) AS "tags"');
    expect(sql).toContain('CAST("__aerolexa_total" AS DOUBLE) AS "__aerolexa_total"');
    expect(sql).toContain('COUNT(*) OVER () AS "__aerolexa_total"');
    expect(sql).toContain("LIMIT 5001");
    expect(sql.startsWith("SELECT ")).toBe(true);
    // The user query must appear only once, inside the subquery.
    expect(sql.match(/GROUP BY region/g)).toHaveLength(1);
  });

  it("strips trailing semicolons and caps at rowCap + 1", () => {
    const sql = buildCastSelect("SELECT * FROM sales;", [{ name: "x", type: "VARCHAR" }], 10);
    expect(sql).toContain("FROM (SELECT * FROM sales) __b");
    expect(sql.endsWith("LIMIT 11")).toBe(true);
  });
});

describe("duckDbErrorMessage", () => {
  it("keeps the readable head and drops the wrapped-query pointer + stack", () => {
    const err = new Error(
      [
        'Binder Error: Referenced column "nope" not found in FROM clause!',
        'Candidate bindings: "active"',
        "",
        'LINE 1: SELECT * FROM (SELECT *, COUNT(*) OVER () AS "__aerolexa_total" FROM (SELECT nope FROM sales) __b) __c LIMIT 6',
        "               ^",
        "    at Nr.runQuery (...)",
      ].join("\n"),
    );
    expect(duckDbErrorMessage(err)).toBe(
      'Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "active"',
    );
  });

  it("falls back to a generic message for empty errors", () => {
    expect(duckDbErrorMessage(new Error(""))).toBe("The query could not be executed by the DuckDB engine.");
  });
});

describe("arrowRowToValues", () => {
  const fields = [
    { name: "n", type: { typeId: 2 } }, // Int
    { name: "name", type: { typeId: 5 } }, // Utf8
    { name: "__aerolexa_total", type: { typeId: 2 } },
  ];

  it("coerces BigInt to Number, dates to ISO strings and skips the total column", () => {
    const row = { n: 42n, name: "north", __aerolexa_total: 3n };
    expect(arrowRowToValues(row as unknown as Record<string, unknown>, fields, 2)).toEqual([42, "north"]);
  });

  it("converts Date values to ISO dates and passes nulls through", () => {
    const withDate = [
      { name: "when", type: { typeId: 11 } }, // Timestamp
      { name: "v", type: { typeId: 5 } },
    ];
    const row = { when: new Date("2024-01-05T00:00:00Z"), v: null };
    expect(arrowRowToValues(row as unknown as Record<string, unknown>, withDate, -1)).toEqual(["2024-01-05", null]);
  });
});

describe("toSqlResultSet", () => {
  it("reports exact totals, truncation and duckdb engine metadata", () => {
    const arrow: DuckDbArrowResult = {
      fields: [
        { name: "region", type: { typeId: 5 } },
        { name: "revenue", type: { typeId: 3 } },
        { name: "__aerolexa_total", type: { typeId: 3 } },
      ],
      rows: [
        { region: "East", revenue: 10, __aerolexa_total: 5 },
        { region: "West", revenue: 20, __aerolexa_total: 5 },
      ],
    };
    const out = toSqlResultSet(arrow, 1, 12, "coverage");
    expect(out.engine).toBe("duckdb");
    expect(out.rowCount).toBe(1);
    expect(out.totalMatched).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.columns).toEqual([
      { name: "region", type: "string" },
      { name: "revenue", type: "number" },
    ]);
    expect(out.rows).toEqual([["East", 10]]);
    expect(out.executionMs).toBe(12);
    expect(out.note).toContain("DuckDB");
    expect(out.note).toContain("coverage");
  });
});

describe("assertReadOnlySql (shared guard)", () => {
  it("accepts read-only SELECTs with richer grammar", () => {
    expect(() => assertReadOnlySql("SELECT * FROM sales")).not.toThrow();
    expect(() =>
      assertReadOnlySql("SELECT region, SUM(revenue) AS s FROM sales GROUP BY region HAVING s > 10"),
    ).not.toThrow();
    expect(() => assertReadOnlySql("SELECT * FROM a JOIN b ON a.id = b.id")).not.toThrow();
    expect(() =>
      assertReadOnlySql("SELECT CASE WHEN revenue > 100 THEN 'high' ELSE 'low' END FROM sales"),
    ).not.toThrow();
  });

  it("rejects DDL/DML and non-SELECT statements", () => {
    for (const bad of [
      "DROP TABLE sales",
      "DELETE FROM sales",
      "INSERT INTO sales VALUES (1)",
      "UPDATE sales SET x = 1",
      "ATTACH 'x.db'",
    ]) {
      expect(() => assertReadOnlySql(bad)).toThrow(SqlError);
    }
  });

  it("rejects empty queries and multiple statements (trailing semicolon is fine)", () => {
    expect(() => assertReadOnlySql("")).toThrow(SqlError);
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(SqlError);
    expect(() => assertReadOnlySql("SELECT 1;")).not.toThrow();
  });
});

describe("sqlFromTable", () => {
  it("extracts the FROM-clause table name", () => {
    expect(sqlFromTable("SELECT * FROM sales")).toBe("sales");
    expect(sqlFromTable("SELECT region, COUNT(*) FROM sales GROUP BY region")).toBe("sales");
    expect(sqlFromTable("SELECT 1")).toBeNull();
    expect(sqlFromTable('SELECT * FROM "my table"')).toBe("my table");
    expect(sqlFromTable(null)).toBeNull();
    expect(sqlFromTable("SELECT * FROM sales;")).toBe("sales");
  });
});
