/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, WarningBanner, ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";

describe("feedback UI states", () => {
  it("ErrorMessage explains what happened and how to fix", async () => {
    const user = userEvent.setup();
    render(<ErrorMessage title="Upload failed" message="File too large." howToFix="Split the file." />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    // "What happened?" is a disclosure
    expect(screen.getByText("What happened?")).toBeInTheDocument();
    expect(screen.getByText("File too large.")).toBeInTheDocument();
    expect(screen.getByText(/Split the file\./)).toBeInTheDocument();
    void user;
  });

  it("ErrorMessage offers a Retry action when provided", async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    render(<ErrorMessage title="Boom" onRetry={onRetry} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("EmptyState renders title, description and CTA", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No data yet"
        description="Upload a file to begin."
        action={<button>Upload</button>}
      />,
    );
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.getByText("Upload a file to begin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("DemoBadge is labelled with its tooltip for assistive tech", () => {
    render(<DemoBadge tooltip="Calculated using prototype logic; live ML pipelines coming soon." />);
    const badge = screen.getByText("Prototype / Demo");
    expect(badge).toBeInTheDocument();
    // The tooltip is in an sr-only node so screen readers announce it.
    expect(screen.getByText(/live ML pipelines coming soon/i)).toBeInTheDocument();
  });

  it("WarningBanner is dismissible", async () => {
    const user = userEvent.setup();
    const onDismiss = jest.fn();
    render(
      <WarningBanner title="Missing values" onDismiss={onDismiss}>
        region has gaps
      </WarningBanner>,
    );
    expect(screen.getByText("Missing values")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("LoadingSkeleton renders placeholder shapes and marks the region busy", () => {
    const { container } = render(<LoadingSkeleton rows={2} />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThanOrEqual(6);
  });
});
