/**
 * Notebook DSL graduation oracles — the evidence behind the "Calculated" label.
 *
 * The DSL's numeric commands delegate to the oracle-validated primitives in
 * stats.ts (compared against SciPy/NumPy in stats-reference.test.ts). These
 * tests pin the DSL OUTPUT STRINGS against hand-computed known answers on a
 * fixture whose ground truth is derivable by hand, so the label is earned by
 * construction:
 *
 *   revenue = [1200, 980, 1350, 760, 1500, 1100], n = 6
 *     sorted    = [760, 980, 1100, 1200, 1350, 1500]
 *     sum       = 6,890
 *     mean      = 6,890 / 6 = 1,148.333…  → "1,148.33"
 *     min / max = 760 / 1,500
 *     R-type-7 quantiles at positions (n−1)·q on the SORTED array:
 *       Q1: pos 1.25  → 980  + 0.25·(1100−980)   = 1,010     → "1,010"
 *       med: pos 2.5  → 1100 + 0.5·(1200−1100)   = 1,150     → "1,150"
 *       Q3: pos 3.75  → 1200 + 0.75·(1350−1200)  = 1,312.5   → "1,312.5"
 *       (the old floor() picker returned 980 / 1200 / 1350 instead)
 *     sample stddev (ddof=1): Σd² = 12545400/36 = 348,483.333;
 *       / (n−1) = 69,696.667 → √ = 264.00126  → displays "264"
 *       (population ddof=0 would be √58,080.556 = 240.999 → "241")
 *
 *   %corr (perfectly correlated x = 2·revenue): r = 1 by construction;
 *   scipy.stats.pearsonr returns p = 0 for a degenerate |r| = 1 stack —
 *   the engine's documented contract (stats.ts pearson).
 */

import { executeNotebookCell, type DslContext } from "@/lib/engine/notebook-dsl";
import { pearson, quantile, stddev } from "@/lib/engine/stats";

const ctx: DslContext = {
  datasetName: "sales.csv",
  columns: [
    { name: "date", type: "date" },
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
    { name: "revenue2x", type: "number" },
  ],
  rows: [
    ["2024-01-05", "East", 1200, 2400],
    ["2024-01-12", "East", 980, 1960],
    ["2024-02-02", "West", 1350, 2700],
    ["2024-02-09", "West", 760, 1520],
    ["2024-03-01", "East", 1500, 3000],
    ["2024-03-08", "East", 1100, 2200],
  ],
  totalRows: 6,
  rowLimit: 5000,
};

function statOf(label: string, out: ReturnType<typeof executeNotebookCell>): string | undefined {
  if (out.type !== "stats") return undefined;
  return out.stats.find((s) => s.label === label)?.value;
}

describe("graduation oracle: %describe against hand-computed answers", () => {
  const out = executeNotebookCell("%describe revenue", ctx);
  it("returns a stats output", () => expect(out.type).toBe("stats"));

  it("sum = 6,890 (hand-addable)", () => expect(statOf("Sum", out)).toBe("6,890"));
  it("mean = 6,890/6 = 1,148.33", () => expect(statOf("Mean", out)).toBe("1,148.33"));
  it("min/max = 760 / 1,500", () => {
    expect(statOf("Min", out)).toBe("760");
    expect(statOf("Max", out)).toBe("1,500");
  });

  it("Q1/median/Q3 are R-type-7 interpolated (not floor() picks)", () => {
    // Hand-derived positions (n−1)·q = 1.25 / 2.5 / 3.75 on the sorted array —
    // the floor() picker the old kernel used would have returned
    // 980 / 1200 / 1350 instead.
    expect(statOf("Q1", out)).toBe("1,010");
    expect(statOf("Median", out)).toBe("1,150");
    expect(statOf("Q3", out)).toBe("1,312.5");
    // And the primitives agree exactly:
    expect(quantile([1200, 980, 1350, 760, 1500, 1100], 0.25)).toBeCloseTo(1010, 9);
    expect(quantile([1200, 980, 1350, 760, 1500, 1100], 0.5)).toBeCloseTo(1150, 9);
    expect(quantile([1200, 980, 1350, 760, 1500, 1100], 0.75)).toBeCloseTo(1312.5, 9);
  });

  it("std dev is the SAMPLE statistic (ddof=1) = 264.001, matching np.std default", () => {
    expect(statOf("Std dev", out)).toBe("264");
    expect(stddev([1200, 980, 1350, 760, 1500, 1100])).toBeCloseTo(264.0012626, 6);
    // The old kernel reported the population statistic (ddof=0 ≈ 240.999,
    // displayed "241") — pinned here so the ddof contract can never drift.
    const pop = Math.sqrt([1200, 980, 1350, 760, 1500, 1100].reduce((a, v) => a + (v - 6890 / 6) ** 2, 0) / 6);
    expect(pop).toBeCloseTo(240.9990776, 5);
    expect(statOf("Std dev", out)).not.toBe("241");
  });
});

describe("graduation oracle: %corr against the pearsonr contract", () => {
  const out = executeNotebookCell("%corr revenue revenue2x", ctx);
  it("returns a stats output", () => expect(out.type).toBe("stats"));
  it("r = 1 for a perfectly correlated pair", () => expect(statOf("Pearson r", out)).toBe("1.0000"));
  it("reports the exact Student-t p-value (p = 0 on a degenerate |r|=1 stack)", () => {
    expect(statOf("p-value", out)).toBe("0.0000");
    // The primitive used is the same one stats-reference.test.ts validates
    // against scipy.stats.pearsonr.
    const pr = pearson([1200, 980, 1350, 760, 1500, 1100], [2400, 1960, 2700, 1520, 3000, 2200]);
    expect(pr.r).toBeCloseTo(1, 9);
    expect(pr.p).toBe(0);
  });
  it("n (pairs) = 6", () => expect(statOf("n (pairs)", out)).toBe("6"));
});

describe("graduation oracle: %kpi aggregation is unchanged", () => {
  const out = executeNotebookCell("%kpi revenue", ctx);
  it("sum/count match the hand totals", () => {
    expect(out.type).toBe("stats");
    if (out.type === "stats") {
      expect(out.stats.find((s) => s.label === "Sum")?.value).toBe("6,890");
      expect(out.stats.find((s) => s.label === "Count")?.value).toBe("6");
      expect(out.stats.find((s) => s.label === "Min")?.value).toBe("760");
      expect(out.stats.find((s) => s.label === "Max")?.value).toBe("1,500");
    }
  });
});

describe("graduation oracle: %histogram uses validated median/stddev", () => {
  const out = executeNotebookCell("%histogram revenue", ctx);
  it("median = 1,150 (R-type-7, not a floor() pick)", () => {
    expect(statOf("Median", out)).toBe("1150.0000");
    expect(statOf("Std dev", out)).toBe("264.0013");
  });
  it("bins cover the full range with all rows assigned", () => {
    if (out.type === "stats" && out.histogram) {
      const total = out.histogram.binCounts.reduce((a, b) => a + b, 0);
      expect(total).toBe(6);
      expect(out.histogram.bins[0]).toBe(760);
      expect(out.histogram.bins[out.histogram.bins.length - 1]).toBe(1500);
    } else {
      throw new Error("histogram payload missing");
    }
  });
});

describe("DSL kernel honesty contract", () => {
  it("python cells still get the honest Pyodide note (no fake execution)", () => {
    const out = executeNotebookCell("import pandas as pd", ctx);
    expect(out.type).toBe("note");
  });
  it("unknown commands still error with %help guidance", () => {
    const out = executeNotebookCell("%bogus", ctx);
    expect(out.type).toBe("error");
    if (out.type === "error") expect(out.message).toContain("%help");
  });
});
