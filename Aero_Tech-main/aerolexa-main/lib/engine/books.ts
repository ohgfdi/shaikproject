/**
 * Books assembly — turn persisted book rows into an `accounting.ts` ledger.
 *
 * `accounting.ts` is pure arithmetic over an in-memory `Ledger`. This module is
 * the seam between that engine and storage: it takes the DB-shaped account and
 * voucher rows, folds opening balances into a single synthetic opening entry so
 * the debit=credit invariant still holds, and hands the result to
 * `buildLedger()`, which refuses to build unbalanced books.
 *
 * Why an opening entry rather than a per-account opening field: the trial
 * balance, income statement and balance sheet all derive from journals. An
 * opening balance that lives outside the journal is exactly how a ledger and a
 * trial balance silently disagree. Making it a dated entry keeps one source of
 * truth, and — because it is validated like every other entry — a set of
 * opening balances that does not sum to zero is reported, not hidden.
 *
 * Pure and deterministic: no clock, no randomness, no database. That is what
 * makes it oracle-testable.
 */

import {
  AccountingError,
  buildLedger,
  type Account,
  type AccountType,
  type JournalEntry,
  type Ledger,
  type LedgerQuery,
} from "./accounting";

export class BooksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BooksError";
  }
}

/** A chart-of-accounts row as stored. `openingBalance` is signed, positive = debit. */
export interface BookAccountRow {
  code: string;
  name: string;
  type: AccountType;
  category: string;
  description?: string | null;
  openingBalance?: number;
}

/** A voucher line. `amount` is signed minor units, positive = debit. */
export interface BookVoucherLineRow {
  accountCode: string;
  amount: number;
  narration?: string | null;
}

export interface BookVoucherRow {
  id: string;
  date: string;
  narration: string;
  reference?: string | null;
  lines: BookVoucherLineRow[];
}

/** The synthetic opening entry id/date, stable so tests and exports can name it. */
export const OPENING_ENTRY_ID = "__opening__";
export const OPENING_ENTRY_DATE = "0000-01-01";

/**
 * Assemble an accounting ledger from stored accounts and vouchers.
 *
 * Opening balances are folded into one opening entry dated before every real
 * voucher, so period reports (`from`/`to`) naturally exclude them from
 * profit-and-loss while the balance sheet still includes them.
 */
export function assembleLedger(accounts: BookAccountRow[], vouchers: BookVoucherRow[]): Ledger {
  const engineAccounts: Account[] = accounts.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type,
    category: a.category,
    description: a.description ?? undefined,
  }));

  const entries: JournalEntry[] = [];

  const openingLines = accounts
    .filter((a) => (a.openingBalance ?? 0) !== 0)
    .map((a) => ({ accountCode: a.code, amount: Math.round(a.openingBalance ?? 0), narration: "Opening balance" }));
  if (openingLines.length > 0) {
    entries.push({
      id: OPENING_ENTRY_ID,
      date: OPENING_ENTRY_DATE,
      narration: "Opening balances",
      lines: openingLines,
    });
  }

  for (const v of vouchers) {
    entries.push({
      id: v.id,
      date: v.date,
      narration: v.narration,
      reference: v.reference ?? undefined,
      lines: v.lines.map((l) => ({
        accountCode: l.accountCode,
        amount: Math.round(l.amount),
        narration: l.narration ?? undefined,
      })),
    });
  }

  try {
    return buildLedger(engineAccounts, entries);
  } catch (err) {
    if (err instanceof AccountingError) throw new BooksError(err.message);
    throw err;
  }
}

/** A single voucher flattened for the day book. */
export interface DayBookRow {
  id: string;
  date: string;
  narration: string;
  reference: string | null;
  debit: number;
  credit: number;
}

/** The day book: vouchers in date order within a range, with their total debit/credit. */
export function dayBook(vouchers: BookVoucherRow[], q: LedgerQuery = {}): DayBookRow[] {
  return vouchers
    .filter((v) => (!q.from || v.date >= q.from) && (!q.to || v.date <= q.to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((v) => {
      const debit = v.lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0);
      const credit = v.lines.reduce((s, l) => s + (l.amount < 0 ? -l.amount : 0), 0);
      return { id: v.id, date: v.date, narration: v.narration, reference: v.reference ?? null, debit, credit };
    });
}

/** A single posting against an account, with the running balance. */
export interface AccountLedgerRow {
  voucherId: string;
  date: string;
  narration: string;
  debit: number;
  credit: number;
  /** Running balance on the account's natural side. */
  balance: number;
}

/**
 * An account's ledger (statement) over a range, with a running natural-side
 * balance. The opening balance for the range is the account's opening amount
 * plus every prior posting, so a mid-year statement does not start at zero.
 */
export function accountLedger(ledger: Ledger, accountCode: string, q: LedgerQuery = {}): AccountLedgerRow[] {
  const account = ledger.accounts.find((a) => a.code === accountCode);
  if (!account) throw new BooksError(`Unknown account "${accountCode}".`);
  const debitNormal = account.type === "asset" || account.type === "expense";

  // Opening balance for the range: natural-side sum of everything strictly
  // before `from`. With no `from`, the range starts at the beginning of the
  // books, so the opening is zero and the main loop below includes everything.
  let opening = 0;
  if (q.from) {
    for (const entry of ledger.entries) {
      if (entry.date >= q.from) continue;
      for (const line of entry.lines) {
        if (line.accountCode !== accountCode) continue;
        opening += debitNormal ? line.amount : -line.amount;
      }
    }
  }

  const rows: AccountLedgerRow[] = [];
  let running = opening;
  for (const entry of ledger.entries) {
    if (q.from && entry.date < q.from) continue;
    if (q.to && entry.date > q.to) continue;
    for (const line of entry.lines) {
      if (line.accountCode !== accountCode) continue;
      running += debitNormal ? line.amount : -line.amount;
      rows.push({
        voucherId: entry.id,
        date: entry.date,
        narration: line.narration ?? entry.narration,
        debit: line.amount > 0 ? line.amount : 0,
        credit: line.amount < 0 ? -line.amount : 0,
        balance: running,
      });
    }
  }
  return rows;
}
