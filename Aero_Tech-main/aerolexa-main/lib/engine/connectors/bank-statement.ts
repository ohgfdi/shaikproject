/**
 * Bank Statement Connector — parses bank statements from CSV, Excel, or PDF
 * into standardized transaction rows.
 *
 * Supports major Indian banks (HDFC, ICICI, Axis, SBI, Kotak, Yes Bank, etc.)
 * with auto-detection of column mappings.
 */

import { parse } from "csv-parse/sync";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import * as XLSX from "xlsx";

import type { ColType, SqlValue } from "@/lib/types";

import type { BankStatementConfig } from "./config";
import { ConnectorError } from "./errors";

export interface BankTransaction {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  reference?: string;
  category?: string;
}

/** Known bank column patterns for auto-detection. */
const BANK_PATTERNS: Record<
  string,
  {
    date: RegExp[];
    description: RegExp[];
    debit: RegExp[];
    credit: RegExp[];
    balance: RegExp[];
    reference?: RegExp[];
  }
> = {
  hdfc: {
    date: [/date/i, /tran\s*date/i, /value\s*date/i],
    description: [/narration/i, /description/i, /particulars/i, /remarks/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i, /amount\s*dr/i],
    credit: [/credit/i, /deposit/i, /cr\./i, /amount\s*cr/i],
    balance: [/balance/i, /closing\s*balance/i, /running\s*balance/i],
    reference: [/ref/i, /cheque/i, /chq/i, /utr/i, /transaction\s*id/i],
  },
  icici: {
    date: [/date/i, /transaction\s*date/i, /value\s*date/i],
    description: [/description/i, /narration/i, /particulars/i, /remarks/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i],
    credit: [/credit/i, /deposit/i, /cr\./i],
    balance: [/balance/i, /closing\s*balance/i],
    reference: [/ref/i, /cheque/i, /utr/i, /ref\s*no/i],
  },
  axis: {
    date: [/date/i, /tran\s*date/i, /value\s*date/i],
    description: [/description/i, /narration/i, /particulars/i, /remarks/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i],
    credit: [/credit/i, /deposit/i, /cr\./i],
    balance: [/balance/i, /closing\s*balance/i],
    reference: [/ref/i, /cheque/i, /utr/i],
  },
  sbi: {
    date: [/date/i, /tran\s*date/i, /post\s*date/i],
    description: [/description/i, /narration/i, /particulars/i, /remarks/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i],
    credit: [/credit/i, /deposit/i, /cr\./i],
    balance: [/balance/i, /closing\s*balance/i],
    reference: [/ref/i, /cheque/i, /utr/i],
  },
  kotak: {
    date: [/date/i, /tran\s*date/i],
    description: [/description/i, /narration/i, /particulars/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i],
    credit: [/credit/i, /deposit/i, /cr\./i],
    balance: [/balance/i, /closing\s*balance/i],
    reference: [/ref/i, /cheque/i, /utr/i],
  },
  yes: {
    date: [/date/i, /tran\s*date/i],
    description: [/description/i, /narration/i, /particulars/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i],
    credit: [/credit/i, /deposit/i, /cr\./i],
    balance: [/balance/i, /closing\s*balance/i],
    reference: [/ref/i, /cheque/i, /utr/i],
  },
  generic: {
    date: [/date/i, /tran\s*date/i, /value\s*date/i, /posting\s*date/i],
    description: [/description/i, /narration/i, /particulars/i, /remarks/i, /details/i],
    debit: [/debit/i, /withdrawal/i, /dr\./i, /amount\s*dr/i, /withdrawal\s*amt/i],
    credit: [/credit/i, /deposit/i, /cr\./i, /amount\s*cr/i, /deposit\s*amt/i],
    balance: [/balance/i, /closing\s*balance/i, /running\s*balance/i, /available\s*balance/i],
    reference: [/ref/i, /cheque/i, /utr/i, /ref\s*no/i, /transaction\s*id/i],
  },
};

/**
 * Parse a bank statement file (CSV, Excel, or PDF) into transactions.
 */
export async function parseBankStatement(filePath: string, config: BankStatementConfig): Promise<BankTransaction[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".csv") {
    return parseBankCsv(filePath, config);
  } else if (ext === ".xlsx" || ext === ".xls") {
    return parseBankExcel(filePath, config);
  } else if (ext === ".pdf") {
    return parseBankPdf(filePath, config);
  } else {
    throw new ConnectorError(`Unsupported bank statement format: ${ext}. Supported: CSV, Excel, PDF`, {
      status: 400,
      code: "BANK_UNSUPPORTED_FORMAT",
    });
  }
}

/** Parse CSV bank statement. */
async function parseBankCsv(filePath: string, config: BankStatementConfig): Promise<BankTransaction[]> {
  const content = await fs.readFile(filePath, config.encoding as BufferEncoding);
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
    from_line: config.skipRows + 1,
  }) as Record<string, string>[];

  return normalizeBankRecords(records, config);
}

/** Parse Excel bank statement. */
function parseBankExcel(filePath: string, config: BankStatementConfig): BankTransaction[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ConnectorError("Excel file has no sheets", {
      status: 400,
      code: "BANK_EMPTY_EXCEL",
    });
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new ConnectorError("Excel sheet not found", {
      status: 400,
      code: "BANK_SHEET_NOT_FOUND",
    });
  }
  const records = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

  // Skip header rows
  const sliced = records.slice(config.skipRows) as Record<string, string>[];
  return normalizeBankRecords(sliced, config);
}

/**
 * Parse a PDF bank statement (ROADMAP follow-up to the documented caveat).
 *
 * Text-layer extraction without a native dependency: PDF content streams are
 * FlateDecode-compressed, and text operators are ASCII/UTF-16 fragments in
 * `Tj` / `TJ` arrays. This parser decompresses every stream, harvests those
 * strings, then reconstructs rows by grouping tokens that start with a date.
 * Scanned statements (no text layer, image-only) are detected and reported
 * honestly — OCR is a different product, and a silent empty result would be
 * worse than a clear error.
 *
 * Column detection reuses the shared `normalizeBankRecords` heuristics by
 * mapping the reconstructed rows through a synthetic header, so CSV / Excel
 * / PDF all produce identically-shaped transactions.
 */
async function parseBankPdf(filePath: string, config: BankStatementConfig): Promise<BankTransaction[]> {
  const data = await fs.readFile(filePath);
  const text = extractPdfText(data);
  if (text.length === 0) {
    throw new ConnectorError(
      "The PDF has no extractable text layer. What happened: this is a scanned statement (images only). How to fix: export the statement as CSV/Excel from your bank's portal, or run it through an OCR tool first.",
      { status: 400, code: "BANK_PDF_NO_TEXT" },
    );
  }
  const rows = pdfTextToRows(text);
  if (rows.length === 0) {
    throw new ConnectorError(
      "No transaction rows could be read from the PDF text. What happened: the statement's layout is not a recognizable table of dated rows. How to fix: export as CSV/Excel from your bank's portal for a lossless import.",
      { status: 400, code: "BANK_PDF_NO_ROWS" },
    );
  }

  // Reuse the exact CSV normalization path: rows become records under a
  // synthetic header, then the bank-pattern auto-detection does the mapping.
  const header: Record<string, string> = { date: "", description: "", debit: "", credit: "", balance: "" };
  const records = rows.map((r) => ({
    date: r[0] ?? "",
    description: r[1] ?? "",
    debit: r[2] ?? "",
    credit: r[3] ?? "",
    balance: r[4] ?? "",
  }));
  const first = records[0] ?? header;
  void first;
  return normalizeBankRecords(records, config);
}

/**
 * Harvest text strings from a PDF's content streams.
 * Decompresses FlateDecode streams and extracts Tj/TJ string operators.
 */
export function extractPdfText(data: Buffer): string {
  const chunks: string[] = [];
  const raw = data.toString("latin1");

  // Every `stream ... endstream` block that is Flate-compressed.
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const body = Buffer.from(match[1]!, "latin1");
    let content: string;
    try {
      content = inflateSync(body).toString("latin1");
    } catch {
      try {
        content = inflateRawSync(body).toString("latin1");
      } catch {
        continue; // not zlib data (fonts, images) — skip
      }
    }
    if (!/Tj|TJ/.test(content)) continue;
    chunks.push(content);
  }

  // A raw (uncompressed) fallback keeps trivial PDFs working.
  if (/Tj|TJ/.test(raw) && chunks.length === 0) chunks.push(raw);
  if (chunks.length === 0) return "";

  const out: string[] = [];
  for (const content of chunks) {
    // (string) Tj  and  [(s1) num (s2)] TJ — capture the parenthesized parts.
    const tjRe = /\((?:\\.|[^()\\])*\)/g;
    for (const m of content.matchAll(tjRe)) {
      const s = m[0]
        .slice(1, -1)
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ");
      if (s.trim() !== "") out.push(s);
    }
  }
  return out.join("\n");
}

/** Tokens that begin a transaction row: dates in the common Indian-bank formats. */
const PDF_DATE_RE = /^\d{1,2}[-/. ]\d{1,2}[-/. ]\d{2,4}\b|^\d{4}-\d{2}-\d{2}\b|^\d{1,2}[ -][A-Za-z]{3,9}[ -]\d{2,4}\b/;

/**
 * Reconstruct transaction rows from harvested PDF text: a new row starts at
 * each date token; amounts and references are pulled from the row's tail;
 * the description is the non-numeric middle.
 */
export function pdfTextToRows(text: string): string[][] {
  const tokens = text
    .split("\n")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t !== "");
  const rows: string[][] = [];
  let current: string[] | null = null;

  for (const token of tokens) {
    if (PDF_DATE_RE.test(token)) {
      if (current) rows.push(current);
      current = [token];
      continue;
    }
    if (current) current.push(token);
  }
  if (current) rows.push(current);

  const out: string[][] = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    // Amounts: signed or comma-grouped numbers in the row's tokens (tail-first).
    const amounts: number[] = [];
    const descParts: string[] = [];
    for (let i = 1; i < row.length; i++) {
      const t = row[i]!;
      const cleaned = t.replace(/[₹,\s]/g, "");
      if (/^-?\d+(\.\d{1,2})?$/.test(cleaned) && cleaned.length > 0) {
        const n = Number(cleaned);
        if (Number.isFinite(n)) {
          amounts.push(n);
          continue;
        }
      }
      if (t.length > 1 && !/^(Cr|Dr|INR|IN)$/i.test(t)) descParts.push(t);
    }
    if (amounts.length === 0) continue;

    // Layouts: [date, desc..., debit, credit, balance] (3 amounts) or
    // [date, desc..., amount, balance] (2 amounts, sign decides debit/credit).
    let debit = 0;
    let credit = 0;
    let balance = 0;
    if (amounts.length >= 3) {
      balance = amounts[amounts.length - 1]!;
      debit = amounts[amounts.length - 3]!;
      credit = amounts[amounts.length - 2]!;
    } else if (amounts.length === 2) {
      const amt = amounts[0]!;
      balance = amounts[1]!;
      if (amt < 0) debit = Math.abs(amt);
      else credit = amt;
    } else {
      const amt = amounts[0]!;
      if (amt < 0) debit = Math.abs(amt);
      else credit = amt;
    }
    out.push([row[0]!, descParts.join(" ").slice(0, 200), String(debit), String(credit), String(balance)]);
  }
  return out;
}

/** Normalize raw records to BankTransaction using config hints + auto-detection. */
function normalizeBankRecords(records: Record<string, string>[], config: BankStatementConfig): BankTransaction[] {
  if (records.length === 0) return [];

  // Detect bank from filename or config
  const bankKey = detectBank(config.bank);
  const patterns = (BANK_PATTERNS[bankKey] ?? BANK_PATTERNS.generic)!;

  // Map columns using config hints or auto-detection
  const firstRecord = records[0];
  if (!firstRecord) return [];
  const columns = detectColumns(firstRecord, patterns, config);

  const transactions: BankTransaction[] = [];

  for (const row of records) {
    const tx = mapRowToTransaction(row, columns, config);
    if (tx) transactions.push(tx);
  }

  // Sort by date
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return transactions;
}

function detectBank(bankHint: string | undefined): string {
  if (!bankHint) return "generic";
  const hint = bankHint.toLowerCase();
  for (const key of Object.keys(BANK_PATTERNS)) {
    if (hint.includes(key)) return key;
  }
  return "generic";
}

function detectColumns(
  header: Record<string, string>,
  patterns: NonNullable<(typeof BANK_PATTERNS)[string]>,
  config: BankStatementConfig,
): {
  date: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
  reference?: string;
} {
  const keys = Object.keys(header);
  const _lowerKeys = keys.map((k) => k.toLowerCase());

  const findColumn = (regexes: RegExp[], hint?: string): string | undefined => {
    if (hint) {
      const hintKey = keys.find((k) => k.toLowerCase() === hint.toLowerCase());
      if (hintKey) return hintKey;
    }
    for (const regex of regexes) {
      const found = keys.find((k) => regex.test(k));
      if (found) return found;
    }
    return undefined;
  };

  const firstKey = keys[0] ?? "";
  const secondKey = keys[1] ?? "";

  return {
    date: findColumn(patterns.date, config.dateColumn) ?? firstKey,
    description: findColumn(patterns.description, config.descriptionColumn) ?? secondKey ?? "",
    debit: findColumn(patterns.debit, config.debitColumn) ?? "",
    credit: findColumn(patterns.credit, config.creditColumn) ?? "",
    balance: findColumn(patterns.balance, config.balanceColumn) ?? "",
    reference: findColumn(patterns.reference ?? [], config.referenceColumn) ?? undefined,
  };
}

function mapRowToTransaction(
  row: Record<string, string>,
  columns: ReturnType<typeof detectColumns>,
  config: BankStatementConfig,
): BankTransaction | null {
  const dateStr = row[columns.date] ?? "";
  const description = row[columns.description] ?? "";
  const debitStr = columns.debit ? (row[columns.debit] ?? "0") : "0";
  const creditStr = columns.credit ? (row[columns.credit] ?? "0") : "0";
  const balanceStr = row[columns.balance] ?? "0";
  const reference = columns.reference ? row[columns.reference] : undefined;

  if (!dateStr || (!description && !config.debitColumn && !config.creditColumn)) {
    return null;
  }

  const date = normalizeBankDate(dateStr);
  const debit = parseAmount(debitStr);
  const credit = parseAmount(creditStr);
  const balance = parseAmount(balanceStr);

  if (!isFinite(debit) && !isFinite(credit)) return null;

  return {
    date,
    description: description.trim(),
    debit,
    credit,
    balance,
    reference: reference?.trim(),
  };
}

function parseAmount(str: string): number {
  if (!str) return 0;
  // Handle Indian number formats: 1,23,456.78 or 1,23,456 or (1,234.56)
  const cleaned = str
    .replace(/[₹,\s]/g, "")
    .replace(/\((.*)\)/, "-$1") // (123.45) -> -123.45
    .trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function normalizeBankDate(dateStr: string): string {
  if (!dateStr) return "";
  const cleaned = dateStr.trim().replace(/\//g, "-").replace(/\./g, "-");

  // Handle DD-MM-YYYY, DD-MM-YY, YYYY-MM-DD, DD-MMM-YYYY
  const parts = cleaned.split("-");
  if (parts.length === 3) {
    const a = parts[0] ?? "";
    const b = parts[1] ?? "";
    const c = parts[2] ?? "";
    if (c.length === 4) return `${c}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`; // DD-MM-YYYY
    if (a.length === 4) return `${a}-${b.padStart(2, "0")}-${c.padStart(2, "0")}`; // YYYY-MM-DD
    if (c.length === 2) return `20${c}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`; // DD-MM-YY
  }

  // Try parsing as ISO or other formats
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0] ?? dateStr;

  return dateStr;
}

/**
 * Convert transactions to standard column/row format.
 */
export function bankToRows(transactions: BankTransaction[]): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns: { name: string; type: ColType }[] = [
    { name: "date", type: "date" },
    { name: "description", type: "string" },
    { name: "debit", type: "number" },
    { name: "credit", type: "number" },
    { name: "balance", type: "number" },
    { name: "reference", type: "string" },
    { name: "category", type: "string" },
  ];

  const rows: SqlValue[][] = transactions.map((tx) => [
    tx.date,
    tx.description,
    tx.debit,
    tx.credit,
    tx.balance,
    tx.reference ?? null,
    tx.category ?? null,
  ]);

  return { columns, rows };
}
