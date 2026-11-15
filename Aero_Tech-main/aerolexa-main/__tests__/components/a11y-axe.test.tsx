/** @jest-environment jsdom */
/**
 * Accessibility gate for the shared UI surface (axe-core, WCAG AA).
 *
 * Why this exists next to the existing Playwright scan
 * (`__tests__/e2e/a11y.spec.ts`): the e2e gate needs a browser, a running
 * server and a real signup, so it is slow and only runs in the e2e job. These
 * shared primitives are what EVERY page composes, so a regression in a Button,
 * Dialog, Table or loading skeleton would previously only surface in the slow
 * browser suite (or not at all).
 *
 * Scanning here makes the primitives cheap to verify on every `npm test`, and
 * keeps the rule consistent with the e2e gate: no critical or serious
 * violations. Minor/moderate findings are printed for triage, not failed.
 */
import { render, screen } from "@testing-library/react";
import axe from "axe-core";

import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage, GallerySkeleton, LoadingSkeleton, TableSkeleton } from "@/components/ui/feedback";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { DataTable, Table, TableBody, Td, Th, TableRow } from "@/components/ui/table";

/** Only critical/serious block the build — mirrors the e2e a11y gate. */
async function expectNoSeriousViolations(container: HTMLElement, label: string) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    // jsdom does not load the Tailwind stylesheet or the CSS custom properties
    // the palette resolves through, so axe cannot compute real contrast ratios
    // and reports every text node as 1:1. The rule stays ON in the Playwright
    // gate (real browser, real CSS); disabling it here keeps genuine findings
    // from being buried under hundreds of false contrast errors.
    rules: { "color-contrast": { enabled: false } },
  });

  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  for (const v of results.violations) {
    if (v.impact !== "critical" && v.impact !== "serious") continue;
    // eslint-disable-next-line no-console
    console.error(
      `[axe] ${label} — [${v.impact}] ${v.id}: ${v.help} — ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(" | ")}`,
    );
  }
  if (blocking.length > 0) {
    // The console.error above already names each rule; make the failure itself
    // self-describing rather than a bare empty-array diff.
    throw new Error(
      `${label} must have no critical/serious axe violations — found: ${blocking
        .map((v) => `[${v.impact}] ${v.id}`)
        .join(", ")}`,
    );
  }
  expect(blocking).toEqual([]);
}

describe("shared UI primitives are accessible", () => {
  it("buttons carry an accessible name", async () => {
    render(
      <div>
        <Button>Save dataset</Button>
        {/* Icon-only buttons must still expose a name — this is the single
            most common a11y regression in an icon-driven UI. */}
        <Button aria-label="Refresh dashboard">
          <span aria-hidden>⟳</span>
        </Button>
        <Button variant="secondary">Cancel</Button>
        <ButtonLink href="/dashboard">Back to dashboard</ButtonLink>
      </div>,
    );
    expect(screen.getByRole("button", { name: "Save dataset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toBeInTheDocument();
    await expectNoSeriousViolations(document.body, "buttons");
  });

  it("a data table exposes its header structure", async () => {
    render(
      <DataTable
        caption="Revenue by region"
        columns={[
          { key: "region", label: "Region" },
          { key: "revenue", label: "Revenue", format: "number" },
        ]}
        rows={[
          ["East", 1200],
          ["West", 900],
        ]}
      />,
    );
    // The table must be NAMED, not just present — an unnamed table is
    // unusable when several render on one page.
    expect(screen.getByRole("table", { name: /revenue by region/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Region" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "East" })).toBeInTheDocument();
    await expectNoSeriousViolations(document.body, "data table");
  });

  it("the error state is announced to assistive tech", async () => {
    render(<ErrorMessage title="Upload failed" message="File too large." howToFix="Use a CSV under 10 MB." />);
    // role="alert" is what makes a failure perceivable without sight.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await expectNoSeriousViolations(document.body, "error message");
  });

  it("loading skeletons expose a busy state", async () => {
    const { container } = render(
      <div>
        <LoadingSkeleton rows={2} />
        <TableSkeleton rows={2} columns={3} />
        <GallerySkeleton items={2} />
      </div>,
    );
    // Every async placeholder must announce itself as busy, otherwise a screen
    // reader reports an empty page rather than "loading".
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(3);
    await expectNoSeriousViolations(document.body, "loading skeletons");
  });

  it("the empty state has a heading", async () => {
    render(<EmptyState title="No datasets yet" description="Upload a CSV to get started." />);
    await expectNoSeriousViolations(document.body, "empty state");
  });

  it("a card keeps its heading in the accessibility tree", async () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Dataset profile</CardTitle>
        </CardHeader>
        <CardContent>12 rows analysed.</CardContent>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Dataset profile" })).toBeInTheDocument();
    await expectNoSeriousViolations(document.body, "card");
  });
});

describe("raw table primitives keep a valid structure", () => {
  it("Table composes into a table role", async () => {
    render(
      <Table>
        <TableRow>
          <Th scope="col">Metric</Th>
        </TableRow>
        <TableBody>
          <TableRow>
            <Td>Revenue</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metric" })).toBeInTheDocument();
    await expectNoSeriousViolations(document.body, "table primitives");
  });
});
