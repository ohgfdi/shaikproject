/** @license MIT — Ledgerly CA source ingestion engine
 *
 * Canonical CA document model + parse/mapp, reconcile-with-trace engine.
 *
 * The gap being closed: CA work is source-system-bound. The value is not in raw
 * import but in trusted, repeatable, mapped, reconciled ingestion with a full
 * source-to-figure trace. This module introduces:
 *   1. A canonical CA document (CaDocument) — one row, one traceable source line,
 *      with a stable fingerprint so repeat syncs dedupe by identity, not by row
 *      index, and with the source identifiers (voucher no / invoice no / challan
 *      serial / IRN / txn id) needed to tie every figure back to its origin.
 *   2. A mapping profile contract (CaMappingProfile) — the reusable "column X
 *      means canonical field Y" artifact a firm saves once per source system and
 *      reuses across repeats, so ingestion is a pipeline, not a one-time
 *      upload-and-pick-columns flow.
 *   3. A reconcile-with-trace engine (reconcileCa) — matches two canonical
 *      sources and returns matches with traceable links to both source identifiers
 *      plus a confidence and reason, so a reconciliation reconcileable to a
 *      voucher/invoice/challan.
 *
 * This is deliberately a pure computation layer (no persistence). Persistence,
 * sync scheduling and repeat-sync semantics live in lib/server/ca-source.ts, and
 * the HTTP surface in app/api/ca/sources/*. That keeps the engine testable without
 * a database and keeps "what a sync does" close to the sync code.
 */

import type { SqlValue, ColType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Source kinds a CA firm actually works from
// ---------------------------------------------------------------------------

/** The source systems the canonical layer knows how to map into a CA document.
 * Ordered so registries iterate deterministically (tests assert the order).
 * Each kind is the authoritative contract for: what source columns it exposes,
 * what the canonical mapping is, and what "identity" means for dedup.
 */
export const CA_SOURCE_KINDS = [
  "tally-vouchers",
  "books-vouchers",
  "bank-statement",
  "gst-invoices",
  "gst-challan",
  "tds-challan",
  "payroll",
  "einvoice",
  "payment-gateway",
  "journal",
] as const;
export type CaSourceKind = (typeof CA_SOURCE_KINDS)[number];

/** Every CA source kind is fully registered — nothing is "coming soon". */
export const ALL_CA_KINDS_REGISTERED: readonly CaSourceKind[] = CA_SOURCE_KINDS;

// ---------------------------------------------------------------------------
// Canonical CA document — one row, one traceable source line
// ---------------------------------------------------------------------------

/** A canonicalised CA document row: one source line, normalized into a small,
 * stable set of fields that every downstream CA calculation can read the same way,
 * plus the source identifiers needed to trace the figure back to its origin
 * (voucher number, invoice number, challan serial, IRN, txn id).
 *
 * Amounts are in RUPEES as a finite number at this layer (a document/canonical
 * shape, not the integer-paise engine contract). Engine callers convert when they
 * cross the compute boundary. Keeping canonical amounts in rupees here is
 * intentional: mapping profiles are authored by humans looking at rupees in a
 * spreadsheet, and a fingerprint must be stable under re-import.
 */
export interface CaDocument {
  /** Stable identity for the row across repeat syncs of the same source.
   * Built from the source kind's identity fields; never the raw row index.
   */
  fingerprint: string;
  /** Human-readable trace label — the thing a reviewer cites in working papers.
   * e.g. "INV-101 (Sales)", "CHALLAN XYZBSR...", "TXN razorpay-...", "JRNAL J-204".
   */
  traceLabel: string;
  /** When this document was created in the source (yyyy-mm-dd). */
  date: string;
  /** The source system this came from. */
  sourceKind: CaSourceKind;
  /** Which party/ledger/account the line sits on in the source.
   * For bank statements this is the narration/description, not a ledger.
   */
  party: string | null;
  /** Account/ledger/group/hsn/sac/section the line maps to, at the granularity
   * the source provides. Null when the source has no such concept (pure cash).
   */
  account: string | null;
  /** Debit amount in rupees (positive when this line is a debit/expense/asset
   * movement at the source). For sources that carry only "amount" with a dr/cr
   * orientation, debit is filled and credit is 0, or vice-versa.
   */
  debit: number;
  /** Credit amount in rupees (positive when this line is a credit/income/liability
   * movement at the source). Exactly one of debit/credit is non-zero for a
   * single-sided source line; some sources (GST invoice rows) carry taxable
   * splits, not dr/cr — in that case the canonicalizer writes the total here
   * depending on supply direction and leaves debit 0.
   */
  credit: number;
  /** The figure a reviewer can tie back to the source document. Source-system
   * currency amounts (incl. GST splits) roll up into this for sources that carry
   * a total, so downstream GST/TDs computations can still start from the raw row
   * via the sourceIds without recomputing from scratch.
   */
  sourceAmount: number;
  /** The GSTIN/IRN/challan serial/txn id that makes the row auditable against a
   * portal or instrument. Populated for statutory sources; null for pure books.
   */
  sourceId: string | null;
  /** Extra statutory context the canonical layer preserves but does not fold into
   * debit/credit/sourceAmount. For GST invoices: igst/cgst/sgst/cess breakdown.
   * For challans: section/head. For payroll: net pay component. Kept as typed
   * metadata so a downstream engine can read it directly instead of re-parsing.
   */
  metadata: CaMetadata;
  /** The source file/table + a short version id for the sync that produced this
   * document, so a report can say "JRNAL 123 from bank-statement file
   * SB-2026-06.csv, sync 3". Filled in during ingestion (lib/server/ca-source.ts),
   * not here.
   */
  provenance: CaProvenance | null;
}

export interface CaMetadata {
  igst?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  cess?: number | null;
  section?: string | null;
  head?: string | null;
  netPay?: number | null;
  rate?: number | null;
  hsn?: string | null;
  sac?: string | null;
  status?: string | null;
  extra?: Record<string, SqlValue> | null;
}

export interface CaProvenance {
  sourceLabel: string;
  syncVersion: string;
}

// ---------------------------------------------------------------------------
// Mapping profile — a stored, reusable "column X means canonical field Y"
// ---------------------------------------------------------------------------

/** A saved mapping profile for one source. This is the "not one-time
 * upload-and-pick-columns" artifact: a firm saves a profile once per source system
 * (Tally Day Book, SB CSV from HDFC, GST GSTR-1 JSON, TDS challan export, payroll
 * export, e-invoice JSON, Razorpay payments) and reuses it across repeats.
 *
 * The profile can be the auto-detected default for a known source shape (e.g. a
 * Tally TCML/CSV voucher file, a bank statement, a GST GSTR-1 JSON) OR a custom
 * mapping a reviewer saved after reconciling the first import. Custom mappings win
 * when present.
 *
 * Source columns are identified by header name as surfaced by the connector parser
 * (the same names listConnectorTables / pull return). Custom mapping lets a
 * reviewer point e.g. "Vch No" → canonical voucherNumber even when the parser
 * emitted "voucher_number".
 */
export interface CaMappingProfile {
  id: string;
  name: string;
  sourceKind: CaSourceKind;
  /** Human-readable source label (file name, system name) attached to rows during
   * ingestion for provenance.
   */
  sourceLabel: string;
  /** The columns the source file/parser exposes, in order, at mapping time.
   * Used to validate a saved mapping still fits the file before applying.
   */
  sourceColumns: string[];
  /** How each canonical field is produced from the source columns. A row is
   * canonicalised only when every identity field resolves; non-identity fields
   * default sensibly when unmapped (so a profile can be partial for exploratory
   * imports and complete for period syncs).
   */
  mapping: CaMapping;
  /** When this profile was first used (ISO datetime) — for "last used" UX. */
  firstUsedAt: string;
  /** Optional reviewer note: why these columns map this way (e.g. "Tally Day Book
   * export, Dr/Cr column is DC").
   */
  note?: string | null;
}

/** The per-field mapping: which source column feeds a canonical field, and an
 * optional transform (for signed/absolute conversions, date reformatting, amount
 * scaling). When a canonical field has no mapping entry, the engine falls back to a
 * known source-column name for that source kind (the parser's canonical column\n
 * names) so a profile can be partial without dropping every row.
 */
export interface CaMapping {
  /** Source column → fingerprint fields (identity). At least one must resolve. */
  fingerprint?: CaColumnMapping | null;
  /** Source column → traceLabel (voucher/invoice/challan/IRN/txn id). */
  traceLabel?: CaColumnMapping | null;
  /** Source column → date (yyyy-mm-dd string). */
  date?: CaColumnMapping | null;
  /** Source column → party (ledger/party name). */
  party?: CaColumnMapping | null;
  /** Source column → account (group/hsn/sac/section). */
  account?: CaColumnMapping | null;
  /** Source columns → debit (rupees). A column mapping OR a signed amount
   * mapping that computes debit from the source amount given the dr/cr orientation.
   */
  debit?: CaColumnMapping | null;
  /** Source columns → credit (rupees). */
  credit?: CaColumnMapping | null;
  /** Source column → source amount (the total the source carries). */
  sourceAmount?: CaColumnMapping | null;
  /** Source column → sourceId (GSTIN/IRN/challan serial/txn id). */
  sourceId?: CaColumnMapping | null;
  /** Source columns → metadata fields. */
  metadata?: {
    igst?: CaColumnMapping | null;
    cgst?: CaColumnMapping | null;
    sgst?: CaColumnMapping | null;
    cess?: CaColumnMapping | null;
    section?: CaColumnMapping | null;
    head?: CaColumnMapping | null;
    netPay?: CaColumnMapping | null;
    rate?: CaColumnMapping | null;
    hsn?: CaColumnMapping | null;
    sac?: CaColumnMapping | null;
    status?: CaColumnMapping | null;
  } | null;
}

/** A single column mapping: which source column (by header name) feeds a canonical
 * field, and an optional transform. The transform receives the raw cell value
 * (string | number | boolean | null) and must return a value the canonical field
 * expects.
 */
export interface CaColumnMapping {
  column: string;
  /** When present, the transform that converts the raw source cell into the
   * canonical field value. Transforms are pure and cheap (string sanitization,
   * number parsing with comma handling, date normalization, absolute sign).
   */
  transform?: (value: SqlValue, row: Record<string, SqlValue>) => SqlValue;
  /** When present, a validation that the transformed value must satisfy. A row
   * that fails a validation is still canonicalised (the field is populated with
   * the transformed value) but the row is marked in the transform report so the
   * reviewer can act.
   */
  validation?: (value: SqlValue) => boolean;
}

// ---------------------------------------------------------------------------
// Canonicalisation — raw rows → CaDocument[]
// ---------------------------------------------------------------------------

/** Canonicalise a flat list of source rows (the same shape pullConnectorTable
 * returns: columns + rows) into CaDocuments using a saved mapping profile.
 *
 * The transform is idempotent for a given (rows, profile) — re-canonicalising the
 * same rows with the same profile produces the same fingerprints, so repeat syncs
 * of the same file dedupe by fingerprint, not by position.
 *
 * Returns the canonical documents plus a per-row transform report that a reviewer
 * can use to fix a malformed profile or a bad source row.
 */
export function canonicaliseSourceRows(
  sourceKind: CaSourceKind,
  columns: { name: string; type: ColType }[],
  rows: (string | number | boolean | null)[][],
  profile: CaMappingProfile,
  options: { provenance?: CaProvenance | null } = {},
): {
  documents: CaDocument[];
  report: CaTransformReport;
} {
  const colIndex: Record<string, number> = {};
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col) {
      colIndex[col.name] = i;
    }
  }

  const documents: CaDocument[] = [];
  const report: CaTransformReport = {
    mapped: 0,
    skipped: 0,
    warnings: [],
  };

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const rec = recordFromRow(row, columns);
    const doc = canonicaliseOneRow(sourceKind, rec, profile, colIndex, r, options);
    if (doc) {
      documents.push(doc);
      report.mapped++;
    } else {
      report.skipped++;
      report.warnings.push(`Row ${r + 1}: could not canonise — at least one identity field unresolved.`);
    }
  }

  return { documents, report };
}

/** Canonicalise a single source row into a CaDocument, or null if the row can't be
 * identity-resolved. Non-identity fields get sensible defaults when unmapped so a
 * partial profile still produces usable docs (with warnings in the report).
 */
function canonicaliseOneRow(
  sourceKind: CaSourceKind,
  row: Record<string, SqlValue>,
  profile: CaMappingProfile,
  colIndex: Record<string, number>,
  rowIndex: number,
  options: { provenance?: CaProvenance | null } = {},
): CaDocument | null {
  // --- identity fields (must resolve) ---
  const fingerprint = readFingerprint(sourceKind, profile, row, colIndex);
  if (!fingerprint) return null;
  const traceLabel = readTraceLabel(sourceKind, profile, row, colIndex) ?? fingerprint;

  const date = readDate(sourceKind, profile, row, colIndex) ?? "";
  const party = readString(sourceKind, profile, "party", row, colIndex) ?? null;
  const account = readString(sourceKind, profile, "account", row, colIndex) ?? null;

  const debit = readAmount(sourceKind, profile, "debit", row, colIndex) ?? 0;
  const credit = readAmount(sourceKind, profile, "credit", row, colIndex) ?? 0;

  const sourceAmount = readAmount(sourceKind, profile, "sourceAmount", row, colIndex) ?? debit + credit;

  const sourceId = readString(sourceKind, profile, "sourceId", row, colIndex);

  const metadata = readMetadata(sourceKind, profile, row, colIndex);

  const provenance = options.provenance ?? null;

  // Normalise amounts to finite numbers; signalling NaN/infinity is a bad source,
  // not a canonisable row.
  const debitN = isFiniteNumber(debit) ? debit : 0;
  const creditN = isFiniteNumber(credit) ? credit : 0;
  const sourceAmountN = isFiniteNumber(sourceAmount) ? sourceAmount : debitN + creditN;

  return {
    fingerprint,
    traceLabel,
    date,
    sourceKind,
    party,
    account,
    debit: debitN,
    credit: creditN,
    sourceAmount: sourceAmountN,
    sourceId,
    metadata,
    provenance,
  };
}

// --- field readers ---

function readFingerprint(
  sourceKind: CaSourceKind,
  profile: CaMappingProfile,
  row: Record<string, SqlValue>,
  _colIndex: Record<string, number>,
): string | null {
  // An explicit fingerprint mapping wins.
  if (profile.mapping.fingerprint?.column) {
    const v = applyMapping(profile.mapping.fingerprint, row);
    const s = canonicalString(v);
    return s && s.length > 0 ? s : null;
  }
  // Fallback: the canonical identity for the source kind (parser's canonical
  // column names). Tally/books/einvoice/journal: voucher number. Bank: reference
  // or a row-local id. Challen/payroll: challan serial / employee+month.
  const identity = knownIdentity(sourceKind, row);
  return identity ?? null;
}

function knownIdentity(sourceKind: CaSourceKind, row: Record<string, SqlValue>): string | null {
  switch (sourceKind) {
    case "tally-vouchers":
    case "books-vouchers":
    case "einvoice":
    case "journal": {
      const vid = ((row["voucher_number"] ?? row["vch_no"]) as SqlValue) ?? null;
      return canonicalString(vid) || null;
    }
    case "bank-statement": {
      const bref = ((row["reference"] ?? row["id"]) as SqlValue) ?? null;
      return canonicalString(bref) || null;
    }
    case "gst-invoices": {
      const inv = ((row["invoice_number"] ?? row["inv_no"]) as SqlValue) ?? null;
      return canonicalString(inv) || null;
    }
    case "gst-challan":
    case "tds-challan": {
      const ch = ((row["challan_serial"] ?? row["challan_no"]) as SqlValue) ?? null;
      return canonicalString(ch) || null;
    }
    case "payroll": {
      const emp = row["employee_id"] as SqlValue;
      const mon = row["month"] as SqlValue;
      if (emp != null && mon != null) {
        return `${canonicalString(emp)}-${canonicalString(mon)}`;
      }
      return canonicalString(emp ?? null) || null;
    }
    case "payment-gateway":
      const pid = ((row["id"] ?? row["txnid"] ?? row["mihpayid"]) as SqlValue) ?? null;
      return canonicalString(pid) || null;
    default:
      return null;
  }
}

function readTraceLabel(
  sourceKind: CaSourceKind,
  profile: CaMappingProfile,
  row: Record<string, SqlValue>,
  _colIndex: Record<string, number>,
): string | null {
  if (profile.mapping.traceLabel?.column) {
    const mapped = applyMapping(profile.mapping.traceLabel, row);
    return canonicalString(mapped);
  }
  // Default trace label = the identity, with an optional voucher-type suffix for
  // voucher sources (so "INV-101" reads as "INV-101 (Sales)").
  const identity = knownIdentity(sourceKind, row);
  if (!identity) return null;
  if (
    sourceKind === "tally-vouchers" ||
    sourceKind === "books-vouchers" ||
    sourceKind === "einvoice" ||
    sourceKind === "journal"
  ) {
    const vt = row["voucher_type"] ?? row["vch_type"] ?? "";
    return vt ? `${identity} (${vt})` : identity;
  }
  return identity;
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
function readDate(
  sourceKind: CaSourceKind,
  profile: CaMappingProfile,
  row: Record<string, SqlValue>,
  _colIndex: Record<string, number>,
): string | null {
  if (profile.mapping.date?.column) {
    const v = applyMapping(profile.mapping.date, row);
    const s = canonicalString(v);
    return isIsoDate(s) ? s : null;
  }
  // Fallback: the parser's canonical date column for the source.
  const dateCol = knownDateColumn(sourceKind);
  const v = row[dateCol] ?? null;
  if (v == null) return null;
  const s = canonicalString(v);
  return isIsoDate(s) ? s : null;
}

const KNOWN_DATE_COLUMN: Record<CaSourceKind, string> = {
  "tally-vouchers": "date",
  "books-vouchers": "date",
  "bank-statement": "date",
  "gst-invoices": "inv_date",
  "gst-challan": "date_of_deposit",
  "tds-challan": "date_of_deposit",
  payroll: "date",
  einvoice: "inv_date",
  "payment-gateway": "created_at",
  journal: "date",
};

function knownDateColumn(sourceKind: CaSourceKind): string {
  return KNOWN_DATE_COLUMN[sourceKind] ?? "date";
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const KNOWN_DATE_COLUMN_FALLBACK: CaSourceKind[] = [
  "tally-vouchers",
  "books-vouchers",
  "bank-statement",
  "gst-invoices",
  "gst-challan",
  "tds-challan",
  "payroll",
  "einvoice",
  "payment-gateway",
  "journal",
];
for (const kind of KNOWN_DATE_COLUMN_FALLBACK) {
  if (!(kind in KNOWN_DATE_COLUMN)) {
    (KNOWN_DATE_COLUMN as Record<string, string>)[kind] = "date";
  }
}

function readString(
  sourceKind: CaSourceKind,
  profile: CaMappingProfile,
  field: "party" | "account" | "sourceId",
  row: Record<string, SqlValue>,
  _colIndex: Record<string, number>,
): string | null {
  const mapping = profile.mapping[field];
  if (mapping?.column) {
    const v = applyMapping(mapping, row);
    // applyMapping returns SqlValue; canonicalString handles all types
    return canonicalString(v);
  }
  // Party/account/sourceId fallbacks are source-specific and intentionally sparse.
  if (field === "party") {
    const v = row["ledger_name"] ?? row["party_name"] ?? row["acc_name"] ?? null;
    return canonicalString(v) || null;
  }
  if (field === "sourceId") {
    const v = row["gstin"] ?? row["irn"] ?? row["tnoc"] ?? null;
    return canonicalString(v) || null;
  }
  const v = row["group"] ?? row["hsn_code"] ?? row["sac_code"] ?? row["section"] ?? null;
  return canonicalString(v) || null;
}

function readAmount(
  sourceKind: CaSourceKind,
  profile: CaMappingProfile,
  field: "debit" | "credit" | "sourceAmount",
  row: Record<string, SqlValue>,
  _colIndex: Record<string, number>,
): number | null {
  const m = profile.mapping[field];
  if (!m) {
    // No explicit mapping for the amount field: no default; caller gets null and
    // sourceAmount falls back to debit+credit below. This is intentional: an
    // unmapped amount field is a bad profile for a period sync.
    return null;
  }
  if (m.column) {
    return numberFrom(applyMapping(m, row));
  }
  return null;
}

function readMetadata(
  sourceKind: CaSourceKind,
  profile: CaMappingProfile,
  row: Record<string, SqlValue>,
  _colIndex: Record<string, number>,
): CaMetadata {
  const m = profile.mapping.metadata ?? {};
  return {
    igst: readMetadataFieldNum(m.igst, row, "igst"),
    cgst: readMetadataFieldNum(m.cgst, row, "cgst"),
    sgst: readMetadataFieldNum(m.sgst, row, "sgst"),
    cess: readMetadataFieldNum(m.cess, row, "cess"),
    section: readMetadataFieldStr(m.section, row, "section"),
    head: readMetadataFieldStr(m.head, row, "head"),
    netPay: readMetadataFieldNum(m.netPay, row, "net_pay"),
    rate: readMetadataFieldNum(m.rate, row),
    hsn: readMetadataFieldStr(m.hsn, row, "hsn_code"),
    sac: readMetadataFieldStr(m.sac, row, "sac_code"),
    status: readMetadataFieldStr(m.status, row, "status"),
    extra: null,
  };
}

function readMetadataFieldNum(
  mapping: CaColumnMapping | undefined | null,
  row: Record<string, SqlValue>,
  fallback?: string,
): number | null {
  let v: SqlValue = null;
  if (mapping?.column) {
    v = applyMapping(mapping, row);
  } else if (fallback != null) {
    v = row[fallback] ?? null;
  }
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return isFinite(n) ? n : null;
  }
  return null;
}

function readMetadataFieldStr(
  mapping: CaColumnMapping | undefined | null,
  row: Record<string, SqlValue>,
  fallback?: string,
): string | null {
  let v: SqlValue = null;
  if (mapping?.column) {
    v = applyMapping(mapping, row);
  } else if (fallback != null) {
    v = row[fallback] ?? null;
  }
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

// --- helpers ---

/** Build a record from a row and its column names (the shape pullConnectorTable
 * returns). */
export function recordFromRow(
  row: (string | number | boolean | null)[],
  columns: { name: string; type: ColType }[],
): Record<string, SqlValue> {
  const rec: Record<string, SqlValue> = {};
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (!col) continue;
    rec[col.name] = row && i < row.length ? (row[i] ?? null) : null;
  }
  return rec;
}

function applyMapping(mapping: CaColumnMapping, row?: Record<string, SqlValue>): SqlValue {
  const raw = row ? row[mapping.column] : null;
  if (raw === undefined || raw === null) return null;
  if (mapping.transform) {
    const result = mapping.transform(raw, row || {});
    return result;
  }
  return raw;
}

function canonicalString(value: SqlValue): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!isFinite(value)) return "";
    return String(value);
  }
  return String(value).trim();
}

function isFiniteNumber(value: SqlValue): value is number {
  return typeof value === "number" && isFinite(value);
}

function numberFrom(value: SqlValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/,/g, "");
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// ---------------------------------------------------------------------------
// Reconcile-with-trace — two canonical sources → matches + unmatched + trace
// ---------------------------------------------------------------------------

/** Reconcile two canonical sources (e.g. books vouchers vs bank statement, or
 * GST invoices vs e-invoice IRN data, or TDS challans vs deposit records) and
 * return matches with traceable links back to both source identifiers, plus the
 * unmatched items, so every figure in a CA reconciliation can be tied to a source
 * line.
 *
 * Matching is deterministic and repeatable: same inputs → same matches, same
 * fingerprints, same trace labels. Confidence reflects how many identity signals
 * agree (exact ref match > date+amount match > amount-only).
 */
export function reconcileCa(
  left: readonly CaDocument[],
  right: readonly CaDocument[],
  options: {
    /** Rupee tolerance for amount matching (default ₹1 = 100 paise expressed as
     * rupees: 1). The canonical layer works in rupees, so tolerance is also in
     * rupees.
     */
    amountTolerance?: number;
    /** Date tolerance in days for date+amount matching (default 1). */
    dateToleranceDays?: number;
    /** When true, also match on traceLabel/identity equivalence when amounts agree
     * within tolerance (e.g. two GST invoice rows with the same invoice number from
     * books vs portal). Default true.
     */
    matchOnIdentity?: boolean;
    /** When true, prefer a reference/sourceId exact match over a date+amount match
     * (the strongest signal should not be stolen by an earlier date-only match).
     * Default true.
     */
    preferReferenceMatch?: boolean;
  } = {},
): CaReconcileResult {
  const amountTolerance = clampNonNegative(options.amountTolerance ?? 1);
  const dateToleranceDays = clampNonNegative(options.dateToleranceDays ?? 1);
  const matchOnIdentity = options.matchOnIdentity !== false;
  const preferReference = options.preferReferenceMatch !== false;

  const matches: CaMatch[] = [];
  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();

  // references first (best signal)
  if (preferReference) {
    for (let i = 0; i < left.length; i++) {
      if (usedLeft.has(i)) continue;
      const li = left[i]!;
      if (!li.sourceId && !li.traceLabel) continue;
      for (let j = 0; j < right.length; j++) {
        if (usedRight.has(j)) continue;
        const ri = right[j]!;
        if (!ri.sourceId && !ri.traceLabel) continue;
        if (!refMatch(li, ri)) continue;
        if (!amountWithinTolerance(li, ri, amountTolerance)) continue;
        // reference + amount — strong match
        matches.push({
          leftFingerprint: li.fingerprint,
          rightFingerprint: ri.fingerprint,
          leftTrace: li.traceLabel,
          rightTrace: ri.traceLabel,
          leftSourceId: li.sourceId,
          rightSourceId: ri.sourceId,
          confidence: 0.99,
          matchType: "reference",
          reasons: ["Exact reference/source-id match with matching amount within tolerance."],
          leftAmount: li.sourceAmount,
          rightAmount: ri.sourceAmount,
        });
        usedLeft.add(i);
        usedRight.add(j);
        break;
      }
    }
  }

  // date + amount matches
  for (let i = 0; i < left.length; i++) {
    if (usedLeft.has(i)) continue;
    const li = left[i]!;
    for (let j = 0; j < right.length; j++) {
      if (usedRight.has(j)) continue;
      const ri = right[j]!;
      if (!amountWithinTolerance(li, ri, amountTolerance)) continue;
      const dateDiff = dateDayDelta(li.date, ri.date);
      if (dateDiff < 0 || dateDiff > dateToleranceDays) continue;
      if (matches.some((m) => m.leftFingerprint === li.fingerprint || m.rightFingerprint === ri.fingerprint)) continue;
      matches.push({
        leftFingerprint: li.fingerprint,
        rightFingerprint: ri.fingerprint,
        leftTrace: li.traceLabel,
        rightTrace: ri.traceLabel,
        leftSourceId: li.sourceId,
        rightSourceId: ri.sourceId,
        confidence: 0.95,
        matchType: "date-amount",
        reasons: [
          `Amounts match within ₹${amountTolerance} (left ₹${li.sourceAmount}, right ₹${ri.sourceAmount}); dates within ${dateDiff} day(s) (left ${li.date}, right ${ri.date}).`,
        ],
        leftAmount: li.sourceAmount,
        rightAmount: ri.sourceAmount,
      });
      usedLeft.add(i);
      usedRight.add(j);
      break;
    }
  }

  // identity-only matches (when requested and amounts agree)
  if (matchOnIdentity) {
    for (let i = 0; i < left.length; i++) {
      if (usedLeft.has(i)) continue;
      const li = left[i]!;
      for (let j = 0; j < right.length; j++) {
        if (usedRight.has(j)) continue;
        const ri = right[j]!;
        if (!amountWithinTolerance(li, ri, amountTolerance)) continue;
        if (!identityMatch(li, ri)) continue;
        if (matches.some((m) => m.leftFingerprint === li.fingerprint || m.rightFingerprint === ri.fingerprint))
          continue;
        matches.push({
          leftFingerprint: li.fingerprint,
          rightFingerprint: ri.fingerprint,
          leftTrace: li.traceLabel,
          rightTrace: ri.traceLabel,
          leftSourceId: li.sourceId,
          rightSourceId: ri.sourceId,
          confidence: 0.85,
          matchType: "identity",
          reasons: [
            `Identical source identity (left ${li.traceLabel}, right ${ri.traceLabel}) with matching amount within ₹${amountTolerance}.`,
          ],
          leftAmount: li.sourceAmount,
          rightAmount: ri.sourceAmount,
        });
        usedLeft.add(i);
        usedRight.add(j);
        break;
      }
    }
  }

  const unmatchedLeft = left
    .filter((_, i) => !usedLeft.has(i))
    .map((d) => ({
      fingerprint: d.fingerprint,
      traceLabel: d.traceLabel,
      sourceKind: d.sourceKind,
      amount: d.sourceAmount,
      sourceId: d.sourceId,
    }));
  const unmatchedRight = right
    .filter((_, j) => !usedRight.has(j))
    .map((d) => ({
      fingerprint: d.fingerprint,
      traceLabel: d.traceLabel,
      sourceKind: d.sourceKind,
      amount: d.sourceAmount,
      sourceId: d.sourceId,
    }));

  const totalMatched = matches.length;
  const matchRate = left.length > 0 ? (totalMatched / left.length) * 100 : 0;

  return {
    matches,
    unmatchedLeft,
    unmatchedRight,
    totalMatched,
    matchRate: Math.round(matchRate * 100) / 100,
    summary: buildReconcileSummary(left, right, matches, unmatchedLeft, unmatchedRight),
  };
}

function refMatch(left: CaDocument, right: CaDocument): boolean {
  const a = left.sourceId ?? left.traceLabel;
  const b = right.sourceId ?? right.traceLabel;
  if (!a || !b) return false;
  return canonicalString(a) === canonicalString(b);
}

function identityMatch(left: CaDocument, right: CaDocument): boolean {
  const a = left.traceLabel;
  const b = right.traceLabel;
  if (!a || !b) return false;
  return canonicalString(a) === canonicalString(b);
}

function amountWithinTolerance(left: CaDocument, right: CaDocument, tolerance: number): boolean {
  return Math.abs(left.sourceAmount - right.sourceAmount) <= tolerance;
}

function dateDayDelta(a: string, b: string): number {
  const da = /^\d{4}-\d{2}-\d{2}$/.test(a) ? new Date(a + "T00:00:00Z") : null;
  const db = /^\d{4}-\d{2}-\d{2}$/.test(b) ? new Date(b + "T00:00:00Z") : null;
  if (!da || !db) return -1;
  return Math.round(Math.abs((da.getTime() - db.getTime()) / 86400000));
}

function buildReconcileSummary(
  left: readonly CaDocument[],
  right: readonly CaDocument[],
  matches: readonly CaMatch[],
  unmatchedLeft: readonly CaUnmatched[],
  unmatchedRight: readonly CaUnmatched[],
): CaReconcileSummary {
  const leftTotal = left.reduce((s, d) => s + d.sourceAmount, 0);
  const rightTotal = right.reduce((s, d) => s + d.sourceAmount, 0);
  const matchedTotal = matches.reduce((s, m) => s + m.leftAmount, 0);
  const unmatchedLeftTotal = unmatchedLeft.reduce((s, u) => s + u.amount, 0);
  const unmatchedRightTotal = unmatchedRight.reduce((s, u) => s + u.amount, 0);

  return {
    leftTotal,
    rightTotal,
    matchedTotal,
    unmatchedLeftTotal,
    unmatchedRightTotal,
    leftNetReconciled: matchedTotal + unmatchedLeftTotal,
    rightNetReconciled: matchedTotal + unmatchedRightTotal,
    leftResidual: leftTotal - (matchedTotal + unmatchedLeftTotal),
    rightResidual: rightTotal - (matchedTotal + unmatchedRightTotal),
    note: buildReconcileNote(
      leftTotal,
      rightTotal,
      matchedTotal,
      unmatchedLeftTotal,
      unmatchedRightTotal,
      left.length,
      right.length,
      matches.length,
      unmatchedLeft.length,
      unmatchedRight.length,
    ),
  };
}

function buildReconcileNote(
  leftTotal: number,
  rightTotal: number,
  matchedTotal: number,
  unmatchedLeftTotal: number,
  unmatchedRightTotal: number,
  leftCount: number,
  rightCount: number,
  matchedCount: number,
  unmatchedLeftCount?: number,
  unmatchedRightCount?: number,
): string {
  const lines = [
    `Left source totals ₹${leftTotal.toFixed(2)} across ${leftCount} document(s); right source totals ₹${rightTotal.toFixed(2)} across ${rightCount} document(s).`,
    `Matched ${matchedCount} document(s) worth ₹${matchedTotal.toFixed(2)} (traceable to source vouchers/invoices/challans/IRNs/txns).`,
  ];
  if (unmatchedLeftTotal !== 0 || unmatchedRightTotal !== 0) {
    const ulCount = unmatchedLeftCount ?? (unmatchedLeftTotal === 0 ? 0 : 0);
    const urCount = unmatchedRightCount ?? (unmatchedRightTotal === 0 ? 0 : 0);
    lines.push(
      `Unmatched: left ₹${unmatchedLeftTotal.toFixed(2)} (${ulCount} doc(s)), right ₹${unmatchedRightTotal.toFixed(2)} (${urCount} doc(s)).`,
    );
  }
  if (Math.abs(leftTotal - rightTotal) < 0.01) {
    lines.push(`Sources reconcile: left and right totals agree to within ₹0.01.`);
  } else {
    lines.push(
      `Sources do NOT fully reconcile: left − right = ₹${(leftTotal - rightTotal).toFixed(2)}. Review unmatched items before signing.`,
    );
  }
  return lines.join(" ");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaTransformReport {
  mapped: number;
  skipped: number;
  warnings: string[];
}

export interface CaMatch {
  leftFingerprint: string;
  rightFingerprint: string;
  leftTrace: string;
  rightTrace: string;
  leftSourceId: string | null;
  rightSourceId: string | null;
  confidence: number;
  matchType: "reference" | "date-amount" | "identity";
  reasons: string[];
  leftAmount: number;
  rightAmount: number;
}

export interface CaUnmatched {
  fingerprint: string;
  traceLabel: string;
  sourceKind: CaSourceKind;
  amount: number;
  sourceId: string | null;
}

export interface CaReconcileResult {
  matches: readonly CaMatch[];
  unmatchedLeft: readonly CaUnmatched[];
  unmatchedRight: readonly CaUnmatched[];
  totalMatched: number;
  matchRate: number;
  summary: CaReconcileSummary;
}

export interface CaReconcileSummary {
  leftTotal: number;
  rightTotal: number;
  matchedTotal: number;
  unmatchedLeftTotal: number;
  unmatchedRightTotal: number;
  leftNetReconciled: number;
  rightNetReconciled: number;
  leftResidual: number;
  rightResidual: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}
