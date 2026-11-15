/**
 * GST Connector — parses GST returns (GSTR-1, GSTR-2A, GSTR-2B, GSTR-3B)
 * from JSON/XML downloaded from the GST portal.
 *
 * These are file-based parsers for government portal exports.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseStringPromise } from "xml2js";

import type { ColType, SqlValue } from "@/lib/types";

import type { GstConfig } from "./config";
import { ConnectorError } from "./errors";

export interface Gstr1Invoice {
  gstin: string;
  fp: string; // financial period (YYYYMM)
  ctin: string; // counter-party GSTIN
  cfs: string; // counter-party state code
  inv: Gstr1InvoiceDetail[];
}

export interface Gstr1InvoiceDetail {
  num: string; // invoice number
  dt: string; // invoice date (DD-MM-YYYY)
  val: number; // invoice value
  pos: string; // place of supply (state code)
  rchrg: "Y" | "N"; // reverse charge
  inv_typ: string; // invoice type
  itms: Gstr1Item[];
}

export interface Gstr1Item {
  num: number; // item number
  itm_det: {
    txval: number; // taxable value
    rt: number; // tax rate
    iamtt: number; // IGST amount
    camtt: number; // CGST amount
    samtt: number; // SGST amount
    csamt: number; // cess amount
  };
}

export interface Gstr2aRecord {
  gstin: string;
  fp: string;
  b2b: Gstr2aB2bRecord[];
  b2ba: Gstr2aB2baRecord[]; // amendments
  cdn: Gstr2aCdnRecord[]; // credit/debit notes
  cdna: Gstr2aCdnaRecord[]; // CDN amendments
  nil: Gstr2aNilRecord[]; // nil rated
  nil_a: Gstr2aNilRecord[]; // nil amendments
  hsn: Gstr2aHsnRecord[]; // HSN summary
}

export interface Gstr2aB2bRecord {
  ctin: string; // supplier GSTIN
  cfs: string; // supplier state code
  cnm: string; // supplier name
  inv: Gstr2aInvoice[];
}

export interface Gstr2aInvoice {
  inum: string; // invoice number
  idt: string; // invoice date
  val: number; // invoice value
  pos: string; // place of supply
  rchrg: "Y" | "N";
  itms: Gstr2aItem[];
}

export interface Gstr2aItem {
  num: number;
  itm_det: {
    txval: number;
    rt: number;
    iamtt: number;
    camtt: number;
    samtt: number;
    csamt: number;
  };
}

export interface Gstr2aB2baRecord {
  ctin: string;
  cfs: string;
  inv: Gstr2aInvoice[];
}

export interface Gstr2aCdnRecord {
  ctin: string;
  cfs: string;
  ntnum: string; // note number
  ntdt: string; // note date
  val: number;
  typ: "C" | "D"; // Credit/Debit
  ntty: string; // note type
  itms: Gstr2aItem[];
}

export interface Gstr2aCdnaRecord {
  ctin: string;
  cfs: string;
  ntnum: string;
  ntdt: string;
  val: number;
  typ: "C" | "D";
  itms: Gstr2aItem[];
}

export interface Gstr2aNilRecord {
  sply_ty: string; // supply type
  txval: number; // taxable value
  iamtt: number; // IGST
  camtt: number; // CGST
  samtt: number; // SGST
  csamt: number; // cess
}

export interface Gstr2aHsnRecord {
  hsn: string; // HSN code
  desc: string; // description
  uqc: string; // unit quantity code
  qty: number; // quantity
  txval: number;
  iamtt: number;
  camtt: number;
  samtt: number;
  csamt: number;
}

export interface Gstr3bRecord {
  gstin: string;
  fp: string;
  "3.1": Gstr3bSection; // outward supplies
  "3.2": Gstr3bSection; // inward supplies liable to reverse charge
  "4": Gstr3bSection; // eligible ITC
  "5": Gstr3bSection; // exempt/nil/non-GST
  "5.1": Gstr3bSection; // interest/late fee
}

export interface Gstr3bSection {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  txval?: number;
}

/**
 * Parse a GST return file (JSON or XML) based on return type.
 */
export async function parseGstReturn(
  filePath: string,
  config: GstConfig,
): Promise<{
  invoices: GstInvoiceRow[];
  hsnSummary: GstHsnRow[];
  summary: GstSummaryRow[];
}> {
  const ext = path.extname(filePath).toLowerCase();
  const content = await fs.readFile(filePath, "utf-8");

  let parsed: unknown;
  if (ext === ".xml" || config.format === "xml") {
    parsed = await parseStringPromise(content, { explicitArray: false, ignoreAttrs: true, trim: true });
  } else {
    parsed = JSON.parse(content);
  }

  switch (config.returnType) {
    case "gstr1":
      return parseGstr1(parsed);
    case "gstr2a":
    case "gstr2b":
      return parseGstr2a(parsed);
    case "gstr3b":
      return parseGstr3b(parsed);
    default:
      throw new ConnectorError(`Unsupported GST return type: ${config.returnType}`, {
        status: 400,
        code: "GST_UNSUPPORTED_TYPE",
      });
  }
}

function parseGstr1(data: unknown): { invoices: GstInvoiceRow[]; hsnSummary: GstHsnRow[]; summary: GstSummaryRow[] } {
  const root = data as Record<string, unknown>;
  const invoices: GstInvoiceRow[] = [];
  const hsnSummary: GstHsnRow[] = [];
  const summary: GstSummaryRow[] = [];

  // GSTR-1 JSON structure varies; handle common formats
  const dataObj = (root.data ?? root.Data ?? root) as Record<string, unknown>;

  // Process B2B invoices
  processGstr1Section(dataObj.b2b, "B2B", invoices);
  processGstr1Section(dataObj.b2ba, "B2B Amendments", invoices);
  processGstr1Section(dataObj.b2cl, "B2CL", invoices);
  processGstr1Section(dataObj.b2cla, "B2CL Amendments", invoices);
  processGstr1Section(dataObj.b2cs, "B2CS", invoices);
  processGstr1Section(dataObj.b2csa, "B2CS Amendments", invoices);
  processGstr1Section(dataObj.cdnr, "CDN", invoices);
  processGstr1Section(dataObj.cdnra, "CDN Amendments", invoices);

  // HSN summary
  if (dataObj.hsn) {
    const hsnList = Array.isArray(dataObj.hsn) ? dataObj.hsn : [dataObj.hsn];
    for (const h of hsnList) {
      hsnSummary.push({
        hsn_code: String(h.hsn ?? h.HSN ?? ""),
        description: String(h.desc ?? h.Desc ?? ""),
        uqc: String(h.uqc ?? h.UQC ?? ""),
        quantity: Number(h.qty ?? h.Qty ?? 0),
        taxable_value: Number(h.txval ?? h.Txval ?? 0),
        igst: Number(h.iamtt ?? h.IAMT ?? 0),
        cgst: Number(h.camtt ?? h.CAMT ?? 0),
        sgst: Number(h.samtt ?? h.SAMT ?? 0),
        cess: Number(h.csamt ?? h.CSAMT ?? 0),
      });
    }
  }

  // Document summary
  if (dataObj.doc_issue || dataObj.docissue) {
    const rawDoc = dataObj.doc_issue ?? dataObj.docissue;
    const docList = (Array.isArray(rawDoc) ? rawDoc : [rawDoc]) as Record<string, unknown>[];
    for (const d of docList) {
      summary.push({
        doc_type: String(d.doc_type ?? d.DocType ?? ""),
        total_docs: Number(d.tot_docs ?? d.TotDocs ?? 0),
        cancelled: Number(d.cancelled ?? d.Cancelled ?? 0),
        net_issued: Number(d.net_issued ?? d.NetIssued ?? 0),
      });
    }
  }

  return { invoices, hsnSummary, summary };
}

function processGstr1Section(section: unknown, sectionName: string, invoices: GstInvoiceRow[]) {
  if (!section) return;
  const parties = Array.isArray(section) ? section : [section];
  for (const party of parties) {
    const ctin = String((party as Record<string, unknown>).ctin ?? (party as Record<string, unknown>).CTIN ?? "");
    const cfs = String((party as Record<string, unknown>).cfs ?? (party as Record<string, unknown>).CFS ?? "");
    const cnm = String((party as Record<string, unknown>).cnm ?? (party as Record<string, unknown>).CNM ?? "");
    const rawInv = (party as Record<string, unknown>).inv;
    const invoicesList = (Array.isArray(rawInv) ? rawInv : [rawInv]) as Record<string, unknown>[];

    for (const inv of invoicesList) {
      if (!inv) continue;
      const invObj = inv as Record<string, unknown>;
      const num = String(invObj.num ?? invObj.NUM ?? "");
      const dt = String(invObj.dt ?? invObj.DT ?? "");
      const val = Number(invObj.val ?? invObj.VAL ?? 0);
      const pos = String(invObj.pos ?? invObj.POS ?? "");
      const rchrg = String(invObj.rchrg ?? invObj.RCHRG ?? "N");
      const invTyp = String(invObj.inv_typ ?? invObj.InvTyp ?? "");

      const items = Array.isArray(invObj.itms) ? invObj.itms : [invObj.itms];
      for (const item of items) {
        const itemObj = item as Record<string, unknown>;
        const itmDet = itemObj.itm_det ?? itemObj.ITM_DET ?? {};
        const itmDetObj = itmDet as Record<string, unknown>;
        invoices.push({
          section: sectionName,
          supplier_gstin: ctin,
          supplier_state: cfs,
          supplier_name: cnm,
          invoice_number: num,
          invoice_date: normalizeGstDate(dt),
          invoice_value: val,
          place_of_supply: pos,
          reverse_charge: rchrg === "Y",
          invoice_type: invTyp,
          item_number: Number(itemObj.num ?? itemObj.NUM ?? 0),
          taxable_value: Number(itmDetObj.txval ?? itmDetObj.TXVAL ?? 0),
          tax_rate: Number(itmDetObj.rt ?? itmDetObj.RT ?? 0),
          igst: Number(itmDetObj.iamtt ?? itmDetObj.IAMT ?? 0),
          cgst: Number(itmDetObj.camtt ?? itmDetObj.CAMT ?? 0),
          sgst: Number(itmDetObj.samtt ?? itmDetObj.SAMT ?? 0),
          cess: Number(itmDetObj.csamt ?? itmDetObj.CSAMT ?? 0),
        });
      }
    }
  }
}

function parseGstr2a(data: unknown): { invoices: GstInvoiceRow[]; hsnSummary: GstHsnRow[]; summary: GstSummaryRow[] } {
  const invoices: GstInvoiceRow[] = [];
  const hsnSummary: GstHsnRow[] = [];
  const summary: GstSummaryRow[] = [];

  const dataObj = ((data as Record<string, unknown>).data ?? data) as Record<string, unknown>;

  // B2B invoices
  if (dataObj.b2b) processGstr2aB2b(dataObj.b2b, invoices);
  if (dataObj.b2ba) processGstr2aB2b(dataObj.b2ba, invoices);
  if (dataObj.cdn) processGstr2aCdn(dataObj.cdn, invoices);
  if (dataObj.cdna) processGstr2aCdn(dataObj.cdna, invoices);
  if (dataObj.nil) processGstr2aNil(dataObj.nil, summary);
  if (dataObj.nil_a) processGstr2aNil(dataObj.nil_a, summary);
  if (dataObj.hsn) processGstr2aHsn(dataObj.hsn, hsnSummary);

  return { invoices, hsnSummary, summary };
}

function processGstr2aB2b(section: unknown, invoices: GstInvoiceRow[]) {
  if (!section) return;
  const parties = Array.isArray(section) ? section : [section];
  for (const party of parties) {
    const p = party as Record<string, unknown>;
    const ctin = String(p.ctin ?? p.CTIN ?? "");
    const cfs = String(p.cfs ?? p.CFS ?? "");
    const cnm = String(p.cnm ?? p.CNM ?? "");
    const invoicesList = Array.isArray(p.inv) ? p.inv : [p.inv];
    for (const inv of invoicesList) {
      if (!inv) continue;
      const invObj = inv as Record<string, unknown>;
      const items = Array.isArray(invObj.itms) ? invObj.itms : [invObj.itms];
      for (const _item of items) {
        const itemObj = _item as Record<string, unknown>;
        const itmDet = (itemObj.itm_det ?? itemObj.ITM_DET ?? {}) as Record<string, unknown>;
        invoices.push({
          section: "B2B",
          supplier_gstin: ctin,
          supplier_state: cfs,
          supplier_name: cnm,
          invoice_number: String(invObj.inum ?? invObj.INUM ?? ""),
          invoice_date: normalizeGstDate(String(invObj.idt ?? invObj.IDT ?? "")),
          invoice_value: Number(invObj.val ?? invObj.VAL ?? 0),
          place_of_supply: String(invObj.pos ?? invObj.POS ?? ""),
          reverse_charge: String(invObj.rchrg ?? invObj.RCHRG ?? "N") === "Y",
          invoice_type: "",
          item_number: Number(itemObj.num ?? itemObj.NUM ?? 0),
          taxable_value: Number(
            (itemObj as Record<string, unknown>).txval ?? (itemObj as Record<string, unknown>).TXVAL ?? 0,
          ),
          tax_rate: Number((itemObj as Record<string, unknown>).rt ?? (itemObj as Record<string, unknown>).RT ?? 0),
          igst: Number(itmDet.iamtt ?? itmDet.IAMT ?? 0),
          cgst: Number(itmDet.camtt ?? itmDet.CAMT ?? 0),
          sgst: Number(itmDet.samtt ?? itmDet.SAMT ?? 0),
          cess: Number(itmDet.csamt ?? itmDet.CSAMT ?? 0),
        });
      }
    }
  }
}

function processGstr2aCdn(section: unknown, invoices: GstInvoiceRow[]) {
  if (!section) return;
  const parties = Array.isArray(section) ? section : [section];
  for (const party of parties) {
    const p = party as Record<string, unknown>;
    const items = Array.isArray(p.itms) ? p.itms : [p.itms];
    for (const item of items) {
      const itemObj = item as Record<string, unknown>;
      const itmDet = (itemObj.itm_det ?? itemObj.ITM_DET ?? {}) as Record<string, unknown>;
      invoices.push({
        section: "CDN",
        supplier_gstin: String(p.ctin ?? p.CTIN ?? ""),
        supplier_state: String(p.cfs ?? p.CFS ?? ""),
        supplier_name: "",
        invoice_number: String(p.ntnum ?? p.NTNUM ?? ""),
        invoice_date: normalizeGstDate(String(p.ntdt ?? p.NTDT ?? "")),
        invoice_value: Number(p.val ?? p.VAL ?? 0),
        place_of_supply: "",
        reverse_charge: false,
        invoice_type: String(p.typ ?? p.TYP ?? "") === "C" ? "Credit Note" : "Debit Note",
        item_number: Number(itemObj.num ?? itemObj.NUM ?? 0),
        taxable_value: Number(itmDet.txval ?? itmDet.TXVAL ?? 0),
        tax_rate: Number(itmDet.rt ?? itmDet.RT ?? 0),
        igst: Number(itmDet.iamtt ?? itmDet.IAMT ?? 0),
        cgst: Number(itmDet.camtt ?? itmDet.CAMT ?? 0),
        sgst: Number(itmDet.samtt ?? itmDet.SAMT ?? 0),
        cess: Number(itmDet.csamt ?? itmDet.CSAMT ?? 0),
      });
    }
  }
}

function processGstr2aNil(section: unknown, summary: GstSummaryRow[]) {
  if (!section) return;
  const items = Array.isArray(section) ? section : [section];
  for (const item of items) {
    const it = item as Record<string, unknown>;
    summary.push({
      supply_type: String(it.sply_ty ?? it.SPLY_TY ?? ""),
      taxable_value: Number(it.txval ?? it.TXVAL ?? 0),
      igst: Number(it.iamtt ?? it.IAMT ?? 0),
      cgst: Number(it.camtt ?? it.CAMT ?? 0),
      sgst: Number(it.samtt ?? it.SAMT ?? 0),
      cess: Number(it.csamt ?? it.CSAMT ?? 0),
    });
  }
}

function processGstr2aHsn(section: unknown, hsnSummary: GstHsnRow[]) {
  if (!section) return;
  const items = Array.isArray(section) ? section : [section];
  for (const item of items) {
    const h = item as Record<string, unknown>;
    hsnSummary.push({
      hsn_code: String(h.hsn ?? h.HSN ?? ""),
      description: String(h.desc ?? h.Desc ?? ""),
      uqc: String(h.uqc ?? h.UQC ?? ""),
      quantity: Number(h.qty ?? h.QTY ?? 0),
      taxable_value: Number(h.txval ?? h.TXVAL ?? 0),
      igst: Number(h.iamtt ?? h.IAMT ?? 0),
      cgst: Number(h.camtt ?? h.CAMT ?? 0),
      sgst: Number(h.samtt ?? h.SAMT ?? 0),
      cess: Number(h.csamt ?? h.CSAMT ?? 0),
    });
  }
}

function parseGstr3b(data: unknown): { invoices: GstInvoiceRow[]; hsnSummary: GstHsnRow[]; summary: GstSummaryRow[] } {
  const summary: GstSummaryRow[] = [];
  const dataObj = ((data as Record<string, unknown>).data ?? data) as Record<string, unknown>;

  const sections = ["3.1", "3.2", "4", "5", "5.1"] as const;
  for (const sec of sections) {
    const secData = dataObj[sec] as Record<string, unknown> | undefined;
    if (secData) {
      summary.push({
        section: sec,
        igst: Number(secData.igst ?? secData.IGST ?? 0),
        cgst: Number(secData.cgst ?? secData.CGST ?? 0),
        sgst: Number(secData.sgst ?? secData.SGST ?? 0),
        cess: Number(secData.cess ?? secData.CESS ?? 0),
        taxable_value: Number(secData.txval ?? secData.TXVAL ?? 0),
      });
    }
  }

  return { invoices: [], hsnSummary: [], summary };
}

function normalizeGstDate(dateStr: string): string {
  // GST dates are typically DD-MM-YYYY
  const cleaned = dateStr.trim().replace(/\//g, "-");
  const parts = cleaned.split("-");
  if (parts.length === 3) {
    const d = parts[0] ?? "";
    const m = parts[1] ?? "";
    const y = parts[2] ?? "";
    if (y.length === 4) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (d.length === 4) return `${d}-${m.padStart(2, "0")}-${y.padStart(2, "0")}`;
    return `20${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0] ?? dateStr;
  return dateStr;
}

export interface GstInvoiceRow {
  section: string;
  supplier_gstin: string;
  supplier_state: string;
  supplier_name: string;
  invoice_number: string;
  invoice_date: string;
  invoice_value: number;
  place_of_supply: string;
  reverse_charge: boolean;
  invoice_type: string;
  item_number: number;
  taxable_value: number;
  tax_rate: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface GstHsnRow {
  hsn_code: string;
  description: string;
  uqc: string;
  quantity: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface GstSummaryRow {
  section?: string;
  doc_type?: string;
  supply_type?: string;
  total_docs?: number;
  cancelled?: number;
  net_issued?: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  taxable_value?: number;
}

/**
 * Convert parsed GST data to standard column/row format.
 */
export function gstToRows(data: { invoices: GstInvoiceRow[]; hsnSummary: GstHsnRow[]; summary: GstSummaryRow[] }): {
  invoices: { columns: { name: string; type: ColType }[]; rows: SqlValue[][] };
  hsnSummary: { columns: { name: string; type: ColType }[]; rows: SqlValue[][] };
  summary: { columns: { name: string; type: ColType }[]; rows: SqlValue[][] };
} {
  const invoiceColumns: { name: string; type: ColType }[] = [
    { name: "section", type: "string" },
    { name: "supplier_gstin", type: "string" },
    { name: "supplier_state", type: "string" },
    { name: "supplier_name", type: "string" },
    { name: "invoice_number", type: "string" },
    { name: "invoice_date", type: "date" },
    { name: "invoice_value", type: "number" },
    { name: "place_of_supply", type: "string" },
    { name: "reverse_charge", type: "boolean" },
    { name: "invoice_type", type: "string" },
    { name: "item_number", type: "number" },
    { name: "taxable_value", type: "number" },
    { name: "tax_rate", type: "number" },
    { name: "igst", type: "number" },
    { name: "cgst", type: "number" },
    { name: "sgst", type: "number" },
    { name: "cess", type: "number" },
  ];

  const hsnColumns: { name: string; type: ColType }[] = [
    { name: "hsn_code", type: "string" },
    { name: "description", type: "string" },
    { name: "uqc", type: "string" },
    { name: "quantity", type: "number" },
    { name: "taxable_value", type: "number" },
    { name: "igst", type: "number" },
    { name: "cgst", type: "number" },
    { name: "sgst", type: "number" },
    { name: "cess", type: "number" },
  ];

  const summaryColumns: { name: string; type: ColType }[] = [
    { name: "section", type: "string" },
    { name: "doc_type", type: "string" },
    { name: "supply_type", type: "string" },
    { name: "total_docs", type: "number" },
    { name: "cancelled", type: "number" },
    { name: "net_issued", type: "number" },
    { name: "igst", type: "number" },
    { name: "cgst", type: "number" },
    { name: "sgst", type: "number" },
    { name: "cess", type: "number" },
    { name: "taxable_value", type: "number" },
  ];

  const invoiceRows: SqlValue[][] = data.invoices.map((inv) => [
    inv.section,
    inv.supplier_gstin,
    inv.supplier_state,
    inv.supplier_name,
    inv.invoice_number,
    inv.invoice_date,
    inv.invoice_value,
    inv.place_of_supply,
    inv.reverse_charge,
    inv.invoice_type,
    inv.item_number,
    inv.taxable_value,
    inv.tax_rate,
    inv.igst,
    inv.cgst,
    inv.sgst,
    inv.cess,
  ]);

  const hsnRows: SqlValue[][] = data.hsnSummary.map((h) => [
    h.hsn_code,
    h.description,
    h.uqc,
    h.quantity,
    h.taxable_value,
    h.igst,
    h.cgst,
    h.sgst,
    h.cess,
  ]);

  const summaryRows: SqlValue[][] = data.summary.map((s) => [
    s.section ?? null,
    s.doc_type ?? null,
    s.supply_type ?? null,
    s.total_docs ?? null,
    s.cancelled ?? null,
    s.net_issued ?? null,
    s.igst ?? null,
    s.cgst ?? null,
    s.sgst ?? null,
    s.cess ?? null,
    s.taxable_value ?? null,
  ]);

  return {
    invoices: { columns: invoiceColumns, rows: invoiceRows },
    hsnSummary: { columns: hsnColumns, rows: hsnRows },
    summary: { columns: summaryColumns, rows: summaryRows },
  };
}
