/**
 * TDS/TCS computation engine — oracle tests.
 *
 * Tax is amount × rate, thresholds are tested against the running
 * aggregate-cumulative (including any carry-over supplied), and interest u/s
 * 201/234E is 1% per month-or-part. All figures are hand-computed.
 *
 * NOTE on form type: the engine selects 24Q by the section-family rule
 * `section.startsWith("194")` and 26Q otherwise. That is the engine's
 * illustrative mapping; the test pins the implemented behaviour.
 */

import { computeTds } from "@/lib/engine/ca-tds-computation";

const tx = (over: Partial<Parameters<typeof computeTds>[0]["transactions"][number]>) => ({
  section: "194C",
  payeeName: "Vendor A",
  payeePan: "AAAAA0000A",
  amount: 100_000,
  rate: 2,
  threshold: 100_000,
  dateOfPayment: "2025-05-31",
  dateOfDeduction: "2025-05-10",
  deposited: true,
  challan: "C-1",
  ...over,
});

const base = {
  payerPan: "AAAAA1111A",
  assessmentYear: "2026-27",
  transactions: [] as ReturnType<typeof tx>[],
  aggregateThresholds: [] as { section: string; cumulative: number }[],
  defaults: [] as { section: string; delayDays: number; reason: string }[],
};

describe("computeTds: per-section computation", () => {
  it("computes tax, threshold crossing and late-deduction interest", () => {
    const res = computeTds({
      ...base,
      transactions: [
        tx({}), // first: cumulative 0 + 1,00,000 > 1,00,000? no
        tx({
          amount: 50_000,
          payeePan: "AAAAA0000A",
          dateOfDeduction: "2025-06-01",
          dateOfPayment: "2025-06-01",
          deposited: false,
          challan: "",
        }), // cumulative 1,00,000 + 50,000 > 1,00,000 → yes
      ],
    });

    expect(res.sections).toHaveLength(1);
    const s = res.sections[0]!;
    expect(s.section).toBe("194C");
    expect(s.aggregateCumulative).toBe(150_000);
    expect(s.totalTax).toBe(3_000); // 2% of 1,00,000 + 2% of 50,000

    const [first, second] = s.transactions;
    expect(first!.crossedThreshold).toBe(false);
    expect(first!.tax).toBe(2_000);
    expect(first!.lateDeduction).toBe(true); // 2025-05-10 → 2025-05-31 = 21 days
    expect(first!.interest201).toBe(20); // 2,000 × 1% × ceil(21/30)=1
    expect(second!.crossedThreshold).toBe(true);
    expect(second!.lateDeduction).toBe(false); // same day
    expect(second!.interest201).toBeUndefined();
  });

  it("carries the supplied aggregate cumulative into the threshold test", () => {
    const res = computeTds({
      ...base,
      transactions: [tx({ amount: 100, threshold: 100_000, deposited: false })],
      aggregateThresholds: [{ section: "194C", cumulative: 30_000 }],
    });

    const s = res.sections[0]!;
    expect(s.aggregateCumulative).toBe(30_100);
    expect(s.transactions[0]!.crossedThreshold).toBe(false);
  });

  it("crosses the threshold when the carry-over plus the payment exceeds it", () => {
    const res = computeTds({
      ...base,
      transactions: [tx({ amount: 100, threshold: 100_000, deposited: false })],
      aggregateThresholds: [{ section: "194C", cumulative: 99_950 }],
    });

    expect(res.sections[0]!.transactions[0]!.crossedThreshold).toBe(true);
  });
});

describe("computeTds: statement summary", () => {
  it("aggregates parties, tax, deposited and pending deposit", () => {
    const res = computeTds({
      ...base,
      transactions: [
        tx({
          section: "195",
          payeeName: "NR A",
          payeePan: "BBBBB2222B",
          amount: 100_000,
          rate: 20,
          deposited: true,
          dateOfDeduction: "2025-07-01",
          dateOfPayment: "2025-07-01",
        }),
        tx({
          section: "195",
          payeeName: "NR A",
          payeePan: "BBBBB2222B",
          amount: 50_000,
          rate: 20,
          deposited: false,
          challan: "",
          dateOfDeduction: "2025-07-01",
          dateOfPayment: "2025-07-01",
        }),
        tx({
          section: "206C(1H)",
          payeeName: "CC",
          payeePan: "CCCCC3333C",
          amount: 200_000,
          rate: 1,
          deposited: true,
          dateOfDeduction: "2025-07-01",
          dateOfPayment: "2025-07-01",
        }),
      ],
    });

    // 195: ₹20,000 + ₹10,000 = ₹30,000 (₹20,000 deposited); 206C(1H): ₹2,000 deposited.
    expect(res.statementSummary.totalTax).toBe(32_000);
    expect(res.statementSummary.totalDeposited).toBe(22_000);
    expect(res.statementSummary.totalPendingDeposit).toBe(10_000);
    expect(res.statementSummary.totalParties).toBe(2); // NR PAN + 206C PAN
    // No section starts with "194" → 26Q.
    expect(res.statementSummary.formType).toBe("26Q");
  });

  it("selects 24Q when a 194-family section is present", () => {
    const res = computeTds({ ...base, transactions: [tx({})] });
    expect(res.statementSummary.formType).toBe("24Q");
  });
});

describe("computeTds: defaults and warnings", () => {
  it("computes 201 and 234E interest on the section tax for a default", () => {
    const res = computeTds({
      ...base,
      transactions: [tx({})],
      defaults: [{ section: "194C", delayDays: 45, reason: "late deduction" }],
    });

    // Section tax ₹2,000; delay 45 days → ceil(45/30) = 2 months.
    expect(res.defaults).toHaveLength(1);
    // Late deposit interest is 1.5% per month: 2,000 × 1.5% × 2 = 60.
    expect(res.defaults[0]!.interest201).toBe(60);
    // 234E is ₹200 per day, capped at the tax: 45 days → 9,000, capped at 2,000.
    expect(res.defaults[0]!.interest234E).toBe(2_000);
    expect(res.warnings.some((w) => w.includes("late deduction"))).toBe(true);
    expect(res.methodology.length).toBe(4);
  });

  it("raises late-deduction and late-deposit warnings per transaction", () => {
    const res = computeTds({
      ...base,
      transactions: [
        tx({ dateOfDeposit: "2025-07-15" }), // deducted 31 May, deposited 15 July (due 7 June)
        tx({ dateOfDeduction: "2025-06-01", dateOfPayment: "2025-06-01", deposited: true }), // on time
      ],
    });

    expect(res.warnings.filter((w) => w.includes("late deduction"))).toHaveLength(1);
    expect(res.warnings.filter((w) => w.includes("late deposit"))).toHaveLength(1);
  });
});
