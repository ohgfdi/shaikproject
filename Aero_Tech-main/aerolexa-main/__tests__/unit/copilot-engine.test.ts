import type { MetricValue } from "@/lib/analytics/semantic-layer";
import { buildExplanation, matchMetrics, schemaContext, suggestActions, tokenize } from "@/lib/copilot/engine";
import type { ColumnDef } from "@/lib/types";

const SALES_COLUMNS: ColumnDef[] = [
  { name: "transaction_id", type: "string" },
  { name: "date", type: "date" },
  { name: "customer_name", type: "string" },
  { name: "region", type: "string" },
  { name: "quantity", type: "number" },
  { name: "revenue", type: "number" },
  { name: "cost", type: "number" },
];

function mv(partial: Partial<MetricValue>): MetricValue {
  return {
    metricId: "revenue_total",
    metricName: "Total Revenue",
    value: 123456.78,
    formattedValue: "$123,456.78",
    confidence: 1,
    computedAt: new Date(),
    sampleSize: 100,
    totalRows: 100,
    resolvedColumns: { value: "revenue" },
    formula: "Σ revenue",
    ...partial,
  };
}

describe("copilot engine — tokenize", () => {
  it("drops stop-words so they can never match a metric", () => {
    expect(tokenize("what is the total for the year")).toEqual(["total", "year"]);
  });

  it("keeps real terms", () => {
    expect(tokenize("show revenue trends")).toContain("revenue");
    expect(tokenize("show revenue trends")).toContain("trends");
  });
});

describe("copilot engine — matchMetrics", () => {
  const values: MetricValue[] = [
    mv({ metricId: "revenue_total", metricName: "Total Revenue", formattedValue: "$12,345.68" }),
    mv({
      metricId: "profit_margin",
      metricName: "Profit Margin",
      formattedValue: "42.00%",
      resolvedColumns: { revenue: "revenue", cost: "cost" },
    }),
    mv({
      metricId: "order_count",
      metricName: "Order Count",
      formattedValue: "88",
      resolvedColumns: { value: "transaction_id" },
    }),
  ];

  it("matches on a metric name token", () => {
    const matched = matchMetrics("what is our total revenue", values);
    expect(matched[0]?.metricId).toBe("revenue_total");
    expect(matched[0]?.matchedOn).toContain("revenue");
  });

  it("matches on a resolved source column name", () => {
    // "cost" is not in "Profit Margin" but IS its resolved column.
    const matched = matchMetrics("how are we doing on cost", values);
    expect(matched.some((m) => m.metricId === "profit_margin")).toBe(true);
  });

  it("never matches on stop-words like 'for' or 'the'", () => {
    expect(matchMetrics("thanks for the update", values)).toEqual([]);
    expect(matchMetrics("what does this dataset contain", values)).toEqual([]);
  });

  it("returns empty when nothing is related", () => {
    expect(matchMetrics("teleport me to the moon", values)).toEqual([]);
  });

  it("carries measured confidence from the semantic layer verbatim", () => {
    const halfCoverage = mv({ confidence: 0.5, sampleSize: 50, totalRows: 100 });
    const matched = matchMetrics("revenue", [halfCoverage]);
    expect(matched[0]?.confidence).toBe(0.5);
  });
});

describe("copilot engine — suggestActions", () => {
  const ctx = schemaContext(SALES_COLUMNS);

  it("suggests a runnable trend with a real date + metric column", () => {
    const actions = suggestActions("show revenue trends over time", ctx);
    const trend = actions.find((a) => a.kind === "trend");
    expect(trend?.config).toEqual({
      kind: "trend",
      dateCol: "date",
      metric: "revenue",
      granularity: "month",
    });
    expect(trend?.missingRequirement).toBeUndefined();
  });

  it("suggests correlation with the actual numeric columns", () => {
    const actions = suggestActions("any strong correlations?", ctx);
    const corr = actions.find((a) => a.kind === "correlation");
    expect(corr?.config).toMatchObject({ kind: "correlation" });
    expect(corr?.config?.kind === "correlation" && corr.config.columns).toContain("revenue");
  });

  it("rejects 'for'-only sentences instead of suggesting a forecast (old bug)", () => {
    // The old matcher fired a forecast suggestion on any sentence containing "for".
    expect(suggestActions("set the filter for the report", ctx).find((a) => a.kind === "forecast")).toBeUndefined();
  });

  it("states the missing requirement instead of suggesting an impossible action", () => {
    const noDates: ColumnDef[] = [
      { name: "region", type: "string" },
      { name: "revenue", type: "number" },
    ];
    const actions = suggestActions("forecast next month", schemaContext(noDates));
    const forecast = actions.find((a) => a.kind === "forecast");
    expect(forecast?.config).toBeNull();
    expect(forecast?.missingRequirement).toMatch(/date column/i);
  });

  it("trends the requested column, not the first numeric column", () => {
    const actions = suggestActions("trend of cost by month", ctx);
    const trend = actions.find((a) => a.kind === "trend");
    expect(trend?.config?.kind === "trend" && trend.config.metric).toBe("cost");
  });

  it("falls back to an always-runnable EDA for unmatched requests", () => {
    const actions = suggestActions("teleport me to the moon", ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("eda");
    expect(actions[0]?.config).toEqual({ kind: "eda" });
  });
});

describe("copilot engine — buildExplanation", () => {
  const ctx = schemaContext(SALES_COLUMNS);
  const counts = { analyzedRows: 100, totalRows: 100 };

  it("reports the metric with formula, columns and measured coverage", () => {
    const matched = matchMetrics("total revenue", [
      mv({ formattedValue: "$12,345.68", confidence: 1, sampleSize: 100, totalRows: 100 }),
    ]);
    const text = buildExplanation("total revenue", matched, [], ctx, counts);
    expect(text).toContain("$12,345.68");
    expect(text).toContain("Σ revenue");
    expect(text).toContain("revenue");
    expect(text).toContain("100 of 100");
    expect(text).toContain("100% coverage");
  });

  it("honestly says no metric matched and names the real columns", () => {
    const text = buildExplanation("what does the fox say", [], [], ctx, counts);
    expect(text).toMatch(/No governed metric matches/i);
    expect(text).toContain("revenue");
    expect(text).toContain("region");
  });

  it("mentions sampling when coverage is partial", () => {
    const matched = matchMetrics("revenue", [
      mv({ formattedValue: "$1.00", confidence: 0.5, sampleSize: 50, totalRows: 100 }),
    ]);
    const text = buildExplanation("revenue", matched, [], ctx, counts);
    expect(text).toContain("50 of 100");
  });
});
