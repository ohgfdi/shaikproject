/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PowerBiStudioPanel } from "@/components/pbi/power-bi-studio-panel";

jest.mock("@/components/charts/pbi-visual", () => ({
  PbiVisual: () => <div data-testid="pbi-visual" />,
}));

const columns = [
  { name: "Date", type: "date" },
  { name: "Region", type: "string" },
  { name: "Amount", type: "number" },
  { name: "Qty", type: "number" },
  { name: "Churned", type: "boolean" },
];

describe("PowerBiStudioPanel", () => {
  beforeEach(() => {
    (global.fetch as unknown as jest.Mock) = jest.fn();
  });

  it("renders the three tabs with the dataset context line", () => {
    render(<PowerBiStudioPanel datasetId="d1" datasetName="Sales" columns={columns} />);
    expect(screen.getByRole("tab", { name: /KPI scorecard/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /DAX measures/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /AI visuals/i })).toBeInTheDocument();
    expect(screen.getByText(/Sales · 2 numeric columns/)).toBeInTheDocument();
  });

  it("computes a KPI and renders the scorecard", async () => {
    const user = userEvent.setup();
    (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          kpi: {
            name: "Amount",
            current: {
              label: "2024-03",
              value: 950,
              target: 1000,
              attainment: 0.95,
              status: "needsAttention",
              priorValue: 1100,
              changePct: -0.136,
            },
            sparkline: [
              { label: "2024-01", value: 1000 },
              { label: "2024-02", value: 1100 },
              { label: "2024-03", value: 950 },
            ],
            totalValue: 3050,
            totalTarget: 3000,
            totalAttainment: 1.017,
            totalStatus: "onTrack",
          },
          note: "computed from actual rows",
        },
      }),
    });

    render(<PowerBiStudioPanel datasetId="d1" datasetName="Sales" columns={columns} />);
    await user.click(screen.getByRole("button", { name: /compute/i }));

    await waitFor(() => {
      expect(screen.getByText("950")).toBeInTheDocument();
      expect(screen.getByText(/Needs attention/)).toBeInTheDocument();
      expect(screen.getByText(/Attainment: 95\.0%/)).toBeInTheDocument();
    });
  });

  it("surfaces API errors in the KPI tab", async () => {
    const user = userEvent.setup();
    (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        ok: false,
        error: { code: "BAD_REQUEST", message: "Measure column “X” is not in this dataset." },
      }),
    });

    render(<PowerBiStudioPanel datasetId="d1" datasetName="Sales" columns={columns} />);
    await user.click(screen.getByRole("button", { name: /compute/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/not in this dataset/)).toBeInTheDocument();
    });
  });

  it("evaluates a DAX measure and shows a single value", async () => {
    const user = userEvent.setup();
    (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, data: { value: 1300, note: "computed" } }),
    });

    render(<PowerBiStudioPanel datasetId="d1" datasetName="Sales" columns={columns} />);
    await user.click(screen.getByRole("tab", { name: /DAX measures/i }));
    await user.click(screen.getByRole("button", { name: /evaluate/i }));

    await waitFor(() => {
      expect(screen.getByText("1,300")).toBeInTheDocument();
    });
  });

  it("switches to AI visuals and renders the influencer table", async () => {
    const user = userEvent.setup();
    (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          baseRate: 0.5,
          totalRows: 6,
          influencers: [
            {
              category: "Region",
              value: "East",
              likelihood: 2 / 3,
              count: 3,
              ciLow: 0.2,
              ciHigh: 0.9,
              lift: 1.33,
              strength: "weak",
            },
          ],
          skippedColumns: [],
          note: "observed proportions",
        },
      }),
    });

    render(<PowerBiStudioPanel datasetId="d1" datasetName="Sales" columns={columns} />);
    await user.click(screen.getByRole("tab", { name: /AI visuals/i }));
    // Default mode is the tree; switch the visual select to influencers first.
    await user.selectOptions(screen.getByRole("combobox", { name: /Visual/i }), "influencers");
    await user.selectOptions(screen.getByLabelText(/Outcome column/i), "Churned");
    await user.click(screen.getByRole("button", { name: /find influencers/i }));

    await waitFor(() => {
      const table = document.querySelector("table");
      expect(table).not.toBeNull();
      expect(table!.textContent).toContain("Region");
      expect(table!.textContent).toContain("East");
      expect(table!.textContent).toContain("1.33×");
      expect(screen.getByText(/Base rate 50\.0%/)).toBeInTheDocument();
    });
  });
});
