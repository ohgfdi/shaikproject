/**
 * Unit tests for the upgraded deterministic NL→pandas translator:
 * filter predicates ("rows where region is East"), value counts, distinct
 * values, and filter + aggregation composition. The generated code is never
 * executed here (that is the venv-gated suite's job) — these pin the
 * translation contract: real column names, runnable mask + core code,
 * honest unmatched help.
 */
import { extractFilter, translateToPandas } from "@/lib/engine/python/nl-to-pandas";
import type { ColumnDef } from "@/lib/types";

const columns: ColumnDef[] = [
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "units", type: "number" },
  { name: "sale_date", type: "date" },
];

describe("extractFilter", () => {
  it("parses 'region is East' and strips it from the remainder", () => {
    const { filter, rest } = extractFilter("rows where region is East then sum of revenue", columns);
    expect(filter).not.toBeNull();
    expect(filter!.column).toBe("region");
    expect(filter!.value).toBe("East");
    expect(filter!.mask).toBe('f_df = df[df["region"] == "East"]');
    expect(rest).toBe("then sum of revenue");
  });

  it("parses numeric comparison operators", () => {
    const { filter } = extractFilter("revenue above 1,000", columns);
    expect(filter).not.toBeNull();
    expect(filter!.mask).toContain("> 1000");
    expect(filter!.mask).toContain('pd.to_numeric(df["revenue"]');
  });

  it("parses >= / <= worded operators", () => {
    expect(extractFilter("units at least 5", columns).filter!.mask).toContain(">= 5");
    expect(extractFilter("units at most 9", columns).filter!.mask).toContain("<= 9");
    expect(extractFilter("region is not East", columns).filter!.mask).toContain("!= ");
  });

  it("cuts the value at clause boundaries", () => {
    const { filter } = extractFilter("region is East and revenue > 10", columns);
    expect(filter!.value).toBe("East");
  });

  it("returns null when no column/op/value triple matches", () => {
    const { filter } = extractFilter("sum of revenue by region", columns);
    expect(filter).toBeNull();
  });
});

describe("translateToPandas — filter composition", () => {
  it("filter alone yields a mask + preview cell", () => {
    const t = translateToPandas("rows where region is East", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('f_df = df[df["region"] == "East"]');
    expect(t.code).toContain("f_df.head(20)");
    expect(t.explanation).toContain("region");
  });

  it("filter + aggregation: the core code operates on f_df, not df", () => {
    const t = translateToPandas("sum of revenue where region is East", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('f_df = df[df["region"] == "East"]');
    // The aggregation must read the FILTERED frame.
    expect(t.code).toMatch(/f_df\["revenue"\]/);
    expect(t.code).not.toMatch(/(?<!f_)df\["revenue"\]/);
    expect(t.explanation).toContain("Filtered: region is East");
  });

  it("filter + group-by composes", () => {
    const t = translateToPandas("average of units by region where revenue above 500", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('f_df = df[pd.to_numeric(df["revenue"], errors="coerce") > 500]');
    expect(t.code).toContain("groupby");
  });

  it("two filters AND-compose into chained masks and the core reads the last frame", () => {
    const t = translateToPandas("sum of revenue where region is East and units at least 5", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('f_df = df[df["region"] == "East"]');
    expect(t.code).toContain('f_df2 = f_df[pd.to_numeric(f_df["units"], errors="coerce") >= 5]');
    // Aggregation must read the FINAL frame.
    expect(t.code).toContain('f_df2["revenue"]');
    expect(t.explanation).toContain("region is East AND units at least 5");
  });

  it("three filters compose to f_df3 and a fourth predicate fails honestly", () => {
    const three = translateToPandas("rows where region is East and revenue above 500 and units at least 5", columns);
    expect(three.matched).toBe(true);
    expect(three.code).toContain("f_df3 = f_df2[");
    expect(three.code).toContain("f_df3.head(20)");

    const four = translateToPandas(
      "rows where region is East and revenue above 500 and units at least 5 and sale_date is 2024",
      columns,
    );
    expect(four.matched).toBe(false);
    expect(four.help).toContain("at most 3");
  });
});

describe("translateToPandas — new value-exploration intents", () => {
  it("value counts per dimension", () => {
    const t = translateToPandas("count of each region", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toBe('df["region"].value_counts().head(25)');
  });

  it("distinct values of a dimension", () => {
    const t = translateToPandas("unique values of region", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toBe('sorted(df["region"].dropna().unique().tolist())');
  });
});

describe("translateToPandas — regressions guarded", () => {
  it("still translates the classic aggregation", () => {
    const t = translateToPandas("sum of revenue by region", columns);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('groupby("region")');
    expect(t.code).toContain('["revenue"]');
  });

  it("unmatched requests still fail honestly with guidance", () => {
    const t = translateToPandas("please make me a sandwich", columns);
    expect(t.matched).toBe(false);
    expect(t.help).toContain("could not map");
  });

  it("never invents a column name", () => {
    const t = translateToPandas("sum of banana_count", columns);
    expect(t.matched).toBe(true); // falls back to describe on best-effort metric
    expect(t.code).not.toContain("banana");
  });
});
