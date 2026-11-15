/**
 * Busy Accounting & Marg ERP Connectors — parse exports
 */

import { parse } from "csv-parse/sync";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as XLSX from "xlsx";
import { parseStringPromise } from "xml2js";

import type { ColType, SqlValue } from "@/lib/types";

import type { BusyAccountingConfig, MargConfig } from "./config";
import { ConnectorError } from "./errors";

export interface VoucherRecord {
  voucher_date: string;
  voucher_type: string;
  voucher_number: string;
  ledger_name: string;
  debit_amount?: number;
  credit_amount?: number;
  narration?: string;
}

export async function parseBusyExport(filePath: string, _config: BusyAccountingConfig): Promise<VoucherRecord[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xml") return parseBusyXml(filePath);
  if (ext === ".csv") return parseGenericCsv(filePath, "busy");
  if (ext === ".xlsx" || ext === ".xls") return parseGenericExcel(filePath, "busy");
  throw new ConnectorError(`Unsupported Busy format: ${ext}`, { status: 400 });
}

export async function parseMargExport(filePath: string, _config: MargConfig): Promise<VoucherRecord[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xml") return parseMargXml(filePath);
  if (ext === ".csv") return parseGenericCsv(filePath, "marg");
  if (ext === ".xlsx" || ext === ".xls") return parseGenericExcel(filePath, "marg");
  throw new ConnectorError(`Unsupported Marg format: ${ext}`, { status: 400 });
}

async function parseBusyXml(filePath: string): Promise<VoucherRecord[]> {
  const xml = await fs.readFile(filePath, "utf-8");
  try {
    const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
    const records: VoucherRecord[] = [];
    const traverse = (obj: unknown): void => {
      if (obj && typeof obj === "object") {
        const node = obj as Record<string, unknown>;
        if (node.VoucherDate || node.voucherDate || node.Date) {
          records.push({
            voucher_date: normalizeDate(text(node.VoucherDate || node.voucherDate || node.Date)),
            voucher_type: text(node.VoucherType || node.voucherType),
            voucher_number: text(node.VoucherNo || node.voucherNo || node.Number),
            ledger_name: text(node.LedgerName || node.ledgerName || node.AccountName),
            debit_amount: parseFloat(text(node.Debit || node.Dr || "0")) || undefined,
            credit_amount: parseFloat(text(node.Credit || node.Cr || "0")) || undefined,
            narration: text(node.Narration || node.narration),
          });
          return;
        }
        for (const k in node) {
          if (Array.isArray(node[k])) {
            for (const item of node[k]) traverse(item);
          } else traverse(node[k]);
        }
      }
    };
    traverse(parsed);
    return records;
  } catch {
    throw new ConnectorError("Failed to parse Busy XML", { status: 400 });
  }
}

async function parseMargXml(filePath: string): Promise<VoucherRecord[]> {
  const xml = await fs.readFile(filePath, "utf-8");
  try {
    const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
    const records: VoucherRecord[] = [];
    const traverse = (obj: unknown): void => {
      if (obj && typeof obj === "object") {
        const node = obj as Record<string, unknown>;
        if (node.VCH_DATE || node.Date || node.date) {
          records.push({
            voucher_date: normalizeDate(text(node.VCH_DATE || node.Date || node.date)),
            voucher_type: text(node.VCH_TYPE || node.VchType),
            voucher_number: text(node.VCH_NO || node.VchNo),
            ledger_name: text(node.ACC_NAME || node.AccName || node.Ledger),
            debit_amount: parseFloat(text(node.DR_AMT || node.DrAmt || "0")) || undefined,
            credit_amount: parseFloat(text(node.CR_AMT || node.CrAmt || "0")) || undefined,
            narration: text(node.NARR || node.Narration),
          });
          return;
        }
        for (const k in node) {
          if (Array.isArray(node[k])) {
            for (const item of node[k]) traverse(item);
          } else traverse(node[k]);
        }
      }
    };
    traverse(parsed);
    return records;
  } catch {
    throw new ConnectorError("Failed to parse Marg XML", { status: 400 });
  }
}

async function parseGenericCsv(filePath: string, _kind: string): Promise<VoucherRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return records
    .map((r) => ({
      voucher_date: normalizeDate(r.voucher_date || r.Date || r.date || ""),
      voucher_type: r.voucher_type || r["Voucher Type"] || r.type || "",
      voucher_number: r.voucher_number || r["Voucher No"] || r.vch_no || "",
      ledger_name: r.ledger_name || r.Ledger || r.Account || r.account || "",
      debit_amount: parseFloat(r.debit_amount || r.Debit || r.Dr || "0") || undefined,
      credit_amount: parseFloat(r.credit_amount || r.Credit || r.Cr || "0") || undefined,
      narration: r.narration || r.Narration || r.Remarks || "",
    }))
    .filter((r) => r.voucher_date || r.voucher_number);
}

function parseGenericExcel(filePath: string, _kind: string): VoucherRecord[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  const records = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as Record<string, string>[];
  return records
    .map((r) => ({
      voucher_date: normalizeDate(r.voucher_date || r.Date || r.date || ""),
      voucher_type: r.voucher_type || r["Voucher Type"] || r.type || "",
      voucher_number: r.voucher_number || r["Voucher No"] || r.vch_no || "",
      ledger_name: r.ledger_name || r.Ledger || r.Account || r.account || "",
      debit_amount: parseFloat(r.debit_amount || r.Debit || r.Dr || "0") || undefined,
      credit_amount: parseFloat(r.credit_amount || r.Credit || r.Cr || "0") || undefined,
      narration: r.narration || r.Narration || r.Remarks || "",
    }))
    .filter((r) => r.voucher_date || r.voucher_number);
}

export function busyMargToRows(
  records: VoucherRecord[],
  kind: string,
): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns =
    kind === "marg"
      ? [
          { name: "date", type: "date" as ColType },
          { name: "vch_type", type: "string" as ColType },
          { name: "vch_no", type: "string" as ColType },
          { name: "acc_name", type: "string" as ColType },
          { name: "dr_amt", type: "number" as ColType },
          { name: "cr_amt", type: "number" as ColType },
          { name: "narr", type: "string" as ColType },
        ]
      : [
          { name: "voucher_date", type: "date" as ColType },
          { name: "voucher_type", type: "string" as ColType },
          { name: "voucher_number", type: "string" as ColType },
          { name: "ledger_name", type: "string" as ColType },
          { name: "debit_amount", type: "number" as ColType },
          { name: "credit_amount", type: "number" as ColType },
          { name: "narration", type: "string" as ColType },
        ];

  if (kind === "marg") {
    const rows = records.map((r) => [
      r.voucher_date,
      r.voucher_type,
      r.voucher_number,
      r.ledger_name,
      r.debit_amount || null,
      r.credit_amount || null,
      r.narration || null,
    ]);
    return { columns, rows };
  } else {
    const rows = records.map((r) => [
      r.voucher_date,
      r.voucher_type,
      r.voucher_number,
      r.ledger_name,
      r.debit_amount || null,
      r.credit_amount || null,
      r.narration || null,
    ]);
    return { columns, rows };
  }
}

/** Coerce a parsed XML/CSV scalar to a string ("" for null/undefined). */
function text(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function normalizeDate(d: string): string {
  if (!d) return "";
  d = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) {
    const [dd, mm, yyyy] = d.split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) {
    const [dd, mm, yyyy] = d.split("-");
    return `${yyyy}-${mm}-${dd}`;
  }
  return d;
}
