/**
 * Finance Act rate registry — oracle tests.
 *
 * Pinned properties:
 *  1. Defaults are AY-keyed and labelled; lookup without registration throws
 *     for an unknown AY (no silent fallback to a wrong year's rates).
 *  2. An override WINS over the default and is reported as `overridden: true`
 *     — that is the mechanism a Finance Act change flows through.
 *  3. slabRateFor scans rows in order and the first row whose upTo exceeds
 *     income wins; income exactly AT a boundary takes the LOWER row.
 */

import {
  getRateTable,
  hasOverride,
  registerOverride,
  registeredAys,
  slabRateFor,
  tablesForAy,
} from "@/lib/engine/ca-rate-registry";

describe("defaults", () => {
  it("serves the AY 2025-26 new-regime slabs, labelled", () => {
    const { table, overridden } = getRateTable("2025-26", "individual-slab-new");
    expect(overridden).toBe(false);
    expect(table.unit).toBe("paise");
    expect(table.rows).toHaveLength(7);
    expect(table.rows[0]).toEqual({ upTo: 4_00_000 * 100, rate: 0 });
    expect(table.rows[table.rows.length - 1]!.upTo).toBeNull();
  });

  it("throws for an unregistered AY instead of silently falling back", () => {
    expect(() => getRateTable("2030-31", "individual-slab-new")).toThrow(/No individual-slab-new table/);
  });

  it("lists registered AYs in order", () => {
    expect(registeredAys()).toContain("2025-26");
  });

  it("lists the tables available for an AY with override status", () => {
    const kinds = tablesForAy("2025-26").map((t) => t.kind);
    expect(kinds).toContain("individual-slab-new");
    expect(kinds).toContain("surcharge");
    expect(tablesForAy("2025-26").every((t) => !t.overridden)).toBe(true);
  });
});

describe("overrides", () => {
  it("registered override wins and is surfaced as overridden", () => {
    registerOverride({
      ay: "2026-27",
      kind: "individual-slab-new",
      unit: "paise",
      source: "Finance Act 2026 (test fixture)",
      asOn: "2026-04-01",
      rows: [
        { upTo: 5_00_000 * 100, rate: 0 },
        { upTo: null, rate: 2500 },
      ],
    });
    const { table, overridden } = getRateTable("2026-27", "individual-slab-new");
    expect(overridden).toBe(true);
    expect(table.source).toContain("test fixture");
    expect(hasOverride("2026-27", "individual-slab-new")).toBe(true);
    expect(hasOverride("2025-26", "individual-slab-new")).toBe(false);
  });

  it("rejects malformed AYs and empty rows", () => {
    expect(() =>
      registerOverride({
        ay: "2026",
        kind: "cess",
        unit: "bps",
        source: "x",
        asOn: "2026-04-01",
        rows: [{ upTo: null, rate: 400 }],
      }),
    ).toThrow(/Invalid AY/);
    expect(() =>
      registerOverride({ ay: "2026-27", kind: "cess", unit: "bps", source: "x", asOn: "2026-04-01", rows: [] }),
    ).toThrow(/at least one row/);
  });
});

describe("slabRateFor", () => {
  const table = getRateTable("2025-26", "individual-slab-new").table;

  it("income exactly at a boundary takes the LOWER row (inclusive upTo)", () => {
    const res = slabRateFor(table, 4_00_000 * 100);
    expect(res.rate).toBe(0);
  });

  it("one paise past the boundary takes the next row", () => {
    const res = slabRateFor(table, 4_00_000 * 100 + 1);
    expect(res.rate).toBe(500);
  });

  it("income above the last boundary lands on the open-ended row", () => {
    const res = slabRateFor(table, 50_00_00_000 * 100);
    expect(res.rate).toBe(3000);
  });
});
