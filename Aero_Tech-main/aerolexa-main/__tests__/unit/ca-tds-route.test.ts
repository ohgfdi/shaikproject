/**
 * Route-level integration for `POST /api/ca/compute` with the TDS kinds.
 *
 * These engines (tds-sections, tds-challan-engine, tds-penalty-exposure) were
 * orphaned — reachable only from their own tests. The assertions are hand-computed
 * and check the ROUTE's rupee→paise contract, not just a 200.
 *
 * NOTE: `tds-threshold-engine` is not covered here — its threshold table was a
 * factor of ten below true paise, so it was originally left unexposed. That
 * unit defect has since been fixed (thresholds are declared in whole rupees via
 * `inPaise()`), and the engine is now a live kind; its route contract is pinned
 * in `__tests__/unit/ca-orphan-engines-route.test.ts` instead.
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

describe("POST /api/ca/compute · tds-section", () => {
  it("looks up a section from the applicability matrix in correct paise", async () => {
    const res = await post({ kind: "tds-section", section: "194C" });
    expect(res.status).toBe(200);
    const json = await res.json();
    const sections = json.data.sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].section).toBe("194C");
    expect(sections[0].form).toBe("26Q");
    expect(sections[0].isTcs).toBe(false);
    // The matrix stores ₹30,000 correctly as 3,000,000 paise (30000 * 100).
    expect(sections[0].thresholdMinor).toBe(3_000_000);
  });

  it("lists every section that travels in one return form", async () => {
    const res = await post({ kind: "tds-section", form: "24Q" });
    const json = await res.json();
    expect(json.data.sections.length).toBeGreaterThan(0);
    expect(json.data.sections.every((s: { form: string }) => s.form === "24Q")).toBe(true);
  });

  it("returns an empty list for an unknown section", async () => {
    const res = await post({ kind: "tds-section", section: "9999" });
    const json = await res.json();
    expect(json.data.sections).toHaveLength(0);
  });
});

describe("POST /api/ca/compute · tds-challan-recon", () => {
  it("matches a challan to a bank credit within the window", async () => {
    const res = await post({
      kind: "tds-challan-recon",
      challans: [{ bsrCode: "0001234", challanSerial: "00001", dateOfDeposit: "2025-07-07", amount: 10_000 }],
      bankStatement: [{ date: "2025-07-08", description: "TDS challan", amount: 10_000, ref: "UTR1" }],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const entry = json.data.reconciliation[0];
    expect(entry.status).toBe("matched");
    expect(entry.challanAmount).toBe(1_000_000);
    expect(entry.bankAmount).toBe(1_000_000);
    expect(entry.difference).toBe(0);
  });

  it("flags a short credit as 'short' with the paise difference", async () => {
    const res = await post({
      kind: "tds-challan-recon",
      challans: [{ bsrCode: "0001234", challanSerial: "00002", dateOfDeposit: "2025-07-07", amount: 10_000 }],
      bankStatement: [{ date: "2025-07-08", description: "TDS challan", amount: 9_000, ref: "UTR2" }],
    });
    const json = await res.json();
    const entry = json.data.reconciliation[0];
    expect(entry.status).toBe("short");
    expect(entry.difference).toBe(-100_000);
  });

  it("rejects a challan with no BSR code", async () => {
    const res = await post({
      kind: "tds-challan-recon",
      challans: [{ bsrCode: "", challanSerial: "1", dateOfDeposit: "2025-07-07", amount: 1 }],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ca/compute · tds-penalty-exposure", () => {
  it("computes 201(1A)(i) interest on a late deduction in paise", async () => {
    const res = await post({
      kind: "tds-penalty-exposure",
      params: { tan: "MUMA12345A", returnFilingDueDate: "2025-07-31" },
      events: [
        {
          id: "E1",
          section: "194J",
          payeeName: "Vendor",
          baseAmount: 100_000,
          ratePct: 10,
          taxShouldBe: 10_000,
          taxActual: 0,
          deductibleDate: "2025-04-15",
          deductedDate: "2025-06-15",
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const exposure = json.data.tdsExposure;
    expect(exposure.params.tan).toBe("MUMA12345A");
    const lateDeduction = exposure.exposures.find((e: { reason: string }) => e.reason === "late-deduction");
    expect(lateDeduction).toBeTruthy();
    // 15 Apr → 15 Jun = 2 part-or-full months; ₹10,000 tax × 1% × 2 = ₹200 = 20,000 paise.
    expect(lateDeduction.months).toBe(2);
    expect(lateDeduction.amount).toBe(20_000);
    expect(exposure.totalInterest).toBeGreaterThanOrEqual(20_000);
  });
});
