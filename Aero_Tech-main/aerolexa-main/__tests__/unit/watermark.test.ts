/**
 * Watermark incremental-sync helpers (Gap ④).
 *
 * Security-critical: the watermark VALUE must always bind as a parameter and
 * identifiers must be engine-quoted. Merge semantics are append-only with a
 * hard schema-match gate — drift falls back to a full pull.
 */

import {
  advanceWatermark,
  appendIncrementalRows,
  buildWatermarkWhere,
  watermarkFilterFromStored,
} from "@/lib/engine/connectors/watermark";

describe("buildWatermarkWhere — parameterized, engine-quoted SQL", () => {
  it("postgres: identifier double-quoted, value bound as $1", () => {
    const { sql, param } = buildWatermarkWhere("postgres", {
      column: "updated_at",
      value: "2026-09-01T00:00:00Z",
      valueType: "string",
    });
    expect(sql).toBe(`"updated_at" > $1`);
    expect(param).toBe("2026-09-01T00:00:00Z");
  });

  it("postgres: quotes embedded double quotes in identifiers", () => {
    const { sql, param } = buildWatermarkWhere("postgres", { column: 'weird"col', value: 5, valueType: "number" });
    expect(sql).toBe(`"weird""col" > $1`);
    expect(param).toBe(5);
  });

  it("mysql: identifier backtick-quoted, value bound as ?", () => {
    const { sql, param } = buildWatermarkWhere("mysql", { column: "id", value: 1250, valueType: "number" });
    expect(sql).toBe("`id` > ?");
    expect(param).toBe(1250);
  });

  it("mysql: doubles embedded backticks", () => {
    const { sql } = buildWatermarkWhere("mysql", { column: "weird`col", value: 1, valueType: "number" });
    expect(sql).toBe("`weird``col` > ?");
  });

  it("numeric values bind as numbers, strings as strings", () => {
    const n = buildWatermarkWhere("postgres", { column: "id", value: "42", valueType: "number" });
    expect(typeof n.param).toBe("number");
    expect(n.param).toBe(42);
    const s = buildWatermarkWhere("mysql", { column: "ts", value: "2026-09-01", valueType: "string" });
    expect(typeof s.param).toBe("string");
  });

  it("rejects empty columns, empty values, and non-finite numbers", () => {
    expect(() => buildWatermarkWhere("postgres", { column: "  ", value: 1, valueType: "number" })).toThrow();
    expect(() => buildWatermarkWhere("postgres", { column: "id", value: "", valueType: "string" })).toThrow();
    expect(() => buildWatermarkWhere("postgres", { column: "id", value: Number.NaN, valueType: "number" })).toThrow();
  });
});

describe("watermarkFilterFromStored — coercion of the stored floor", () => {
  it("numeric columns bind as numbers", () => {
    const f = watermarkFilterFromStored("id", "1250", "number");
    expect(f).toEqual({ column: "id", value: 1250, valueType: "number" });
  });

  it("date columns stay strings", () => {
    const f = watermarkFilterFromStored("updated_at", "2026-09-01T00:00:00Z", "date");
    expect(f).toEqual({ column: "updated_at", value: "2026-09-01T00:00:00Z", valueType: "string" });
  });

  it("non-numeric stored value on a numeric column degrades to the raw string", () => {
    const f = watermarkFilterFromStored("id", "not-a-number", "number");
    expect(f.value).toBe("not-a-number");
  });
});

describe("advanceWatermark — the floor never moves backwards", () => {
  it("numeric: takes the max seen, comparing numerically", () => {
    const rows: (string | number | boolean | null)[][] = [[9], [1250], [42], [null]];
    expect(advanceWatermark(rows, 0, "100")).toBe("1250");
  });

  it("ISO timestamps advance lexically (correct for ISO-8601)", () => {
    const rows: (string | number | boolean | null)[][] = [["2026-09-02T00:00:00Z"], ["2026-09-10T00:00:00Z"]];
    expect(advanceWatermark(rows, 0, "2026-09-01T00:00:00Z")).toBe("2026-09-10T00:00:00Z");
  });

  it("returns the current floor when nothing exceeds it (or all cells are null)", () => {
    expect(advanceWatermark([[1], [2]], 0, "99")).toBe("99");
    expect(advanceWatermark([[null], [null]], 0, "7")).toBe("7");
    expect(advanceWatermark([], 0, "7")).toBe("7");
  });

  it("non-finite stored floor resets to the first numeric value seen", () => {
    const rows: (string | number | boolean | null)[][] = [[5]];
    expect(advanceWatermark(rows, 0, "stale")).toBe("5");
  });
});

describe("appendIncrementalRows — append-only merge with schema gate", () => {
  const cols = [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
  ];

  it("appends when column names AND types match exactly", () => {
    const merged = appendIncrementalRows(
      cols,
      [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
      ],
      [[1, "a"]],
      [[2, "b"]],
    );
    expect(merged).toEqual({
      columns: cols,
      rows: [
        [1, "a"],
        [2, "b"],
      ],
    });
  });

  it("returns null on schema drift (type change)", () => {
    const drifted = [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
    ];
    expect(appendIncrementalRows(cols, drifted, [[1, "a"]], [[2, "b"]])).toBeNull();
  });

  it("returns null on column reorder (positional rows would corrupt)", () => {
    const reordered = [
      { name: "name", type: "string" },
      { name: "id", type: "number" },
    ];
    expect(appendIncrementalRows(cols, reordered, [[1, "a"]], [["b", 2]])).toBeNull();
  });

  it("returns null for empty column sets", () => {
    expect(appendIncrementalRows([], [], [], [])).toBeNull();
  });
});
