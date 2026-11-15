/**
 * Books assembly — oracle tests.
 *
 * The invariant that matters is the same as accounting.ts: opening balances
 * plus vouchers must keep debits equal to credits, and a mid-year account
 * statement must carry its opening balance forward rather than restart at zero.
 */

import { balanceSheet, incomeStatement, trialBalance } from "@/lib/engine/accounting";
import {
  accountLedger,
  assembleLedger,
  BooksError,
  dayBook,
  type BookAccountRow,
  type BookVoucherRow,
} from "@/lib/engine/books";
import { INR } from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

const accounts: BookAccountRow[] = [
  { code: "1000", name: "Cash", type: "asset", category: "Current assets", openingBalance: INR(100000) },
  { code: "3100", name: "Retained Earnings", type: "equity", category: "Equity", openingBalance: INR(-100000) },
  { code: "4000", name: "Revenue from Operations", type: "income", category: "Operating income" },
  { code: "5000", name: "Cost of Goods Sold", type: "expense", category: "Operating expenses" },
];

const vouchers: BookVoucherRow[] = [
  {
    id: "V1",
    date: "2025-04-10",
    narration: "Cash sale",
    lines: [
      { accountCode: "1000", amount: INR(50000) },
      { accountCode: "4000", amount: INR(-50000) },
    ],
  },
  {
    id: "V2",
    date: "2025-05-02",
    narration: "Cost of goods sold",
    lines: [
      { accountCode: "5000", amount: INR(20000) },
      { accountCode: "1000", amount: INR(-20000) },
    ],
  },
];

describe("assembleLedger", () => {
  it("folds opening balances into a balancing opening entry", () => {
    const ledger = assembleLedger(accounts, vouchers);
    const tb = trialBalance(ledger);
    expect(tb.balanced).toBe(true);
    expect(r(tb.totalDebit)).toBe(150000); // cash 1,30,000 + COGS 20,000
    expect(r(tb.totalCredit)).toBe(150000); // retained 1,00,000 + revenue 50,000
  });

  it("produces an income statement over the period", () => {
    const ledger = assembleLedger(accounts, vouchers);
    const is = incomeStatement(ledger);
    expect(r(is.totalIncome)).toBe(50000);
    expect(r(is.totalExpenses)).toBe(20000);
    expect(r(is.netProfit)).toBe(30000);
  });

  it("balances the balance sheet after the opening entry", () => {
    const ledger = assembleLedger(accounts, vouchers);
    const bs = balanceSheet(ledger);
    expect(bs.imbalance).toBe(0);
    expect(r(bs.totalAssets)).toBe(130000);
    expect(r(bs.totalEquity)).toBe(130000); // 1,00,000 + 30,000 profit
  });

  it("refuses opening balances that do not sum to zero", () => {
    const unbalanced: BookAccountRow[] = [
      { code: "1000", name: "Cash", type: "asset", category: "Current assets", openingBalance: INR(100) },
    ];
    expect(() => assembleLedger(unbalanced, [])).toThrow(BooksError);
  });
});

describe("dayBook", () => {
  it("totals debit and credit per voucher", () => {
    const rows = dayBook(vouchers);
    expect(rows).toHaveLength(2);
    expect(r(rows[0]!.debit)).toBe(50000);
    expect(r(rows[0]!.credit)).toBe(50000);
    expect(r(rows[1]!.debit)).toBe(20000);
  });

  it("filters by date range", () => {
    const rows = dayBook(vouchers, { from: "2025-05-01" });
    expect(rows.map((x) => x.id)).toEqual(["V2"]);
  });
});

describe("accountLedger", () => {
  it("carries the running balance forward", () => {
    const ledger = assembleLedger(accounts, vouchers);
    const rows = accountLedger(ledger, "1000");
    // Opening 1,00,000, +50,000 sale, −20,000 COGS = 1,30,000.
    expect(r(rows[rows.length - 1]!.balance)).toBe(130000);
  });

  it("starts a mid-year statement from the opening balance for the range", () => {
    const ledger = assembleLedger(accounts, vouchers);
    const rows = accountLedger(ledger, "1000", { from: "2025-05-01" });
    // Only the May voucher; balance = 1,00,000 opening + 50,000 sale − 20,000 = 1,30,000.
    expect(rows).toHaveLength(1);
    expect(r(rows[0]!.balance)).toBe(130000);
  });

  it("throws on an unknown account", () => {
    const ledger = assembleLedger(accounts, vouchers);
    expect(() => accountLedger(ledger, "9999")).toThrow(BooksError);
  });
});
