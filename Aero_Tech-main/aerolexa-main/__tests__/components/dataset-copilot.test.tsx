/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DatasetCopilot } from "@/components/datasets/dataset-copilot";

/**
 * Regression tests for the two production defects:
 * 1. The component used to read response fields without unwrapping the
 *    {ok, data} API envelope → TypeError on every successful answer.
 * 2. Error payloads are {error:{code,message}} and were rendered as [object Object].
 */

const ENVELOPED_ANSWER = {
  ok: true,
  data: {
    explanation:
      "From this dataset: **Total Revenue = $12,345.68** (formula: Σ revenue; columns: revenue) — computed over 100 of 100 analysed rows (100% coverage).",
    matchedMetrics: [
      {
        metricId: "revenue_total",
        metricName: "Total Revenue",
        value: 123456.78,
        formattedValue: "$12,345.68",
        formula: "Σ revenue",
        resolvedColumns: { value: "revenue" },
        sampleSize: 100,
        totalRows: 100,
        confidence: 1,
        matchedOn: ["revenue"],
      },
    ],
    suggestedActions: [
      {
        kind: "trend",
        title: "Trend over time",
        description: "Plot revenue grouped by date (month) with period-over-period change.",
        config: { kind: "trend", dateCol: "date", metric: "revenue", granularity: "month" },
      },
    ],
    grounded: true,
    grounding: {
      analyzedRows: 100,
      totalRows: 100,
      sampled: false,
      columns: [
        { name: "date", type: "date" },
        { name: "revenue", type: "number" },
      ],
      availableMetrics: [{ id: "revenue_total", name: "Total Revenue", formula: "Σ revenue" }],
    },
  },
};

describe("DatasetCopilot", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("renders an enveloped answer with metric provenance and coverage", async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ENVELOPED_ANSWER,
    } as unknown as Response);

    render(<DatasetCopilot datasetId="d1" />);
    await user.type(screen.getByLabelText(/ask the copilot/i), "total revenue");
    await user.click(screen.getByRole("button", { name: /ask copilot/i }));

    await waitFor(() => {
      // "Total Revenue" appears in both the explanation and the metric row.
      expect(screen.getAllByText(/Total Revenue/).length).toBeGreaterThanOrEqual(2);
    });
    // Provenance: formula + resolved column + measured coverage.
    expect(screen.getAllByText(/Σ revenue/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/matched “revenue”/i)).toBeInTheDocument();
    expect(screen.getByText(/100% rows/)).toBeInTheDocument();
    // Grounding footer.
    expect(screen.getByText(/Grounded on 100 rows/)).toBeInTheDocument();
  });

  it("renders an honest no-match answer", async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          ...ENVELOPED_ANSWER.data,
          explanation: "No governed metric matches “what does the fox say”.",
          matchedMetrics: [],
        },
      }),
    } as unknown as Response);

    render(<DatasetCopilot datasetId="d1" />);
    await user.type(screen.getByLabelText(/ask the copilot/i), "what does the fox say");
    await user.click(screen.getByRole("button", { name: /ask copilot/i }));

    await waitFor(() => {
      expect(screen.getByText(/No governed metric matches/)).toBeInTheDocument();
    });
    expect(screen.getByText(/What I can run instead/i)).toBeInTheDocument();
  });

  it("surfaces API error messages instead of [object Object]", async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Too many requests — try again in 42 seconds." },
      }),
    } as unknown as Response);

    render(<DatasetCopilot datasetId="d1" />);
    await user.type(screen.getByLabelText(/ask the copilot/i), "total revenue");
    await user.click(screen.getByRole("button", { name: /ask copilot/i }));

    await waitFor(() => {
      expect(screen.getByText(/Too many requests — try again in 42 seconds/)).toBeInTheDocument();
    });
  });
});
