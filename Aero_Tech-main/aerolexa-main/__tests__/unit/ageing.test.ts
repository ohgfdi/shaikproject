/**
 * AR/AP ageing + MSME 43B(h) — oracle tests.
 *
 * Hand-computed. Pinned exactly below:
 *   - bucket boundaries: day 30 → "0-30", day 31 → "31-60", day 45 → "31-60",
 *     day 46+ is 43B(h) territory, day 181 → "180+"
 *   - 43B(h): only MSME invoices beyond 45 days add back, per invoice
 *   - s16 interest: from day 46, at the caller rate, /365
 */

import {
  ageInvoices,
  bucketFor,
  msme43bh,
  msmeInterestDays,
  type MsmeSupplier,
  type OpenInvoice,
} from "@/lib/engine/ageing";
import { INR } from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

describe("bucket boundaries", () => {
  it("places the boundary days exactly", () => {
    expect(bucketFor(0)).toBe("0-30");
    expect(bucketFor(30)).toBe("0-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(60)).toBe("31-60");
    expect(bucketFor(61)).toBe("61-90");
    expect(bucketFor(90)).toBe("61-90");
    expect(bucketFor(91)).toBe("91-180");
    expect(bucketFor(180)).toBe("91-180");
    expect(bucketFor(181)).toBe("180+");
  });
});

describe("ageInvoices", () => {
  const AS_OF = "2025-06-30";

  it("ages invoices into the right buckets and groups by counterparty", () => {
    const invoices: OpenInvoice[] = [
      { number: "S-1", counterparty: "Acme Traders", date: "2025-06-20", outstanding: INR(40000) }, // 10 days
      { number: "S-2", counterparty: "Acme Traders", date: "2025-05-15", outstanding: INR(30000) }, // 46 days
      { number: "P-1", counterparty: "Bharat Supplies", date: "2025-04-01", outstanding: INR(25000) }, // 90 days
      { number: "P-2", counterparty: "Bharat Supplies", date: "2024-11-15", outstanding: INR(10000) }, // 227 days
    ];
    const res = ageInvoices({ invoices, asOfDate: AS_OF });

    const acme = res.rows.find((x) => x.counterparty === "Acme Traders")!;
    expect(r(acme.buckets["0-30"])).toBe(40000);
    expect(r(acme.buckets["31-60"])).toBe(30000);
    expect(r(acme.total)).toBe(70000);

    const bharat = res.rows.find((x) => x.counterparty === "Bharat Supplies")!;
    expect(r(bharat.buckets["61-90"])).toBe(25000);
    expect(r(bharat.buckets["180+"])).toBe(10000);

    expect(r(res.total)).toBe(105000);
    expect(r(res.byBucket["0-30"])).toBe(40000);
    expect(r(res.byBucket["180+"])).toBe(10000);
  });

  it("puts a 90-day invoice in 61-90 and a 91-day one in 91-180", () => {
    const res = ageInvoices({
      invoices: [
        { number: "A", counterparty: "X", date: "2025-04-01", outstanding: INR(1000) }, // 90
        { number: "B", counterparty: "Y", date: "2025-03-31", outstanding: INR(1000) }, // 91
      ],
      asOfDate: AS_OF,
    });
    expect(r(res.byBucket["61-90"])).toBe(1000);
    expect(r(res.byBucket["91-180"])).toBe(1000);
  });

  it("rejects a malformed as-of date and negative amounts", () => {
    expect(() => ageInvoices({ invoices: [], asOfDate: "30-06-2025" })).toThrow(/asOfDate/);
    expect(() =>
      ageInvoices({
        invoices: [{ number: "N", counterparty: "X", date: "2025-01-01", outstanding: -1 }],
        asOfDate: AS_OF,
      }),
    ).toThrow(/non-negative/);
  });
});

describe("msme43bh", () => {
  const AS_OF = "2025-06-30";
  const suppliers: MsmeSupplier[] = [
    { name: "Micro Motors", isMsme: true, msmeInterestRatePct: 27 }, // 3 × 9%
    { name: "Small Tools Co", isMsme: true, msmeInterestRatePct: 24 },
    { name: "Big Corporates", isMsme: false, msmeInterestRatePct: 0 },
  ];

  it("disallows only MSME balances beyond 45 days, per invoice", () => {
    const invoices: OpenInvoice[] = [
      { number: "M1", counterparty: "Micro Motors", date: "2025-06-01", outstanding: INR(100000) }, // 29 days → allowed
      { number: "M2", counterparty: "Micro Motors", date: "2025-04-10", outstanding: INR(200000) }, // 81 days → disallowed
      { number: "T1", counterparty: "Small Tools Co", date: "2025-05-15", outstanding: INR(50000) }, // 46 days → disallowed
      { number: "B1", counterparty: "Big Corporates", date: "2025-01-01", outstanding: INR(900000) }, // non-MSME, ignored
    ];
    const res = msme43bh({ invoices, suppliers, asOfDate: AS_OF });

    const micro = res.suppliers.find((s) => s.name === "Micro Motors")!;
    expect(r(micro.disallowed)).toBe(200000); // only M2
    expect(r(micro.outstanding)).toBe(300000); // M1 + M2

    const tools = res.suppliers.find((s) => s.name === "Small Tools Co")!;
    expect(r(tools.disallowed)).toBe(50000);
    expect(tools.daysOutstanding).toBe(46);

    expect(r(res.totalDisallowed)).toBe(250000);
  });

  it("excludes non-MSME suppliers entirely", () => {
    const res = msme43bh({
      invoices: [{ number: "B1", counterparty: "Big Corporates", date: "2025-01-01", outstanding: INR(900000) }],
      suppliers,
      asOfDate: AS_OF,
    });
    expect(res.suppliers).toHaveLength(0);
    expect(r(res.totalDisallowed)).toBe(0);
  });

  it("computes s16 interest from day 46 at the caller rate /365", () => {
    // Micro Motors M2: 81 days outstanding → 36 interest days on ₹2,00,000 @27%.
    const invoices: OpenInvoice[] = [
      { number: "M2", counterparty: "Micro Motors", date: "2025-04-10", outstanding: INR(200000) },
    ];
    const res = msme43bh({ invoices, suppliers, asOfDate: AS_OF });
    const expected = Math.round((INR(200000) * 27 * 36) / (100 * 365));
    const micro = res.suppliers.find((s) => s.name === "Micro Motors")!;
    expect(micro.interestLiability).toBe(expected);
    expect(r(expected)).toBeCloseTo(5326.03, 0); // 2,00,000 × 27% × 36/365
  });

  it("lists an in-window MSME supplier on the watch list with zero disallowance and interest", () => {
    const res = msme43bh({
      invoices: [{ number: "M1", counterparty: "Micro Motors", date: "2025-06-01", outstanding: INR(100000) }],
      suppliers,
      asOfDate: AS_OF,
    });
    const micro = res.suppliers.find((s) => s.name === "Micro Motors");
    expect(micro).toBeDefined(); // monitored, currently compliant
    expect(micro!.disallowed).toBe(0);
    expect(micro!.interestLiability).toBe(0);
    expect(micro!.daysOutstanding).toBe(29);
    expect(msmeInterestDays("2025-06-01", AS_OF)).toBe(0);
  });

  it("rejects a malformed as-of date", () => {
    expect(() => msme43bh({ invoices: [], suppliers, asOfDate: "junk" })).toThrow(/asOfDate/);
  });
});
