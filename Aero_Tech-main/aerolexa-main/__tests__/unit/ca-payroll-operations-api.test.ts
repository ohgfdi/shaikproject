/**
 * Payroll practice API adapter — oracle tests.
 *
 * Pins the RUPEES → PAISE conversion on the employee master and the monthly run
 * lines, and the `op` dispatch/validation, all of which the engine suite (which
 * speaks paise directly) cannot see.
 */

import { PF_DEFAULTS, type EcrResult, type EsiResult } from "@/lib/engine/ca-payroll-operations";
import { payrollOperationsInput, computePayrollOperations } from "@/lib/engine/ca-payroll-operations-api";

function run(input: unknown) {
  return computePayrollOperations(payrollOperationsInput.parse(input));
}

/** Employee master with RUPEES wage fields, as it arrives over the API. */
function employee(over: Record<string, unknown> = {}) {
  return {
    employeeId: "E001",
    name: "Asha Rao",
    status: "active",
    dateOfJoining: "2020-04-01",
    dateOfExit: null,
    uan: "100200300400",
    esicNumber: "3100000000",
    aadhaarLinked: true,
    pan: "ABCDE1234F",
    bank: { accountNumber: "000111222333", ifsc: "HDFC0001234", accountHolder: "Asha Rao" },
    pfEcsMapping: "KNBNG0012345",
    department: "Finance",
    designation: "Manager",
    state: "Karnataka",
    establishmentEmployeeCount: 45,
    grossMonthly: 60_000,
    basicMonthly: 30_000,
    ...over,
  };
}

describe("payrollOperationsInput validation", () => {
  it("accepts a payload carrying the outer `kind` discriminator", () => {
    expect(
      payrollOperationsInput.safeParse({
        kind: "payroll-operations",
        op: "registers",
        profile: {
          state: "Goa",
          employeeCount: 5,
          employsContractLabour: false,
          employsWomen: false,
          hasOvertime: false,
          isShopsEstablishment: false,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown op", () => {
    expect(payrollOperationsInput.safeParse({ op: "nope" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    expect(payrollOperationsInput.safeParse({ op: "leave-encashment" }).success).toBe(false);
  });
});

describe("employee master lifecycle", () => {
  it("validates a complete master record", () => {
    expect((run({ op: "validate-employee", profile: employee() }) as { valid: boolean }).valid).toBe(true);
  });

  it("rejects a malformed UAN / IFSC", () => {
    const result = run({
      op: "validate-employee",
      profile: employee({ uan: "123", bank: { accountNumber: "1", ifsc: "XX", accountHolder: "A" } }),
    }) as { valid: boolean; errors: string[] };
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/UAN/);
    expect(result.errors.join(" ")).toMatch(/IFSC/);
  });

  it("counts completed service and converts gratuity wage from rupees", () => {
    expect(
      (
        run({ op: "service-years", profile: employee({ dateOfJoining: "2018-04-01" }), asOf: "2024-04-01" }) as {
          years: number;
        }
      ).years,
    ).toBe(6);
    // ₹30,000 → 3,000,000 paise; 15/26 × 3,000,000 × 6.
    const g = run({
      op: "gratuity",
      profile: employee({ dateOfJoining: "2018-04-01" }),
      lastDrawnMonthly: 30_000,
      asOf: "2024-04-01",
    }) as { payable: boolean; accruedMinor: number };
    expect(g.payable).toBe(true);
    expect(g.accruedMinor).toBe(Math.round((3_000_000 * 15 * 6) / 26));
  });

  it("encashes leave from a rupee daily wage", () => {
    expect(
      (run({ op: "leave-encashment", leaveBalanceDays: 10, dailyWage: 1_000 }) as { amountMinor: number }).amountMinor,
    ).toBe(1_000_000);
  });

  it("applies the bonus band", () => {
    const eligible = run({ op: "bonus", grossMonthly: 15_000, eligibilityCeiling: 21_000, monthsWorked: 12 }) as {
      eligible: boolean;
    };
    expect(eligible.eligible).toBe(true);
    const over = run({ op: "bonus", grossMonthly: 30_000, eligibilityCeiling: 21_000, monthsWorked: 12 }) as {
      eligible: boolean;
      maximumBonusMinor: number;
    };
    expect(over.eligible).toBe(false);
    expect(over.maximumBonusMinor).toBe(0);
  });

  it("tracks declarations and proofs", () => {
    const declaration = {
      employeeId: "E001",
      financialYear: "2026-27",
      regime: "old" as const,
      section80C: 150_000,
      section80CCD1B: 50_000,
      section80D: 25_000,
      section80TTA: 0,
      houseRentPaidAnnual: 240_000,
      homeLoanInterestAnnual: 0,
      declaredAt: "2026-04-15",
    };
    const status = run({ op: "proof-status", declaration }) as {
      totalChapterVIA: number;
      proofs: unknown[];
      proofsComplete: boolean;
    };
    expect(status.totalChapterVIA).toBe(22_500_000); // ₹225,000 → paise
    expect(status.proofsComplete).toBe(false);

    const proofs = run({
      op: "record-proof",
      proofs: [
        { section: "80C", required: 150_000, collected: 0, status: "pending" },
        { section: "80D", required: 25_000, collected: 0, status: "pending" },
      ],
      section: "80C",
      received: 150_000,
    }) as { section: string; status: string }[];
    expect(proofs.find((p) => p.section === "80C")!.status).toBe("collected");
  });
});

describe("monthly run workflow (rupee → paise)", () => {
  const line = {
    employeeId: "E001",
    paidDays: 30,
    lopDays: 0,
    overtimeHours: 4,
    overtimeRatePerHour: 300,
    bonus: 0,
    arrear: 1_000,
    advanceRecovery: 2_000,
    advanceOutstanding: 10_000,
  };

  it("validates a clean run", () => {
    expect((run({ op: "validate-run", lines: [line], employees: [employee()] }) as { valid: boolean }).valid).toBe(
      true,
    );
  });

  it("computes overtime, arrears and advance recovery in paise", () => {
    const result = run({ op: "run-line", line, monthlyGross: 60_000 }) as {
      overtimePayMinor: number;
      grossEarningsMinor: number;
      advanceOutstandingAfterMinor: number;
      netBeforeStatutoryMinor: number;
    };
    expect(result.overtimePayMinor).toBe(120_000); // 4 h × ₹300
    expect(result.grossEarningsMinor).toBe(6_220_000); // 6,000,000 + 120,000 + 100,000
    expect(result.advanceOutstandingAfterMinor).toBe(800_000);
    expect(result.netBeforeStatutoryMinor).toBe(6_020_000);
  });

  it("builds a correction run and disbursement file", () => {
    const correction = run({
      op: "correction-run",
      originalPeriod: "2026-05",
      correctionPeriod: "2026-06",
      corrections: [
        { employeeId: "E001", difference: 500, reason: "LOP correction" },
        { employeeId: "E002", difference: -200, reason: "Excess OT reversed" },
      ],
    }) as { totalDifferenceMinor: number };
    expect(correction.totalDifferenceMinor).toBe(30_000); // ₹300

    const file = run({
      op: "disbursement-file",
      netPay: [
        { employeeId: "E001", netPay: 58_000 },
        { employeeId: "E002", netPay: 20_000 },
      ],
      employees: [employee(), employee({ employeeId: "E002", name: "No Bank", bank: null })],
    }) as { lines: unknown[]; totalMinor: number; unpayable: string[] };
    expect(file.lines).toHaveLength(1);
    expect(file.totalMinor).toBe(5_800_000);
    expect(file.unpayable).toEqual(["E002"]);
  });

  it("tracks payslip issuance", () => {
    const status = run({
      op: "payslip-status",
      employees: [employee(), employee({ employeeId: "E002" })],
      issued: ["E001"],
    }) as { pending: string[]; completionPct: number };
    expect(status.pending).toEqual(["E002"]);
    expect(status.completionPct).toBe(50);
  });
});

describe("statutory filings (PF / ESI / PT / labour)", () => {
  it("caps PF wages at the ceiling and splits EPS/EDLI", () => {
    const ecr = run({
      op: "prepare-ecr",
      employees: [
        { uan: "100200300400", name: "Asha", grossWages: 60_000, pfWages: 30_000, ncpDays: 0 },
        { uan: null, name: "Broken", grossWages: 20_000, pfWages: 20_000, ncpDays: 0 },
      ],
    }) as EcrResult;
    expect(ecr.errors.join(" ")).toMatch(/no UAN/);
    expect(ecr.lines[0]!.epfWagesMinor).toBe(PF_DEFAULTS.wageCeilingMinor);
    expect(ecr.totals.employeeContributionMinor).toBe(Math.round((PF_DEFAULTS.wageCeilingMinor * 12) / 100));
  });

  it("prepares the ESI return for covered employees only", () => {
    const esi = run({
      op: "prepare-esi",
      employees: [
        { esicNumber: "3100000000", name: "Asha", grossWages: 18_000 },
        { esicNumber: "3100000001", name: "Senior", grossWages: 40_000 },
      ],
    }) as EsiResult;
    expect(esi.totals.insuredPersons).toBe(1);
    expect(esi.totals.employeeContributionMinor).toBe(Math.ceil((1_800_000 * 0.75) / 100));
    expect(esi.lines.find((l) => l.name === "Senior")!.applicable).toBe(false);
  });

  it("matches PF and assembles the PT return", () => {
    const matched = run({
      op: "match-pf",
      remittedEmployee: 1_800,
      remittedEmployer: 1_800,
      computedEmployee: 1_800,
      computedEmployer: 1_800,
    }) as { matched: boolean };
    expect(matched.matched).toBe(true);

    const pt = run({
      op: "pt-return",
      stateCode: "Karnataka",
      lines: [
        { employeeId: "E001", pt: 200 },
        { employeeId: "E002", pt: 200 },
      ],
    }) as { totalMinor: number; employeeCount: number };
    expect(pt.totalMinor).toBe(40_000);
    expect(pt.employeeCount).toBe(2);
  });

  it("picks registers/returns by establishment profile and checks minimum wage", () => {
    const registers = run({
      op: "registers",
      profile: {
        state: "Maharashtra",
        employeeCount: 45,
        employsContractLabour: true,
        employsWomen: true,
        hasOvertime: true,
        isShopsEstablishment: true,
      },
    }) as { register: string }[];
    expect(registers.map((r) => r.register)).toContain("Contract labour register");

    const mw = run({
      op: "minimum-wage",
      lines: [
        { employeeId: "E1", paidMonthly: 15_000, applicableMinimum: 15_000 },
        { employeeId: "E2", paidMonthly: 12_000, applicableMinimum: 15_000 },
      ],
    }) as { compliant: boolean; shortfalls: string[]; totalShortfallMinor: number };
    expect(mw.compliant).toBe(false);
    expect(mw.shortfalls).toEqual(["E2"]);
    expect(mw.totalShortfallMinor).toBe(300_000);
  });

  it("scores inspection readiness", () => {
    const readiness = run({
      op: "inspection-readiness",
      items: [
        { document: "Wage register", available: true, mandatory: true },
        { document: "ECR filings", available: false, mandatory: true },
      ],
    }) as { ready: boolean; missingMandatory: string[] };
    expect(readiness.ready).toBe(false);
    expect(readiness.missingMandatory).toEqual(["ECR filings"]);
  });
});

describe("reconciliation", () => {
  it("reconciles payroll-to-books, TDS and statutory components", () => {
    expect((run({ op: "reconcile-books", payrollNet: 100, booksNet: 100 }) as { reconciled: boolean }).reconciled).toBe(
      true,
    );
    expect(
      (run({ op: "reconcile-tds", deducted: 500, deposited: 400 }) as { differenceMinor: number }).differenceMinor,
    ).toBe(10_000);

    const result = run({
      op: "reconcile-statutory",
      components: [
        { component: "pf", computed: 3_600, remitted: 3_600 },
        { component: "pt", computed: 400, remitted: 200 },
      ],
    }) as { allReconciled: boolean };
    expect(result.allReconciled).toBe(false);
  });
});
