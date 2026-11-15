/**
 * Payroll engine — oracle tests.
 *
 * Hand-computed FY 2025-26 examples. Pinned exactly below:
 *   - EPF on ₹20,000 basic runs on the ₹15,000 ceiling (not actual wages):
 *     employee 12% = 1,800; employer 12% = 1,800 split EPS 8.33% of 15,000
 *     = 1,250 (rounded) + EPF 550; EDLI/admin 75 each.
 *   - ESI stops at one rupee above the ₹21,000 ceiling.
 *   - EPS never exceeds the ceiling even when PF runs on actual wages.
 *   - s192 TDS = annual tax (new regime, std deduction) ÷ months remaining.
 */

import { INR, NEW_REGIME_2025_26 } from "@/lib/engine/india-tax";
import { computePayslip, PAYROLL_DEFAULTS_2025_26, payrollRegister, professionalTax } from "@/lib/engine/payroll";

const r = (minor: number) => minor / 100;

const REGIME = NEW_REGIME_2025_26;

describe("professional tax", () => {
  it("reads the caller-supplied state slabs", () => {
    const slabs = PAYROLL_DEFAULTS_2025_26.professionalTaxSlabs;
    expect(r(professionalTax(INR(6000), slabs))).toBe(0);
    expect(r(professionalTax(INR(8000), slabs))).toBe(175);
    expect(r(professionalTax(INR(25000), slabs))).toBe(200);
  });

  it("refuses a slab table with no open top slab", () => {
    const closed = [
      { upTo: INR(10000), amount: INR(100) },
      { upTo: INR(20000), amount: INR(150) },
    ];
    expect(() => professionalTax(INR(50000), closed)).toThrow(/open top slab/);
  });
});

describe("computePayslip — EPF ceiling arithmetic", () => {
  it("caps EPF wages at ₹15,000 while gross stays ₹20,000", () => {
    const p = computePayslip({
      employee: { employeeId: "E1", name: "Asha", basic: INR(20000), hra: INR(8000) },
      month: "2025-04",
      regime: REGIME,
      annualTaxableSalary: INR(336000), // 20,000 + 8,000 = 28,000 × 12
    });

    expect(r(p.gross)).toBe(28000);
    expect(r(p.epfWages)).toBe(15000); // capped
    expect(r(p.deductions.epfEmployee)).toBe(1800); // 12% of 15,000

    // Employer 12% of 15,000 = 1,800 = EPS 8.33% of 15,000 = 1,250 (rounded) + 550 EPF.
    expect(r(p.employerCosts.epsEmployer)).toBe(1250); // 1,249.5 rounds to 1,250
    expect(r(p.employerCosts.epfEmployer)).toBe(550);
    expect(r(p.employerCosts.edli)).toBe(75); // 0.5% of 15,000
    expect(r(p.employerCosts.epfAdmin)).toBe(75);

    expect(p.esiApplicable).toBe(false); // gross 28,000 > 21,000
    expect(p.deductions.esiEmployee).toBe(0);
    expect(r(p.deductions.professionalTax)).toBe(200);
  });

  it("applies ESI at or below the ₹21,000 ceiling and stops one rupee over", () => {
    const under = computePayslip({
      employee: { employeeId: "E2", name: "Ravi", basic: INR(20000) },
      month: "2025-04",
      regime: REGIME,
      annualTaxableSalary: INR(240000),
    });
    expect(under.esiApplicable).toBe(true);
    expect(r(under.deductions.esiEmployee)).toBe(150); // 0.75% of 20,000
    expect(r(under.employerCosts.esiEmployer)).toBe(650); // 3.25% of 20,000

    const over = computePayslip({
      employee: { employeeId: "E3", name: "Meena", basic: INR(21001) },
      month: "2025-04",
      regime: REGIME,
      annualTaxableSalary: INR(252012),
    });
    expect(over.esiApplicable).toBe(false);
    expect(over.deductions.esiEmployee).toBe(0);
    expect(over.employerCosts.esiEmployer).toBe(0);
  });

  it("keeps EPS, EDLI and admin within the ceiling even when PF runs on actual wages", () => {
    const p = computePayslip({
      employee: { employeeId: "E4", name: "Vikram", basic: INR(50000) },
      month: "2025-04",
      regime: REGIME,
      annualTaxableSalary: INR(600000),
      config: { epfOnActualWages: true },
    });
    expect(r(p.epfWages)).toBe(50000); // no cap on PF wages
    expect(r(p.deductions.epfEmployee)).toBe(6000); // 12% of 50,000
    expect(r(p.employerCosts.epsEmployer)).toBe(1250); // 8.33% of 15,000 ceiling, NOT 4,165
    expect(r(p.employerCosts.epfEmployer)).toBe(4750); // 6,000 − 1,250
    // EDLI and admin are charged on the capped wages, not on ₹50,000.
    expect(r(p.employerCosts.edli)).toBe(75); // 0.5% of 15,000
    expect(r(p.employerCosts.epfAdmin)).toBe(75);
  });

  it("projects TDS u/s 192 as annual tax ÷ months remaining", () => {
    const p = computePayslip({
      employee: { employeeId: "E5", name: "Neha", basic: INR(100000) },
      month: "2025-10",
      regime: REGIME,
      annualTaxableSalary: INR(2000000),
      monthsRemaining: 6,
    });
    // New regime, FY 2025-26: std deduction 75,000 → taxable 19,25,000.
    // Slab: 20,000 + 40,000 + 60,000 + (3,25,000 × 20% = 65,000) = 1,85,000.
    // No rebate (taxable > ₹12L). Cess 4% = 7,400. Total 1,92,400.
    // ÷ 6 = 32,066.67 → deposited in whole rupees = 32,067.
    expect(p.tdsAnnualTax).toBe(INR(192400));
    expect(r(p.deductions.tds)).toBe(32067);
    // PF runs on the CAPPED ₹15,000 wages (no opt-out here): 12% = 1,800.
    expect(r(p.netPay)).toBe(100000 - 1800 - 200 - 32067); // 65,933
  });
});

describe("payrollRegister", () => {
  it("totals the register and computes the true employer cost", () => {
    const reg = payrollRegister({
      month: "2025-04",
      regime: REGIME,
      monthsRemaining: 12,
      employees: [
        { employeeId: "E1", name: "Asha", basic: INR(20000), hra: INR(8000) },
        { employeeId: "E2", name: "Ravi", basic: INR(20000) },
      ],
      annualSalaries: { E1: INR(336000), E2: INR(240000) },
    });

    expect(reg.payslips).toHaveLength(2);
    expect(r(reg.totals.gross)).toBe(48000);
    expect(r(reg.totals.epfEmployee)).toBe(3600); // 1,800 × 2
    // E1 no ESI (28k), E2 ESI 150 employee / 650 employer.
    expect(r(reg.totals.esiEmployee)).toBe(150);
    expect(r(reg.totals.esiEmployer)).toBe(650);
    // Employer 12% = 1,800 each; EPS (whole rupees) 1,250 each → EPF part 550 each.
    expect(r(reg.totals.epfEmployer)).toBe(1100);
    // E1 employer cost: 550 + 1,250 + 75 + 75 = 1,950; E2 adds ESI 650 → 2,600. Total 4,550.
    expect(r(reg.totals.totalCost)).toBe(52550);
  });
});
