/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InsightCardView } from "@/components/insight/insight-card";
import type { InsightCard } from "@/lib/types";

const insight: InsightCard = {
  id: "i1",
  title: "Revenue accelerated in Q4",
  severity: "warning",
  metric: "revenue",
  observedChange: "+18.4% vs previous period",
  evidence: ["revenue increased from $412,000 (Q3) to $488,000 (Q4)", "Online channel drove 62% of the growth"],
  possibleCause: "Holiday-season demand combined with a partner promotion.",
  businessImplication: "Cash flow strengthens ahead of the fiscal year end.",
  recommendedNextStep: "Lock in Q1 supply commitments early to avoid stockouts.",
  confidence: "inferred",
  createdAt: "2026-01-04T00:00:00.000Z",
};

describe("InsightCardView", () => {
  it("renders title, severity, observed change and confidence", () => {
    render(<InsightCardView insight={insight} />);
    expect(screen.getByText("Revenue accelerated in Q4")).toBeInTheDocument();
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.getByText("+18.4% vs previous period")).toBeInTheDocument();
    expect(screen.getByText("inferred")).toBeInTheDocument();
    expect(screen.getByText("Demo logic")).toBeInTheDocument();
  });

  it("opens the evidence dialog listing each cited line", async () => {
    const user = userEvent.setup();
    render(<InsightCardView insight={insight} />);
    await user.click(screen.getByRole("button", { name: "View evidence" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/increased from \$412,000/)).toBeInTheDocument();
    expect(screen.getByText(/Online channel drove 62%/)).toBeInTheDocument();
  });

  it("reveals business context on demand", async () => {
    const user = userEvent.setup();
    render(<InsightCardView insight={insight} />);
    await user.click(screen.getByRole("button", { name: /business read/i }));
    expect(screen.getByText(/Holiday-season demand combined/)).toBeInTheDocument();
    expect(screen.getByText(/Lock in Q1 supply commitments/)).toBeInTheDocument();
  });

  it("calls onDelete when present", async () => {
    const user = userEvent.setup();
    const onDelete = jest.fn();
    render(<InsightCardView insight={insight} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete insight" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
