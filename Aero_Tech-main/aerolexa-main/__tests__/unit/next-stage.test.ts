import { buildClientComplianceCalendar } from "@/lib/engine/compliance-calendar";
import type { ComplianceTask } from "@/lib/engine/compliance-calendar";
import { buildFilingShadowPlan } from "@/lib/engine/filing/shadow";
import type { ItcReconciliation, ReconciledInvoice } from "@/lib/engine/gstr-2b-itc";
import { summarizeItcConfidence } from "@/lib/engine/itc-confidence";
import { buildNudgeDigest } from "@/lib/server/compliance-nudges";
import { buildApprovalAuditBundle } from "@/lib/server/receipt-audit-bundle";
import { summarizeTenantOps } from "@/lib/server/tenant-ops";

function invoice(overrides: Partial<ReconciledInvoice>): ReconciledInvoice {
  return {
    key: "27AAAAA0000A1Z5:INV-1:INV",
    gstin: "27AAAAA0000A1Z5",
    supplierName: "Supplier",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-10-01",
    docType: "INV",
    verdict: "matched-eligible",
    twoB: null,
    books: null,
    taxDifference: 0,
    blockedCategory: null,
    blockedLabel: null,
    s16Deadline: "2027-11-30",
    reasons: [],
    ...overrides,
  };
}

function reconciliation(invoices: ReconciledInvoice[]): ItcReconciliation {
  return {
    invoices,
    table4: {} as ItcReconciliation["table4"],
    counts: {} as ItcReconciliation["counts"],
    warnings: [],
    methodology: [],
  };
}

describe("filing shadow plan", () => {
  const base = {
    channel: "irp-irn" as const,
    provider: "live" as const,
    payload: { invoice: "INV-1" },
    token: "run-12345678",
    providerConfigured: true,
    missingCredentials: [],
    signingRequired: false,
    signingConfigured: false,
  };

  it("computes a digest and never claims to transmit", () => {
    const plan = buildFilingShadowPlan(base);
    expect(plan.willTransmit).toBe(false);
    expect(plan.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.blockers).toEqual([]);
    expect(plan.summary).toContain("nothing was transmitted");
  });

  it("lists missing credentials and missing signing as blockers", () => {
    const plan = buildFilingShadowPlan({
      ...base,
      channel: "efiling-audit",
      providerConfigured: false,
      missingCredentials: ["FILING_EFILING_CLIENT_ID"],
      signingRequired: true,
      signingConfigured: false,
    });
    expect(plan.blockers.join(" ")).toContain("FILING_EFILING_CLIENT_ID");
    expect(plan.blockers.join(" ")).toContain("DSC");
    expect(plan.checks.find((check) => check.id === "signing")?.ok).toBe(false);
  });
});

describe("ITC match confidence", () => {
  it("scores eligible matches highest and puts exceptions in a worklist", () => {
    const result = summarizeItcConfidence(
      reconciliation([
        invoice({}),
        invoice({ key: "k2", invoiceNumber: "INV-2", verdict: "amount-mismatch" }),
        invoice({ key: "k3", invoiceNumber: "INV-3", verdict: "in-books-only" }),
      ]),
    );
    expect(result.counts.high).toBe(1);
    expect(result.counts.low).toBe(2);
    expect(result.worklist[0]?.invoiceNumber).toBe("INV-3");
    expect(result.summary).toContain("2 of 3");
  });

  it("claims no confidence when nothing was compared", () => {
    const result = summarizeItcConfidence(reconciliation([]));
    expect(result.score).toBe(0);
    expect(result.summary).toContain("no confidence");
  });
});

describe("tenant ops", () => {
  it("ranks a tenant with overdue filings above a healthy one", () => {
    const posture = summarizeTenantOps([
      { organizationId: "a", organizationName: "Alpha", overdueFilings: 0, openFilings: 2, pendingMail: 0, failedMail: 0 },
      { organizationId: "b", organizationName: "Beta", overdueFilings: 3, openFilings: 0, pendingMail: 1, failedMail: 0 },
    ]);
    expect(posture.tenants[0]?.organizationName).toBe("Beta");
    expect(posture.tenants[0]?.attention).toBe("critical");
    expect(posture.totals.overdueFilings).toBe(3);
  });
});

describe("approval audit bundle", () => {
  it("states when there is no receipt instead of implying approval evidence", () => {
    const bundle = buildApprovalAuditBundle({
      organization: { id: "org", name: "Firm" },
      engagementName: "Client",
      generatedAt: new Date("2026-11-13T00:00:00Z"),
      events: [],
      run: {
        id: "run",
        taskId: "task",
        title: "GSTR-3B",
        authority: "GSTN",
        dueDate: "2026-11-20",
        stage: "prepared",
        filedAt: null,
        acknowledgementReference: null,
        verificationStatus: "unverified",
        clientApprovedAt: null,
        clientApprovalReceipt: null,
        clientApprovalDigest: null,
      },
    });
    expect(bundle.approval.receipt).toBeNull();
    expect(bundle.approval.digestMatches).toBeNull();
    expect(bundle.notes.join(" ")).toContain("No client approval receipt");
  });
});

describe("labour coverage", () => {
  it("adds monthly EPF ECR and ESI obligations only for employers", () => {
    const profile = {
      clientId: "e1",
      clientName: "Acme",
      entityKind: "company" as const,
      financialYear: "2025-26",
      gstRegistered: false,
      gstFrequency: "monthly" as const,
      tdsDeductor: false,
      taxAuditApplicable: false,
      transferPricingApplicable: false,
      listedCompany: false,
      state: null,
      employsStaff: true,
    };
    const tasks = buildClientComplianceCalendar(profile);
    expect(tasks.filter((task) => task.code === "EPF-ECR")).toHaveLength(12);
    expect(tasks.filter((task) => task.code === "ESI-RETURN")).toHaveLength(12);
    expect(tasks.find((task) => task.code === "EPF-ECR" && task.period === "Apr 2025")?.dueDate).toBe("2025-05-15");
    expect(buildClientComplianceCalendar({ ...profile, employsStaff: false }).some((task) => task.code === "EPF-ECR")).toBe(false);
  });
});

describe("compliance nudge digest", () => {
  function task(overrides: Partial<ComplianceTask>): ComplianceTask {
    return {
      id: "t1",
      clientId: "c1",
      clientName: "Acme",
      code: "GSTR-3B",
      title: "GSTR-3B",
      authority: "GSTN",
      period: "Oct 2026",
      dueDate: "2026-11-20",
      note: null,
      ...overrides,
    };
  }

  it("includes overdue and near dates, with an explicit non-notice disclaimer", () => {
    const digest = buildNudgeDigest({
      firmName: "Firm",
      clientName: "Acme",
      today: "2026-11-13",
      tasks: [task({}), task({ id: "t2", title: "GSTR-1", dueDate: "2026-10-11" }), task({ id: "t3", dueDate: "2027-03-31" })],
    });
    expect(digest?.taskCount).toBe(2);
    expect(digest?.text).toContain("overdue by 33 days");
    expect(digest?.text).toContain("not a statutory notice");
  });

  it("returns null when nothing is within the horizon", () => {
    expect(
      buildNudgeDigest({ firmName: "Firm", clientName: "Acme", today: "2026-11-13", tasks: [task({ dueDate: "2027-03-31" })] }),
    ).toBeNull();
  });
});
