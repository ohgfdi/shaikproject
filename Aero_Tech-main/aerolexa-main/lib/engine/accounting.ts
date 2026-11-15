/**
 * Double-entry accounting engine.
 *
 * The rule this whole module exists to enforce: for every journal entry, total
 * debits equal total credits. Everything else — the trial balance, the income
 * statement, the balance sheet — is a projection of that invariant. If the
 * entries are unbalanced, every downstream statement is arithmetically wrong
 * in a way that still looks plausible on the page, so `postEntry` refuses
 * rather than repairing.
 *
 * Design decisions worth stating:
 *
 *  - PURITIES over convenience. Amounts are stored in MINOR UNITS (paise /
 *    cents) as integers. Floating-point rupees accumulate error that eventually
 *    breaks the debit=credit identity, which is the one thing that must never
 *    happen in a bookkeeping tool. The public helpers convert to/from major
 *    units at the boundary only.
 *
 *  - The chart of accounts is EXPLICIT. No account is inferred from a name, and
 *    no posting is allowed to an account that does not exist. An implicit chart
 *    is how trial balances silently disagree with ledgers.
 *
 *  - Normal balances are encoded, not assumed. Assets and expenses carry debit
 *    balances; liabilities, equity and income carry credit balances. A
 *    contra-entry (a negative amount) is legal and flips the effective side,
 *    because real adjustments (a credit note, a rebate) do exactly that.
 *
 *  - Reporting is BY DATE RANGE, never "all time". A balance sheet dated
 *    2025-03-31 that silently includes April postings is worse than no
 *    statement at all.
 *
 * Everything here is pure and deterministic: same input, same statements, no
 * clock and no randomness. That is what makes it oracle-testable.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Round a major-unit amount to minor units using HALF AWAY FROM ZERO.
 *
 * `Math.round` alone rounds -0.5 to -0, which silently moves one paise in the
 * wrong direction for negative amounts — an error that compounds across a
 * ledger and makes the books fail to balance for no visible reason.
 */
export function toMinorUnits(major: number): number {
  if (!Number.isFinite(major)) return 0;
  return major < 0 ? -Math.round(-major * 100) : Math.round(major * 100);
}

export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

/** Minor units → a display string with exactly two decimals. */
export function formatMinor(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${s}` : s;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** Accounts whose balance sits on the debit side under normal operation. */
const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>(["asset", "expense"]);

export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL.has(type);
}

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  /** Grouped for statement rendering (current assets, revenue, etc.). */
  category: string;
  description?: string;
}

/**
 * The standard Indian chart of accounts a CA firm starts from, aligned to the
 * Schedule III presentation used in Indian financial statements.
 *
 * This is a TEMPLATE, not a constraint: firms add accounts, and callers may
 * pass their own list to every function here. It exists so a new workspace has
 * something correct to start from rather than an empty dropdown.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: readonly Account[] = [
  // Assets
  { code: "1000", name: "Cash", type: "asset", category: "Current assets" },
  { code: "1010", name: "Bank", type: "asset", category: "Current assets" },
  { code: "1100", name: "Accounts Receivable", type: "asset", category: "Current assets" },
  { code: "1200", name: "Inventory", type: "asset", category: "Current assets" },
  { code: "1300", name: "Prepaid Expenses", type: "asset", category: "Current assets" },
  { code: "1500", name: "Fixed Assets", type: "asset", category: "Non-current assets" },
  { code: "1590", name: "Accumulated Depreciation", type: "asset", category: "Non-current assets" },
  { code: "1900", name: "Goodwill", type: "asset", category: "Non-current assets" },
  // Liabilities
  { code: "2000", name: "Accounts Payable", type: "liability", category: "Current liabilities" },
  { code: "2100", name: "Loans Payable", type: "liability", category: "Non-current liabilities" },
  { code: "2200", name: "TDS Payable", type: "liability", category: "Current liabilities" },
  { code: "2210", name: "GST Payable", type: "liability", category: "Current liabilities" },
  { code: "2220", name: "GST Input Credit", type: "liability", category: "Current liabilities" },
  { code: "2250", name: "Statutory Dues Payable", type: "liability", category: "Current liabilities" },
  { code: "2300", name: "Salaries Payable", type: "liability", category: "Current liabilities" },
  { code: "2400", name: "Provision for Tax", type: "liability", category: "Current liabilities" },
  // Equity
  { code: "3000", name: "Share Capital", type: "equity", category: "Equity" },
  { code: "3100", name: "Retained Earnings", type: "equity", category: "Equity" },
  { code: "3200", name: "Current Year Profit", type: "equity", category: "Equity" },
  // Income
  { code: "4000", name: "Revenue from Operations", type: "income", category: "Operating income" },
  { code: "4100", name: "Other Income", type: "income", category: "Other income" },
  { code: "4900", name: "Sales Returns", type: "income", category: "Operating income" },
  // Expenses
  { code: "5000", name: "Cost of Goods Sold", type: "expense", category: "Operating expenses" },
  { code: "5100", name: "Employee Costs", type: "expense", category: "Operating expenses" },
  { code: "5200", name: "Rent", type: "expense", category: "Operating expenses" },
  { code: "5300", name: "Utilities", type: "expense", category: "Operating expenses" },
  { code: "5400", name: "Professional Fees", type: "expense", category: "Operating expenses" },
  { code: "5500", name: "Depreciation", type: "expense", category: "Operating expenses" },
  { code: "5600", name: "Interest Expense", type: "expense", category: "Finance costs" },
  { code: "5900", name: "Income Tax Expense", type: "expense", category: "Tax" },
];

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

export interface JournalLine {
  accountCode: string;
  /** Signed amount in MINOR UNITS. Positive = debit, negative = credit. */
  amount: number;
  narration?: string;
}

export interface JournalEntry {
  id: string;
  date: string; // ISO yyyy-mm-dd
  narration: string;
  lines: JournalLine[];
  /** Free-form provenance: source document, voucher no, import batch. */
  reference?: string;
}

export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

/** Signed amount in minor units, expressed on its NATURAL side. */
function signedOnNaturalSide(account: Account, amount: number): number {
  return isDebitNormal(account.type) ? amount : -amount;
}

/**
 * Validate an entry without mutating anything.
 *
 * Returns the balanced entry (amounts coerced to integers) or throws with a
 * message naming the exact discrepancy — a bookkeeper must be able to fix the
 * voucher from the error text alone.
 */
export function validateEntry(entry: JournalEntry, accounts: readonly Account[]): JournalEntry {
  if (entry.lines.length < 2) {
    throw new AccountingError(
      `Journal entry ${entry.id} needs at least two lines — a single-sided entry cannot balance.`,
    );
  }
  const byCode = new Map(accounts.map((a) => [a.code, a] as const));

  let debits = 0;
  let credits = 0;
  const checked: JournalLine[] = [];

  for (const line of entry.lines) {
    const account = byCode.get(line.accountCode);
    if (!account) {
      throw new AccountingError(
        `Journal entry ${entry.id} posts to unknown account “${line.accountCode}”. Add it to the chart of accounts first.`,
      );
    }
    if (!Number.isFinite(line.amount)) {
      throw new AccountingError(`Journal entry ${entry.id} has a non-numeric amount on account ${line.accountCode}.`);
    }
    // Coerce to integer minor units so fractional paise can never enter a ledger.
    const minor = Math.round(line.amount);
    if (minor === 0) continue; // a zero line carries no information
    if (minor > 0) debits += minor;
    else credits += -minor;
    checked.push({ ...line, amount: minor });
  }

  if (checked.length < 2) {
    throw new AccountingError(`Journal entry ${entry.id} has no non-zero lines once rounded to paise.`);
  }
  if (debits !== credits) {
    throw new AccountingError(
      `Journal entry ${entry.id} does not balance: debits ${formatMinor(debits)} vs credits ${formatMinor(credits)} — ` +
        `out of balance by ${formatMinor(Math.abs(debits - credits))}.`,
    );
  }

  return { ...entry, lines: checked };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface AccountBalance {
  account: Account;
  /** Signed balance in minor units, on the account's NATURAL side. */
  balance: number;
  totalDebits: number;
  totalCredits: number;
  postings: number;
}

export interface Ledger {
  accounts: readonly Account[];
  entries: JournalEntry[];
}

export interface LedgerQuery {
  /** ISO dates, inclusive. Omit for open-ended. */
  from?: string;
  to?: string;
}

/**
 * Build account balances over a date range.
 *
 * A balance is the SUM OF NATURAL-SIDE AMOUNTS: an expense debited 500 has a
 * +500 balance (it is a debit balance), while revenue credited 500 has a +500
 * balance too — but it is a CREDIT balance. Keeping the sign consistent and
 * letting `isDebitNormal` decide presentation is what makes the trial balance
 * arithmetic trivial and correct.
 */
export function accountBalances(ledger: Ledger, q: LedgerQuery = {}): AccountBalance[] {
  const byCode = new Map(ledger.accounts.map((a) => [a.code, a] as const));
  const acc = new Map<string, { balance: number; totalDebits: number; totalCredits: number; postings: number }>();

  for (const account of ledger.accounts) {
    acc.set(account.code, { balance: 0, totalDebits: 0, totalCredits: 0, postings: 0 });
  }

  for (const entry of ledger.entries) {
    if (q.from && entry.date < q.from) continue;
    if (q.to && entry.date > q.to) continue;
    for (const line of entry.lines) {
      const account = byCode.get(line.accountCode);
      if (!account) continue;
      const bucket = acc.get(line.accountCode);
      if (!bucket) continue;
      const natural = signedOnNaturalSide(account, line.amount);
      bucket.balance += natural;
      bucket.postings += 1;
      if (line.amount > 0) bucket.totalDebits += line.amount;
      else bucket.totalCredits += -line.amount;
    }
  }

  return ledger.accounts.map((account) => {
    const b = acc.get(account.code);
    return {
      account,
      balance: b?.balance ?? 0,
      totalDebits: b?.totalDebits ?? 0,
      totalCredits: b?.totalCredits ?? 0,
      postings: b?.postings ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  category: string;
  debit: number;
  credit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** True when total debits equal total credits. */
  balanced: boolean;
  difference: number;
}

/**
 * The trial balance, in absolute debit/credit columns.
 *
 * An account with a credit-normal balance (e.g. revenue) is displayed on the
 * CREDIT side; a debit-normal account on the DEBIT side. Negative natural
 * balances — a credit note against an expense, say — flip to the other column,
 * which is standard practice and is why a contra-entry does not corrupt the
 * statement.
 */
export function trialBalance(ledger: Ledger, q: LedgerQuery = {}): TrialBalance {
  const balances = accountBalances(ledger, q);
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const b of balances) {
    if (b.balance === 0) continue;
    const debitNormal = isDebitNormal(b.account.type);
    const isDebit = b.balance > 0 ? debitNormal : !debitNormal;
    const row: TrialBalanceRow = {
      code: b.account.code,
      name: b.account.name,
      type: b.account.type,
      category: b.account.category,
      debit: 0,
      credit: 0,
    };
    if (isDebit) {
      row.debit = Math.abs(b.balance);
      totalDebit += row.debit;
    } else {
      row.credit = Math.abs(b.balance);
      totalCredit += row.credit;
    }
    rows.push(row);
  }

  rows.sort((a, b) => a.code.localeCompare(b.code));
  return {
    rows,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
    difference: totalDebit - totalCredit,
  };
}

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

export interface StatementLine {
  key: string;
  label: string;
  amount: number;
  /** Direct children, for a nested render. */
  children?: StatementLine[];
}

export interface IncomeStatement {
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncome: number;
  totalExpenses: number;
  /** Net profit in minor units; negative means a loss. */
  netProfit: number;
  from?: string;
  to?: string;
}

export interface BalanceSheet {
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Assets − (Liabilities + Equity). Non-zero means the books are broken. */
  imbalance: number;
  asOf?: string;
}

/** Group flat balances into nested category → account statement lines. */
function groupIntoStatement(
  balances: AccountBalance[],
  types: AccountType[],
): { lines: StatementLine[]; total: number } {
  const relevant = balances.filter((b) => types.includes(b.account.type));
  const byCategory = new Map<string, AccountBalance[]>();
  for (const b of relevant) {
    const list = byCategory.get(b.account.category) ?? [];
    list.push(b);
    byCategory.set(b.account.category, list);
  }

  const lines: StatementLine[] = [];
  let total = 0;
  for (const [category, items] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const children: StatementLine[] = items
      .filter((i) => i.balance !== 0)
      .sort((a, b) => a.account.code.localeCompare(b.account.code))
      .map((i) => ({ key: i.account.code, label: i.account.name, amount: i.balance }));
    const subtotal = children.reduce((s, c) => s + c.amount, 0);
    if (subtotal === 0) continue;
    lines.push({ key: category, label: category, amount: subtotal, children });
    total += subtotal;
  }
  return { lines, total };
}

/**
 * Income statement over the date range.
 *
 * Income and expenses are period figures; opening balances from prior periods
 * are deliberately excluded, which is why the same account can show a
 * different balance here than in the balance sheet without either being wrong.
 */
export function incomeStatement(ledger: Ledger, q: LedgerQuery = {}): IncomeStatement {
  const balances = accountBalances(ledger, q);
  const income = groupIntoStatement(balances, ["income"]);
  const expenses = groupIntoStatement(balances, ["expense"]);
  return {
    income: income.lines,
    expenses: expenses.lines,
    totalIncome: income.total,
    totalExpenses: expenses.total,
    netProfit: income.total - expenses.total,
    from: q.from,
    to: q.to,
  };
}

/**
 * Balance sheet as at a date.
 *
 * The retained-earnings figure is the CURRENT PERIOD profit, not the equity
 * account's posted balance, when the caller supplies the period bounds — that
 * is the closing entry every chart of accounts needs, and doing it here means
 * the identity Assets = Liabilities + Equity holds without the caller having to
 * remember to post it.
 */
export function balanceSheet(ledger: Ledger, q: LedgerQuery = {}): BalanceSheet {
  const asOfBalances = accountBalances(ledger, { from: q.from, to: q.to });
  const assets = groupIntoStatement(asOfBalances, ["asset"]);
  const liabilities = groupIntoStatement(asOfBalances, ["liability"]);

  // The closing entry is implied, not assumed: profit for the period is added
  // to equity automatically. When no range is supplied the period is the whole
  // ledger, because "as at now" means every posting made so far — omitting
  // that profit would leave the sheet out by exactly the net income.
  const period: LedgerQuery = q.from || q.to ? { from: q.from, to: q.to } : {};
  const profit = incomeStatement(ledger, period).netProfit;
  const equityBalances = asOfBalances.filter((b) => b.account.type === "equity");
  const equityFromAccounts = equityBalances.reduce((s, b) => s + b.balance, 0);

  const equityLines: StatementLine[] = [];
  for (const b of equityBalances) {
    if (b.balance === 0) continue;
    equityLines.push({ key: b.account.code, label: b.account.name, amount: b.balance });
  }
  if (profit !== 0) {
    equityLines.push({
      key: "retained-current-period",
      label: q.from || q.to ? "Profit for the period" : "Current year profit",
      amount: profit,
    });
  }
  equityLines.sort((a, b) => a.key.localeCompare(b.key));
  const totalEquity = equityFromAccounts + profit;

  const totalAssets = assets.total;
  const totalLiabilities = liabilities.total;

  return {
    assets: assets.lines,
    liabilities: liabilities.lines,
    equity: equityLines,
    totalAssets,
    totalLiabilities,
    totalEquity,
    // A non-zero imbalance is a hard error in the books, not a rounding note.
    imbalance: totalAssets - (totalLiabilities + totalEquity),
    asOf: q.to,
  };
}

// ---------------------------------------------------------------------------
// Statement of cash flows (indirect method)
// ---------------------------------------------------------------------------

export interface CashFlowStatement {
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  openingCash: number;
  closingCash: number;
  reconciled: boolean;
}

/**
 * Cash flow, indirect method.
 *
 * Starting from net profit, working-capital movements are the change in
 * non-cash current assets/liabilities. `reconciled` asserts the derived
 * closing cash equals the cash accounts' actual balance — the statement is
 * only trustworthy if that holds, so it is returned rather than assumed.
 */
export function cashFlow(ledger: Ledger, q: LedgerQuery = {}): CashFlowStatement {
  const is = incomeStatement(ledger, q);
  const balances = accountBalances(ledger, q);

  // Opening balances = everything strictly before `from`.
  const opening = q.from ? accountBalances(ledger, { to: shiftDate(q.from, -1) }) : [];
  const openingMap = new Map(opening.map((b) => [b.account.code, b.balance] as const));

  let workingCapital = 0;
  for (const b of balances) {
    const isCurrentAsset =
      b.account.type === "asset" &&
      b.account.category === "Current assets" &&
      b.account.name !== "Cash" &&
      b.account.name !== "Bank";
    const isCurrentLiability = b.account.type === "liability" && b.account.category === "Current liabilities";
    if (isCurrentAsset) workingCapital -= b.balance - (openingMap.get(b.account.code) ?? 0);
    else if (isCurrentLiability) workingCapital += b.balance - (openingMap.get(b.account.code) ?? 0);
  }

  const investing = balances
    .filter((b) => b.account.type === "asset" && b.account.category === "Non-current assets")
    .reduce((s, b) => s - b.balance, 0);

  // Financing = non-current liability movements PLUS capital introduced.
  // Share capital is a financing INFLOW, not an operating item: a founder
  // injecting ₹10L raises cash without it appearing anywhere in the income
  // statement. Leaving equity out here is the classic cash-flow that refuses to
  // reconcile, so it is included explicitly.
  const financing =
    balances
      .filter((b) => b.account.type === "liability" && b.account.category === "Non-current liabilities")
      .reduce((s, b) => s - b.balance, 0) +
    balances.filter((b) => b.account.type === "equity").reduce((s, b) => s + b.balance, 0);

  const openingCash = opening
    .filter((b) => b.account.name === "Cash" || b.account.name === "Bank")
    .reduce((s, b) => s + b.balance, 0);

  const operating = is.netProfit + workingCapital;
  const netChange = operating + investing + financing;

  // Prefer the ledger's own cash balance as the authoritative closing figure.
  const ledgerClosingCash = balances
    .filter((b) => b.account.name === "Cash" || b.account.name === "Bank")
    .reduce((s, b) => s + b.balance, 0);
  const closingCash = openingCash + netChange;

  return {
    operating,
    investing,
    financing,
    netChange,
    openingCash,
    closingCash,
    reconciled: closingCash === ledgerClosingCash,
  };
}

/** Shift an ISO date by whole days (UTC-safe). */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Ledger construction helpers
// ---------------------------------------------------------------------------

/** Build a validated ledger from raw entries. Throws on the first bad entry. */
export function buildLedger(accounts: readonly Account[], entries: JournalEntry[]): Ledger {
  const validated = entries.map((e) => validateEntry(e, accounts));
  return { accounts, entries: validated };
}

/**
 * Convert a row of a double-entry CSV into a journal entry.
 *
 * Expects `date,account,narration,debit,credit` — the format every accounting
 * package exports — so a client can hand over their existing books rather than
 * re-keying them.
 */
export function entryFromCsvRow(
  row: { date: string; account: string; narration?: string; debit?: string; credit?: string },
  id: string,
): JournalLine {
  const debit = toMinorUnits(Number(row.debit ?? 0));
  const credit = toMinorUnits(Number(row.credit ?? 0));
  if (debit === 0 && credit === 0) {
    throw new AccountingError(`CSV row ${id} has neither a debit nor a credit amount.`);
  }
  if (debit !== 0 && credit !== 0) {
    throw new AccountingError(
      `CSV row ${id} has both a debit (${formatMinor(debit)}) and a credit (${formatMinor(credit)}) — use one or the other.`,
    );
  }
  return { accountCode: row.account, amount: debit !== 0 ? debit : -credit, narration: row.narration };
}
