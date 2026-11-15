/** @jest-environment jsdom */
/**
 * Component verification of the new CA practice-area panels.
 *
 * These drive the REAL components and assert what each panel posts and renders.
 *
 * SCOPE: the route boundary (rupee input → paise in the engine, envelope shape)
 * is pinned in `__tests__/unit/ca-practice-areas-route.test.ts`, which imports
 * the handler under the node environment. It cannot be imported here: jsdom
 * resolves jose's `browser` export (and next-auth's nested copy of it) to
 * untranspiled ESM that jest cannot parse. So this suite substitutes the HTTP
 * helper with a transport double that applies the SAME rupee→paise conversion
 * and calls the SAME engine the route calls — a panel that posts the wrong
 * field, or renders paise as though it were rupees, still fails here.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DocumentsPanel } from "@/components/ca/ca-documents-panel";
import { ItrUPanel } from "@/components/ca/ca-itru-panel";
import {
  ConcurrentAuditPanel,
  InternalAuditPanel,
  LitigationPanel,
  StockAuditPanel,
} from "@/components/ca/ca-practice-panels";
import { TimesheetsPanel } from "@/components/ca/ca-timesheets-panel";
import { api } from "@/lib/client/api";
import { buildClientPortalView, buildDocumentRegister } from "@/lib/engine/ca-documents";
import { computeConcurrentAudit, computeInternalAudit, computeStockAudit } from "@/lib/engine/ca-internal-audit-api";
import { litigationPortfolio, planAppeal } from "@/lib/engine/ca-litigation";
import { buildUpdatedReturn, validateItrUPayload } from "@/lib/engine/itr-u";
import { buildTaxInvoice, buildTimesheetSummary } from "@/lib/engine/practice-timesheets";

jest.mock("@/lib/client/api", () => ({
  api: jest.fn(),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));

const mockApi = api as jest.MockedFunction<typeof api>;

const paise = (rupees: number) => Math.round(rupees * 100);

/** Mirror of the route's kind→engine dispatch for the kinds these panels post. */
function compute(body: Record<string, any>): unknown {
  const op = body.op;
  switch (body.kind) {
    case "internal-audit":
      return { internalAudit: computeInternalAudit(op) };
    case "concurrent-audit":
      return { concurrentAudit: computeConcurrentAudit(op) };
    case "stock-audit":
      return { stockAudit: computeStockAudit(op) };
    case "litigation": {
      if (op.op === "plan-appeal") {
        const m = op.matter;
        return {
          appealPlan: planAppeal({
            ...m,
            taxEffectMinor: paise(m.taxEffect),
            disputedTaxMinor: m.disputedTax === undefined ? undefined : paise(m.disputedTax),
          }),
        };
      }
      return {
        litigationPortfolio: litigationPortfolio(
          { matters: op.matters.map((m: any) => ({ ...m, taxEffectMinor: paise(m.taxEffect) })) },
          op.dueSoonDays,
        ),
      };
    }
    case "timesheets": {
      const entries = op.entries.map((e: any) => ({ ...e, ratePerHourMinor: paise(e.ratePerHour) }));
      if (op.op === "summarise") {
        return {
          timesheets: buildTimesheetSummary({
            entries,
            budgets: op.budgets,
            targetUtilisationPct: op.targetUtilisationPct,
            asOfDate: op.asOfDate,
          }),
        };
      }
      return {
        invoice: buildTaxInvoice({
          invoiceNumber: op.invoiceNumber,
          invoiceDate: op.invoiceDate,
          supplierName: op.supplierName,
          supplierGstin: op.supplierGstin,
          supplierStateCode: op.supplierStateCode,
          clientName: op.clientName,
          clientGstin: op.clientGstin ?? null,
          placeOfSupplyStateCode: op.placeOfSupplyStateCode,
          entries,
          discountPct: op.discountPct,
        }),
      };
    }
    case "documents": {
      const documents = op.documents.map((d: any) => ({ ...d, engagementId: d.engagementId ?? null }));
      if (op.op === "register")
        return { documentRegister: buildDocumentRegister(documents, { asOfDate: op.asOfDate }) };
      return { clientPortal: buildClientPortalView(op.client, documents, { awaiting: op.awaiting }) };
    }
    case "itr-u": {
      const result = buildUpdatedReturn({
        pan: body.pan,
        name: body.name,
        assessmentYear: body.assessmentYear,
        originalReturnFiledDate: body.originalReturnFiledDate ?? null,
        updatedReturnFilingDate: body.updatedReturnFilingDate,
        originalTotalIncomeMinor: paise(body.originalTotalIncome),
        updatedTotalIncomeMinor: paise(body.updatedTotalIncome),
        taxOnOriginalMinor: paise(body.taxOnOriginal),
        taxOnUpdatedMinor: paise(body.taxOnUpdated),
        interestOnUpdatedMinor: paise(body.interestOnUpdated),
        taxAlreadyPaidMinor: paise(body.taxAlreadyPaid),
        pendingProceedings: body.pendingProceedings,
        searchOrSurvey: body.searchOrSurvey,
        reducesReportedIncome: body.reducesReportedIncome,
        showsLoss: body.showsLoss,
        reasons: body.reasons,
      });
      return { updatedReturn: result, validation: validateItrUPayload(result.payload) };
    }
    default:
      throw new Error(`unhandled kind "${body.kind}"`);
  }
}

mockApi.mockImplementation(((path: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
  return Promise.resolve(compute(body));
}) as typeof api);

function lastBody(): Record<string, any> {
  const call = mockApi.mock.calls[mockApi.mock.calls.length - 1]!;
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? "{}"));
}

beforeEach(() => {
  mockApi.mockClear();
});

describe("InternalAuditPanel", () => {
  it("assesses the default engagement and shows the rating and findings", async () => {
    const user = userEvent.setup();
    render(<InternalAuditPanel />);

    await user.click(screen.getByRole("button", { name: /Assess internal audit/i }));

    await waitFor(() => expect(screen.getByText(/Overall:/)).toBeInTheDocument());
    // Five components rated "adequate" on both design and operation, so the
    // engagement rating is the worst of them: adequate.
    expect(screen.getByText(/Overall:/).textContent).toContain("adequate");
    expect(lastBody().op.plan.materiality).toBe(500000); // rupees at the boundary
    expect(lastBody().op.plan.cosoComponents).toHaveLength(5);
    expect(screen.getAllByText(/1 open/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Three-way match not evidenced/).length).toBeGreaterThan(0);
  });
});

describe("ConcurrentAuditPanel", () => {
  it("flags the breached limit with the right headroom and blocks sign-off", async () => {
    const user = userEvent.setup();
    render(<ConcurrentAuditPanel />);

    await user.click(screen.getByRole("button", { name: /Assess branch/i }));

    await waitFor(() => expect(screen.getAllByText(/Single borrower exposure/).length).toBeGreaterThan(0));
    // ₹1,20,00,000 exposure against a ₹1,00,00,000 limit → ₹20,00,000 of negative headroom.
    expect(screen.getByText(/-20,00,000/)).toBeInTheDocument();
    expect(screen.getByText(/block sign-off/i)).toBeInTheDocument();
  });
});

describe("StockAuditPanel", () => {
  it("reconciles the default areas and reports the variance", async () => {
    const user = userEvent.setup();
    render(<StockAuditPanel />);

    await user.click(screen.getByRole("button", { name: /Reconcile stock/i }));

    await waitFor(() => expect(screen.getByText(/within materiality/)).toBeInTheDocument());
    expect(screen.getAllByText(/Yarn store/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5,000/).length).toBeGreaterThan(0);
  });
});

describe("LitigationPanel", () => {
  it("plans the appeal and reports the limitation window", async () => {
    const user = userEvent.setup();
    render(<LitigationPanel />);

    await user.click(screen.getByRole("button", { name: /Plan the appeal/i }));

    await waitFor(() => expect(screen.getAllByText(/Next forum:/).length).toBeGreaterThan(0));
    // Served 2025-04-15 + a 30-day limitation → expiry 2025-05-15 (the panel
    // shows it in the limitation line and again in the methodology).
    expect(screen.getAllByText(/expiry 2025-05-15/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Filing checklist/)).toBeInTheDocument();
    expect(lastBody().op.matter.taxEffect).toBe(300000);
  });

  it("checks limitation risk across the portfolio", async () => {
    const user = userEvent.setup();
    render(<LitigationPanel />);

    await user.click(screen.getByRole("button", { name: /Check limitation risk/i }));

    await waitFor(() => expect(screen.getByText(/matters ·/)).toBeInTheDocument());
    expect(screen.getByText(/M1/)).toBeInTheDocument();
  });
});

describe("TimesheetsPanel", () => {
  it("summarises utilisation and WIP from the same time ledger", async () => {
    const user = userEvent.setup();
    render(<TimesheetsPanel />);

    await user.click(screen.getByRole("button", { name: /Summarise time/i }));

    await waitFor(() => expect(screen.getByText(/utilisation 78.9%/)).toBeInTheDocument());
    expect(screen.getAllByText(/30,000/).length).toBeGreaterThan(0); // 15 h × ₹2,000 of WIP
    expect(lastBody().op.entries[0].ratePerHour).toBe(2000);
  });

  it("builds a tax invoice with the s.194J deduction", async () => {
    const user = userEvent.setup();
    render(<TimesheetsPanel />);

    await user.click(screen.getByRole("button", { name: /Build tax invoice/i }));

    await waitFor(() => expect(screen.getByText(/Net receivable/)).toBeInTheDocument());
    expect(screen.getAllByText(/TDS u\/s 194J/).length).toBeGreaterThan(0);
    expect(lastBody().op.entries).toHaveLength(3);
  });
});

describe("DocumentsPanel", () => {
  it("reports the missing required category in the register", async () => {
    const user = userEvent.setup();
    render(<DocumentsPanel />);

    await user.click(screen.getByRole("button", { name: /Build register/i }));

    await waitFor(() => expect(screen.getByText(/Missing required categories/i)).toBeInTheDocument());
    expect(screen.getByText(/financial-statement/)).toBeInTheDocument();
  });

  it("shows the client only the shared documents", async () => {
    const user = userEvent.setup();
    render(<DocumentsPanel />);

    await user.click(screen.getByRole("button", { name: /Open the portal/i }));

    await waitFor(() => expect(screen.getByText(/shared document/)).toBeInTheDocument());
    expect(screen.getByText(/Engagement-letter.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/ITR-FY25.pdf/)).toBeInTheDocument();
    // The unshared working paper must not appear in the client's view.
    expect(screen.queryByText(/WP-1.xlsx/)).not.toBeInTheDocument();
    expect(screen.getByText(/Upload \/ confirm the kyc/)).toBeInTheDocument();
  });
});

describe("ItrUPanel", () => {
  it("computes the s.140B band and renders the payload", async () => {
    const user = userEvent.setup();
    render(<ItrUPanel />);

    await user.click(screen.getByRole("button", { name: /Compute the updated return/i }));

    await waitFor(() => expect(screen.getAllByText(/s.140B band:/).length).toBeGreaterThan(0));
    // 8 whole months after the AY ended 2024-03-31 → the 25% band.
    expect(screen.getAllByText(/25%/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Net payable/)).toBeInTheDocument();
    expect(screen.getAllByText(/s.140B additional tax/).length).toBeGreaterThan(0);
    expect(lastBody().updatedTotalIncome).toBe(1500000); // rupees at the boundary
    // The payload the gateway would receive is rendered, and it is an ITR-U.
    expect(screen.getAllByText(/ITR-U/).length).toBeGreaterThan(0);
  });
});
