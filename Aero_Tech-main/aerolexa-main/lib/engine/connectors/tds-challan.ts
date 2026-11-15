/**
 * TDS Challan Connector — parses TDS challan data from CSV/Excel/JSON exports.
 */

import { parse } from "csv-parse/sync";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as XLSX from "xlsx";

import type { ColType, SqlValue } from "@/lib/types";

import type { TdsChallanConfig } from "./config";
import { ConnectorError } from "./errors";

export interface TdsChallanRecord {
  challan_serial: string;
  bsr_code: string;
  tan?: string;
  section?: string;
  amount: number;
  date_of_deposit: string;
  major_head?: string;
  minor_head?: string;
}

export async function parseTdsChallan(filePath: string, config: TdsChallanConfig): Promise<TdsChallanRecord[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".csv") {
    return parseTdsChallanCsv(filePath, config);
  } else if (ext === ".xlsx" || ext === ".xls") {
    return parseTdsChallanExcel(filePath, config);
  } else if (ext === ".json") {
    return parseTdsChallanJson(filePath);
  } else {
    throw new ConnectorError(`Unsupported TDS challan format: ${ext}. Supported: CSV, Excel, JSON`, {
      status: 400,
      code: "TDS_CHALLAN_UNSUPPORTED_FORMAT",
    });
  }
}

async function parseTdsChallanCsv(filePath: string, config: TdsChallanConfig): Promise<TdsChallanRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    from_line: config.skipRows + 1,
  }) as Record<string, string>[];

  return normalizeTdsChallanRecords(records);
}

function parseTdsChallanExcel(filePath: string, config: TdsChallanConfig): TdsChallanRecord[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ConnectorError("Excel file has no sheets");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new ConnectorError("Excel sheet not found");
  const records = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const sliced = records.slice(config.skipRows) as Record<string, string>[];
  return normalizeTdsChallanRecords(sliced);
}

async function parseTdsChallanJson(filePath: string): Promise<TdsChallanRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(content);
  if (Array.isArray(data)) {
    return normalizeTdsChallanRecords(data as Record<string, string>[]);
  }
  return [];
}

function normalizeTdsChallanRecords(records: Record<string, string>[]): TdsChallanRecord[] {
  const results: TdsChallanRecord[] = [];
  for (const row of records) {
    const challan_serial =
      row.challan_serial || row.ChallanSerial || row["Challan No"] || row["Challan No."] || row.challanNo || "";
    const bsr_code = row.bsr_code || row.BSRCode || row["BSR Code"] || row.bsr || "";
    const amount = parseFloat((row.amount || row.Amount || row["Amount (Rs.)"] || "0").replace(/,/g, "")) || 0;
    const date_of_deposit =
      row.date_of_deposit || row.DateOfDeposit || row["Date of Deposit"] || row.deposit_date || row.date || "";

    if (!challan_serial && !bsr_code) continue;

    results.push({
      challan_serial,
      bsr_code,
      tan: row.tan || row.TAN || undefined,
      section: row.section || row.Section || undefined,
      amount,
      date_of_deposit: normalizeDate(date_of_deposit),
      major_head: row.major_head || row.MajorHead || undefined,
      minor_head: row.minor_head || row.MinorHead || undefined,
    });
  }
  return results;
}

export function tdsChallanToRows(records: TdsChallanRecord[]): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns = [
    { name: "challan_serial", type: "string" as ColType },
    { name: "bsr_code", type: "string" as ColType },
    { name: "tan", type: "string" as ColType },
    { name: "section", type: "string" as ColType },
    { name: "amount", type: "number" as ColType },
    { name: "date_of_deposit", type: "date" as ColType },
    { name: "major_head", type: "string" as ColType },
    { name: "minor_head", type: "string" as ColType },
  ];
  const rows = records.map((r) => [
    r.challan_serial,
    r.bsr_code,
    r.tan || null,
    r.section || null,
    r.amount,
    r.date_of_deposit,
    r.major_head || null,
    r.minor_head || null,
  ]);
  return { columns, rows };
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
