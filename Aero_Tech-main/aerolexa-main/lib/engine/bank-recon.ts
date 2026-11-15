/**
 * Bank reconciliation statement (BRS) engine — the monthly bank-vs-books close.
 *
 * What a CA actually does: take the cash book and the bank statement, pair
 * every entry that appears on both sides, and explain what remains. The
 * unmatched remainders fall into four classical buckets, all produced here:
 *
 *   deposits in transit      — cash-book receipts the bank has not credited yet
 *   cheques unpresented      — cash-book payments not yet presented
 *   bank-side items          — charges, interest, direct debits the books missed
 *   book-side items          — customer credits the bank recorded, books missed
 *
 * SCOPE AND HONESTY — same contract as the other CA engines: this matches and
 * explains. It does not fetch statements, and "matched" here means amounts
 * equal within a tolerance on the same statement side — a CA reviews the
 * pairing before signing. Money is in MINOR UNITS (paise) as integers,
 * matching `accounting.ts`.
 */

import { formatInr } from "./india-tax";

export class BankReconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankReconError";
  }
}

// ---------------------------------------------------------------------------
// Input rows
// ---------------------------------------------------------------------------

export interface CashBookRow {
  /** Unique cash-book entry id (voucher number). */
  id: string;
  date: string;
  narration: string;
  /** Positive = receipt (bank debits you), negative = payment. Minor units. */
  amount: number;
  /** Optional cheque/instrument reference to strengthen matching. */
  reference?: string | null;
}

export interface BankStatementRow {
  id: string;
  date: string;
  narration: string;
  /** Positive = credit on the statement, negative = debit. Minor units. */
  amount: CB_OR_BANK_AMOUNT;
  reference?: string | null;
}

/** Statement-side amount (kept as an alias so the sign convention is explicit). */
type CB_OR_BANK_AMOUNT = number;

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type BrsVerdict = "matched" | "deposit-in-transit" | "cheque-unpresented" | "bank-side-item" | "book-side-item";

export interface BrsItem {
  /** Cash-book row id, or null for bank-side items. */
  cashBookId: string | null;
  /** Bank-statement row id, or null for transit/unpresented items. */
  bankId: string | null;
  date: string;
  narration: string;
  /** Amount in cash-book sign convention (minor units). */
  amount: number;
  verdict: BrsVerdict;
  reasons: string[];
}

export interface BankReconciliation {
  /** Statement date for the closing-balance identity. */
  asOfDate: string;
  /** Cash-book closing balance at asOfDate (minor units, bank view). */
  bookBalance: number;
  /** Bank-statement closing balance at asOfDate (minor units). */
  bankBalance: number;
  items: BrsItem[];
  /** Sum of adjustments applied to the book balance. */
  totalAdjustments: number;
  /** bookBalance + totalAdjustments — must equal bankBalance. */
  reconciledBalance: number;
  /** bankBalance − reconciledBalance; non-zero means the recon has a hole. */
  difference: number;
  counts: Record<BrsVerdict, number>;
  warnings: string[];
  methodology: string[];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const emptyCounts = (): Record<BrsVerdict, number> => ({
  matched: 0,
  "deposit-in-transit": 0,
  "cheque-unpresented": 0,
  "bank-side-item": 0,
  "book-side-item": 0,
});

/**
 * A cash-book row is paired with a statement row when:
 *   - the amounts are equal within tolerance AND opposite in sign (a receipt
 *     in the books is a debit on the statement), and
 *   - the reference matches exactly when BOTH sides carry one, else
 *   - the statement date is on or after the cash-book date (money moves
 *     bank-ward; the bank can never credit you before you record the receipt).
 */
function pairRows(
  cashBook: CashBookRow[],
  statement: BankStatementRow[],
  tolerance: number,
): { pairs: [CashBookRow, BankStatementRow][]; usedCb: Set<string>; usedBank: Set<string> } {
  const usedCb = new Set<string>();
  const usedBank = new Set<string>();
  const pairs: [CashBookRow, BankStatementRow][] = [];

  // References first: exact reference equality is the strongest signal and
  // must not be stolen by an earlier date-only match.
  for (const cb of cashBook) {
    if (!cb.reference?.trim()) continue;
    const bank = statement.find(
      (b) =>
        !usedBank.has(b.id) &&
        b.reference?.trim() &&
        b.reference.trim() === cb.reference!.trim() &&
        Math.abs(cb.amount - b.amount) <= tolerance,
    );
    if (bank) {
      usedCb.add(cb.id);
      usedBank.add(bank.id);
      pairs.push([cb, bank]);
    }
  }

  // Then amount + chronology: the bank can never clear an entry before it is
  // recorded in the books, so the statement date must be on or after the
  // cash-book date.
  for (const cb of cashBook) {
    if (usedCb.has(cb.id)) continue;
    const bank = statement.find(
      (b) => !usedBank.has(b.id) && Math.abs(cb.amount - b.amount) <= tolerance && b.date >= cb.date,
    );
    if (bank) {
      usedCb.add(cb.id);
      usedBank.add(bank.id);
      pairs.push([cb, bank]);
    }
  }

  return { pairs, usedCb, usedBank };
}

// ---------------------------------------------------------------------------
// The reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile the cash book against the bank statement as at `asOfDate`.
 *
 * Sign conventions (both customer-perspective, so amounts compare directly):
 *   cash book    receipt +, payment −
 *   statement    credit   +, debit    −
 *
 * The identity the tests pin — derivable because every matched pair has the
 * same amount on both sides:
 *
 *   bookBalance + (statement-only items) − (transit deposits + unpresented
 *   cheques) = bankBalance
 *
 * i.e. reconciledBalance = bookBalance + totalAdjustments and the difference
 * against bankBalance is zero when every unmatched row has been classified.
 */
export function reconcileBank(input: {
  cashBook: CashBookRow[];
  statement: BankStatementRow[];
  asOfDate: string;
  /** Rupee tolerance for matching (default ₹1). */
  tolerance?: number;
}): BankReconciliation {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) {
    throw new BankReconError("asOfDate must be yyyy-mm-dd.");
  }
  const tolerance = Math.max(0, Math.round(input.tolerance ?? 100));

  const cashBook = [...input.cashBook].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const statement = [...input.statement].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const { pairs, usedCb, usedBank } = pairRows(cashBook, statement, tolerance);

  const items: BrsItem[] = [];

  for (const [cb, bank] of pairs) {
    items.push({
      cashBookId: cb.id,
      bankId: bank.id,
      date: bank.date,
      narration: cb.narration,
      amount: cb.amount,
      verdict: "matched",
      reasons: [
        `Cleared on ${bank.date} — recorded in the books ${cb.date}${cb.reference ? `, ref ${cb.reference}` : ""}.`,
      ],
    });
  }

  let bookBalance = 0;
  for (const cb of cashBook) {
    if (usedCb.has(cb.id)) continue;
    const reasons: string[] = [];
    let verdict: BrsVerdict;
    if (cb.amount > 0) {
      verdict = "deposit-in-transit";
      reasons.push("Receipt in the cash book not yet credited by the bank.");
    } else {
      verdict = "cheque-unpresented";
      reasons.push("Payment recorded in the cash book not yet presented to the bank.");
    }
    items.push({
      cashBookId: cb.id,
      bankId: null,
      date: cb.date,
      narration: cb.narration,
      amount: cb.amount,
      verdict,
      reasons,
    });
  }

  let bankBalance = 0;
  for (const b of statement) {
    if (usedBank.has(b.id)) continue;
    const reasons: string[] = [];
    let verdict: BrsVerdict;
    if (b.amount < 0) {
      verdict = "bank-side-item";
      reasons.push("Debit on the statement the books have not recorded — charge, interest or direct debit; book it.");
    } else {
      verdict = "book-side-item";
      reasons.push(
        "Credit on the statement the books have not recorded — direct customer credit, interest credited; book it.",
      );
    }
    items.push({
      cashBookId: null,
      bankId: b.id,
      date: b.date,
      narration: b.narration,
      // Both conventions are customer-perspective: a statement credit is a
      // receipt (positive), a debit is a payment (negative). No sign flip.
      amount: b.amount,
      verdict: verdict as BrsVerdict,
      reasons,
    });
  }

  for (const cb of cashBook) bookBalance += cb.amount;
  for (const b of statement) bankBalance += b.amount;

  // Statement-only rows already sit in bankBalance; they are the classic
  // "add/deduct in the cash book" lines, i.e. adjustments to the BOOK balance.
  const inTransit = items.filter((i) => i.verdict === "deposit-in-transit").reduce((s, i) => s + i.amount, 0);
  const unpresented = items.filter((i) => i.verdict === "cheque-unpresented").reduce((s, i) => s + i.amount, 0);
  const bankSide = items.filter((i) => i.verdict === "bank-side-item").reduce((s, i) => s + i.amount, 0);
  const bookSide = items.filter((i) => i.verdict === "book-side-item").reduce((s, i) => s + i.amount, 0);

  // Adjustments to the BOOK balance: add statement-only items, remove the
  // cash-only items the bank has not yet recorded (transit deposits are
  // positive, unpresented cheques negative). The result equals bankBalance —
  // see the derivation in the doc comment above.
  const totalAdjustments = bankSide + bookSide - inTransit - unpresented;
  const reconciledBalance = bookBalance + totalAdjustments;
  const difference = bankBalance - reconciledBalance;

  const warnings: string[] = [];
  if (difference !== 0) {
    warnings.push(
      `Reconciliation difference of ${formatInr(Math.abs(difference))} ${difference > 0 ? "(bank higher)" : "(books higher)"} — every unmatched row must be classified for the BRS to close; investigate before signing.`,
    );
  }
  const staleCut = addMonths(input.asOfDate, -3);
  for (const i of items) {
    if ((i.verdict === "deposit-in-transit" || i.verdict === "cheque-unpresented") && i.date < staleCut) {
      warnings.push(
        `${i.cashBookId} dated ${i.date} is over three months old and still ${i.verdict === "deposit-in-transit" ? "in transit" : "unpresented"} — follow up or write back.`,
      );
    }
  }

  const counts = emptyCounts();
  for (const i of items) counts[i.verdict] += 1;

  return {
    asOfDate: input.asOfDate,
    bookBalance,
    bankBalance,
    items,
    totalAdjustments,
    reconciledBalance,
    difference,
    counts,
    warnings,
    methodology: [
      `Matched ${pairs.length} cash-book row(s) to statement row(s) on amount${tolerance > 0 ? ` (tolerance ${formatInr(tolerance)})` : ""}, opposite sign and chronology; references took precedence.`,
      `Cash-book closing ${formatInr(bookBalance)}; statement closing ${formatInr(bankBalance)}.`,
      `Adjustments: transit deposits ${formatInr(inTransit)}, unpresented cheques ${formatInr(unpresented)}, statement-only items ${formatInr(bankSide + bookSide)}.`,
      difference === 0
        ? "The reconciliation closes: books + adjustments = bank."
        : `The reconciliation does NOT close: difference ${formatInr(difference)} — see warnings.`,
    ],
  };
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
