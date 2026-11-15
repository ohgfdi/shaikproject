/**
 * TDS credit reconciliation — 26AS / AIS against the client's books.
 *
 * The job: the client's TDS receivable ledger says one thing, Form 26AS / AIS
 * says another, and the difference decides what can be claimed in the ITR. This
 * engine parses the statement export the client downloads, matches each credit
 * to a books entry, and states the amount that is unsupported, unclaimed or
 * short.
 *
 * WHAT THIS DOES NOT DO — it does not log into TRACES, it does not verify a
 * deductors' return, and it does not decide whether a credit is legally
 * available (e.g. a deductor default under s 205). It reconciles two sets of
 * rows the caller supplies. Portal export formats differ by release, so the
 * parser reports row-level warnings instead of silently dropping a row.
 *
 * Money is in MINOR UNITS (paise) as integers, matching the other CA engines.
 * Parsers accept RUPEES as printed by the portals and convert once at the
 * boundary.
 */

export class TdsReconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdsReconError";
  }
}

export type TdsSource = "26AS" | "AIS" | "TRACES" | "books";

/** One TDS/TCS credit line, normalised from either side. */
export interface TdsCreditRow {
  tan: string;
  deductorName: string | null;
  section: string;
  financialYear: string | null;
  quarter: string | null;
  /** yyyy-mm-dd when the credit is dated; null when the export omits it. */
  date: string | null;
  /** Gross amount paid/credited, paise. */
  amountPaid: number;
  /** TDS/TCS deducted, paise. */
  tds: number;
  /** TDS actually deposited per the statement, paise (portal rows only). */
  tdsDeposited: number | null;
  form: string | null;
  status: string | null;
  source: TdsSource;
}

export interface ParsedTdsRows {
  rows: TdsCreditRow[];
  warnings: string[];
}

export type TdsVerdict =
  | "matched"
  | "amount-mismatch"
  | "missing-in-books"
  | "missing-in-statement"
  | "duplicate-statement"
  | "duplicate-books";

export interface ReconciledTdsCredit {
  key: string;
  tan: string;
  deductorName: string | null;
  section: string;
  quarter: string | null;
  statement: TdsCreditRow | null;
  books: TdsCreditRow | null;
  /** books − statement TDS in paise; null when a side is missing. */
  difference: number | null;
  verdict: TdsVerdict;
  notes: string[];
}

export interface TdsReconTotals {
  statementTds: number;
  booksTds: number;
  /** Duplicate rows excluded from the usable figures. */
  duplicateStatementTds: number;
  duplicateBooksTds: number;
  /** Statement TDS with no books entry (credit not claimed). */
  unclaimedTds: number;
  /** Books TDS with no statement support (claim at risk). */
  unsupportedTds: number;
  /** On paired rows: books above statement. */
  excessClaimTds: number;
  /** On paired rows: books below statement. */
  shortClaimTds: number;
  /** Net books − statement across every row. */
  netDifference: number;
}

export interface TdsReconciliation {
  rows: ReconciledTdsCredit[];
  totals: TdsReconTotals;
  counts: Record<TdsVerdict, number>;
  warnings: string[];
  methodology: string[];
}

const DEFAULT_TOLERANCE = 100; // ₹1 in paise

// ---------------------------------------------------------------------------
// CSV / JSON parsing
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  tan: ["tan", "deductortan", "tanofdeductor", "deductor tan"],
  deductorName: ["deductorname", "nameofdeductor", "deductor", "deductor name", "name"],
  section: ["section", "tdssection", "sectionunderwhichdeducted", "section code"],
  financialYear: ["financialyear", "fy", "year"],
  quarter: ["quarter", "qtr"],
  date: ["date", "datededucted", "bookingdate", "transactiondate", "creditdate", "dateofcredit"],
  amountPaid: ["amountpaid", "amountcredited", "amountpaidcredited", "grossamount", "amount"],
  tds: ["taxdeducted", "tds", "tdsdeducted", "tax", "total tax deducted"],
  tdsDeposited: ["taxdeposited", "tdsdeposited", "deposited"],
  form: ["form", "returnform", "formtype"],
  status: ["status", "bookingstatus", "filingstatus"],
};

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row: Record<string, unknown>, field: keyof typeof HEADER_ALIASES): unknown {
  const wanted = (HEADER_ALIASES[field] ?? []).map(normaliseHeader);
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(normaliseHeader(key))) return value;
  }
  return undefined;
}

/** Parse a rupee amount as printed by the portals ("1,00,000.50", "₹ 500"). */
export function parseRupeesToPaise(raw: unknown): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new TdsReconError("Amount is not a finite number.");
    return Math.round(raw * 100);
  }
  if (raw === null || raw === undefined || raw === "") return 0;
  const cleaned = String(raw).replace(/[₹,\s]/g, "").replace(/[()]/g, "");
  const negative = /^\(.*\)$/.test(String(raw).trim());
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new TdsReconError(`Amount "${String(raw)}" is not a number.`);
  const paise = Math.round(Number(cleaned) * 100);
  return negative ? -paise : paise;
}

/** Accept dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd and ISO timestamps. */
export function parseCreditDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    return validDate(year, month, day) ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
  }
  return null;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function normaliseTan(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normaliseSection(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9()]/g, "");
}

function normaliseQuarter(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim().toUpperCase();
  const q = /^Q?([1-4])$/.exec(text);
  if (q) return `Q${q[1]}`;
  if (text.includes("APR") && text.includes("JUN")) return "Q1";
  if (text.includes("JUL") && text.includes("SEP")) return "Q2";
  if (text.includes("OCT") && text.includes("DEC")) return "Q3";
  if (text.includes("JAN") && text.includes("MAR")) return "Q4";
  return text;
}

function normaliseFy(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : null;
}

/** Minimal RFC-4180 CSV row splitter (quotes, escaped quotes, CRLF). */
function csvLines(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
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
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function rowFromObject(
  record: Record<string, unknown>,
  defaults: { tan?: unknown; deductorName?: unknown; section?: unknown; source: TdsSource },
  warnings: string[],
  lineLabel: string,
): TdsCreditRow | null {
  const tan = normaliseTan(pick(record, "tan") ?? defaults.tan);
  if (!tan) {
    warnings.push(`${lineLabel}: skipped — no deductor TAN.`);
    return null;
  }
  if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) {
    warnings.push(`${lineLabel}: TAN "${tan}" does not match the 10-character format. Check the export.`);
  }
  const section = normaliseSection(pick(record, "section") ?? defaults.section);
  if (!section) {
    warnings.push(`${lineLabel}: skipped — no TDS section.`);
    return null;
  }
  const date = parseCreditDate(pick(record, "date"));
  if (pick(record, "date") && !date) {
    warnings.push(`${lineLabel}: unreadable date "${String(pick(record, "date"))}" — kept with no date.`);
  }
  let amountPaid: number;
  let tds: number;
  try {
    amountPaid = parseRupeesToPaise(pick(record, "amountPaid"));
    tds = parseRupeesToPaise(pick(record, "tds"));
  } catch (err) {
    warnings.push(`${lineLabel}: skipped — ${err instanceof Error ? err.message : "unreadable amount"}.`);
    return null;
  }
  if (tds < 0 || amountPaid < 0) {
    warnings.push(`${lineLabel}: negative amount kept as a reversal — confirm it is a credit note.`);
  }
  const depositedRaw = pick(record, "tdsDeposited");
  let tdsDeposited: number | null = null;
  if (depositedRaw !== undefined && depositedRaw !== "") {
    try {
      tdsDeposited = parseRupeesToPaise(depositedRaw);
    } catch {
      warnings.push(`${lineLabel}: unreadable deposited amount — deposit check skipped.`);
    }
  }
  return {
    tan,
    deductorName: String(pick(record, "deductorName") ?? defaults.deductorName ?? "").trim() || null,
    section,
    financialYear: normaliseFy(pick(record, "financialYear")),
    quarter: normaliseQuarter(pick(record, "quarter")),
    date,
    amountPaid,
    tds,
    tdsDeposited,
    form: String(pick(record, "form") ?? "").trim() || null,
    status: String(pick(record, "status") ?? "").trim() || null,
    source: defaults.source,
  };
}

/** Parse the statement CSV (26AS / AIS / any header-compatible export). */
export function parseTdsCsv(text: string, source: TdsSource = "26AS"): ParsedTdsRows {
  const lines = csvLines(text.trim());
  if (lines.length === 0) throw new TdsReconError("The statement is empty.");
  const header = (lines[0] ?? []).map((h) => h.trim());
  const normalised = header.map(normaliseHeader);
  const hasTan = HEADER_ALIASES.tan.some((a) => normalised.includes(normaliseHeader(a)));
  const hasTds = HEADER_ALIASES.tds.some((a) => normalised.includes(normaliseHeader(a)));
  if (!hasTan || !hasTds) {
    throw new TdsReconError(
      "The CSV needs a deductor TAN column and a TDS/tax-deducted column. Map the export headers first.",
    );
  }

  const warnings: string[] = [];
  const rows: TdsCreditRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i] ?? [];
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });
    const row = rowFromObject(record, { source }, warnings, `Row ${i + 1}`);
    if (row) rows.push(row);
  }
  if (rows.length === 0) warnings.push("No usable statement rows were found.");
  return { rows, warnings };
}

/**
 * Parse JSON exports. Recognised shapes:
 *   - an array of credit rows;
 *   - `{ rows: [...] }` (or entries / data / records / transactions);
 *   - TRACES-style `{ deductors: [{ tan, name, entries: [...] }] }`;
 *   - AIS-style `{ tds_tcs: { tds: [...], tcs: [...] } }` (flattened).
 * A deductor wrapper's TAN/name is inherited by its entries.
 */
export function parseTdsJson(text: string, source: TdsSource = "26AS"): ParsedTdsRows {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TdsReconError("The JSON is not valid. Export it again from the portal, or paste CSV.");
  }
  const warnings: string[] = [];
  const rows: TdsCreditRow[] = [];

  const collect = (value: unknown, inherited: Record<string, unknown>, depth: number) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item, inherited, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;

    const selfTan = pick(record, "tan");
    const selfName = pick(record, "deductorName");
    const merged = { ...inherited, ...(selfTan ? { tan: selfTan } : {}), ...(selfName ? { deductorName: selfName } : {}) };

    if ((selfTan ?? inherited.tan) && pick(record, "tds") !== undefined) {
      const row = rowFromObject(record, { tan: merged.tan, deductorName: merged.deductorName as unknown, source }, warnings, `Row ${rows.length + 1}`);
      if (row) rows.push(row);
    }

    const nestedKeys = [
      "rows",
      "entries",
      "data",
      "records",
      "transactions",
      "deductors",
      "tds",
      "tcs",
      "tds_tcs",
      "tdsTcs",
      "statement",
    ];
    for (const [key, child] of Object.entries(record)) {
      if (nestedKeys.includes(key) || Array.isArray(child)) {
        collect(child, merged, depth + 1);
      }
    }
  };

  collect(parsed, {}, 0);
  if (rows.length === 0) warnings.push("No usable statement rows were found in the JSON.");
  return { rows, warnings };
}

/** Auto-detect JSON vs CSV and parse. */
export function parseTdsStatement(text: string, source: TdsSource = "26AS"): ParsedTdsRows {
  const trimmed = text.trim();
  if (!trimmed) throw new TdsReconError("Paste the statement export first.");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return parseTdsJson(trimmed, source);
  return parseTdsCsv(trimmed, source);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

const emptyCounts = (): Record<TdsVerdict, number> => ({
  matched: 0,
  "amount-mismatch": 0,
  "missing-in-books": 0,
  "missing-in-statement": 0,
  "duplicate-statement": 0,
  "duplicate-books": 0,
});

const keyOf = (row: TdsCreditRow) => `${row.tan}|${row.section}`;

function signature(row: TdsCreditRow): string {
  return `${keyOf(row)}|${row.quarter ?? "-"}|${row.date ?? "-"}|${row.tds}`;
}

function daysApart(a: string | null, b: string | null): number {
  if (!a || !b) return 3650;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.abs(ta - tb) / 86_400_000;
}

/**
 * Reconcile a statement export against the books extract.
 *
 * Matching is deterministic and one-to-one:
 *   1. identical duplicates within a side are set aside first;
 *   2. within a TAN + section bucket, pair the closest TDS amount within
 *      tolerance, preferring the same quarter, then the nearest date;
 *   3. remaining rows in the same bucket pair as `amount-mismatch` when their
 *      quarters agree (or both are absent), so a wrong rate is visible instead
 *      of being reported as two unrelated absences;
 *   4. whatever is left is missing on one side.
 */
export function reconcileTdsCredits(input: {
  statement: TdsCreditRow[];
  books: TdsCreditRow[];
  /** Paise tolerance for an exact TDS match (default ₹1). */
  tolerance?: number;
}): TdsReconciliation {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TdsReconError("Tolerance must be zero or more.");

  const warnings: string[] = [];
  const counts = emptyCounts();
  const rows: ReconciledTdsCredit[] = [];

  const dedupe = (side: TdsCreditRow[], verdict: TdsVerdict) => {
    const seen = new Set<string>();
    const unique: TdsCreditRow[] = [];
    for (const row of side) {
      const sig = signature(row);
      if (seen.has(sig)) {
        counts[verdict] += 1;
        rows.push({
          key: sig,
          tan: row.tan,
          deductorName: row.deductorName,
          section: row.section,
          quarter: row.quarter,
          statement: verdict === "duplicate-statement" ? row : null,
          books: verdict === "duplicate-books" ? row : null,
          difference: null,
          verdict,
          notes: ["Identical duplicate (same TAN, section, quarter, date and TDS) — ignored in the totals."],
        });
        continue;
      }
      seen.add(sig);
      unique.push(row);
    }
    return unique;
  };

  const statement = dedupe(input.statement, "duplicate-statement");
  const books = dedupe(input.books, "duplicate-books");

  const statementTds = input.statement.reduce((sum, r) => sum + r.tds, 0);
  const booksTds = input.books.reduce((sum, r) => sum + r.tds, 0);
  const duplicateStatementTds = input.statement
    .filter((r) => !statement.includes(r))
    .reduce((sum, r) => sum + r.tds, 0);
  const duplicateBooksTds = input.books.filter((r) => !books.includes(r)).reduce((sum, r) => sum + r.tds, 0);

  const buckets = new Map<string, { statement: TdsCreditRow[]; books: TdsCreditRow[] }>();
  const bucketFor = (key: string) => {
    const b = buckets.get(key) ?? { statement: [], books: [] };
    buckets.set(key, b);
    return b;
  };
  for (const row of statement) bucketFor(keyOf(row)).statement.push(row);
  for (const row of books) bucketFor(keyOf(row)).books.push(row);

  for (const [key, bucket] of buckets) {
    const booksSide = [...bucket.books];
    const usedBooks = new Set<TdsCreditRow>();
    const unmatchedStatement: TdsCreditRow[] = [];

    // Stage 2: closest amount within tolerance, same quarter preferred.
    for (const s of bucket.statement) {
      const candidates = booksSide.filter((b) => !usedBooks.has(b) && Math.abs(b.tds - s.tds) <= tolerance);
      const best = candidates.sort(
        (a, b) =>
          Number((a.quarter ?? "") !== (s.quarter ?? "")) - Number((b.quarter ?? "") !== (s.quarter ?? "")) ||
          daysApart(a.date, s.date) - daysApart(b.date, s.date) ||
          Math.abs(a.tds - s.tds) - Math.abs(b.tds - s.tds),
      )[0];
      if (!best) {
        unmatchedStatement.push(s);
        continue;
      }
      usedBooks.add(best);
      counts.matched += 1;
      rows.push({
        key,
        tan: s.tan,
        deductorName: s.deductorName ?? best.deductorName,
        section: s.section,
        quarter: s.quarter ?? best.quarter,
        statement: s,
        books: best,
        difference: best.tds - s.tds,
        verdict: "matched",
        notes: [],
      });
    }

    // Stage 3: same bucket and compatible quarter → amount mismatch.
    const remainingBooks = booksSide.filter((b) => !usedBooks.has(b));
    for (const s of unmatchedStatement) {
      const index = remainingBooks.findIndex(
        (b) => (b.quarter ?? null) === (s.quarter ?? null) || (b.quarter === null && s.quarter === null),
      );
      if (index === -1) continue;
      const [b] = remainingBooks.splice(index, 1);
      if (!b) continue;
      counts["amount-mismatch"] += 1;
      const diff = b.tds - s.tds;
      rows.push({
        key,
        tan: s.tan,
        deductorName: s.deductorName ?? b.deductorName,
        section: s.section,
        quarter: s.quarter ?? b.quarter,
        statement: s,
        books: b,
        difference: diff,
        verdict: "amount-mismatch",
        notes: [
          `TDS differs by ₹${Math.abs(diff / 100).toFixed(2)} (${diff > 0 ? "books higher" : "statement higher"}).`,
          ...(s.date && b.date && s.date !== b.date ? [`Dates differ: statement ${s.date}, books ${b.date}.`] : []),
        ],
      });
    }

    // Stage 4: leftovers are missing on one side.
    for (const s of unmatchedStatement) {
      if (rows.some((r) => r.statement === s)) continue;
      counts["missing-in-books"] += 1;
      rows.push({
        key,
        tan: s.tan,
        deductorName: s.deductorName,
        section: s.section,
        quarter: s.quarter,
        statement: s,
        books: null,
        difference: null,
        verdict: "missing-in-books",
        notes: ["In the statement but not in the books — credit not claimed unless posted."],
      });
    }
    for (const b of remainingBooks) {
      if (rows.some((r) => r.books === b)) continue;
      counts["missing-in-statement"] += 1;
      rows.push({
        key,
        tan: b.tan,
        deductorName: b.deductorName,
        section: b.section,
        quarter: b.quarter,
        statement: null,
        books: b,
        difference: null,
        verdict: "missing-in-statement",
        notes: ["In the books but not in the statement — the claim is unsupported until the deductor corrects its return."],
      });
    }
  }

  const sum = (verdict: TdsVerdict, side: "statement" | "books") =>
    rows
      .filter((r) => r.verdict === verdict)
      .reduce((total, r) => total + (r[side]?.tds ?? 0), 0);

  const totals: TdsReconTotals = {
    statementTds,
    booksTds,
    duplicateStatementTds,
    duplicateBooksTds,
    unclaimedTds: sum("missing-in-books", "statement"),
    unsupportedTds: sum("missing-in-statement", "books"),
    excessClaimTds: rows
      .filter((r) => r.verdict === "amount-mismatch" && (r.difference ?? 0) > 0)
      .reduce((t, r) => t + (r.difference ?? 0), 0),
    shortClaimTds: rows
      .filter((r) => r.verdict === "amount-mismatch" && (r.difference ?? 0) < 0)
      .reduce((t, r) => t + Math.abs(r.difference ?? 0), 0),
    netDifference: booksTds - statementTds,
  };

  if (counts["missing-in-statement"] > 0) {
    warnings.push(
      `${counts["missing-in-statement"]} books credit(s) are not in the statement. Do not claim them in the ITR until the deductor files/corrects its TDS return.`,
    );
  }
  if (counts["missing-in-books"] > 0) {
    warnings.push(
      `${counts["missing-in-books"]} statement credit(s) are missing from the books. Post them before computing the ITR refund.`,
    );
  }
  if (counts["amount-mismatch"] > 0) {
    warnings.push(`${counts["amount-mismatch"]} pair(s) have a TDS amount mismatch — check the rate applied and the deductor's correction.`);
  }
  const unfiledDeposit = statement.filter(
    (r) => r.tdsDeposited !== null && Math.abs(r.tdsDeposited - r.tds) > tolerance,
  );
  if (unfiledDeposit.length > 0) {
    warnings.push(
      `${unfiledDeposit.length} statement row(s) show TDS deducted but not deposited in full. Credit may not be available until the deductor deposits it.`,
    );
  }

  rows.sort((a, b) => a.tan.localeCompare(b.tan) || a.section.localeCompare(b.section) || (a.quarter ?? "").localeCompare(b.quarter ?? ""));

  return {
    rows,
    totals,
    counts,
    warnings,
    methodology: [
      "Rows are matched one-to-one within the same deductor TAN and TDS section.",
      `An exact match requires the TDS amounts to agree within the tolerance (default ₹${(DEFAULT_TOLERANCE / 100).toFixed(2)}); the same quarter is preferred, then the nearest date.`,
      "Remaining rows in the same TAN + section with the same quarter are reported as an amount mismatch rather than two absences.",
      "Duplicate rows (same TAN, section, quarter, date and TDS) are counted but excluded from the totals.",
      "Statement TDS without a books entry is unclaimed credit; books TDS without statement support is an unsupported claim.",
      "This reconciles supplied rows only: it does not log in to TRACES, verify the deductor's return, or opine on legal availability of credit.",
    ],
  };
}
