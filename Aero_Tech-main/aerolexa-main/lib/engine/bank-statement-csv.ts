/**
 * Bank-statement CSV parser for the reconciliation screen.
 *
 * A CA firm's beginner work starts with a statement downloaded from net-banking:
 * `date, narration, amount` with a debit/credit marker. This module turns that
 * text into the shape `POST /api/books/[id]/bank-feeds` (action
 * `bulk-transactions`) accepts, and reports every row it could not parse instead
 * of silently dropping it — a reconciliation that quietly ignores three lines is
 * worse than one that refuses.
 *
 * Sign convention: `BankTransactionInput.amount` is minor units where POSITIVE
 * is a credit to the bank account. A statement "Dr" (money leaving the account)
 * therefore becomes negative.
 */

export interface ParsedStatementRow {
  date: string;
  narration: string;
  /** Minor units (paise). Positive = credit to the bank account. */
  amount: number;
  reference: string | null;
}

export interface StatementParseError {
  /** 1-based line number in the input, counting the header. */
  line: number;
  message: string;
}

export interface StatementParseResult {
  rows: ParsedStatementRow[];
  errors: StatementParseError[];
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"' && line.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      out.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** `2026-03-31`, `31/03/2026`, `31-03-2026` → ISO. Anything else is null. */
export function normaliseStatementDate(raw: string): string | null {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : value;
  }
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (!match) return null;
  const [, d, m, y] = match;
  const day = Number(d);
  const month = Number(m);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export class StatementCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementCsvError";
  }
}

/**
 * Parse an amount cell into minor units, applying the Dr/Cr marker.
 * Accepts `1,234.50 Cr`, `Cr 1,234.50`, `-1234.50`, `(1234.50)` (bankers'
 * bracket notation) and a bare unsigned number (assumed a credit, as bank
 * statements list credits without a sign).
 */
export function parseStatementAmount(raw: string): number | null {
  let value = raw.trim();
  if (!value) return null;
  let sign = 1;

  const marker = /\b(dr|cr)\b\.?/i.exec(value);
  if (marker) {
    if ((marker[1] ?? "").toLowerCase() === "dr") sign = -1;
    value = value.replace(marker[0], "").trim();
  }

  if (/^\(.*\)$/.test(value)) {
    sign *= -1;
    value = value.slice(1, -1);
  }

  value = value.replace(/,/g, "").replace(/[₹\s]/g, "");
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(value)) return null;
  const rupees = Number.parseFloat(value);
  if (!Number.isFinite(rupees)) return null;
  // The sign already lives in the parsed number; `sign` only carries Dr/Cr and
  // bracket notation, so they must be multiplied once, never twice.
  return Math.round(rupees * 100) * sign;
}

/**
 * Parse a pasted/downloaded statement. Columns are `date, narration, amount`
 * with an optional fourth `reference`; a header row is detected and skipped.
 */
export function parseStatementCsv(text: string): StatementParseResult {
  const rows: ParsedStatementRow[] = [];
  const errors: StatementParseError[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!line.trim()) return;
    const cells = splitCsvLine(line);
    const [dateCell = "", narration = "", amountCell = "", reference = ""] = cells;
    if (index === 0 && /date/i.test(dateCell) && /amount|debit|credit/i.test(line)) return;
    if (cells.length < 3) {
      errors.push({ line: lineNo, message: "Expected date, narration and amount columns." });
      return;
    }
    const date = normaliseStatementDate(dateCell);
    if (!date) {
      errors.push({ line: lineNo, message: `“${dateCell}” is not a recognisable date.` });
      return;
    }
    if (!narration) {
      errors.push({ line: lineNo, message: "Narration is empty." });
      return;
    }
    const amount = parseStatementAmount(amountCell);
    if (amount === null) {
      errors.push({ line: lineNo, message: `“${amountCell}” is not a recognisable amount.` });
      return;
    }
    if (amount === 0) {
      errors.push({ line: lineNo, message: "A zero-value bank line carries no information." });
      return;
    }
    rows.push({ date, narration, amount, reference: reference || null });
  });

  return { rows, errors };
}
