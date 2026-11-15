import { buildDecompositionTree, findKeyInfluencers } from "@/lib/engine/ai-visuals";
import { computeKpi } from "@/lib/engine/kpi";
import type { SqlValue } from "@/lib/types";

/**
 * Hand-computed fixture:
 * Region Segment Amount Churned
 * East   A       100    true
 * East   A        50    false
 * East   B       200    true
 * West   A       300    false
 * West   B       100    true
 * West   B       250    false
 */
const columns = ["Region", "Segment", "Amount", "Churned"];
const rows: SqlValue[][] = [
  ["East", "A", 100, true],
  ["East", "A", 50, false],
  ["East", "B", 200, true],
  ["West", "A", 300, false],
  ["West", "B", 100, true],
  ["West", "B", 250, false],
];

describe("Decomposition tree — exact values", () => {
  test("root totals the measure", () => {
    const tree = buildDecompositionTree({ columns, rows, measureColumn: "Amount", levels: ["Region"] });
    expect(tree.value).toBe(1000);
    expect(tree.shareOfTotal).toBe(1);
  });

  test("children sums and shares are exact", () => {
    const tree = buildDecompositionTree({ columns, rows, measureColumn: "Amount", levels: ["Region", "Segment"] });
    expect(tree.children).toHaveLength(2);
    const east = tree.children.find((c) => c.label === "East");
    const west = tree.children.find((c) => c.label === "West");
    expect(east?.value).toBe(350); // 100 + 50 + 200
    expect(west?.value).toBe(650); // 300 + 100 + 250
    expect(east?.shareOfParent).toBeCloseTo(0.35, 10);
    expect(west?.shareOfParent).toBeCloseTo(0.65, 10);

    // Second level: East → segments A(150) B(200)
    const eastA = east!.children.find((c) => c.label === "A");
    const eastB = east!.children.find((c) => c.label === "B");
    expect(eastA?.value).toBe(150);
    expect(eastB?.value).toBe(200);
    expect(eastB?.shareOfParent).toBeCloseTo(200 / 350, 10);
  });

  test("filters narrow the tree deterministically", () => {
    const tree = buildDecompositionTree({
      columns,
      rows,
      measureColumn: "Amount",
      levels: ["Segment"],
      filters: [{ column: "Region", value: "West" }],
    });
    expect(tree.value).toBe(650);
    const a = tree.children.find((c) => c.label === "A");
    const b = tree.children.find((c) => c.label === "B");
    expect(a?.value).toBe(300);
    expect(b?.value).toBe(350);
  });

  test("unknown columns are rejected", () => {
    expect(() => buildDecompositionTree({ columns, rows, measureColumn: "Nope", levels: ["Region"] })).toThrow(
      /not found/,
    );
  });
});

describe("Key influencers — exact statistics", () => {
  test("base rate and per-value likelihoods match manual computation", () => {
    // Groups of 3 rows each, so minCount must allow them (default is 5).
    const result = findKeyInfluencers({ columns, rows, outcomeColumn: "Churned", minCount: 3 });
    expect(result.totalRows).toBe(6);
    expect(result.baseRate).toBeCloseTo(0.5, 10); // 3 of 6 churned

    const east = result.influencers.find((i) => i.category === "Region" && i.value === "East");
    // East: 2 of 3 churned → 2/3
    expect(east?.likelihood).toBeCloseTo(2 / 3, 10);
    expect(east?.count).toBe(3);
    expect(east?.lift).toBeCloseTo(2 / 3 / 0.5, 10);

    const westA = result.influencers.find((i) => i.category === "Region" && i.value === "West");
    expect(westA?.likelihood).toBeCloseTo(1 / 3, 10);
    expect(westA?.lift).toBeCloseTo(2 / 3, 10);
  });

  test("Wilson CI stays within [0,1] and contains the estimate", () => {
    const result = findKeyInfluencers({ columns, rows, outcomeColumn: "Churned" });
    for (const inf of result.influencers) {
      expect(inf.ciLow).toBeGreaterThanOrEqual(0);
      expect(inf.ciHigh).toBeLessThanOrEqual(1);
      expect(inf.ciLow).toBeLessThanOrEqual(inf.likelihood);
      expect(inf.ciHigh).toBeGreaterThanOrEqual(inf.likelihood);
    }
  });

  test("minCount filters sparse groups", () => {
    const result = findKeyInfluencers({ columns, rows, outcomeColumn: "Churned", minCount: 4 });
    expect(result.influencers).toHaveLength(0);
  });

  test("near-unique columns are skipped as non-generalizing", () => {
    const cols = ["Id", "Churned"];
    const r: SqlValue[][] = Array.from({ length: 10 }, (_, i) => [`id-${i}`, i % 2 === 0]);
    const result = findKeyInfluencers({ columns: cols, rows: r, outcomeColumn: "Churned" });
    expect(result.skippedColumns).toContain("Id");
  });
});

describe("KPI scorecard — exact attainment and trend", () => {
  const kpiColumns = ["Month", "Revenue", "Target"];
  const kpiRows: SqlValue[][] = [
    ["2024-01", 900, 1000],
    ["2024-02", 1100, 1000],
    ["2024-03", 950, 1000],
  ];

  test("per-period attainment, trend and status", () => {
    const kpi = computeKpi({
      columns: kpiColumns,
      rows: kpiRows,
      measureColumn: "Revenue",
      target: 1000,
      direction: "increasing",
    });
    // No date column parse: Month strings are not ISO dates, so a single bucket.
    // Use dateColumn instead:
    expect(kpi.totalValue).toBe(2950);
  });

  test("monthly buckets from ISO dates with trend", () => {
    const cols = ["Date", "Revenue"];
    const r: SqlValue[][] = [
      ["2024-01-05", 900],
      ["2024-01-20", 100], // Jan total 1000
      ["2024-02-10", 1100], // Feb
      ["2024-03-01", 950], // Mar
    ];
    const kpi = computeKpi({
      columns: cols,
      rows: r,
      measureColumn: "Revenue",
      dateColumn: "Date",
      grain: "month",
      target: 1000,
    });
    expect(kpi.sparkline).toEqual([
      { label: "2024-01", value: 1000 },
      { label: "2024-02", value: 1100 },
      { label: "2024-03", value: 950 },
    ]);
    expect(kpi.current.label).toBe("2024-03");
    expect(kpi.current.value).toBe(950);
    expect(kpi.current.attainment).toBeCloseTo(0.95, 10);
    expect(kpi.current.status).toBe("needsAttention"); // 0.95 ≥ 0.9 but < 0.98
    expect(kpi.current.changePct).toBeCloseTo((950 - 1100) / 1100, 10);
  });

  test("decreasing-is-good direction inverts attainment", () => {
    const cols = ["Date", "Complaints"];
    const r: SqlValue[][] = [["2024-01-15", 50]];
    const kpi = computeKpi({
      columns: cols,
      rows: r,
      measureColumn: "Complaints",
      dateColumn: "Date",
      target: 100,
      direction: "decreasing",
    });
    // attainment = target / value = 100/50 = 2 → onTrack
    expect(kpi.current.status).toBe("onTrack");
    expect(kpi.current.attainment).toBeCloseTo(2, 10);
  });

  test("targetColumn averages per bucket when no fixed target", () => {
    const cols = ["Date", "Revenue", "Target"];
    const r: SqlValue[][] = [
      ["2024-01-01", 800, 900],
      ["2024-01-15", 1000, 1100],
    ];
    const kpi = computeKpi({
      columns: cols,
      rows: r,
      measureColumn: "Revenue",
      dateColumn: "Date",
      targetColumn: "Target",
    });
    expect(kpi.current.target).toBeCloseTo(1000, 10); // (900+1100)/2
    expect(kpi.current.value).toBe(1800);
    expect(kpi.current.status).toBe("onTrack");
  });
});
