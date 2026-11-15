/**
 * Unit tests for the read-only prototype SQL engine (lib/engine/sql.ts).
 */
import { executeSql, SqlError, type SqlSource } from "@/lib/engine/sql";

const source: SqlSource = {
  columns: [
    { name: "date", type: "date" },
    { name: "region", type: "string" },
    { name: "channel", type: "string" },
    { name: "revenue", type: "number" },
    { name: "cost", type: "number" },
  ],
  rows: [
    ["2024-01-05", "East", "Online", 1200, 700],
    ["2024-01-12", "East", "Retail", 980, 600],
    ["2024-02-02", "West", "Online", 1350, 800],
    ["2024-02-09", "West", "Partner", 760, 500],
    ["2024-03-01", "East", "Online", 1500, 900],
    ["2024-03-08", "East", "Retail", 1100, 650],
    ["2024-04-05", "West", "Online", 1620, 950],
    ["2024-04-12", "West", "Partner", 900, 550],
    ["2024-05-03", "East", "Online", 1780, 1000],
    ["2024-05-10", "East", "Retail", 1240, 720],
    ["2024-06-07", "West", "Online", 1900, 1100],
    ["2024-06-14", "West", "Partner", 1010, 640],
  ],
};

describe("sql engine — selection & filtering", () => {
  it("selects all rows with *", () => {
    const out = executeSql(source, "SELECT * FROM sales");
    expect(out.columns.map((c) => c.name)).toEqual(["date", "region", "channel", "revenue", "cost"]);
    expect(out.rowCount).toBe(12);
    expect(out.engine).toBe("prototype-sql");
  });

  it("filters with WHERE and string equality", () => {
    const out = executeSql(source, "SELECT revenue FROM sales WHERE region = 'East'");
    expect(out.rowCount).toBe(6);
    expect(out.totalMatched).toBe(6);
  });

  it("supports comparisons, AND/OR/NOT and arithmetic in WHERE", () => {
    const out = executeSql(source, "SELECT region, revenue FROM sales WHERE revenue >= 1500 AND region != 'West'");
    expect(out.rowCount).toBe(2);
    const withNot = executeSql(source, "SELECT * FROM sales WHERE NOT region = 'East'");
    expect(withNot.rowCount).toBe(6);
    const margin = executeSql(source, "SELECT region FROM sales WHERE revenue - cost > 600");
    expect(margin.rowCount).toBe(3); // 670, 780, 800
  });

  it("supports IS NULL / IS NOT NULL", () => {
    const withNull: SqlSource = {
      columns: source.columns,
      rows: [...source.rows.slice(0, 2), [...source.rows[2]!.slice(0, 2), null, null, 10]],
    };
    const out = executeSql(withNull, "SELECT revenue FROM sales WHERE revenue IS NULL");
    expect(out.rowCount).toBe(1);
    const out2 = executeSql(withNull, "SELECT revenue FROM sales WHERE revenue IS NOT NULL");
    expect(out2.rowCount).toBe(2);
  });

  it("is case-insensitive for keywords and bare columns (string values stay exact)", () => {
    const out = executeSql(source, "select REVENUE from sales where REGION = 'East'");
    expect(out.rowCount).toBe(6);
    expect(out.columns[0]!.name.toLowerCase()).toBe("revenue");
    // String comparisons follow SQL semantics — 'east' ≠ 'East'.
    expect(executeSql(source, "select revenue from sales where REGION = 'east'").rowCount).toBe(0);
  });

  it("handles LIMIT and ORDER BY with aliases and ordinals", () => {
    const out = executeSql(source, "SELECT revenue AS r FROM sales ORDER BY r DESC LIMIT 3");
    expect(out.rows).toEqual([[1900], [1780], [1620]]);
    const ord = executeSql(source, "SELECT region, revenue FROM sales ORDER BY 2 DESC LIMIT 1");
    expect(ord.rows).toEqual([["West", 1900]]);
  });

  it("tolerates comments and a trailing semicolon", () => {
    const out = executeSql(source, "SELECT revenue -- top revenue\nFROM sales;");
    expect(out.rowCount).toBe(12);
  });
});

describe("sql engine — aggregates & grouping", () => {
  it("computes SUM/AVG/MIN/MAX/COUNT", () => {
    const out = executeSql(
      source,
      "SELECT COUNT(*), SUM(revenue), AVG(revenue), MIN(revenue), MAX(revenue) FROM sales",
    );
    expect(out.rowCount).toBe(1);
    const total = 1200 + 980 + 1350 + 760 + 1500 + 1100 + 1620 + 900 + 1780 + 1240 + 1900 + 1010;
    expect(out.rows[0]).toEqual([12, total, total / 12, 760, 1900]);
  });

  it("groups by a dimension with aggregates", () => {
    const out = executeSql(
      source,
      "SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC",
    );
    expect(out.rowCount).toBe(2);
    expect(out.rows[0]![0]).toBe("East");
    expect(out.rows[1]![0]).toBe("West");
  });

  it("supports grouped counts and nested aggregate expressions", () => {
    const out = executeSql(
      source,
      "SELECT channel, COUNT(*) AS n, SUM(revenue) / COUNT(*) AS avg_rev FROM sales GROUP BY channel",
    );
    expect(out.rowCount).toBe(3);
    const online = out.rows.find((r) => r[0] === "Online")!;
    expect(online[1]).toBe(6);
    const expectedAvg = (1200 + 1350 + 1500 + 1620 + 1780 + 1900) / 6;
    expect(online[2]).toBeCloseTo(expectedAvg, 5);
  });

  it("applies WHERE before grouping", () => {
    const out = executeSql(
      source,
      "SELECT region, SUM(revenue) AS total FROM sales WHERE region = 'East' GROUP BY region",
    );
    expect(out.rowCount).toBe(1);
    expect(out.rows[0]![1]).toBe(1200 + 980 + 1500 + 1100 + 1780 + 1240);
  });

  it("rejects bare columns in aggregate queries without GROUP BY", () => {
    expect(() => executeSql(source, "SELECT region, SUM(revenue) FROM sales")).toThrow(SqlError);
  });
});

describe("sql engine — security & errors", () => {
  it("rejects DDL/DML statements", () => {
    for (const bad of [
      "DROP TABLE sales",
      "DELETE FROM sales",
      "UPDATE sales SET revenue = 0",
      "INSERT INTO sales VALUES (1)",
      "WITH x AS (SELECT 1) SELECT * FROM x",
    ]) {
      expect(() => executeSql(source, bad)).toThrow(/not allowed|read-only/i);
    }
  });

  it("rejects multiple statements and non-SELECT starters", () => {
    expect(() => executeSql(source, "SELECT * FROM sales; SELECT * FROM sales")).toThrow(/one SELECT/i);
    expect(() => executeSql(source, "SHOW TABLES")).toThrow(/SELECT/i);
  });

  it("rejects unknown columns", () => {
    expect(() => executeSql(source, "SELECT nope FROM sales")).toThrow(/Unknown column/i);
  });

  it("caps rows via rowCap and flags truncation", () => {
    const out = executeSql(source, "SELECT * FROM sales", { rowCap: 5 });
    expect(out.rowCount).toBe(5);
    expect(out.truncated).toBe(true);
  });
});
