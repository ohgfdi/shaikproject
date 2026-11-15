/**
 * Route-level integration for `POST /api/ca/compute` — the practice-area kinds
 * added with the litigation, timesheets/billing, document-management and ITR-U
 * engines.
 *
 * These engines were written for this surface, so the tests check the ROUTE's
 * rupee→paise contract and the envelopes the UI reads, not merely a 200.
 */

import { POST } from "@/app/api/ca/compute/route";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1" },
      workspace: { id: "w1" },
      settings: {},
      organization: null,
      organizationRole: null,
    })),
  };
});

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/ca/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

async function postOk<T = any>(payload: unknown): Promise<T> {
  const res = await post(payload);
  const json = await res.json();
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(json)}`);
  expect(json.ok).toBe(true);
  return json.data as T;
}

const matter = {
  matterId: "LIT-001",
  clientName: "Sharma Textiles Pvt Ltd",
  pan: "AAAAA0000A",
  assessmentYear: "2023-24",
  orderBy: "ao",
  orderReference: "AO/DEL/2025/11",
  orderDate: "2025-04-10",
  servedDate: "2025-04-15",
  taxEffect: 300000, // ₹3,00,000
  disputedTax: 300000,
  grounds: ["Disallowance u/s 40(a)(ia) without the proviso"],
};

describe("POST /api/ca/compute · litigation", () => {
  it("plans a CIT(A) appeal and dates the limitation from service, in paise", async () => {
    const data = await postOk<{ appealPlan: any }>({ kind: "litigation", op: { op: "plan-appeal", matter } });
    const plan = data.appealPlan;
    expect(plan.nextRoute.to).toBe("cit-appeals");
    expect(plan.limitation.expiryDate).toBe("2025-05-15"); // 15 Apr + 30 days
    expect(plan.taxEffectMinor).toBe(30_000_000); // ₹3,00,000 in paise
    expect(plan.stayDepositMinor).toBe(6_000_000); // 20% of the disputed demand
    expect(plan.feeMinor).toBe(0); // CIT(A) charges no fee
    expect(plan.checklist.length).toBeGreaterThan(0);
  });

  it("prices the ITAT fee from the rupee tax effect when the order is a CIT(A) order", async () => {
    const data = await postOk<{ appealPlan: any }>({
      kind: "litigation",
      op: { op: "plan-appeal", matter: { ...matter, orderBy: "cit-appeals", servedDate: "2025-05-01" } },
    });
    expect(data.appealPlan.nextRoute.to).toBe("itat");
    expect(data.appealPlan.feeMinor).toBe(500_000); // ₹5,000 for a ₹3,00,000 tax effect
  });

  it("rejects a matter with no grounds at the schema boundary", async () => {
    const res = await post({ kind: "litigation", op: { op: "plan-appeal", matter: { ...matter, grounds: [] } } });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION");
  });

  it("rolls a matter list into a limitation portfolio", async () => {
    const data = await postOk<{ litigationPortfolio: any }>({
      kind: "litigation",
      op: {
        op: "portfolio",
        matters: [
          {
            matterId: "M1",
            clientName: "Alpha",
            forum: "cit-appeals",
            taxEffect: 100000,
            servedDate: "2025-05-01",
            limitationDays: 30,
            filingDate: "2025-05-20",
            status: "not-filed",
          },
          {
            matterId: "M2",
            clientName: "Beta",
            forum: "itat",
            taxEffect: 200000,
            servedDate: "2025-05-01",
            limitationDays: 30,
            filingDate: "2025-06-10",
            status: "not-filed",
          },
          {
            matterId: "M3",
            clientName: "Gamma",
            forum: "itat",
            taxEffect: 50000,
            servedDate: "2025-01-01",
            limitationDays: 30,
            filingDate: "2025-02-01",
            status: "filed",
          },
        ],
      },
    });
    expect(data.litigationPortfolio.totalMatters).toBe(3);
    expect(data.litigationPortfolio.filedCount).toBe(1);
    expect(data.litigationPortfolio.atRisk.map((m: any) => m.matterId)).toEqual(["M2"]);
    expect(data.litigationPortfolio.dueSoon.map((m: any) => m.matterId)).toEqual(["M1"]);
    expect(data.litigationPortfolio.totalTaxEffectMinor).toBe(35_000_000); // ₹3,50,000
  });
});

const entries = [
  {
    id: "T1",
    staffId: "S1",
    staffName: "R. Iyer",
    engagementId: "ENG-1",
    clientName: "Sharma Textiles",
    date: "2025-06-01",
    hours: 10,
    billable: true,
    ratePerHour: 2000,
    notes: "Audit fee",
  },
  {
    id: "T2",
    staffId: "S1",
    staffName: "R. Iyer",
    engagementId: "ENG-1",
    clientName: "Sharma Textiles",
    date: "2025-06-05",
    hours: 5,
    billable: true,
    ratePerHour: 2000,
    notes: "Audit fee",
  },
  {
    id: "T3",
    staffId: "S2",
    staffName: "A. Rao",
    engagementId: "ENG-2",
    clientName: "Beta Traders",
    date: "2025-06-06",
    hours: 4,
    billable: false,
    ratePerHour: 2000,
    notes: "Admin",
  },
];

describe("POST /api/ca/compute · timesheets", () => {
  it("summarises utilisation and WIP in paise from rupee rates", async () => {
    const data = await postOk<{ timesheets: any }>({
      kind: "timesheets",
      op: { op: "summarise", entries, asOfDate: "2025-06-30", budgets: { "ENG-1": 20 } },
    });
    const s = data.timesheets;
    expect(s.totals.totalHours).toBe(19);
    expect(s.totals.billableHours).toBe(15);
    expect(s.totals.utilisationPct).toBe(78.9);
    expect(s.totals.wipValueMinor).toBe(3_000_000); // ₹30,000
    // ENG-1 carries the 15 billable hours against a 20-hour budget; ENG-2 only
    // has the non-billable admin time.
    const eng1 = s.byEngagement.find((e: any) => e.engagementId === "ENG-1");
    expect(eng1.totalHours).toBe(15);
    expect(eng1.budgetUsedPct).toBe(75);
    expect(eng1.overBudget).toBe(false);
  });

  it("builds a GST invoice with the intra-state split and the 194J estimate", async () => {
    const data = await postOk<{ invoice: any }>({
      kind: "timesheets",
      op: {
        op: "invoice",
        invoiceNumber: "INV/2025-26/014",
        invoiceDate: "2025-06-30",
        supplierName: "Iyer & Co.",
        supplierGstin: "27AAAAA0000A1Z5",
        supplierStateCode: "27",
        clientName: "Sharma Textiles",
        placeOfSupplyStateCode: "27",
        entries,
        discountPct: 10,
      },
    });
    const inv = data.invoice;
    expect(inv.subtotalMinor).toBe(3_000_000); // ₹30,000, non-billable time excluded
    expect(inv.discountMinor).toBe(300_000);
    expect(inv.taxableValueMinor).toBe(2_700_000);
    expect(inv.cgstMinor).toBe(243_000); // 9% of ₹27,000
    expect(inv.sgstMinor).toBe(243_000);
    expect(inv.igstMinor).toBe(0);
    expect(inv.totalMinor).toBe(3_186_000);
    expect(inv.tdsEstimatedMinor).toBe(270_000); // 10% u/s 194J
    expect(inv.netReceivableMinor).toBe(2_916_000);
  });

  it("refuses an invoice with no billable time", async () => {
    const res = await post({
      kind: "timesheets",
      op: {
        op: "invoice",
        invoiceNumber: "INV-1",
        invoiceDate: "2025-06-30",
        supplierName: "X",
        supplierGstin: "27AAAAA0000A1Z5",
        supplierStateCode: "27",
        clientName: "Y",
        placeOfSupplyStateCode: "27",
        entries: [{ ...entries[2] }],
      },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toMatch(/billable/);
  });
});

const documents = [
  {
    id: "D1",
    name: "EL-Sharma.pdf",
    category: "engagement-letter",
    clientId: "C1",
    clientName: "Sharma Textiles",
    uploadedAt: "2025-01-10",
    uploadedBy: "R. Iyer",
    version: 1,
    sizeBytes: 1000,
    signed: true,
    sharedWithClient: true,
  },
  {
    id: "D2",
    name: "WP-1.xlsx",
    category: "working-paper",
    clientId: "C1",
    clientName: "Sharma Textiles",
    uploadedAt: "2025-03-01",
    uploadedBy: "R. Iyer",
    version: 1,
    sizeBytes: 2000,
    signed: false,
    sharedWithClient: false,
  },
  {
    id: "D3",
    name: "WP-1.xlsx",
    category: "working-paper",
    clientId: "C1",
    clientName: "Sharma Textiles",
    uploadedAt: "2025-04-01",
    uploadedBy: "R. Iyer",
    version: 2,
    sizeBytes: 2000,
    signed: false,
    sharedWithClient: false,
  },
];

describe("POST /api/ca/compute · documents", () => {
  it("builds the register with retention, completeness and conflicts", async () => {
    const data = await postOk<{ documentRegister: any }>({
      kind: "documents",
      op: { op: "register", documents, asOfDate: "2026-10-16" },
    });
    const reg = data.documentRegister;
    expect(reg.totalDocuments).toBe(3);
    expect(reg.totalBytes).toBe(5_000);
    expect(reg.versionConflicts).toEqual([{ name: "WP-1.xlsx", clientId: "C1", versions: [1, 2] }]);
    expect(reg.unsigned.map((u: any) => u.id)).toEqual(["D2", "D3"]);
    expect(reg.completeness.complete).toBe(false);
    expect(reg.completeness.missing).toEqual(["financial-statement", "tax-return"]);
    expect(reg.expired).toHaveLength(0); // everything is inside its retention period
  });

  it("returns the client portal slice with only shared documents", async () => {
    const data = await postOk<{ clientPortal: any }>({
      kind: "documents",
      op: {
        op: "client-portal",
        client: { clientId: "C1", clientName: "Sharma Textiles" },
        documents,
        awaiting: ["kyc"],
      },
    });
    expect(data.clientPortal.visibleDocumentIds).toEqual(["D1"]);
    expect(data.clientPortal.sharedCount).toBe(1);
    expect(data.clientPortal.folders.map((f: any) => f.category)).toEqual(["engagement-letter"]);
    expect(data.clientPortal.checklist[0]).toMatch(/kyc/);
  });

  it("rejects an unknown document category", async () => {
    const res = await post({
      kind: "documents",
      op: { op: "register", documents: [{ ...documents[0], category: "not-a-category" }] },
    });
    expect(res.status).toBe(400);
  });
});

const itrUBase = {
  pan: "AAAAA0000A",
  name: "Sharma Textiles Pvt Ltd",
  assessmentYear: "2023-24",
  originalReturnFiledDate: "2024-07-31",
  updatedReturnFilingDate: "2024-12-15",
  originalTotalIncome: 1000000,
  updatedTotalIncome: 1500000,
  taxOnOriginal: 1000,
  taxOnUpdated: 2500,
  interestOnUpdated: 300,
  taxAlreadyPaid: 1000,
  reasons: ["Incorrect reporting of interest income"],
};

describe("POST /api/ca/compute · itr-u", () => {
  it("computes the 25% s.140B charge and returns a validated ITR-U payload", async () => {
    const data = await postOk<{ updatedReturn: any; validation: any }>({ kind: "itr-u", ...itrUBase });
    const r = data.updatedReturn;
    expect(r.monthsElapsed).toBe(8);
    expect(r.bandRatePct).toBe(25);
    expect(r.additionalIncomeMinor).toBe(50_000_000); // ₹5,00,000
    expect(r.additionalTax140BMinor).toBe(45_000); // 25% of (₹1,500 + ₹300)
    expect(r.netPayableMinor).toBe(225_000); // ₹3,250 liability − ₹1,000 paid
    expect(r.eligible).toBe(true);
    expect(data.validation.valid).toBe(true);
    expect(data.validation.errors).toEqual([]);
  });

  it("blocks an update past the 48-month window", async () => {
    const data = await postOk<{ updatedReturn: any }>({
      kind: "itr-u",
      ...itrUBase,
      updatedReturnFilingDate: "2028-06-01",
    });
    expect(data.updatedReturn.bandRatePct).toBeNull();
    expect(data.updatedReturn.eligible).toBe(false);
    expect(data.updatedReturn.blockers.join(" ")).toMatch(/48-month window/);
  });

  it("rejects a non-PAN at the schema boundary", async () => {
    const res = await post({ kind: "itr-u", ...itrUBase, pan: "NOTAPAN" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION");
  });
});
