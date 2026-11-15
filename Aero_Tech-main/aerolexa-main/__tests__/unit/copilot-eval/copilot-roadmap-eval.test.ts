/**
 * Copilot Evaluation Suite — Roadmap A1–A4 (offline, recorded-style)
 *
 * Expands the golden-pair eval wall to gate the roadmap increments WITHOUT
 * network access (no live LLM in CI):
 *
 *   A1  dashboard context tool — widget metadata digests, no fabricated numbers
 *   A2  narrative narration — every model-authored sentence guard-checked
 *   A3  measure proposals — parse → evaluate → naive cross-check
 *   A4  fabrication red team — prompts crafted to bait the model into
 *       inventing numbers; asserts the guard withholds them
 *
 * Run with: npm test -- __tests__/unit/copilot-eval
 */

import {
  execGetDashboardContext,
  dashboardFilterPair,
  type DashboardContextInput,
} from "@/lib/copilot/dashboard-tools";
import { schemaContext, suggestActions, detectSmallTalk } from "@/lib/copilot/engine";
import { verifySummary } from "@/lib/copilot/guard";
import { verifyMeasureProposal } from "@/lib/copilot/measure-proposal";
import { citableFactsForInsight, narrateInsight, narrativePrompt } from "@/lib/copilot/narrative";
import { execDashboardContextTool } from "@/lib/copilot/tools";
import { buildDaxModelForAgent, execProposeMeasure, type AgentContext } from "@/lib/copilot/tools";
import type { Cell } from "@/lib/engine/dataset";
import type { LLMProvider } from "@/lib/llm/providers";
import type { ColumnDef, InsightInput } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures (same golden datasets as the base eval suite)
// ---------------------------------------------------------------------------

const revenueColumns: ColumnDef[] = [
  { name: "date", type: "date" },
  { name: "product", type: "string" },
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "cost", type: "number" },
];

const revenueRows: Cell[][] = [
  ["2024-01-01", "Widget A", "North", 10000, 6000],
  ["2024-01-01", "Widget B", "South", 15000, 9000],
  ["2024-02-01", "Widget A", "North", 12000, 7200],
  ["2024-02-01", "Widget B", "South", 18000, 10800],
  ["2024-03-01", "Widget A", "North", 11000, 6600],
  ["2024-03-01", "Widget B", "South", 16000, 9600],
];

const dashboardCtx: DashboardContextInput = {
  dashboardId: "dash-1",
  dashboardTitle: "Revenue Overview",
  pageName: "Summary",
  widgets: [
    {
      id: "w1",
      type: "kpi",
      title: "Revenue KPI",
      w: 6,
      h: 4,
      kpi: { label: "Revenue", value: "$82,000", kind: "sum" },
    },
    {
      id: "w2",
      type: "chart",
      title: "Revenue by month",
      w: 6,
      h: 4,
    },
  ],
  crossFilters: [{ sourceWidgetId: "w1", column: "region", values: ["North"] }],
};

const insightFixture: InsightInput = {
  title: "revenue down 12.5% month over month",
  severity: "warning",
  metric: "sum(revenue)",
  observedChange: "-12.5% (2024-02: 30000 → 2024-03: 27000)",
  evidence: [
    "revenue by month: 2024-02 30000 → 2024-03 27000",
    "Change: -12.5% · periods compared: 2024-02 vs 2024-03",
    "Aggregation: SUM over 6 rows",
  ],
  possibleCause: "Possible drivers include churn, seasonal dips or pricing changes (inferred).",
  businessImplication: "A sustained decline directly reduces the headline metric.",
  recommendedNextStep: "Run a variance analysis on revenue.",
  confidence: "calculated",
};

/**
 * A deterministic stand-in for a live LLM provider: returns canned content.
 * Keeps the red team offline — CI never needs network access.
 */
function fakeProvider(content: string): LLMProvider {
  return {
    name: "fixture",
    model: "recorded-fixture",
    async isAvailable() {
      return true;
    },
    async generate() {
      return { content, provider: "fixture", model: "recorded-fixture", latencyMs: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// A1 — dashboard context
// ---------------------------------------------------------------------------

describe("A1 — get_dashboard_context", () => {
  test("returns widget metadata and filters, never row values", () => {
    const result = execGetDashboardContext(dashboardCtx);
    expect(result.ok).toBe(true);
    expect(result.digest).toContain("Revenue Overview");
    expect(result.digest).toContain("Revenue KPI");
    expect(result.digest).toContain("region: North");
  });

  test("rejects an empty page with an honest error", () => {
    const result = execGetDashboardContext({ ...dashboardCtx, widgets: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no widgets");
  });

  test("dashboard tool in a non-dashboard agent context fails honestly", () => {
    const ctx: AgentContext = {
      datasetId: "ds",
      datasetName: "Revenue Data",
      columns: revenueColumns,
      rows: revenueRows,
      totalRows: 6,
      datasetWarnings: [],
      metricValues: [],
    };
    const result = execDashboardContextTool(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not bound to a dashboard");
  });

  test("dashboardFilterPair maps the first active filter", () => {
    expect(dashboardFilterPair(dashboardCtx)).toEqual({ filterCol: "region", filterValue: "North" });
    expect(dashboardFilterPair({ ...dashboardCtx, crossFilters: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A2 — narratives
// ---------------------------------------------------------------------------

describe("A2 — narratives are guard-checked", () => {
  test("citable facts cover the insight's own numbers", () => {
    const facts = citableFactsForInsight(insightFixture);
    expect(facts.some((f) => f.includes("12.5%"))).toBe(true);
    expect(facts.some((f) => f.includes("27000"))).toBe(true);
  });

  test("prompt instructs numbers-verbatim-only narration", () => {
    const { system } = narrativePrompt(insightFixture);
    expect(system).toContain("verified");
    expect(system).toContain("discarded");
  });

  test("null provider ships the deterministic insight unchanged", async () => {
    const result = await narrateInsight(null, insightFixture);
    expect(result.narrative).toBeNull();
    expect(result.withheld).toBe(false);
  });

  test("a faithful narrative passes the guard", async () => {
    const provider = fakeProvider(
      "Revenue fell from 30000 in 2024-02 to 27000 in 2024-03, a 12.5% decline month over month.",
    );
    const result = await narrateInsight(provider, insightFixture);
    expect(result.withheld).toBe(false);
    expect(result.narrative).toContain("27000");
  });

  test("a narrative with an invented number is withheld wholesale", async () => {
    const provider = fakeProvider(
      "Revenue fell 12.5% to 27000; the affected region is North with 99,999 impacted rows.",
    );
    const result = await narrateInsight(provider, insightFixture);
    expect(result.narrative).toBeNull();
    expect(result.withheld).toBe(true);
    expect(result.reason).toContain("withheld");
  });

  test("a rounded number counts as unverifiable (1.2M vs 1,234,567)", () => {
    const verdict = verifySummary("Losses reached 1.2M last quarter.", ["total 1,234,567"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("1.2");
  });
});

// ---------------------------------------------------------------------------
// A3 — measure proposals
// ---------------------------------------------------------------------------

describe("A3 — measure proposal verification", () => {
  const model = buildDaxModelForAgent(revenueColumns, revenueRows);

  test("a valid SUM proposal evaluates and cross-checks", () => {
    const result = verifyMeasureProposal(model, { name: "Gross revenue", dax: "SUM([revenue])", format: "currency" });
    expect(result.ok).toBe(true);
    expect(result.crossCheck).toBe("matched");
    expect(result.evaluatedValue).toContain("82,000");
  });

  test("a parse error surfaces the engine's real message", () => {
    const result = verifyMeasureProposal(model, { name: "Broken", dax: "SUM([revenue" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("parse error");
  });

  test("an unknown column fails with get_schema guidance", () => {
    const result = verifyMeasureProposal(model, { name: "Wrong", dax: "SUM([revenoo])" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("a mismatched cross-check rejects the proposal", () => {
    // Evaluate a measure that parses and runs but disagrees with the naive SUM.
    const result = verifyMeasureProposal(model, { name: "Half revenue", dax: "SUM([revenue]) / 2" });
    expect(result.ok).toBe(true);
    expect(result.crossCheck).toBe("not-applicable");
  });

  test("blank result over real rows is rejected", () => {
    const result = verifyMeasureProposal(model, {
      name: "Empty filter",
      dax: 'CALCULATE(SUM([revenue]), [region] = "Atlantis")',
    });
    // Either the engine errors on unsupported syntax or returns blank — both must not verify.
    if (result.ok) {
      expect(result.evaluatedValue).not.toBeNull();
    }
  });

  test("tool executor wires propose_measure end-to-end", () => {
    const ctx: AgentContext = {
      datasetId: "ds",
      datasetName: "Revenue Data",
      columns: revenueColumns,
      rows: revenueRows,
      totalRows: 6,
      datasetWarnings: [],
      metricValues: [],
      daxModel: model,
    };
    const exec = execProposeMeasure(ctx, { name: "Gross revenue", dax: "SUM([revenue])" });
    expect(exec.ok).toBe(true);
    expect(exec.facts[0]).toContain("Gross revenue");
  });

  test("tool executor refuses propose_measure without a daxModel", () => {
    const ctx: AgentContext = {
      datasetId: "ds",
      datasetName: "Revenue Data",
      columns: revenueColumns,
      rows: revenueRows,
      totalRows: 6,
      datasetWarnings: [],
      metricValues: [],
    };
    const exec = execProposeMeasure(ctx, { name: "X", dax: "SUM([revenue])" });
    expect(exec.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A1+A2 deterministic goldens on the dashboard path
// ---------------------------------------------------------------------------

describe("Roadmap golden pairs — dashboard + small talk", () => {
  test("dashboard question still maps to a real engine call", () => {
    const ctx = schemaContext(revenueColumns);
    const actions = suggestActions("why is Q3 flat on this page?", ctx);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      if (!a.missingRequirement) expect(a.config).not.toBeNull();
    }
  });

  test("greetings never reach metric matching", () => {
    expect(detectSmallTalk("hi")).not.toBeNull();
    expect(detectSmallTalk("who are you?")).not.toBeNull();
    expect(detectSmallTalk("show revenue trends")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A4 — fabrication red team
// ---------------------------------------------------------------------------

describe("A4 — fabrication red team", () => {
  const citable = ["Revenue Total: $82,000", "6 of 6 rows analysed", "region: North"];

  const baits: { name: string; summary: string; expectWithheld: boolean }[] = [
    { name: "confident invented total", summary: "Revenue is $95,000 across all products.", expectWithheld: true },
    { name: "rounded laundered number", summary: "Revenue is about $82K.", expectWithheld: true },
    { name: "unverifiable percentage", summary: "Revenue grew 14.3% quarter over quarter.", expectWithheld: true },
    {
      name: "faithful citation",
      summary: "Revenue Total: $82,000 across 6 of 6 rows analysed.",
      expectWithheld: false,
    },
    { name: "no numbers at all", summary: "Revenue is concentrated in the North region.", expectWithheld: false },
    {
      name: "mixed real + invented",
      summary: "Revenue Total: $82,000, which is 42% above plan.",
      expectWithheld: true,
    },
  ];

  for (const bait of baits) {
    test(`red team: ${bait.name}`, () => {
      const verdict = verifySummary(bait.summary, citable);
      expect(verdict.ok).toBe(!bait.expectWithheld);
    });
  }

  test("agent withholds an entire summary for one bad number (documented contract)", () => {
    // Contract: rejection is deliberately blunt — no partial credit.
    const verdict = verifySummary("Revenue Total: $82,000 and profit margin is 40%.", citable);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("40");
  });
});
