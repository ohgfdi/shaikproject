/**
 * Gap ⑦ extended watermark coverage: warehouse SQL-text rendering under a
 * strict safe-grammar gate, and Mongo's native filter builder. The invariant
 * under test: an UNSAFE value returns null (full-pull fallback) — never an
 * interpolated string.
 */

import {
  advanceWatermark,
  buildWatermarkMongoFilter,
  buildWatermarkSqlText,
  ISO_TIMESTAMP_RE,
} from "@/lib/engine/connectors/watermark";

export {};

describe("buildWatermarkSqlText — warehouse grammar is provably safe", () => {
  it("renders finite numbers as bare numeric literals", () => {
    expect(buildWatermarkSqlText({ column: "id", value: 1250, valueType: "number" }, "snowflake")).toBe(`"id" > 1250`);
    expect(buildWatermarkSqlText({ column: "id", value: "1250", valueType: "number" }, "bigquery")).toBe(`"id" > 1250`);
  });

  it("renders strict ISO-8601 strings as TIMESTAMP literals", () => {
    expect(
      buildWatermarkSqlText({ column: "updated_at", value: "2026-09-01T12:30:00Z", valueType: "string" }, "snowflake"),
    ).toBe(`"updated_at" > TIMESTAMP '2026-09-01T12:30:00Z'`);
    expect(
      buildWatermarkSqlText({ column: "updated_at", value: "2026-09-01 12:30:00", valueType: "string" }, "bigquery"),
    ).toBe(`"updated_at" > TIMESTAMP '2026-09-01T12:30:00'`);
  });

  it("returns null (fallback) for arbitrary text — the injection gate", () => {
    for (const evil of ["x' OR 1=1 --", "'; DROP TABLE Dataset; --", "2026-09-01' OR '1'='1", "abc", ""]) {
      expect(buildWatermarkSqlText({ column: "c", value: evil, valueType: "string" }, "snowflake")).toBeNull();
    }
  });

  it("returns null for non-finite numbers and empty columns", () => {
    expect(buildWatermarkSqlText({ column: "id", value: "NaN", valueType: "number" }, "snowflake")).toBeNull();
    expect(buildWatermarkSqlText({ column: "", value: 1, valueType: "number" }, "bigquery")).toBeNull();
  });

  it("quotes embedded double quotes in identifiers", () => {
    expect(buildWatermarkSqlText({ column: 'we"ird', value: 1, valueType: "number" }, "snowflake")).toBe(
      `"we""ird" > 1`,
    );
  });

  it("ISO_TIMESTAMP_RE accepts calendar dates, space separators and offsets, rejects junk", () => {
    expect(ISO_TIMESTAMP_RE.test("2026-09-01")).toBe(true);
    expect(ISO_TIMESTAMP_RE.test("2026-09-01T12:30:00.123456Z")).toBe(true);
    expect(ISO_TIMESTAMP_RE.test("2026-09-01T12:30:00+05:30")).toBe(true);
    expect(ISO_TIMESTAMP_RE.test("2026-13-40")).toBe(true); // shape-level gate; the DB is the semantic check
    expect(ISO_TIMESTAMP_RE.test("yesterday")).toBe(false);
    expect(ISO_TIMESTAMP_RE.test("2026-09-01 OR 1=1")).toBe(false);
  });
});

describe("buildWatermarkMongoFilter — native predicate, no SQL surface", () => {
  it("numeric floors bind as numbers", () => {
    expect(buildWatermarkMongoFilter("seq", "42", "number")).toEqual({ seq: { $gt: 42 } });
  });

  it("ISO strings become real Date objects", () => {
    const filter = buildWatermarkMongoFilter("updatedAt", "2026-09-01T00:00:00Z", "string");
    expect(filter).toBeTruthy();
    expect((filter!.updatedAt as { $gt: Date }).$gt).toBeInstanceOf(Date);
  });

  it("rejects $-prefixed keys (operator injection) and unsafe strings", () => {
    expect(buildWatermarkMongoFilter("$where", "1", "number")).toBeNull();
    expect(buildWatermarkMongoFilter("c", "injection", "string")).toBeNull();
  });
});

describe("advanceWatermark stays monotonic for the new engine paths", () => {
  it("never lowers the floor below the previous value", () => {
    expect(advanceWatermark([[5]], 0, "100")).toBe("100");
    expect(advanceWatermark([["2026-08-01T00:00:00Z"]], 0, "2026-09-01T00:00:00Z")).toBe("2026-09-01T00:00:00Z");
  });
});
