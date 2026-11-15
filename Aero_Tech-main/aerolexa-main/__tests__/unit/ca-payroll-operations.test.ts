import {
  ESI_DEFAULTS,
  PF_DEFAULTS,
  bonusEligibility,
  buildCorrectionRun,
  buildDisbursementFile,
  completedServiceYears,
  computeRunLine,
  gratuityAccrual,
  inspectionReadiness,
  investmentProofStatus,
  leaveEncashment,
  matchPfContribution,
  minimumWageCompliance,
  payslipIssuanceStatus,
  prepareEcr,
  prepareEsiReturn,
  preparePtReturn,
  reconcilePayrollToTds,
  reconcilePayrollTotalsToBooks,
  reconcileStatutoryComponents,
  recordProof,
  requiredLabourReturns,
  requiredRegisters,
  validateEmployeeProfile,
  validateMonthlyInputs,
  type EmployeeProfile,
} from "@/lib/engine/ca-payroll-operations";

const INR = (rupees: number) => Math.round(rupees * 100);

function employee(over: Partial<EmployeeProfile> = {}): EmployeeProfile {
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
    grossMonthlyMinor: INR(60_000),
    basicMonthlyMinor: INR(30_000),
    ...over,
  };
}

describe("employee master lifecycle", () => {
  it("accepts a complete master record", () => {
    expect(validateEmployeeProfile(employee()).valid).toBe(true);
  });

  it("rejects a malformed UAN, PAN and IFSC", () => {
    const result = validateEmployeeProfile(
      employee({ uan: "12345", pan: "BADPAN", bank: { accountNumber: "1", ifsc: "XX", accountHolder: "A" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/UAN/);
    expect(result.errors.join(" ")).toMatch(/PAN/);
    expect(result.errors.join(" ")).toMatch(/IFSC/);
  });

  it("requires an exit date for a non-active employee and forbids an exit before joining", () => {
    expect(validateEmployeeProfile(employee({ status: "resigned", dateOfExit: null })).errors.join(" ")).toMatch(
      /exit date/i,
    );
    expect(
      validateEmployeeProfile(employee({ status: "resigned", dateOfExit: "2019-01-01" })).errors.join(" "),
    ).toMatch(/cannot precede/i);
  });

  it("rejects basic above gross", () => {
    expect(validateEmployeeProfile(employee({ basicMonthlyMinor: INR(70_000) })).valid).toBe(false);
  });

  it("counts completed service and pays gratuity only after five years", () => {
    const sixYears = employee({ dateOfJoining: "2018-04-01" });
    expect(completedServiceYears(sixYears, "2024-04-01")).toBe(6);
    const g = gratuityAccrual(sixYears, INR(30_000), "2024-04-01");
    expect(g.payable).toBe(true);
    expect(g.accruedMinor).toBe(Math.round((INR(30_000) * 15 * 6) / 26));

    const junior = employee({ dateOfJoining: "2022-04-01" });
    expect(gratuityAccrual(junior, INR(30_000), "2024-04-01").accruedMinor).toBe(0);
  });

  it("encashes leave and refuses a negative balance", () => {
    expect(leaveEncashment(10, INR(1_000))).toBe(INR(10_000));
    expect(() => leaveEncashment(-1, INR(1_000))).toThrow(/negative/i);
  });

  it("applies the bonus eligibility ceiling and the 8.33%-20% band", () => {
    const eligible = bonusEligibility({
      grossMonthlyMinor: INR(15_000),
      eligibilityCeilingMinor: INR(21_000),
      monthsWorked: 12,
    });
    expect(eligible.eligible).toBe(true);
    expect(eligible.minimumBonusMinor).toBeLessThan(eligible.maximumBonusMinor);

    const over = bonusEligibility({
      grossMonthlyMinor: INR(30_000),
      eligibilityCeilingMinor: INR(21_000),
      monthsWorked: 12,
    });
    expect(over.eligible).toBe(false);
    expect(over.maximumBonusMinor).toBe(0);
  });

  it("tracks investment declarations and proofs end to end", () => {
    const declaration = {
      employeeId: "E001",
      financialYear: "2026-27",
      regime: "old" as const,
      section80C: INR(150_000),
      section80CCD1B: INR(50_000),
      section80D: INR(25_000),
      section80TTA: 0,
      houseRentPaidAnnual: INR(240_000),
      homeLoanInterestAnnual: 0,
      declaredAt: "2026-04-15",
    };
    const status = investmentProofStatus(declaration);
    expect(status.totalChapterVIA).toBe(INR(225_000));
    expect(status.proofsComplete).toBe(false);

    const afterFull = recordProof(status.proofs, "80C", INR(150_000));
    expect(afterFull.find((p) => p.section === "80C")!.status).toBe("collected");

    const partial = recordProof(status.proofs, "80D", INR(10_000));
    expect(partial.find((p) => p.section === "80D")!.status).toBe("partial");
  });
});

describe("monthly payroll run workflow", () => {
  const employees = [employee()];

  const goodLine = {
    employeeId: "E001",
    paidDays: 30,
    lopDays: 0,
    overtimeHours: 4,
    overtimeRatePerHourMinor: INR(300),
    bonusMinor: 0,
    arrearMinor: 0,
    advanceRecoveryMinor: INR(2_000),
    advanceOutstandingMinor: INR(10_000),
  };

  it("validates a clean run", () => {
    expect(validateMonthlyInputs([goodLine], employees).valid).toBe(true);
  });

  it("flags duplicates, unknown employees, over-31 days and over-recovery", () => {
    const dup = validateMonthlyInputs([goodLine, goodLine], employees);
    expect(dup.errors.join(" ")).toMatch(/Duplicate/);

    const unknown = validateMonthlyInputs([{ ...goodLine, employeeId: "E999" }], employees);
    expect(unknown.warnings.join(" ")).toMatch(/unknown employee/i);

    const days = validateMonthlyInputs([{ ...goodLine, paidDays: 31, lopDays: 2 }], employees);
    expect(days.errors.join(" ")).toMatch(/exceed 31/);

    const recovery = validateMonthlyInputs([{ ...goodLine, advanceRecoveryMinor: INR(20_000) }], employees);
    expect(recovery.errors.join(" ")).toMatch(/exceeds the outstanding/);
  });

  it("warns when an active employee is missing from the run", () => {
    expect(validateMonthlyInputs([], employees).warnings.join(" ")).toMatch(/no payroll line/);
  });

  it("computes overtime, arrears, bonus and advance recovery", () => {
    const result = computeRunLine({ ...goodLine, arrearMinor: INR(1_000) }, INR(60_000));
    expect(result.overtimePayMinor).toBe(INR(1_200));
    expect(result.grossEarningsMinor).toBe(INR(62_200));
    expect(result.advanceOutstandingAfterMinor).toBe(INR(8_000));
    expect(result.netBeforeStatutoryMinor).toBe(INR(60_200));
  });

  it("builds a correction run with a net difference", () => {
    const correction = buildCorrectionRun({
      originalPeriod: "2026-05",
      correctionPeriod: "2026-06",
      corrections: [
        { employeeId: "E001", differenceMinor: INR(500), reason: "LOP correction" },
        { employeeId: "E002", differenceMinor: -INR(200), reason: "Excess OT reversed" },
      ],
    });
    expect(correction.totalDifferenceMinor).toBe(INR(300));
  });

  it("builds a disbursement file and isolates unpayable lines", () => {
    const file = buildDisbursementFile(
      [
        { employeeId: "E001", netPayMinor: INR(58_000) },
        { employeeId: "E002", netPayMinor: INR(20_000) },
      ],
      [employee(), employee({ employeeId: "E002", name: "No Bank", bank: null })],
    );
    expect(file.lines).toHaveLength(1);
    expect(file.totalMinor).toBe(INR(58_000));
    expect(file.unpayable).toEqual(["E002"]);
  });

  it("tracks payslip issuance", () => {
    const status = payslipIssuanceStatus([employee(), employee({ employeeId: "E002" })], ["E001"]);
    expect(status.pending).toEqual(["E002"]);
    expect(status.completionPct).toBe(50);
  });
});

describe("PF/ESI/PT compliance", () => {
  it("caps PF wages at the ceiling and splits EPS/EDLI", () => {
    const ecr = prepareEcr(
      [
        { uan: "100200300400", name: "Asha", grossWagesMinor: INR(60_000), pfWagesMinor: INR(30_000), ncpDays: 0 },
        { uan: null, name: "Broken", grossWagesMinor: INR(20_000), pfWagesMinor: INR(20_000), ncpDays: 0 },
      ],
      PF_DEFAULTS,
    );
    expect(ecr.errors.join(" ")).toMatch(/no UAN/);
    const line = ecr.lines[0]!;
    expect(line.epfWagesMinor).toBe(PF_DEFAULTS.wageCeilingMinor);
    expect(line.employeeContributionMinor).toBe(Math.round((PF_DEFAULTS.wageCeilingMinor * 12) / 100));
    expect(ecr.totals.epsContributionMinor).toBe(Math.round((PF_DEFAULTS.wageCeilingMinor * 8.33) / 100));
    expect(ecr.totals.edliContributionMinor).toBe(Math.round((PF_DEFAULTS.wageCeilingMinor * 0.5) / 100));
  });

  it("matches PF contributions and reports a mismatch", () => {
    const matched = matchPfContribution({
      remittedEmployeeMinor: INR(1_800),
      remittedEmployerMinor: INR(1_800),
      computedEmployeeMinor: INR(1_800),
      computedEmployerMinor: INR(1_800),
    });
    expect(matched.matched).toBe(true);

    const mismatch = matchPfContribution({
      remittedEmployeeMinor: INR(1_700),
      remittedEmployerMinor: INR(1_800),
      computedEmployeeMinor: INR(1_800),
      computedEmployerMinor: INR(1_800),
    });
    expect(mismatch.matched).toBe(false);
    expect(mismatch.employeeDifferenceMinor).toBe(-INR(100));
  });

  it("assembles a state PT return", () => {
    const pt = preparePtReturn("Karnataka", [
      { employeeId: "E001", ptMinor: INR(200) },
      { employeeId: "E002", ptMinor: INR(200) },
    ]);
    expect(pt.totalMinor).toBe(INR(400));
    expect(pt.employeeCount).toBe(2);
  });

  it("scores inspection readiness and lists missing mandatory documents", () => {
    const readiness = inspectionReadiness([
      { document: "Wage register", available: true, mandatory: true },
      { document: "ECR filings", available: false, mandatory: true },
      { document: "Voluntary policy", available: false, mandatory: false },
    ]);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingMandatory).toEqual(["ECR filings"]);
    expect(readiness.score).toBe(33);
  });
});

describe("labour-law registers and returns by size and state", () => {
  it("adds registers that match the establishment's actual activity", () => {
    const registers = requiredRegisters({
      state: "Maharashtra",
      employeeCount: 45,
      employsContractLabour: true,
      employsWomen: true,
      hasOvertime: true,
      isShopsEstablishment: true,
    }).map((r) => r.register);
    expect(registers).toEqual(
      expect.arrayContaining([
        "Wage register",
        "Overtime register",
        "Maternity benefit register",
        "Contract labour register",
        "Shops & Establishments register",
        "PF & ESI registers",
      ]),
    );
  });

  it("omits activity-specific registers for a small establishment without them", () => {
    const registers = requiredRegisters({
      state: "Goa",
      employeeCount: 5,
      employsContractLabour: false,
      employsWomen: false,
      hasOvertime: false,
      isShopsEstablishment: false,
    }).map((r) => r.register);
    expect(registers).toHaveLength(3);
    expect(registers).not.toContain("PF & ESI registers");
  });

  it("adds monthly PF/ESI returns only at 20+ employees", () => {
    const small = requiredLabourReturns({
      state: "Goa",
      employeeCount: 5,
      employsContractLabour: false,
      employsWomen: false,
      hasOvertime: false,
      isShopsEstablishment: false,
    }).map((r) => r.returnName);
    expect(small).not.toContain("PF ECR");

    const large = requiredLabourReturns({
      state: "Karnataka",
      employeeCount: 45,
      employsContractLabour: true,
      employsWomen: true,
      hasOvertime: true,
      isShopsEstablishment: true,
    }).map((r) => r.returnName);
    expect(large).toEqual(
      expect.arrayContaining(["PF ECR", "ESI contribution return", "Contract labour (R&A) annual return"]),
    );
  });
});

describe("reconciliation", () => {
  it("reconciles payroll to books", () => {
    expect(reconcilePayrollTotalsToBooks({ payrollNetMinor: INR(100), booksNetMinor: INR(100) }).reconciled).toBe(true);
    const diff = reconcilePayrollTotalsToBooks({ payrollNetMinor: INR(100), booksNetMinor: INR(90) });
    expect(diff.differenceMinor).toBe(INR(10));
    expect(diff.note).toMatch(/reconciling journal/);
  });

  it("reconciles salary TDS to the deposit", () => {
    expect(reconcilePayrollToTds({ deductedMinor: INR(500), depositedMinor: INR(500) }).reconciled).toBe(true);
    expect(reconcilePayrollToTds({ deductedMinor: INR(500), depositedMinor: INR(400) }).differenceMinor).toBe(INR(100));
  });

  it("reconciles PF/ESI/PT components together", () => {
    const result = reconcileStatutoryComponents([
      { component: "pf", computedMinor: INR(3_600), remittedMinor: INR(3_600) },
      { component: "esi", computedMinor: INR(1_000), remittedMinor: INR(1_000) },
      { component: "pt", computedMinor: INR(400), remittedMinor: INR(200) },
    ]);
    expect(result.allReconciled).toBe(false);
    expect(result.items.find((i) => i.component === "pt")!.differenceMinor).toBe(INR(200));
  });
});

describe("ESI return", () => {
  it("computes 0.75%/3.25% contributions for covered employees only", () => {
    const esi = prepareEsiReturn(
      [
        { esicNumber: "3100000000", name: "Asha", grossWagesMinor: INR(18_000) },
        { esicNumber: null, name: "NoIp", grossWagesMinor: INR(15_000) },
        { esicNumber: "3100000001", name: "Senior", grossWagesMinor: INR(40_000) },
      ],
      ESI_DEFAULTS,
    );
    expect(esi.errors.join(" ")).toMatch(/no IP number/);
    expect(esi.totals.insuredPersons).toBe(1);
    expect(esi.totals.employeeContributionMinor).toBe(Math.ceil((INR(18_000) * 0.75) / 100));
    expect(esi.totals.employerContributionMinor).toBe(Math.ceil((INR(18_000) * 3.25) / 100));
    expect(esi.lines.find((l) => l.name === "Senior")!.applicable).toBe(false);
  });
});

describe("minimum wage compliance", () => {
  it("flags a wage below the applicable minimum and totals the shortfall", () => {
    const result = minimumWageCompliance([
      { employeeId: "E1", paidMonthlyMinor: INR(15_000), applicableMinimumMinor: INR(15_000) },
      { employeeId: "E2", paidMonthlyMinor: INR(12_000), applicableMinimumMinor: INR(15_000) },
    ]);
    expect(result.compliant).toBe(false);
    expect(result.shortfalls).toEqual(["E2"]);
    expect(result.totalShortfallMinor).toBe(INR(3_000));
  });

  it("passes when every wage meets its floor", () => {
    expect(
      minimumWageCompliance([{ employeeId: "E1", paidMonthlyMinor: INR(20_000), applicableMinimumMinor: INR(18_000) }])
        .compliant,
    ).toBe(true);
  });
});
