/**
 * Litigation & appeals engine — oracle tests.
 *
 * Every number here is hand-computed. Money is integer paise; dates are
 * yyyy-mm-dd. The statutory tables are defaults, so the tests pin the
 * ARITHMETIC (which slab, which date, which order), not the law.
 */

import {
  APPEAL_ROUTES,
  DEFAULT_APPEAL_FEE_SLABS,
  appealFee,
  daysBetween,
  limitationStatus,
  litigationPortfolio,
  planAppeal,
} from "@/lib/engine/ca-litigation";

describe("appealFee", () => {
  it("charges ₹500 when the tax effect is within ₹1,00,000", () => {
    expect(appealFee(1_00_000 * 100)).toBe(500 * 100);
    expect(appealFee(10_000 * 100)).toBe(500 * 100);
  });

  it("charges ₹1,500 in the ₹1L–₹2L slab", () => {
    expect(appealFee(1_50_000 * 100)).toBe(1_500 * 100);
  });

  it("charges ₹5,000 in the ₹2L–₹5L slab", () => {
    expect(appealFee(5_00_000 * 100)).toBe(5_000 * 100);
  });

  it("charges ₹10,000 above ₹5,00,000", () => {
    expect(appealFee(50_00_000 * 100)).toBe(10_000 * 100);
  });

  it("takes a caller-supplied slab table instead of the default", () => {
    expect(appealFee(9_00_000 * 100, [{ uptoMinor: null, feeMinor: 7_77 * 100 }])).toBe(7_77 * 100);
  });

  it("refuses a negative tax effect", () => {
    expect(() => appealFee(-1)).toThrow(/negative/);
  });

  it("exposes monotonic default slabs, the last of which is open-ended", () => {
    expect(DEFAULT_APPEAL_FEE_SLABS).toHaveLength(4);
    expect(DEFAULT_APPEAL_FEE_SLABS[DEFAULT_APPEAL_FEE_SLABS.length - 1]!.uptoMinor).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts calendar days forward and backward", () => {
    expect(daysBetween("2025-05-01", "2025-05-31")).toBe(30);
    expect(daysBetween("2025-05-31", "2025-05-01")).toBe(-30);
    expect(daysBetween("2025-05-01", "2025-05-01")).toBe(0);
  });

  it("handles a month boundary and a leap day", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // 2024 is a leap year
  });

  it("rejects a non-ISO date", () => {
    expect(() => daysBetween("01-05-2025", "2025-05-31")).toThrow(/yyyy-mm-dd/);
  });
});

describe("limitationStatus", () => {
  it("computes the expiry as service date + limitation days", () => {
    // Served 2025-05-01, CIT(A) limitation 30 days → expiry 2025-05-31.
    const status = limitationStatus({ servedDate: "2025-05-01", limitationDays: 30, filingDate: "2025-05-20" });
    expect(status.expiryDate).toBe("2025-05-31");
    expect(status.daysRemaining).toBe(11);
    expect(status.withinLimitation).toBe(true);
    expect(status.requiresCondonation).toBe(false);
    expect(status.delayDays).toBe(0);
  });

  it("flags a late filing with the delay that needs condonation", () => {
    const status = limitationStatus({ servedDate: "2025-05-01", limitationDays: 30, filingDate: "2025-06-05" });
    expect(status.withinLimitation).toBe(false);
    expect(status.requiresCondonation).toBe(true);
    expect(status.delayDays).toBe(5); // expiry 31 May, filed 5 June
  });

  it("treats filing on the expiry date as in time", () => {
    const status = limitationStatus({ servedDate: "2025-05-01", limitationDays: 30, filingDate: "2025-05-31" });
    expect(status.withinLimitation).toBe(true);
    expect(status.daysRemaining).toBe(0);
  });
});

describe("planAppeal", () => {
  const base = {
    matterId: "LIT-001",
    clientName: "Sharma Textiles Pvt Ltd",
    pan: "AAAAA0000A",
    assessmentYear: "2023-24",
    orderBy: "ao" as const,
    orderReference: "AO/DEL/2025/11",
    orderDate: "2025-04-10",
    servedDate: "2025-04-15",
    taxEffectMinor: 3_00_000 * 100,
    disputedTaxMinor: 3_00_000 * 100,
    grounds: ["Disallowance u/s 40(a)(ia) without appreciating the proviso"],
  };

  it("picks the CIT(A) step, prices no fee and dates the limitation from service", () => {
    const plan = planAppeal(base);
    expect(plan.nextRoute?.to).toBe("cit-appeals");
    expect(plan.nextRoute?.limitationDays).toBe(30);
    expect(plan.nextRoute?.statute).toBe("s.249(2) / s.246A(3)");
    expect(plan.feeMinor).toBe(0); // CIT(A) charges no filing fee
    expect(plan.limitation.expiryDate).toBe("2025-05-15"); // 15 Apr + 30 days
    expect(plan.limitation.withinLimitation).toBe(true);
    expect(plan.stayDepositMinor).toBe(60_000 * 100); // 20% of ₹3,00,000
  });

  it("keeps the remaining ladder from the forum whose order is appealed", () => {
    const plan = planAppeal(base);
    expect(plan.ladder.map((l) => l.to)).toEqual(["cit-appeals", "itat", "high-court"]);
    expect(plan.ladder.map((l) => l.limitationDays)).toEqual([30, 60, 120]);
  });

  it("prices the ITAT fee when the appeal is from the CIT(A)", () => {
    const plan = planAppeal({ ...base, orderBy: "cit-appeals", servedDate: "2025-05-01" });
    expect(plan.nextRoute?.to).toBe("itat");
    expect(plan.ladder.map((l) => l.to)).toEqual(["itat", "high-court"]);
    // ₹3,00,000 tax effect lands in the ₹2L–₹5L slab → ₹5,000.
    expect(plan.feeMinor).toBe(5_000 * 100);
  });

  it("requires condonation when the filing date is past the expiry", () => {
    const plan = planAppeal({ ...base, filingDate: "2025-06-20" });
    expect(plan.limitation.requiresCondonation).toBe(true);
    expect(plan.limitation.delayDays).toBe(36); // expiry 15 May, filed 20 Jun
    expect(plan.warnings.join(" ")).toMatch(/condonation/);
    expect(plan.checklist.join(" ")).toMatch(/condonation/);
  });

  it("stops at the High Court with a warning and no fee", () => {
    const plan = planAppeal({ ...base, orderBy: "high-court" });
    expect(plan.nextRoute).toBeNull();
    expect(plan.ladder).toHaveLength(0);
    expect(plan.feeMinor).toBe(0);
    expect(plan.warnings.join(" ")).toMatch(/No further appeal route/);
  });

  it("carries the grounds through as a verification skeleton", () => {
    const plan = planAppeal({ ...base, grounds: ["Ground A", "Ground B"] });
    expect(plan.groundsSkeleton.map((g) => g.ground)).toEqual(["Ground A", "Ground B"]);
    expect(plan.groundsSkeleton.every((g) => g.toVerify.length > 0)).toBe(true);
  });

  it("refuses an empty grounds list and a negative tax effect", () => {
    expect(() => planAppeal({ ...base, grounds: [] })).toThrow(/ground/);
    expect(() => planAppeal({ ...base, taxEffectMinor: -1 })).toThrow(/negative/);
  });

  it("declares the routes table it applied", () => {
    expect(APPEAL_ROUTES).toHaveLength(3);
    expect(APPEAL_ROUTES[0]).toMatchObject({ from: "ao", to: "cit-appeals", limitationDays: 30, feeApplies: false });
  });
});

describe("litigationPortfolio", () => {
  const matters = [
    // Expiry 2025-05-31, proposed filing 2025-05-20 → in time, 11 days left.
    {
      matterId: "M1",
      clientName: "Alpha",
      forum: "cit-appeals" as const,
      taxEffectMinor: 1_00_000 * 100,
      servedDate: "2025-05-01",
      limitationDays: 30,
      filingDate: "2025-05-20",
      status: "not-filed" as const,
    },
    // Expiry 2025-05-31, proposed filing 2025-05-28 → due soon (3 days).
    {
      matterId: "M2",
      clientName: "Beta",
      forum: "cit-appeals" as const,
      taxEffectMinor: 2_00_000 * 100,
      servedDate: "2025-05-01",
      limitationDays: 30,
      filingDate: "2025-05-28",
      status: "not-filed" as const,
    },
    // Expiry 2025-05-31, proposed filing 2025-06-10 → barred: at risk.
    {
      matterId: "M3",
      clientName: "Gamma",
      forum: "itat" as const,
      taxEffectMinor: 3_00_000 * 100,
      servedDate: "2025-05-01",
      limitationDays: 30,
      filingDate: "2025-06-10",
      status: "not-filed" as const,
    },
    // Already filed → not at risk even though it would be past expiry.
    {
      matterId: "M4",
      clientName: "Delta",
      forum: "itat" as const,
      taxEffectMinor: 4_00_000 * 100,
      servedDate: "2025-01-01",
      limitationDays: 30,
      filingDate: "2025-06-01",
      status: "filed" as const,
    },
  ];

  it("separates at-risk from due-soon and already-filed matters", () => {
    const p = litigationPortfolio({ matters });
    expect(p.totalMatters).toBe(4);
    expect(p.filedCount).toBe(1);
    expect(p.atRisk.map((m) => m.matterId)).toEqual(["M3"]);
    expect(p.atRisk[0]!.delayDays).toBe(10);
    // Sorted by urgency: M2 has 3 days left, M1 has 11; both are inside 15.
    expect(p.dueSoon.map((m) => m.matterId)).toEqual(["M2", "M1"]);
    expect(p.byForum).toEqual({ "cit-appeals": 2, itat: 2 });
    expect(p.totalTaxEffectMinor).toBe(10_00_000 * 100);
  });

  it("honours a caller-supplied due-soon window", () => {
    const p = litigationPortfolio({ matters }, 20);
    expect(p.dueSoon.map((m) => m.matterId).sort()).toEqual(["M1", "M2"]);
  });
});
