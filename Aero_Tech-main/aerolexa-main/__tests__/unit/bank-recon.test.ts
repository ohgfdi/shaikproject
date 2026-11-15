/**
 * BRS engine — oracle tests.
 *
 * Hand-computed. The identity pinned exactly below:
 *   bookBalance + adjustments = bankBalance
 * where adjustments = statement-only items − transit deposits − unpresented
 * cheques. Sign conventions are customer-perspective on both sides (receipts
 * positive), so amounts compare directly.
 */

import { reconcileBank, type BankStatementRow, type CashBookRow } from "@/lib/engine/bank-recon";
import { INR } from "@/lib/engine/india-tax";

const cb = (id: string, date: string, amount: number, extra: Partial<CashBookRow> = {}): CashBookRow => ({
  id,
  date,
  narration: `CB ${id}`,
  amount,
  ...extra,
});

const bk = (id: string, date: string, amount: number, extra: Partial<BankStatementRow> = {}): BankStatementRow => ({
  id,
  date,
  narration: `BK ${id}`,
  amount,
  ...extra,
});

describe("reconcileBank — the closing identity", () => {
  it("closes a textbook BRS with all four unmatched buckets", () => {
    // Books: two receipts cleared, one in transit; one payment cleared, one
    // cheque unpresented. Closing book balance = 50,000 − 8,000 = 42,000.
    const cashBook: CashBookRow[] = [
      cb("R1", "2025-04-02", INR(30000)),
      cb("R2", "2025-04-28", INR(20000)), // in transit
      cb("P1", "2025-04-05", -INR(8000)),
      cb("P2", "2025-04-20", -INR(5000)), // unpresented
    ];

    // Statement: the two cleared pairs, plus a bank charge the books missed.
    // Closing bank balance = 30,000 − 8,000 − 500 (charge) = 21,500.
    const statement: BankStatementRow[] = [
      bk("S1", "2025-04-04", INR(30000)),
      bk("S2", "2025-04-06", -INR(8000)),
      bk("S3", "2025-04-25", -INR(500)), // bank charge — bank-side item
    ];

    const brs = reconcileBank({ cashBook, statement, asOfDate: "2025-04-30" });

    const verdictOf = (id: string | null) => brs.items.find((i) => i.cashBookId === id || i.bankId === id)?.verdict;
    expect(verdictOf("R1")).toBe("matched");
    expect(verdictOf("P1")).toBe("matched");
    expect(verdictOf("R2")).toBe("deposit-in-transit");
    expect(verdictOf("P2")).toBe("cheque-unpresented");
    expect(verdictOf("S3")).toBe("bank-side-item");

    // 30,000 + 20,000 − 8,000 − 5,000 = 37,000.
    expect(brs.bookBalance).toBe(INR(37000));
    expect(brs.bankBalance).toBe(INR(21500));

    // adjustments = (−500 statement-only) − 20,000 transit − (−5,000) unpresented
    //             = −500 − 20,000 + 5,000 = −15,500
    expect(brs.totalAdjustments).toBe(-INR(15500));
    expect(brs.reconciledBalance).toBe(INR(21500));

    // The identity closes exactly: 37,000 − 15,500 = 21,500 = bank balance.
    expect(brs.difference).toBe(0);
  });

  it("closes to zero difference when the books already carry the statement-only items", () => {
    // Same as above but the books have also recorded the bank charge as P3,
    // which pairs with S3 on amount+chronology.
    const cashBook: CashBookRow[] = [
      cb("R1", "2025-04-02", INR(30000)),
      cb("R2", "2025-04-28", INR(20000)),
      cb("P1", "2025-04-05", -INR(8000)),
      cb("P2", "2025-04-20", -INR(5000)),
      cb("P3", "2025-04-24", -INR(500)), // charge now booked
    ];
    const statement: BankStatementRow[] = [
      bk("S1", "2025-04-04", INR(30000)),
      bk("S2", "2025-04-06", -INR(8000)),
      bk("S3", "2025-04-25", -INR(500)),
    ];
    const brs = reconcileBank({ cashBook, statement, asOfDate: "2025-04-30" });

    expect(brs.counts.matched).toBe(3); // R1, P1, P3↔S3
    expect(brs.bookBalance).toBe(INR(36500)); // 37,000 − 500
    expect(brs.bankBalance).toBe(INR(21500));
    // adjustments = 0 statement-only − 20,000 transit + 5,000 unpresented = −15,000
    expect(brs.totalAdjustments).toBe(-INR(15000));
    expect(brs.reconciledBalance).toBe(INR(21500));
    expect(brs.difference).toBe(0);
  });

  it("matches pairs one-for-one when amounts repeat", () => {
    const cashBook = [cb("A1", "2025-04-01", INR(1000)), cb("A2", "2025-04-02", INR(1000))];
    const statement = [bk("B1", "2025-04-03", INR(1000)), bk("B2", "2025-04-04", INR(1000))];
    const brs = reconcileBank({ cashBook, statement, asOfDate: "2025-04-30" });
    expect(brs.counts.matched).toBe(2);
    expect(brs.difference).toBe(0);
  });

  it("uses exact references before date-chronology matching", () => {
    // Two identical receipts; only refs distinguish the early statement row.
    const cashBook = [
      cb("R1", "2025-04-01", INR(5000), { reference: "CHQ-1001" }),
      cb("R2", "2025-04-02", INR(5000), { reference: "CHQ-1002" }),
    ];
    const statement = [
      bk("S1", "2025-04-01", INR(5000), { reference: "CHQ-1002" }),
      bk("S2", "2025-04-03", INR(5000), { reference: "CHQ-1001" }),
    ];
    const brs = reconcileBank({ cashBook, statement, asOfDate: "2025-04-30" });
    const itemOf = (cbId: string) => brs.items.find((i) => i.cashBookId === cbId)!;
    expect(itemOf("R1").bankId).toBe("S2");
    expect(itemOf("R2").bankId).toBe("S1");
  });

  it("flags stale transit items over three months old", () => {
    const brs = reconcileBank({
      cashBook: [cb("OLD", "2025-01-05", INR(7000))],
      statement: [],
      asOfDate: "2025-04-30",
    });
    expect(brs.counts["deposit-in-transit"]).toBe(1);
    expect(brs.warnings.some((w) => w.includes("OLD") && w.includes("three months"))).toBe(true);
  });

  it("rejects a malformed as-of date", () => {
    expect(() => reconcileBank({ cashBook: [], statement: [], asOfDate: "30-04-2025" })).toThrow(/asOfDate/);
  });

  it("handles an empty recon — both balances zero, difference zero", () => {
    const brs = reconcileBank({ cashBook: [], statement: [], asOfDate: "2025-04-30" });
    expect(brs.bookBalance).toBe(0);
    expect(brs.bankBalance).toBe(0);
    expect(brs.difference).toBe(0);
    expect(brs.methodology.length).toBeGreaterThanOrEqual(3);
  });
});
