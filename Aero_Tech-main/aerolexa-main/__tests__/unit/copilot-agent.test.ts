import type { MetricValue } from "@/lib/analytics/semantic-layer";
import { runCopilotAgent } from "@/lib/copilot/agent";
import type { AgentContext } from "@/lib/copilot/tools";
import type { Cell } from "@/lib/engine/dataset";
import type { LLMProvider } from "@/lib/llm/providers";
import type { ColumnDef } from "@/lib/types";

/**
 * The agent loop is where model output meets real engines. These tests use a
 * scripted provider (no network) to prove the honesty contract end to end:
 * tools do the computing, a hallucinated number is caught and withheld, and a
 * dead provider degrades instead of inventing an answer.
 */

const COLUMNS: ColumnDef[] = [
  { name: "date", type: "date" },
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
];

const ROWS: Cell[][] = [
  ["2024-01-05", "North", 100],
  ["2024-02-05", "South", 200],
  ["2024-03-05", "North", 300],
  ["2024-04-05", "South", 400],
];

const METRICS: MetricValue[] = [
  {
    metricId: "revenue_total",
    metricName: "Total Revenue",
    value: 1000,
    formattedValue: "$1,000.00",
    confidence: 1,
    computedAt: new Date(),
    sampleSize: 4,
    totalRows: 4,
    resolvedColumns: { value: "revenue" },
    formula: "Σ revenue",
  },
];

const CTX: AgentContext = {
  datasetId: "ds-1",
  datasetName: "sales.csv",
  columns: COLUMNS,
  rows: ROWS,
  totalRows: 4,
  datasetWarnings: [],
  metricValues: METRICS,
};

/** A provider that replays scripted replies (or throws) in order. */
function scriptedProvider(responses: (string | Error)[]): LLMProvider {
  let i = 0;
  return {
    name: "mock",
    model: "mock-model-1",
    isAvailable: async () => true,
    async generate() {
      const reply = responses[Math.min(i, responses.length - 1)]!;
      i++;
      if (reply instanceof Error) throw reply;
      return { content: reply, provider: "mock", model: "mock-model-1", latencyMs: 1, tokensUsed: 1 };
    },
  };
}

describe("copilot agent — grounded happy path", () => {
  it("executes real tools and returns a verified summary", async () => {
    const provider = scriptedProvider([
      '{"tool":"compute_metrics","args":{}}',
      '{"tool":"finish","args":{"summary":"Total revenue was $1,000.00 across every row."}}',
    ]);

    const result = await runCopilotAgent(provider, CTX, "what is total revenue?");
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Total revenue was $1,000.00 across every row.");
    expect(result!.summaryWithheld).toBe(false);
    expect(result!.model).toBe("mock-model-1");
    // The metric card came from the real tool payload.
    expect(result!.matchedMetrics.map((m) => m.metricId)).toEqual(["revenue_total"]);
    expect(result!.steps.map((s) => s.tool)).toEqual(["compute_metrics", "finish"]);
  });

  it("returns runnable actions from a real analysis", async () => {
    const provider = scriptedProvider([
      '{"tool":"run_analysis","args":{"kind":"trend","metric":"revenue","dateCol":"date","granularity":"month"}}',
      '{"tool":"finish","args":{"summary":"Revenue trended upward over the period."}}',
    ]);

    const result = await runCopilotAgent(provider, CTX, "show the revenue trend");
    expect(result!.suggestedActions).toHaveLength(1);
    expect(result!.suggestedActions[0]!.kind).toBe("trend");
    expect(result!.suggestedActions[0]!.config).toMatchObject({ kind: "trend", metric: "revenue" });
  });
});

describe("copilot agent — hallucination defence", () => {
  it("withholds a summary that cites a number no tool produced", async () => {
    const provider = scriptedProvider([
      '{"tool":"compute_metrics","args":{}}',
      '{"tool":"finish","args":{"summary":"Total revenue was $5,555.55."}}',
    ]);

    const result = await runCopilotAgent(provider, CTX, "what is total revenue?");
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.summaryWithheld).toBe(true);
    expect(result!.withheldReason).toMatch(/5,555.55|5555.55/);
    // The real computed metrics are still returned — only the prose was dropped.
    expect(result!.matchedMetrics.map((m) => m.metricId)).toEqual(["revenue_total"]);
  });

  it("withholds a summary that rounds a real number", async () => {
    const provider = scriptedProvider([
      '{"tool":"compute_metrics","args":{}}',
      '{"tool":"finish","args":{"summary":"Revenue was about 1 thousand."}}',
    ]);
    const result = await runCopilotAgent(provider, CTX, "revenue?");
    expect(result!.summaryWithheld).toBe(true);
  });
});

describe("copilot agent — failure and recovery", () => {
  it("returns null when the provider fails before doing anything", async () => {
    const provider = scriptedProvider([new Error("connection refused")]);
    const result = await runCopilotAgent(provider, CTX, "anything");
    expect(result).toBeNull();
  });

  it("recovers from an invalid response and still finishes", async () => {
    const provider = scriptedProvider([
      "I think the revenue is fine!",
      '{"tool":"finish","args":{"summary":"The data cannot answer that precisely."}}',
    ]);
    const result = await runCopilotAgent(provider, CTX, "how happy are customers?");
    expect(result!.steps[0]!.tool).toBe("(invalid)");
    expect(result!.steps[0]!.ok).toBe(false);
    expect(result!.summary).toBe("The data cannot answer that precisely.");
  });

  it("stops at the step budget instead of looping forever", async () => {
    const provider = scriptedProvider(['{"tool":"get_schema","args":{}}']);
    const result = await runCopilotAgent(provider, CTX, "loop please", { maxSteps: 3 });
    expect(result!.steps).toHaveLength(3);
    expect(result!.summary).toBeNull();
    expect(result!.summaryWithheld).toBe(true);
    expect(result!.withheldReason).toMatch(/step budget/i);
  });

  it("stops when the wall-clock budget is exceeded", async () => {
    const provider: LLMProvider = {
      name: "slow",
      model: "slow-1",
      isAvailable: async () => true,
      async generate() {
        await new Promise((r) => setTimeout(r, 20));
        return { content: '{"tool":"get_schema","args":{}}', provider: "slow", model: "slow-1", latencyMs: 20 };
      },
    };
    const result = await runCopilotAgent(provider, CTX, "anything", {
      maxSteps: 5,
      totalBudgetMs: 10,
      timeoutMs: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.withheldReason).toMatch(/time budget/i);
  });

  it("ends without a summary when the provider dies mid-run", async () => {
    const provider = scriptedProvider(['{"tool":"get_schema","args":{}}', new Error("timeout")]);
    const result = await runCopilotAgent(provider, CTX, "something");
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.summaryWithheld).toBe(true);
  });
});
