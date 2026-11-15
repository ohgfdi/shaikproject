/**
 * Unit tests for the elite advisor engine.
 *
 * Each test asserts a verifiable statistical fact about synthetic data whose
 * ground truth is known by construction — the same numbers scipy would return:
 *
 *  - decomposition: group totals/shares sum to the grand total
 *  - concentration: HHI is 10,000 for a monopoly, 2,500 for a 4-way tie
 *  - Welch t-test: detects a real mean shift, rejects a noise difference
 *  - Mann–Kendall trend: significant for a monotonic series, flat otherwise
 *  - the composed advisor answer cites computed values and lists what is
 *    unavailable instead of inventing it
 */
import { answerAdvisorQuestion } from "@/lib/engine/advisor";
import {
  compareTopSegments,
  concentrationDiagnosis,
  decomposeByDimension,
  diagnoseTrend,
  resolveDimension,
  resolvePrimaryMetric,
  welchTTest,
  type AdvisorDataset,
} from "@/lib/engine/advisor-analysis";
import type { ColumnDef } from "@/lib/types";

function salesDataset(): AdvisorDataset {
  const columns: ColumnDef[] = [
    { name: "month", type: "date" },
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
    { name: "units", type: "number" },
  ];
  const rows: (string | number | null)[][] = [];
  // 24 months, two regions. East = 3× West. Revenue grows monotonically.
  for (let m = 0; m < 24; m++) {
    const month = new Date(Date.UTC(2024, m, 1)).toISOString().slice(0, 10);
    const east = 3000 + m * 100;
    const west = 1000 + m * 30;
    rows.push([month, "East", east, 30]);
    rows.push([month, "West", west, 10]);
  }
  return { columns, rows, totalRows: rows.length, datasetName: "Sales", datasetId: "ds_test" };
}

describe("resolvePrimaryMetric / resolveDimension", () => {
  it("picks the largest non-binary numeric column as the headline metric", () => {
    const p = resolvePrimaryMetric(salesDataset());
    expect(p?.metric).toBe("revenue");
    // East 3000..5300 avg 4150 × 24 + West 1000..1690 avg 1345 × 24
    expect(p?.total).toBeCloseTo(((3000 + 5300) / 2) * 24 + ((1000 + 1690) / 2) * 24, 0);
  });

  it("picks a balanced categorical dimension", () => {
    expect(resolveDimension(salesDataset())).toBe("region");
  });
});

describe("decomposeByDimension", () => {
  it("produces group totals whose shares sum to 100%", () => {
    const ds = salesDataset();
    const r = decomposeByDimension(ds, "revenue", "region", "month");
    const shareSum = r.groups.reduce((a, g) => a + g.sharePct, 0);
    expect(shareSum).toBeCloseTo(100, 6);
    expect(r.grandTotal).toBeCloseTo(
      r.groups.reduce((a, g) => a + g.total, 0),
      6,
    );
    // East is ≥ 3× West and grows faster, so its share is slightly above 75%
    // (exact: 99,600 / 131,880 = 75.52%).
    expect(r.groups[0]?.group).toBe("East");
    expect(r.groups[0]?.sharePct).toBeCloseTo(75.523, 1);
  });

  it("computes per-group latest-period change in absolute units", () => {
    const ds = salesDataset();
    const r = decomposeByDimension(ds, "revenue", "region", "month");
    // Month 23 vs 22: East +100, West +30 by construction.
    const east = r.groups.find((g) => g.group === "East");
    const west = r.groups.find((g) => g.group === "West");
    expect(east?.latestChange).toBeCloseTo(100, 6);
    expect(west?.latestChange).toBeCloseTo(30, 6);
  });
});

describe("concentrationDiagnosis", () => {
  it("reads a monopoly as HHI 10,000", () => {
    const ds: AdvisorDataset = {
      columns: [
        { name: "g", type: "string" },
        { name: "v", type: "number" },
      ],
      rows: [
        ["A", 100],
        ["A", 100],
        ["A", 100],
        ["B", 1],
      ],
      totalRows: 4,
      datasetName: "x",
      datasetId: "x",
    };
    const r = decomposeByDimension(ds, "v", "g", null);
    const c = concentrationDiagnosis(r, "g");
    expect(c.hhi).toBeGreaterThan(9500);
    expect(c.interpretation).toBe("highly concentrated");
  });

  it("reads a perfect 4-way tie as HHI 2,500", () => {
    const ds: AdvisorDataset = {
      columns: [
        { name: "g", type: "string" },
        { name: "v", type: "number" },
      ],
      rows: [
        ["A", 10],
        ["B", 10],
        ["C", 10],
        ["D", 10],
      ],
      totalRows: 4,
      datasetName: "x",
      datasetId: "x",
    };
    const r = decomposeByDimension(ds, "v", "g", null);
    const c = concentrationDiagnosis(r, "g");
    expect(c.hhi).toBeCloseTo(2500, 0);
    expect(c.interpretation).toBe("moderately concentrated");
  });
});

describe("welchTTest / compareTopSegments", () => {
  it("detects a real mean shift as significant", () => {
    const a = [100, 102, 98, 101, 99, 100, 103, 97, 100, 99];
    const b = [50, 52, 48, 51, 49, 50, 53, 47, 50, 49];
    const t = welchTTest(a, b);
    expect(t?.p).toBeLessThan(1e-6);
  });

  it("does NOT flag a tiny within-noise difference", () => {
    const a = [100, 102, 98, 101, 99, 100, 103, 97, 100, 99];
    const b = [101, 99, 102, 98, 100, 101, 99, 102, 98, 100];
    const t = welchTTest(a, b);
    expect(t?.p).toBeGreaterThan(0.05);
  });

  it("compares the top vs bottom revenue segments and marks the gap significant", () => {
    const ds = salesDataset();
    const s = compareTopSegments(ds, "revenue", "region");
    expect(s?.segmentA).toBe("East");
    expect(s?.segmentB).toBe("West");
    expect(s?.significant).toBe(true); // 3× mean gap with tight variance
    expect((s?.meanA ?? 0) / (s?.meanB ?? 1)).toBeGreaterThan(2.5);
  });
});

describe("diagnoseTrend", () => {
  it("detects the monotonic uptrend and backtests a projection", () => {
    const ds = salesDataset();
    const t = diagnoseTrend(ds, "revenue", "month", "month");
    expect(t).not.toBeNull();
    expect(t!.nPeriods).toBe(24);
    expect(t!.mannKendall.direction).toBe("increasing");
    expect(t!.mannKendall.p).toBeLessThan(0.001);
    expect(t!.olsSlope).toBeGreaterThan(0);
    expect(t!.projection).not.toBeNull();
    // The next month should project above the last observed month (5300+100 East, 1690+30 West).
    expect(t!.projection!.nextPeriod).toBeGreaterThan(5300 + 100 + (1690 + 30) - 50);
  });

  it("refuses to invent a trend with fewer than 3 periods", () => {
    const ds: AdvisorDataset = {
      columns: [
        { name: "m", type: "date" },
        { name: "v", type: "number" },
      ],
      rows: [
        ["2024-01-01", 10],
        ["2024-02-01", 20],
      ],
      totalRows: 2,
      datasetName: "x",
      datasetId: "x",
    };
    expect(diagnoseTrend(ds, "v", "m")).toBeNull();
  });
});

describe("answerAdvisorQuestion (composed answer)", () => {
  it("cites computed statistics and marks sections calculated", () => {
    const ds = salesDataset();
    const res = answerAdvisorQuestion({
      question: "How is our business performing and growing over time?",
      columns: ds.columns,
      rows: ds.rows,
      totalRows: ds.totalRows,
      sampled: false,
      datasetName: ds.datasetName,
      datasetId: ds.datasetId,
    });
    // The executive answer must contain the computed Mann–Kendall reading and
    // the backtested projection — not vague prototype language.
    expect(res.executiveAnswer).toMatch(/Mann–Kendall/i);
    expect(res.executiveAnswer).toMatch(/projects? to/i);
    expect(res.evidence.some((e) => e.label === "Trend significance" && e.confidence === "calculated")).toBe(true);
    expect(res.evidence.some((e) => e.label === "Backtested projection")).toBe(true);
    expect(res.evidence.some((e) => e.label === "Contribution breakdown")).toBe(true);
    expect(res.diagnostics?.trend?.mannKendallDirection).toBe("increasing");
    expect(res.diagnostics?.trend?.projection?.reliable).toBe(true); // near-perfect backtest is plannable
    expect(res.diagnostics?.concentration?.interpretation).toBe("highly concentrated"); // 75/25 split
    expect(res.confidenceFlags.find((f) => f.section === "Evidence")?.confidence).toBe("calculated");
  });

  it("lists what is unavailable instead of guessing when the dataset has no dates", () => {
    const ds: AdvisorDataset = {
      columns: [
        { name: "region", type: "string" },
        { name: "revenue", type: "number" },
      ],
      rows: [
        ["East", 100],
        ["West", 40],
        ["East", 110],
        ["West", 45],
        ["East", 90],
        ["North", 10],
      ],
      totalRows: 6,
      datasetName: "NoDates",
      datasetId: "x",
    };
    const res = answerAdvisorQuestion({
      question: "What is our trend?",
      columns: ds.columns,
      rows: ds.rows,
      totalRows: ds.totalRows,
      sampled: false,
      datasetName: ds.datasetName,
      datasetId: ds.datasetId,
    });
    expect(res.diagnostics?.unavailable.some((u) => u.toLowerCase().includes("date"))).toBe(true);
    expect(res.executiveAnswer).toMatch(/no date column/i);
    // Must NOT fabricate a projection or a trend p-value.
    expect(res.diagnostics?.trend).toBeNull();
    expect(res.evidence.some((e) => e.label === "Backtested projection")).toBe(false);
  });
});
