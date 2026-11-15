/**
 * Accounting engine — oracle tests.
 *
 * Double-entry arithmetic is the ideal case for hand-computed oracles: every
 * expected figure here is derived by hand from a small, fully-spelled-out set
 * of entries, so a failure points at a specific broken rule rather than a
 * drifted snapshot.
 *
 * The invariants that matter, in priority order:
 *
 *  1. EVERY entry balances (debits = credits). If this fails, nothing else is
 *     trustworthy, so it is asserted on every fixture below.
 *  2. The trial balance balances.
 *  3. Assets = Liabilities + Equity on the balance sheet.
 *  4. The income statement ties to the movement in equity.
 *
 * The negative tests matter just as much: an unbalanced entry MUST throw, not
 * silently repair itself. A bookkeeping tool that "fixes" an imbalance by
 * inventing a rounding plug is worse than one that refuses.
 */

import {
  AccountingError,
  DEFAULT_CHART_OF_ACCOUNTS,
  accountBalances,
  balanceSheet,
  buildLedger,
  cashFlow,
  entryFromCsvRow,
  formatMinor,
  fromMinorUnits,
  incomeStatement,
  toMinorUnits,
  trialBalance,
  validateEntry,
  type JournalEntry,
} from "@/lib/engine/accounting";
import { AnalysisInputError, runAnalysis } from "@/lib/engine/analyses";
import type { AnalysisConfig } from "@/lib/types";

// ---------------------------------------------------------------------------
// The worked example
//
// A tiny but complete set of books for a trading company, all in minor units
// (paise). Hand-derived expectations are written next to each assertion.
// ---------------------------------------------------------------------------

function minor(major: number): number {
  return toMinorUnits(major);
}

/**
 * Entries (amounts in paise):
 *  E1  Capital introduced 10,00,000        Dr Bank 100000000  Cr Share Capital 100000000
 *  E2  Purchase inventory 2,00,000        Dr Inventory 20000000   Cr Accounts Payable 20000000
 *  E3  Credit sale 5,00,000              Dr Receivable 50000000  Cr Revenue 50000000
 *  E4  Cost of goods sold 1,50,000       Dr COGS 15000000        Cr Inventory 15000000
 *  E5  Rent paid 50,000                  Dr Rent 5000000         Cr Bank 5000000
 *  E6  Salary accrued 40,000             Dr Employee Cost 4000000 Cr Salaries Payable 4000000
 */
const ENTRIES: JournalEntry[] = [
  {
    id: "E1",
    date: "2025-04-01",
    narration: "Capital introduced",
    lines: [
      { accountCode: "1010", amount: minor(1000000) },
      { accountCode: "3000", amount: -minor(1000000) },
    ],
  },
  {
    id: "E2",
    date: "2025-04-05",
    narration: "Inventory purchased",
    lines: [
      { accountCode: "1200", amount: minor(200000) },
      { accountCode: "2000", amount: -minor(200000) },
    ],
  },
  {
    id: "E3",
    date: "2025-06-10",
    narration: "Credit sale",
    lines: [
      { accountCode: "1100", amount: minor(500000) },
      { accountCode: "4000", amount: -minor(500000) },
    ],
  },
  {
    id: "E4",
    date: "2025-06-15",
    narration: "Cost of goods sold",
    lines: [
      { accountCode: "5000", amount: minor(150000) },
      { accountCode: "1200", amount: -minor(150000) },
    ],
  },
  {
    id: "E5",
    date: "2025-07-01",
    narration: "Rent paid",
    lines: [
      { accountCode: "5200", amount: minor(50000) },
      { accountCode: "1010", amount: -minor(50000) },
    ],
  },
  {
    id: "E6",
    date: "2025-07-31",
    narration: "Salary accrued",
    lines: [
      { accountCode: "5100", amount: minor(40000) },
      { accountCode: "2300", amount: -minor(40000) },
    ],
  },
];

// ---------------------------------------------------------------------------
// Money primitives
// ---------------------------------------------------------------------------

describe("money: minor-unit conversion", () => {
  it("converts major units to paise exactly", () => {
    expect(toMinorUnits(1)).toBe(100);
    expect(toMinorUnits(1234.56)).toBe(123456);
    expect(toMinorUnits(0.1)).toBe(10);
    expect(fromMinorUnits(123456)).toBe(1234.56);
  });

  it("rounds half AWAY FROM ZERO on negatives — Math.round would move this the wrong way", () => {
    // Math.round(-0.5) is -0 (Object.is distinguishes -0 from 0), which silently
    // loses half a paise in the wrong direction. This is the specific bug the
    // helper exists to prevent.
    expect(Object.is(Math.round(-0.5), 0)).toBe(false);
    expect(Object.is(Math.round(-0.5), -0)).toBe(true);
    // Half a rupee is 50 paise, and the helper takes the absolute value first
    // so the rounding direction is symmetric for negatives.
    expect(toMinorUnits(-0.5)).toBe(-50);
    // Half a PAISE is the real rounding edge: ±0.005 rupee → ±1 paise.
    expect(toMinorUnits(-0.005)).toBe(-1);
    expect(toMinorUnits(0.005)).toBe(1);

    // Documented float caveat, not an accident: -1.005 is stored as
    // -1.0049999999999998934, so it rounds to -100 paise. This is why the
    // engine takes MINOR UNITS as integers at every internal boundary — once
    // an amount is an integer number of paise, no float ever touches it again
    // and the debit=credit identity cannot drift.
    expect(toMinorUnits(-1.005)).toBe(-100);
  });

  it("formats with exactly two decimals, sign before the digits", () => {
    expect(formatMinor(123456)).toBe("1234.56");
    expect(formatMinor(-123456)).toBe("-1234.56");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(0)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

describe("journal entries", () => {
  it("accepts a balanced entry", () => {
    const e = validateEntry(ENTRIES[0]!, DEFAULT_CHART_OF_ACCOUNTS);
    expect(e.lines).toHaveLength(2);
  });

  it("REJECTS an unbalanced entry rather than repairing it", () => {
    const bad: JournalEntry = {
      id: "BAD",
      date: "2025-04-01",
      narration: "Unbalanced",
      lines: [
        { accountCode: "1010", amount: minor(100) },
        { accountCode: "3000", amount: -minor(99) },
      ],
    };
    // The message must state the exact discrepancy — a bookkeeper fixes the
    // voucher from this text alone, without opening the app.
    expect(() => validateEntry(bad, DEFAULT_CHART_OF_ACCOUNTS)).toThrow(AccountingError);
    expect(() => validateEntry(bad, DEFAULT_CHART_OF_ACCOUNTS)).toThrow(/out of balance by 1\.00/);
  });

  it("rejects posting to an account not in the chart", () => {
    const bad: JournalEntry = {
      id: "BAD2",
      date: "2025-04-01",
      narration: "Unknown account",
      lines: [
        { accountCode: "1010", amount: minor(100) },
        { accountCode: "9999", amount: -minor(100) },
      ],
    };
    expect(() => validateEntry(bad, DEFAULT_CHART_OF_ACCOUNTS)).toThrow(/unknown account/i);
  });

  it("rejects a single-line entry", () => {
    expect(() =>
      validateEntry(
        {
          id: "BAD3",
          date: "2025-04-01",
          narration: "One-sided",
          lines: [{ accountCode: "1010", amount: minor(100) }],
        },
        DEFAULT_CHART_OF_ACCOUNTS,
      ),
    ).toThrow(/at least two lines/);
  });

  it("drops zero-value lines but still requires two real ones", () => {
    const e = validateEntry(
      {
        id: "ZERO",
        date: "2025-04-01",
        narration: "Has a zero line",
        lines: [
          { accountCode: "1010", amount: minor(100) },
          { accountCode: "5200", amount: 0 },
          { accountCode: "3000", amount: -minor(100) },
        ],
      },
      DEFAULT_CHART_OF_ACCOUNTS,
    );
    expect(e.lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Trial balance — hand-computed
// ---------------------------------------------------------------------------

describe("trial balance", () => {
  const ledger = buildLedger(DEFAULT_CHART_OF_ACCOUNTS, ENTRIES);
  const tb = trialBalance(ledger);

  it("balances: every balanced entry must produce a balanced trial balance", () => {
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.difference).toBe(0);
  });

  it("matches the hand-computed totals", () => {
    // Debits: Bank 1,000,000 − 50,000 = 950,000
    //        Inventory 200,000 − 150,000 = 50,000
    //        Receivable 500,000; COGS 150,000; Rent 50,000; Employee 40,000
    // Total debits = 950,000 + 50,000 + 500,000 + 150,000 + 50,000 + 40,000
    //             = 1,740,000
    expect(fromMinorUnits(tb.totalDebit)).toBe(1740000);
  });

  it("places a credit-normal account (revenue) in the credit column", () => {
    const revenue = tb.rows.find((r) => r.code === "4000");
    expect(revenue?.debit).toBe(0);
    expect(fromMinorUnits(revenue?.credit ?? 0)).toBe(500000);
  });

  it("nets an account across multiple postings", () => {
    // Bank: +1,000,000 (E1) then −50,000 (E5) = 950,000 debit.
    const bank = tb.rows.find((r) => r.code === "1010");
    expect(fromMinorUnits(bank?.debit ?? 0)).toBe(950000);
  });

  it("omits untouched accounts rather than printing zero rows", () => {
    expect(tb.rows.find((r) => r.code === "1500")).toBeUndefined();
  });

  it("respects the date range — a trial balance is as-at, not all-time", () => {
    // Through 2025-06-30 only E1–E4 are in scope: rent and salary come later.
    const qb = trialBalance(ledger, { to: "2025-06-30" });
    expect(qb.rows.find((r) => r.code === "5200")).toBeUndefined();
    expect(qb.rows.find((r) => r.code === "5100")).toBeUndefined();
    expect(qb.balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Income statement — hand-computed
// ---------------------------------------------------------------------------

describe("income statement", () => {
  const ledger = buildLedger(DEFAULT_CHART_OF_ACCOUNTS, ENTRIES);
  const is = incomeStatement(ledger);

  it("computes the exact period result", () => {
    // Income  = Revenue 500,000
    // Expense = COGS 150,000 + Rent 50,000 + Employee 40,000 = 240,000
    // Profit  = 500,000 − 240,000 = 260,000
    expect(fromMinorUnits(is.totalIncome)).toBe(500000);
    expect(fromMinorUnits(is.totalExpenses)).toBe(240000);
    expect(fromMinorUnits(is.netProfit)).toBe(260000);
  });

  it("nests accounts under their category for the statement render", () => {
    const operating = is.expenses.find((l) => l.label === "Operating expenses");
    expect(operating).toBeDefined();
    expect(operating?.children?.map((c) => c.label)).toContain("Cost of Goods Sold");
  });

  it("is period-scoped, so a half-year differs from the full year", () => {
    const h1 = incomeStatement(ledger, { to: "2025-06-30" });
    // Through June: income 500,000; expense COGS 150,000 only.
    expect(fromMinorUnits(h1.totalExpenses)).toBe(150000);
    expect(fromMinorUnits(h1.netProfit)).toBe(350000);
  });

  it("reports a loss as a negative profit rather than hiding it", () => {
    const lossLedger = buildLedger(DEFAULT_CHART_OF_ACCOUNTS, [
      {
        id: "L1",
        date: "2025-04-01",
        narration: "Pure expense",
        lines: [
          { accountCode: "5200", amount: minor(100) },
          { accountCode: "1010", amount: -minor(100) },
        ],
      },
    ]);
    expect(fromMinorUnits(incomeStatement(lossLedger).netProfit)).toBe(-100);
  });
});

// ---------------------------------------------------------------------------
// Balance sheet — the identity must hold
// ---------------------------------------------------------------------------

describe("balance sheet", () => {
  const ledger = buildLedger(DEFAULT_CHART_OF_ACCOUNTS, ENTRIES);
  const bs = balanceSheet(ledger, { from: "2025-04-01", to: "2025-07-31" });

  it("satisfies Assets = Liabilities + Equity", () => {
    expect(bs.imbalance).toBe(0);
    expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
  });

  it("matches the hand-computed figures", () => {
    // Assets: Bank 950,000 + Inventory 50,000 + Receivable 500,000 = 1,500,000
    // Liabilities: AP 200,000 + Salaries Payable 40,000 = 240,000
    // Equity: Share capital 1,000,000 + period profit 260,000 = 1,260,000
    // 240,000 + 1,260,000 = 1,500,000 ✓
    expect(fromMinorUnits(bs.totalAssets)).toBe(1500000);
    expect(fromMinorUnits(bs.totalLiabilities)).toBe(240000);
    expect(fromMinorUnits(bs.totalEquity)).toBe(1260000);
  });

  it("carries the period profit into equity automatically — no closing entry required", () => {
    expect(bs.equity.some((l) => l.label === "Profit for the period")).toBe(true);
  });

  it("ties the income statement to the balance sheet's equity movement", () => {
    const is = incomeStatement(ledger, { from: "2025-04-01", to: "2025-07-31" });
    const equityFromAccounts = accountBalances(ledger, { from: "2025-04-01", to: "2025-07-31" })
      .filter((b) => b.account.type === "equity")
      .reduce((s, b) => s + b.balance, 0);
    expect(bs.totalEquity).toBe(equityFromAccounts + is.netProfit);
  });
});

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

describe("cash flow (indirect)", () => {
  const ledger = buildLedger(DEFAULT_CHART_OF_ACCOUNTS, ENTRIES);
  const cf = cashFlow(ledger, { from: "2025-04-01", to: "2025-07-31" });

  it("reconciles to the ledger's own cash balance", () => {
    // If this is false the statement is showing a closing cash figure the books
    // do not support — the classic unreconciled-cash-flow failure.
    expect(cf.reconciled).toBe(true);
  });

  it("matches the hand-computed net change", () => {
    // Operating = profit 260,000
    //   − inventory change (asset ↑50,000) = −50,000
    //   − receivables (asset ↑500,000)    = −500,000
    //   + payables (liability ↑200,000)  = +200,000
    //   + salaries payable ↑40,000        = +40,000
    //   = 260,000 − 50,000 − 500,000 + 200,000 + 40,000 = −50,000
    // Investing  = 0
    // Financing  = share capital introduced 1,000,000 (an equity injection is
    //               a financing INFLOW, not an operating item)
    // Net change = −50,000 + 1,000,000 = +950,000, and closing cash is 950,000
    // because the books opened the period with nothing.
    expect(fromMinorUnits(cf.netChange)).toBe(950000);
    expect(fromMinorUnits(cf.closingCash)).toBe(950000);
    expect(fromMinorUnits(cf.financing)).toBe(1000000);
  });
});

// ---------------------------------------------------------------------------
// Contra entries and CSV import
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The accounting ANALYSIS KIND — end-to-end from an uploaded voucher file
// ---------------------------------------------------------------------------

describe("accounting analysis kind", () => {
  // A voucher file exactly as a firm would export it: date, voucher ref,
  // account code, debit, credit. One row per posting side.
  const columns = [
    { name: "date", type: "date" as const },
    { name: "voucher", type: "string" as const },
    { name: "account", type: "string" as const },
    { name: "debit", type: "number" as const },
    { name: "credit", type: "number" as const },
  ];
  const rows = [
    ["2025-04-01", "V1", "1010", 1000000, 0],
    ["2025-04-01", "V1", "3000", 0, 1000000],
    ["2025-04-05", "V2", "1200", 200000, 0],
    ["2025-04-05", "V2", "2000", 0, 200000],
    ["2025-06-10", "V3", "1100", 500000, 0],
    ["2025-06-10", "V3", "4000", 0, 500000],
    ["2025-06-15", "V4", "5000", 150000, 0],
    ["2025-06-15", "V4", "1200", 0, 150000],
    ["2025-07-01", "V5", "5200", 50000, 0],
    ["2025-07-01", "V5", "1010", 0, 50000],
  ];
  const input = {
    datasetId: "ds-acct",
    datasetName: "FY25 vouchers",
    totalRows: rows.length,
    columns,
    rows: rows as (string | number)[][],
  };
  const cfg = {
    kind: "accounting",
    dateCol: "date",
    accountCol: "account",
    debitCol: "debit",
    creditCol: "credit",
    narrationCol: null,
    referenceCol: "voucher",
    from: null,
    to: null,
  } as const;

  it("produces a balanced trial balance from a voucher file", () => {
    const res = runAnalysis(input, cfg as unknown as AnalysisConfig);
    expect(res.stats?.find((s) => s.label === "Trial balance")?.value).toBe("Balanced");
    expect(res.tables?.some((t) => t.title.startsWith("Trial balance"))).toBe(true);
  });

  it("satisfies A = L + E on the balance sheet", () => {
    const res = runAnalysis(input, cfg as unknown as AnalysisConfig);
    expect(res.stats?.find((s) => s.label === "Balance sheet")?.value).toBe("Balanced");
  });

  it("emits all three statements", () => {
    const res = runAnalysis(input, cfg as unknown as AnalysisConfig);
    const titles = res.tables?.map((t) => t.title) ?? [];
    expect(titles.some((t) => t.includes("Trial balance"))).toBe(true);
    expect(titles.some((t) => t.includes("Profit & loss"))).toBe(true);
    expect(titles.some((t) => t.includes("Balance sheet"))).toBe(true);
  });

  it("rejects an unbalanced voucher rather than repairing it", () => {
    // V9 posts 5,000 debit against 3,000 credit — a real imbalance that the
    // engine must refuse rather than plug.
    const bad = [...rows, ["2025-08-01", "V9", "5200", 5000, 0], ["2025-08-01", "V9", "1010", 0, 3000]];
    const res = runAnalysis(
      { ...input, totalRows: bad.length, rows: bad as (string | number)[][] },
      cfg as unknown as AnalysisConfig,
    );
    // The other vouchers still post, but the rejection is surfaced loudly.
    expect(res.quickFindings?.join(" ")).toMatch(/rejected/i);
    expect(res.qualityWarnings.join(" ")).toMatch(/cannot balance|out of balance/i);
  });

  it("rejects an unknown account code rather than silently creating it", () => {
    // A good voucher alongside a bad one: the good one still posts and the
    // rejection is surfaced, rather than the whole file being discarded.
    const mixed = [...rows, ["2025-08-01", "V9", "8888", 5000, 0], ["2025-08-01", "V9", "1010", 0, 5000]];
    const res = runAnalysis(
      { datasetId: "d", datasetName: "n", totalRows: mixed.length, columns, rows: mixed as (string | number)[][] },
      cfg as unknown as AnalysisConfig,
    );
    expect(res.qualityWarnings.join(" ")).toMatch(/unknown account/i);

    // When EVERY voucher is unusable there is nothing to report, so it throws
    // with the first reason rather than rendering empty statements.
    const allBad = [
      ["2025-04-01", "V1", "1010", 1000, 0],
      ["2025-04-01", "V1", "8888", 0, 1000],
    ];
    expect(() =>
      runAnalysis(
        { datasetId: "d", datasetName: "n", totalRows: 2, columns, rows: allBad as (string | number)[][] },
        cfg as unknown as AnalysisConfig,
      ),
    ).toThrow(/unknown account/i);
  });

  it("fails loudly when nothing in the file can balance", () => {
    const allBad = [
      ["2025-04-01", "V1", "1010", 1000, 0],
      ["2025-04-01", "V1", "1010", 0, 500],
    ];
    expect(() =>
      runAnalysis(
        { datasetId: "d", datasetName: "n", totalRows: 2, columns, rows: allBad as (string | number)[][] },
        cfg as unknown as AnalysisConfig,
      ),
    ).toThrow(AnalysisInputError);
  });
});

// ---------------------------------------------------------------------------
// Contra entries and imports
// ---------------------------------------------------------------------------

describe("contra entries and imports", () => {
  it("flips a negative amount to the opposite side without corrupting the statement", () => {
    // A sales return: negative revenue (a credit-normal account going negative
    // means a debit balance), offset against receivables.
    const withContra = buildLedger(DEFAULT_CHART_OF_ACCOUNTS, [
      ...ENTRIES,
      {
        id: "C1",
        date: "2025-08-01",
        narration: "Sales return",
        lines: [
          { accountCode: "1100", amount: -minor(20000) },
          { accountCode: "4000", amount: minor(20000) },
        ],
      },
    ]);
    const is = incomeStatement(withContra);
    // Revenue falls by 20,000 → profit 240,000.
    expect(fromMinorUnits(is.netProfit)).toBe(240000);
    expect(trialBalance(withContra).balanced).toBe(true);
  });

  it("imports a debit/credit CSV row into a signed line", () => {
    const line = entryFromCsvRow({ date: "2025-04-01", account: "1010", debit: "1000.50", credit: "" }, "R1");
    expect(line.amount).toBe(minor(1000.5));
  });

  it("rejects a CSV row with both a debit and a credit", () => {
    expect(() => entryFromCsvRow({ date: "2025-04-01", account: "1010", debit: "100", credit: "50" }, "R2")).toThrow(
      /use one or the other/,
    );
  });

  it("rejects an empty CSV row rather than posting a silent zero", () => {
    expect(() => entryFromCsvRow({ date: "2025-04-01", account: "1010" }, "R3")).toThrow(
      /neither a debit nor a credit/,
    );
  });
});
