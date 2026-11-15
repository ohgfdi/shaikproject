/**
 * CA payroll engine — oracle tests.
 *
 * PF is 12% of basic + DA capped at the ₹15,000 wage ceiling, split EPS 8.33%
 * and EPF as the balance, with EDLI and admin at 0.5% each. ESI is 0.75% /
 * 3.25% of GROSS while gross is at or below ₹21,000 — it is not a capped
 * contribution, it stops. Professional tax comes from the state registry's slab
 * table. Every figure below is hand-computed.
 */

import { computePayroll } from "@/lib/engine/ca-payroll";

const employee = (over: Partial<Parameters<typeof computePayroll>[0]["employees"][number]>) => ({
  id: "E1",
  name: "Asha",
  basic: 10_000,
  da: 5_000,
  hra: 4_000,
  specialAllowance: 2_000,
  otherAllowances: 1_000,
  bonusses: 0,
  deductions: { providentFund: 0, esi: 0, professionalTax: 0, lwf: 0, other: 0 },
  dateOfJoining: "2020-04-01",
  dateOfBirth: "1990-01-01",
  gender: "female",
  ...over,
});

const base = {
  period: "2025-04",
  state: "Delhi",
  employeeCount: 1,
  employees: [employee({})],
  minimumWage: { skilled: 20_000, unskilled: 15_000 },
};

describe("computePayroll: ceiling-boundary arithmetic", () => {
  it("caps PF at the wage ceiling and stops ESI above the gross ceiling", () => {
    // basic + DA = ₹15,000 (exactly the PF ceiling); gross = ₹22,000 > ₹21,000.
    const res = computePayroll(base);
    const row = res.employees[0]!;

    expect(res.employees).toHaveLength(1);
    expect(row.grossSalary).toBe(22_000);
    expect(row.pfEmployee).toBe(1_800); // 12% of 15,000
    expect(row.eps).toBe(1_250); // 8.33% of 15,000, whole rupees
    expect(row.edli).toBe(75); // 0.5% of 15,000
    expect(row.pfAdmin).toBe(75); // 0.5% of 15,000
    expect(row.pfEmployer).toBe(550); // 1,800 − 1,250 (EPF share only)
    // ₹22,000 is over the ₹21,000 ESI ceiling: nothing is payable.
    expect(row.esiEmployee).toBe(0);
    expect(row.esiEmployer).toBe(0);
    expect(row.professionalTax).toBe(0); // Delhi does not levy PT
    expect(row.totalDeductions).toBe(1_800);
    expect(row.netPay).toBe(20_200);
  });

  it("charges ESI while gross is at or below ₹21,000 (and not one rupee over)", () => {
    const atCeiling = computePayroll({
      ...base,
      employees: [
        employee({
          id: "E2",
          basic: 10_000,
          da: 5_000,
          hra: 4_000,
          specialAllowance: 1_000,
          otherAllowances: 1_000, // gross exactly ₹21,000
        }),
      ],
    });
    expect(atCeiling.employees[0]!.esiEmployee).toBe(158); // 0.75% of 21,000
    expect(atCeiling.employees[0]!.esiEmployer).toBe(683); // 3.25% of 21,000

    const over = computePayroll({
      ...base,
      employees: [
        employee({ id: "E3", basic: 10_001, da: 5_000, hra: 4_000, specialAllowance: 1_000, otherAllowances: 1_000 }),
      ],
    });
    expect(over.employees[0]!.grossSalary).toBe(21_001);
    expect(over.employees[0]!.esiEmployee).toBe(0);
  });

  it("always caps basic + DA over the PF ceiling and warns", () => {
    const res = computePayroll({
      ...base,
      employees: [employee({ id: "E9", basic: 20_000, da: 0, hra: 0, specialAllowance: 0, otherAllowances: 0 })],
    });
    const e = res.employees[0]!;

    expect(e.basic + e.da).toBe(20_000);
    expect(e.pfEmployee).toBe(1_800); // still capped at 15,000 base
    expect(res.warnings.some((w) => w.includes("E9") && w.includes("PF wage ceiling"))).toBe(true);
  });

  it("accrues gratuity on completed service from the joining date", () => {
    const res = computePayroll(base); // joined 2020-04-01, period 2025-04 → 5 years
    // 15,000 × 15/26 × 5 / 12 = ₹3,605.77 → ₹3,606
    expect(res.employees[0]!.gratuity).toBe(3_606);

    const newJoiner = computePayroll({
      ...base,
      employees: [employee({ dateOfJoining: "2025-01-15" })],
    });
    expect(newJoiner.employees[0]!.gratuity).toBe(0); // no completed year yet
  });
});

describe("computePayroll: caller-supplied deductions", () => {
  it("prefers supplied deductions over computed contributions", () => {
    const res = computePayroll({
      ...base,
      state: "Maharashtra",
      employees: [
        employee({ deductions: { providentFund: 2_000, esi: 200, professionalTax: 250, lwf: 20, other: 100 } }),
      ],
    });
    const e = res.employees[0]!;

    // Computed contributions are still reported (gross ₹22,000 is over the ESI
    // ceiling, so the computed ESI is nil)…
    expect(e.pfEmployee).toBe(1_800);
    expect(e.esiEmployee).toBe(0);
    // …but the deduction waterfall uses the caller's figures.
    expect(e.otherDeductions).toBe(100);
    expect(e.totalDeductions).toBe(2_570); // 2,000 + 200 + 250 + 20 + 100
    expect(e.netPay).toBe(19_430); // 22,000 − 2,570
  });
});

describe("computePayroll: professional tax by state", () => {
  it("applies the state slab table and zero for a state that does not levy PT", () => {
    const maharashtra = computePayroll({ ...base, state: "Maharashtra" });
    expect(maharashtra.employees[0]!.professionalTax).toBe(200); // >₹10,000 slab

    const delhi = computePayroll({ ...base, state: "Delhi" });
    expect(delhi.employees[0]!.professionalTax).toBe(0); // no PT in Delhi

    const tamilNadu = computePayroll({ ...base, state: "Tamil Nadu" });
    expect(tamilNadu.employees[0]!.professionalTax).toBe(1_000); // >₹12,500 slab
  });

  it("applies Maharashtra's ₹300 February rate", () => {
    const feb = computePayroll({ ...base, period: "2026-02", state: "Maharashtra" });
    expect(feb.employees[0]!.professionalTax).toBe(300);
  });

  it("charges nothing for a state absent from the registry", () => {
    const unknown = computePayroll({ ...base, state: "Atlantis" });
    expect(unknown.employees[0]!.professionalTax).toBe(0);
  });
});

describe("computePayroll: surfaced ceilings", () => {
  it("publishes the statutory rates and ceilings for review", () => {
    const res = computePayroll(base);

    expect(res.statutoryCeilings).toEqual({
      pfWageCeiling: 15_000,
      epfRate: 12,
      edliRate: 0.5,
      pfAdminRate: 0.5,
      esiWageCeiling: 21_000,
      esiEmployeeRate: 0.75,
      esiEmployerRate: 3.25,
    });
    expect(res.period).toBe("2025-04");
    expect(res.employeeCount).toBe(1);
    expect(res.methodology).toHaveLength(7);
  });
});
