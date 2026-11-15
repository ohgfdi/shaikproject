/**
 * TDS returns engine — oracle tests.
 *
 * Hand-computed. Pinned exactly below:
 *   - 201(1A)(ii): ₹10,000 deducted 10 Apr, deposited 10 May → due 7 May →
 *     1 part-month × 1.5% = ₹150.
 *   - 201(1A)(i): ₹500 deductible 1 Jun, deducted 15 Jul → Jun part + Jul
 *     part = 2 months × 1% = ₹10.
 *   - 234E: 5 days late × ₹200 = ₹1,000; 200 days late is capped at the TDS.
 *   - Deductee rows consolidate by PAN + section.
 *   - Form ↔ section consistency (24Q = s192 only; 26Q never s192).
 */

import { INR } from "@/lib/engine/india-tax";
import { depositDueDate, monthsOrPart, prepareTdsReturn, type TdsDeductionRecord } from "@/lib/engine/tds-returns";

const r = (minor: number) => minor / 100;

const row = (
  over: Partial<TdsDeductionRecord> & Pick<TdsDeductionRecord, "payeeName" | "pan" | "section">,
): TdsDeductionRecord => ({
  baseAmount: INR(100000),
  ratePct: 10,
  deducted: INR(10000),
  deductibleDate: "2025-04-10",
  deductedDate: "2025-04-10",
  depositedDate: "2025-05-10",
  ...over,
});

describe("date arithmetic", () => {
  it("counts part months as full for 201(1A)", () => {
    expect(monthsOrPart("2025-04-15", "2025-05-10")).toBe(2);
    expect(monthsOrPart("2025-04-15", "2025-04-20")).toBe(1);
    expect(monthsOrPart("2025-04-15", "2025-04-15")).toBe(0);
    expect(monthsOrPart("2025-04-15", "2025-03-01")).toBe(0);
  });

  it("sets the deposit due date: 7th of the following month, 30 April for March", () => {
    expect(depositDueDate("2025-04-10")).toBe("2025-05-07");
    expect(depositDueDate("2025-03-15")).toBe("2025-04-30");
    expect(depositDueDate("2025-12-20")).toBe("2026-01-07");
  });
});

describe("prepareTdsReturn — Form 26Q", () => {
  const baseInput = () => ({
    form: "26Q" as const,
    tan: "MUMA12345B",
    quarter: { from: "2025-04-01", to: "2025-06-30" },
    filingDueDate: "2025-07-31",
    filingDate: "2025-08-05",
    deductions: [
      // A: on time for deduction, 3 days late to deposit (due 7 May, paid 10 May).
      row({ payeeName: "Acme Consulting", pan: "AAPFU0939F", section: "194J" }),
      // Same PAN + section as A → consolidates into one deductee row.
      row({
        payeeName: "Acme Consulting",
        pan: "AAPFU0939F",
        section: "194J",
        baseAmount: INR(50000),
        ratePct: 10,
        deducted: INR(5000),
        deductibleDate: "2025-05-01",
        deductedDate: "2025-05-01",
        depositedDate: "2025-06-05",
      }),
      // B: deducted 45 days late; PAN malformed.
      row({
        payeeName: "Bharat Contractors",
        pan: "BADPAN",
        section: "194C",
        baseAmount: INR(50000),
        ratePct: 1,
        deducted: INR(500),
        deductibleDate: "2025-06-01",
        deductedDate: "2025-07-15",
        depositedDate: "2025-07-15",
      }),
    ],
    challans: [{ bsrCode: "0004329", challanSerial: "00345", dateOfDeposit: "2025-05-10", amount: INR(15500) }],
  });

  it("consolidates deductees by PAN + section", () => {
    const res = prepareTdsReturn(baseInput());
    expect(res.deductees).toHaveLength(2); // Acme (194J) + Bharat (194C)
    const acme = res.deductees.find((d) => d.payeeName === "Acme Consulting")!;
    expect(r(acme.baseAmount)).toBe(150000);
    expect(r(acme.deducted)).toBe(15000);
    expect(r(res.totals.deducted)).toBe(15500);
    expect(r(res.totals.deposited)).toBe(15500);
    expect(res.totals.depositShortfall).toBe(0);
  });

  it("computes 201(1A) interest for late deduction and late deposit", () => {
    const res = prepareTdsReturn(baseInput());
    const depositInterest = res.interest.rows.find((x) => x.reason === "late-deposit")!;
    expect(r(depositInterest.interest)).toBe(150); // 10,000 × 1.5% × 1
    expect(depositInterest.months).toBe(1);

    const deductionInterest = res.interest.rows.find((x) => x.reason === "late-deduction")!;
    expect(deductionInterest.months).toBe(2); // Jun part + Jul part
    expect(r(deductionInterest.interest)).toBe(10); // 500 × 1% × 2

    expect(r(res.interest.total)).toBe(160);
  });

  it("computes the 234E fee and the total exposure", () => {
    const res = prepareTdsReturn(baseInput());
    expect(res.lateFilingFee.days).toBe(5);
    expect(r(res.lateFilingFee.fee)).toBe(1000); // 5 × ₹200
    expect(r(res.totalExposure)).toBe(1160); // 160 + 1,000
    expect(res.panIssues.some((p) => p.includes("Bharat Contractors"))).toBe(true);
  });

  it("caps the 234E fee at the TDS amount", () => {
    const res = prepareTdsReturn({
      ...baseInput(),
      filingDate: "2026-02-12", // 196 days late
    });
    expect(res.lateFilingFee.cappedAtTds).toBe(true);
    expect(res.lateFilingFee.fee).toBe(INR(15500)); // cap = total deducted
  });

  it("flags a shortfall when challans do not cover the deductions", () => {
    const res = prepareTdsReturn({
      ...baseInput(),
      challans: [{ bsrCode: "0004329", challanSerial: "00345", dateOfDeposit: "2025-05-10", amount: INR(10000) }],
    });
    expect(res.totals.depositShortfall).toBe(INR(5500));
    expect(res.warnings.some((w) => w.includes("shortfall"))).toBe(true);
  });

  it("keeps untagged challans out of per-section shortfall math", () => {
    const res = prepareTdsReturn(baseInput());
    expect(res.sectionSummary.every((s) => s.shortfall === 0)).toBe(true);
    expect(res.warnings.every((w) => !w.includes("per-section shortfall"))).toBe(true);
  });

  it("warns when the form does not match the sections", () => {
    const res24 = prepareTdsReturn({ ...baseInput(), form: "24Q" });
    expect(res24.warnings.some((w) => w.includes("24Q") && w.includes("194J"))).toBe(true);

    const res26 = prepareTdsReturn({
      ...baseInput(),
      deductions: [row({ payeeName: "Salary 1", pan: "AAPFU0939F", section: "192", ratePct: 10, deducted: INR(5000) })],
    });
    expect(res26.warnings.some((w) => w.includes("26Q") && w.includes("192"))).toBe(true);
  });

  it("warns about deductions with no deposit date", () => {
    const res = prepareTdsReturn({
      ...baseInput(),
      deductions: [row({ payeeName: "Pending Ltd", pan: "AAPFU0939F", section: "194J", depositedDate: null })],
    });
    expect(res.warnings.some((w) => w.includes("no deposit date"))).toBe(true);
  });

  it("rejects malformed dates", () => {
    expect(() =>
      prepareTdsReturn({
        ...baseInput(),
        deductions: [row({ payeeName: "X", pan: "AAPFU0939F", section: "194J", deductibleDate: "10-04-2025" })],
      }),
    ).toThrow(/deductibleDate/);
    expect(() => prepareTdsReturn({ ...baseInput(), quarter: { from: "junk", to: "2025-06-30" } })).toThrow(
      /quarter.from/,
    );
  });
});
