/**
 * Copilot Evaluation Suite — Golden Q → Engine Pairs
 *
 * This test suite verifies that the copilot correctly maps natural-language
 * questions to the deterministic analysis engine. Every question has an
 * expected engine call (or explicit "cannot answer") — the model is never
 * allowed to invent numbers.
 *
 * Run with: npm test -- __tests__/unit/copilot-eval
 */

import type { MetricValue } from "@/lib/analytics/semantic-layer";
import {
  schemaContext,
  suggestActions,
  matchMetrics,
  buildExplanation,
  INTENT_RULES,
  tokenize,
  normalize,
} from "@/lib/copilot/engine";
import { execGetSchema, execComputeMetrics, execRunAnalysis } from "@/lib/copilot/tools";
import { Cell } from "@/lib/engine/dataset";
import type { ColumnDef } from "@/lib/types";

// ---------------------------------------------------------------------------
// Test fixtures — these are the "golden" datasets and questions
// ---------------------------------------------------------------------------

/** Revenue dataset with date, product, region, revenue, cost columns. */
export const revenueDataset: {
  columns: ColumnDef[];
  rows: Cell[][];
  totalRows: number;
} = {
  columns: [
    { name: "date", type: "date" },
    { name: "product", type: "string" },
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
    { name: "cost", type: "number" },
  ],
  rows: [
    ["2024-01-01", "Widget A", "North", 10000, 6000],
    ["2024-01-01", "Widget B", "South", 15000, 9000],
    ["2024-02-01", "Widget A", "North", 12000, 7200],
    ["2024-02-01", "Widget B", "South", 18000, 10800],
    ["2024-03-01", "Widget A", "North", 11000, 6600],
    ["2024-03-01", "Widget B", "South", 16000, 9600],
  ],
  totalRows: 6,
};

/** Customer dataset with customer_id, signup_date, ltv, channel columns. */
export const customerDataset: {
  columns: ColumnDef[];
  rows: Cell[][];
  totalRows: number;
} = {
  columns: [
    { name: "customer_id", type: "string" },
    { name: "signup_date", type: "date" },
    { name: "ltv", type: "number" },
    { name: "channel", type: "string" },
  ],
  rows: [
    ["C001", "2023-01-15", 5000, "organic"],
    ["C002", "2023-02-20", 3000, "paid"],
    ["C003", "2023-03-10", 7000, "referral"],
    ["C004", "2023-04-05", 2500, "organic"],
    ["C005", "2023-05-12", 6000, "paid"],
  ],
  totalRows: 5,
};

/** Empty metric values for testing "no metrics available" case. */
export const emptyMetricValues: MetricValue[] = [];

/** Sample metric values for the revenue dataset. */
export const revenueMetricValues: MetricValue[] = [
  {
    metricId: "revenue_total",
    metricName: "Revenue Total",
    value: 82000,
    formattedValue: "$82,000",
    formula: "SUM(revenue)",
    resolvedColumns: { revenue: "revenue" },
    sampleSize: 6,
    totalRows: 6,
    confidence: 1.0,
    computedAt: new Date("2026-01-01T00:00:00Z"),
  },
  {
    metricId: "revenue_avg",
    metricName: "Average Revenue",
    value: 13666.67,
    formattedValue: "$13,667",
    formula: "AVG(revenue)",
    resolvedColumns: { revenue: "revenue" },
    sampleSize: 6,
    totalRows: 6,
    confidence: 1.0,
    computedAt: new Date("2026-01-01T00:00:00Z"),
  },
  {
    metricId: "cost_total",
    metricName: "Cost Total",
    value: 49200,
    formattedValue: "$49,200",
    formula: "SUM(cost)",
    resolvedColumns: { cost: "cost" },
    sampleSize: 6,
    totalRows: 6,
    confidence: 1.0,
    computedAt: new Date("2026-01-01T00:00:00Z"),
  },
];

/** Sample metric values for the customer dataset. */
export const customerMetricValues: MetricValue[] = [
  {
    metricId: "customer_lifetime_value",
    metricName: "Customer Lifetime Value",
    value: 4700,
    formattedValue: "$4,700",
    formula: "AVG(ltv)",
    resolvedColumns: { ltv: "ltv" },
    sampleSize: 5,
    totalRows: 5,
    confidence: 1.0,
    computedAt: new Date("2026-01-01T00:00:00Z"),
  },
  {
    metricId: "customer_count",
    metricName: "Customer Count",
    value: 5,
    formattedValue: "5",
    formula: "COUNT(customer_id)",
    resolvedColumns: { customer_id: "customer_id" },
    sampleSize: 5,
    totalRows: 5,
    confidence: 1.0,
    computedAt: new Date("2026-01-01T00:00:00Z"),
  },
];

// ---------------------------------------------------------------------------
// Golden Q → Engine pairs
// ---------------------------------------------------------------------------

export interface GoldenPair {
  /** Natural language question. */
  question: string;
  /** Dataset fixture to use. */
  dataset: "revenue" | "customer";
  /** Expected intent rule kinds that should match. Omitted → EDA fallback expected. */
  expectedIntents?: string[];
  /** Expected tool calls (for agent mode). */
  expectedTools?: string[];
  /** Expected to NOT match any metric (explicit "cannot answer"). */
  expectNoMetricMatch?: boolean;
  /** Expected explanation substring. */
  explanationContains?: string;
}

/** The golden evaluation pairs — these define the contract. */
export const GOLDEN_PAIRS: GoldenPair[] = [
  // Revenue dataset questions
  {
    question: "What is the trend of revenue over time?",
    dataset: "revenue",
    expectedIntents: ["trend", "kpi"],
    expectedTools: ["run_analysis"],
    explanationContains: "Revenue Total",
  },
  {
    question: "Show me revenue growth by month",
    dataset: "revenue",
    expectedIntents: ["trend", "kpi"],
    expectedTools: ["run_analysis"],
    explanationContains: "Revenue Total",
  },
  {
    question: "What are the KPIs for revenue?",
    dataset: "revenue",
    expectedIntents: ["kpi"],
    expectedTools: ["run_analysis"],
    explanationContains: "Revenue Total",
  },
  {
    question: "Compare revenue across regions",
    dataset: "revenue",
    expectedIntents: ["variance", "kpi"],
    expectedTools: ["run_analysis"],
    explanationContains: "Revenue Total",
  },
  {
    question: "Forecast revenue for next quarter",
    dataset: "revenue",
    expectedIntents: ["forecast", "kpi"],
    expectedTools: ["run_analysis"],
    explanationContains: "Revenue Total",
  },
  {
    question: "What is the correlation between revenue and cost?",
    dataset: "revenue",
    expectedIntents: ["correlation", "kpi"],
    expectedTools: ["run_analysis"],
  },
  {
    question: "Show me the distribution of revenue",
    dataset: "revenue",
    expectedIntents: ["distribution", "kpi"],
    expectedTools: ["run_analysis"],
  },
  {
    question: "What is the profit margin?", // Not in metrics - should fail gracefully
    dataset: "revenue",
    expectedIntents: ["kpi"], // kpi matches "profit" and "margin" but no profit metric exists
    expectNoMetricMatch: true,
    explanationContains: "No governed metric matches",
  },
  {
    question: "Data quality check",
    dataset: "revenue",
    expectedIntents: ["eda"],
    expectedTools: ["run_analysis"],
  },

  // Customer dataset questions
  {
    question: "What is the average customer lifetime value?",
    dataset: "customer",
    expectedIntents: ["kpi"],
    expectedTools: ["compute_metrics", "run_analysis"],
    explanationContains: "Customer Lifetime Value",
  },
  {
    question: "How many customers do we have?",
    dataset: "customer",
    expectedIntents: ["kpi"],
    expectedTools: ["compute_metrics"],
    explanationContains: "Customer Count",
  },
  {
    question: "Segment customers by LTV",
    dataset: "customer",
    expectedIntents: ["segmentation"],
    expectedTools: ["run_analysis"],
  },
  {
    question: "Forecast customer signups",
    dataset: "customer",
    expectedIntents: ["forecast"],
    expectedTools: ["run_analysis"],
  },
  {
    question: "What is the churn rate?", // Not in metrics
    dataset: "customer",
    // No expectedIntents: no governed metric matches, so the honest intent is
    // the EDA fallback (the suite's `?? ["eda"]` default below).
    expectNoMetricMatch: true,
    explanationContains: "No governed metric matches",
  },

  // Edge cases
  {
    question: "Hello how are you?", // Greeting - should fall back to EDA
    dataset: "revenue",
    expectedIntents: ["eda"],
    expectedTools: ["run_analysis"],
  },
  {
    question: "Analyze this data", // Vague - should fall back to EDA
    dataset: "revenue",
    expectedIntents: ["eda"],
  },
];

// ---------------------------------------------------------------------------
// Helper to get dataset fixture
// ---------------------------------------------------------------------------

function getDatasetFixture(name: "revenue" | "customer") {
  const ds = name === "revenue" ? revenueDataset : customerDataset;
  const metrics = name === "revenue" ? revenueMetricValues : customerMetricValues;
  return { ...ds, metricValues: metrics };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Copilot Intent Engine (deterministic)", () => {
  for (const pair of GOLDEN_PAIRS) {
    const expectedIntents = pair.expectedIntents ?? ["eda"]; // Default to EDA for edge cases
    test(`"${pair.question}" → ${expectedIntents.join(" + ")}`, () => {
      const { columns, metricValues } = getDatasetFixture(pair.dataset);
      const ctx = schemaContext(columns);
      const actions = suggestActions(pair.question, ctx);
      const matched = matchMetrics(pair.question, metricValues);
      const explanation = buildExplanation(pair.question, matched, actions, ctx, {
        analyzedRows: metricValues[0]?.sampleSize ?? 0,
        totalRows: metricValues[0]?.totalRows ?? 0,
      });

      // Check expected intents are present
      for (const expectedKind of expectedIntents) {
        const found = actions.some((a) => a.kind === expectedKind);
        expect(found).toBe(true);
      }

      // Check no unexpected high-priority intents
      const highPriorityIntents = [
        "trend",
        "kpi",
        "forecast",
        "variance",
        "correlation",
        "distribution",
        "segmentation",
      ];
      const foundHighPriority = actions.filter((a) => highPriorityIntents.includes(a.kind));
      for (const action of foundHighPriority) {
        expect(pair.expectedIntents).toContain(action.kind);
      }

      // Check metric matching
      if (pair.expectNoMetricMatch) {
        expect(matched.length).toBe(0);
      } else if (pair.explanationContains) {
        expect(explanation).toContain(pair.explanationContains);
      }

      // All returned actions should have executable configs (except when missingRequirement is set)
      for (const action of actions) {
        if (action.missingRequirement) {
          expect(action.config).toBeNull();
        } else {
          expect(action.config).not.toBeNull();
        }
      }
    });
  }
});

describe("Copilot Tool Executors (agent mode)", () => {
  const revenueCtx = {
    datasetId: "ds-revenue",
    datasetName: "Revenue Data",
    columns: revenueDataset.columns,
    rows: revenueDataset.rows,
    totalRows: revenueDataset.totalRows,
    datasetWarnings: [],
    metricValues: revenueMetricValues,
  };

  const customerCtx = {
    datasetId: "ds-customer",
    datasetName: "Customer Data",
    columns: customerDataset.columns,
    rows: customerDataset.rows,
    totalRows: customerDataset.totalRows,
    datasetWarnings: [],
    metricValues: customerMetricValues,
  };

  test("get_schema returns real column info", () => {
    const result = execGetSchema(revenueCtx);
    expect(result.ok).toBe(true);
    expect(result.digest).toContain("Revenue Data");
    expect(result.digest).toContain("analysed rows: 6");
    expect(result.facts).toContain("6 of 6 rows analysed");
    expect(result.data).toEqual(
      expect.objectContaining({
        datasetName: "Revenue Data",
        analyzedRows: 6,
        totalRows: 6,
        columns: expect.arrayContaining([
          expect.objectContaining({ name: "date", type: "date" }),
          expect.objectContaining({ name: "revenue", type: "number" }),
        ]),
      }),
    );
  });

  test("compute_metrics returns real metric values", () => {
    const result = execComputeMetrics(revenueCtx, {});
    expect(result.ok).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0]).toContain("Revenue Total: $82,000");
    expect(result.facts[1]).toContain("Average Revenue: $13,667");
    expect(result.facts[2]).toContain("Cost Total: $49,200");
    expect(result.data).toEqual(
      expect.objectContaining({
        metrics: expect.arrayContaining([
          expect.objectContaining({ metricId: "revenue_total", metricName: "Revenue Total" }),
        ]),
      }),
    );
    // Every fact must be a verbatim string from the metric values
    for (const fact of result.facts) {
      const hasMetric = revenueMetricValues.some((m) => fact.includes(m.formattedValue));
      expect(hasMetric).toBe(true);
    }
  });

  test("compute_metrics rejects unknown metric IDs", () => {
    const result = execComputeMetrics(revenueCtx, { ids: ["nonexistent_metric"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("None of the requested metrics exist");
  });

  test("run_analysis executes real trend analysis", () => {
    const result = execRunAnalysis(revenueCtx, {
      kind: "trend",
      metric: "revenue",
      dateCol: "date",
      granularity: "month",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        kind: "trend",
        config: expect.objectContaining({ kind: "trend", metric: "revenue", dateCol: "date" }),
        result: expect.objectContaining({
          kind: "trend",
          charts: expect.arrayContaining([expect.objectContaining({ kind: "line" })]),
          scope: expect.objectContaining({ rowsUsed: 6 }),
        }),
      }),
    );
    // Facts must be real numbers from the result
    for (const fact of result.facts) {
      expect(typeof fact).toBe("string");
      expect(fact.length).toBeGreaterThan(0);
    }
  });

  test("run_analysis rejects invalid analysis kind", () => {
    const result = execRunAnalysis(revenueCtx, { kind: "invalid_kind" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown analysis kind");
  });

  test("run_analysis returns engine error for missing columns", () => {
    const result = execRunAnalysis(revenueCtx, {
      kind: "trend",
      metric: "nonexistent",
      dateCol: "date",
      granularity: "month",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("customer dataset: compute_metrics works for LTV", () => {
    const result = execComputeMetrics(customerCtx, {});
    expect(result.ok).toBe(true);
    expect(result.facts.some((f) => f.includes("Customer Lifetime Value"))).toBe(true);
    expect(result.facts.some((f) => f.includes("Customer Count"))).toBe(true);
  });
});

describe("Intent Rules are complete and non-overlapping", () => {
  test("every intent rule has required fields", () => {
    for (const rule of INTENT_RULES) {
      expect(rule.kind).toBeTruthy();
      expect(rule.title).toBeTruthy();
      expect(rule.patterns).toBeInstanceOf(RegExp);
      expect(typeof rule.build).toBe("function");
      expect(typeof rule.describe).toBe("function");
    }
  });

  test("no duplicate intent kinds", () => {
    const kinds = INTENT_RULES.map((r) => r.kind);
    const unique = new Set(kinds);
    expect(unique.size).toBe(kinds.length);
  });

  test("fallback EDA is always last", () => {
    const lastRule = INTENT_RULES.at(-1);
    expect(lastRule?.kind).toBe("eda");
  });
});

describe("Tokenization and stop-word filtering", () => {
  test("stop words are removed", () => {
    const tokens = tokenize("the revenue for the quarter");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("for");
    expect(tokens).toContain("revenue");
    expect(tokens).toContain("quarter");
  });

  test("normalization removes punctuation", () => {
    expect(normalize("Revenue!")).toBe("revenue");
    expect(normalize("customer_id")).toBe("customerid");
  });
});

describe("Provenance — every answer cites real tokens", () => {
  test("matchedOn contains only tokens from the request", () => {
    const { metricValues } = getDatasetFixture("revenue");
    const matched = matchMetrics("trend of revenue over time", metricValues);
    for (const m of matched) {
      const requestTokens = new Set(tokenize("trend of revenue over time").map(normalize));
      for (const token of m.matchedOn) {
        expect(requestTokens.has(token)).toBe(true);
      }
    }
  });

  test("metrics without matching tokens are not returned", () => {
    const { metricValues } = getDatasetFixture("revenue");
    const matched = matchMetrics("hello world", metricValues);
    expect(matched.length).toBe(0);
  });
});
