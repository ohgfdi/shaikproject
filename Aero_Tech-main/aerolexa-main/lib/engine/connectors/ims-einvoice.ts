/**
 * IMS/E-Invoice Connector — parses IMS and e-invoice data from JSON/XML/CSV exports.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseStringPromise } from "xml2js";

import type { ColType, SqlValue } from "@/lib/types";

import type { ImsEinvoiceConfig } from "./config";
import { ConnectorError } from "./errors";

export interface EinvoiceRecord {
  irn?: string;
  ack_no?: string;
  ack_date?: string;
  inv_no: string;
  inv_date: string;
  gstin_seller: string;
  gstin_buyer: string;
  taxable_value: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  total: number;
}

export async function parseImsEinvoice(filePath: string, _config: ImsEinvoiceConfig): Promise<EinvoiceRecord[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    return parseEinvoiceJson(filePath);
  } else if (ext === ".xml") {
    return parseEinvoiceXml(filePath);
  } else if (ext === ".csv") {
    return parseEinvoiceCsv(filePath);
  } else {
    throw new ConnectorError(`Unsupported IMS/e-invoice format: ${ext}. Supported: JSON, XML, CSV`, {
      status: 400,
      code: "EINVOICE_UNSUPPORTED_FORMAT",
    });
  }
}

async function parseEinvoiceJson(filePath: string): Promise<EinvoiceRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const data: unknown = JSON.parse(content);
  const records: EinvoiceRecord[] = [];

  // Handle different JSON structures
  if (Array.isArray(data)) {
    for (const item of data) {
      records.push(normalizeEinvoiceItem(item));
    }
  } else if (data && typeof data === "object" && ("invoices" in data || "data" in data)) {
    const envelope = data as Record<string, unknown>;
    const items = envelope.invoices ?? envelope.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        records.push(normalizeEinvoiceItem(item));
      }
    }
  } else {
    // Single record
    records.push(normalizeEinvoiceItem(data));
  }
  return records.filter((r) => r.inv_no && r.inv_date);
}

async function parseEinvoiceXml(filePath: string): Promise<EinvoiceRecord[]> {
  const xml = await fs.readFile(filePath, "utf-8");
  try {
    const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
    const records: EinvoiceRecord[] = [];
    // Basic XML parsing - traverse common structures
    const traverse = (obj: unknown): void => {
      if (obj && typeof obj === "object") {
        const node = obj as Record<string, unknown>;
        // Look for invoice patterns
        if (node.InvNo || node.invNo || node.invoiceNo) {
          records.push(normalizeEinvoiceItem(node));
          return;
        }
        for (const key in node) {
          if (Array.isArray(node[key])) {
            for (const item of node[key]) {
              traverse(item);
            }
          } else {
            traverse(node[key]);
          }
        }
      }
    };
    traverse(parsed);
    return records;
  } catch {
    throw new ConnectorError("Failed to parse e-invoice XML", { status: 400, code: "EINVOICE_PARSE_ERROR" });
  }
}

async function parseEinvoiceCsv(filePath: string): Promise<EinvoiceRecord[]> {
  const { parse } = await import("csv-parse/sync");
  const content = await fs.readFile(filePath, "utf-8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  return records.map((r) => normalizeEinvoiceItem(r)).filter((r) => r.inv_no && r.inv_date);
}

/** Read the first present key of a parsed JSON/XML/CSV row. */
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Coerce a parsed scalar to a string ("" for an absent value). */
function text(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Parse an amount that may carry thousands separators; 0 when unusable. */
function amount(v: unknown): number {
  return parseFloat(text(v).replace(/,/g, "")) || 0;
}

function normalizeEinvoiceItem(item: unknown): EinvoiceRecord {
  const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  return {
    irn: text(pick(row, ["irn", "IRN", "Irn"])) || undefined,
    ack_no: text(pick(row, ["ackNo", "ack_no", "Ack No"])) || undefined,
    ack_date: normalizeDate(text(pick(row, ["ackDate", "ack_date", "Ack Date"]))),
    inv_no: text(pick(row, ["invNo", "inv_no", "invoiceNo", "Invoice No", "invoice_number"])),
    inv_date: normalizeDate(text(pick(row, ["invDate", "inv_date", "Invoice Date", "invoice_date"]))),
    gstin_seller: text(pick(row, ["gstinSeller", "gstin_seller", "sellerGstin", "Seller GSTIN"])),
    gstin_buyer: text(pick(row, ["gstinBuyer", "gstin_buyer", "buyerGstin", "Buyer GSTIN"])),
    taxable_value: amount(pick(row, ["taxableValue", "taxable_value", "Taxable Value"]) ?? 0),
    igst: amount(pick(row, ["igst", "IGST", "IGST Amount"]) ?? 0) || undefined,
    cgst: amount(pick(row, ["cgst", "CGST", "CGST Amount"]) ?? 0) || undefined,
    sgst: amount(pick(row, ["sgst", "SGST", "SGST Amount"]) ?? 0) || undefined,
    cess: amount(pick(row, ["cess", "CESS"]) ?? 0) || undefined,
    total: amount(pick(row, ["total", "Total", "invoiceValue", "Total Value"]) ?? 0),
  };
}

export function einvoiceToRows(records: EinvoiceRecord[]): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns = [
    { name: "irn", type: "string" as ColType },
    { name: "ack_no", type: "string" as ColType },
    { name: "ack_date", type: "date" as ColType },
    { name: "inv_no", type: "string" as ColType },
    { name: "inv_date", type: "date" as ColType },
    { name: "gstin_seller", type: "string" as ColType },
    { name: "gstin_buyer", type: "string" as ColType },
    { name: "taxable_value", type: "number" as ColType },
    { name: "igst", type: "number" as ColType },
    { name: "cgst", type: "number" as ColType },
    { name: "sgst", type: "number" as ColType },
    { name: "cess", type: "number" as ColType },
    { name: "total", type: "number" as ColType },
  ];
  const rows = records.map((r) => [
    r.irn || null,
    r.ack_no || null,
    r.ack_date || null,
    r.inv_no,
    r.inv_date,
    r.gstin_seller,
    r.gstin_buyer,
    r.taxable_value,
    r.igst || null,
    r.cgst || null,
    r.sgst || null,
    r.cess || null,
    r.total,
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
