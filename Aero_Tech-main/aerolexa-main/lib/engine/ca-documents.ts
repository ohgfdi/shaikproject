/**
 * Document management & client portal engine — the filing cabinet behind a CA
 * practice, and the slice of it a client sees.
 *
 * What it actually does: builds a document register with a retention due date
 * per record, checks the register for the documents an engagement is supposed
 * to hold, flags version conflicts and unsigned records, and produces the
 * per-client portal view (only documents the practice chose to share) plus the
 * list of documents still awaited from the client.
 *
 * SCOPE AND HONESTY: the retention table below is a DEFAULT with the provision
 * it follows named on every row, but retention is a legal judgement (and the
 * periods move); the caller owns the table. Sharing is a per-document flag —
 * the engine does not enforce access control, the caller must filter the
 * register before it leaves the server.
 *
 * Dates are yyyy-mm-dd strings; sizes are bytes.
 */

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export type DocumentCategory =
  | "engagement-letter"
  | "working-paper"
  | "financial-statement"
  | "tax-return"
  | "audit-report"
  | "gst-record"
  | "kyc"
  | "client-correspondence"
  | "other";

export const DOCUMENT_CATEGORIES: readonly DocumentCategory[] = [
  "engagement-letter",
  "working-paper",
  "financial-statement",
  "tax-return",
  "audit-report",
  "gst-record",
  "kyc",
  "client-correspondence",
  "other",
];

export interface DocumentRecord {
  id: string;
  name: string;
  category: DocumentCategory;
  clientId: string;
  clientName: string;
  engagementId: string | null;
  /** yyyy-mm-dd the record was filed. */
  uploadedAt: string;
  uploadedBy: string;
  version: number;
  sizeBytes: number;
  /** Signed with DSC / e-sign. */
  signed: boolean;
  /** Whether the practice exposes the record to the client's portal. */
  sharedWithClient: boolean;
}

export interface RetentionRule {
  category: DocumentCategory;
  years: number;
  /** The provision the period follows — named so a reviewer can check it. */
  source: string;
}

/**
 * Default retention periods. VERIFY before relying on them: the caller owns the
 * retention policy, and different statutes can apply to the same record.
 */
export const DEFAULT_RETENTION_RULES: readonly RetentionRule[] = [
  { category: "financial-statement", years: 8, source: "s.128(5) Companies Act 2013 — 8 financial years" },
  { category: "audit-report", years: 8, source: "s.128(5) / s.139 read with ICAI records guidelines" },
  { category: "working-paper", years: 8, source: "ICAI Council guidelines on engagement records" },
  { category: "engagement-letter", years: 8, source: "ICAI Council guidelines on engagement records" },
  { category: "tax-return", years: 6, source: "s.44AA / s.44AB Income-tax Act — 6 years (8 for companies)" },
  { category: "gst-record", years: 6, source: "s.36(1) CGST Act — 72 months" },
  { category: "kyc", years: 8, source: "PMLA record-keeping practice (8 years)" },
  { category: "client-correspondence", years: 6, source: "Practice policy default" },
  { category: "other", years: 6, source: "Practice policy default" },
];

/** Categories a completed engagement is expected to hold. */
export const DEFAULT_REQUIRED_CATEGORIES: readonly DocumentCategory[] = [
  "engagement-letter",
  "financial-statement",
  "tax-return",
  "working-paper",
];

function parseIso(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DocumentError(`${field} must be yyyy-mm-dd, received "${value}".`);
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) throw new DocumentError(`Unparseable ${field} "${value}".`);
  return t;
}

const DAY_MS = 86_400_000;

/** Calendar days from `fromIso` to `toIso` (positive when `to` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso, "to") - parseIso(fromIso, "from")) / DAY_MS);
}

/** Retention due date = filed date + the rule's years (365-day years, UTC). */
export function retentionDueDate(uploadedAt: string, years: number): string {
  if (years < 0) throw new DocumentError("years must not be negative.");
  return new Date(parseIso(uploadedAt, "uploadedAt") + years * 365 * DAY_MS).toISOString().slice(0, 10);
}

export interface RetentionRow {
  id: string;
  name: string;
  category: DocumentCategory;
  uploadedAt: string;
  dueDate: string;
  retentionYears: number;
  source: string;
  expired: boolean;
  daysRemaining: number;
}

export interface DocumentRegisterResult {
  totalDocuments: number;
  totalBytes: number;
  byCategory: Record<string, number>;
  byClient: Record<string, number>;
  retention: RetentionRow[];
  expired: RetentionRow[];
  expiringSoon: RetentionRow[];
  completeness: {
    required: DocumentCategory[];
    present: DocumentCategory[];
    missing: DocumentCategory[];
    complete: boolean;
  };
  versionConflicts: { name: string; clientId: string; versions: number[] }[];
  unsigned: { id: string; name: string; category: DocumentCategory }[];
  unshared: number;
  methodology: string[];
}

/**
 * Build the document register: retention status, completeness, conflicts.
 */
export function buildDocumentRegister(
  documents: DocumentRecord[],
  options: {
    rules?: readonly RetentionRule[];
    requiredCategories?: readonly DocumentCategory[];
    asOfDate?: string;
    /** Records expiring within this many days are "expiring soon". */
    expiringSoonDays?: number;
  } = {},
): DocumentRegisterResult {
  const rules = options.rules ?? DEFAULT_RETENTION_RULES;
  const required = options.requiredCategories ?? DEFAULT_REQUIRED_CATEGORIES;
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const soonDays = options.expiringSoonDays ?? 180;
  parseIso(asOfDate, "asOfDate");

  const byCategory: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  const retention: RetentionRow[] = [];
  const unsigned: DocumentRegisterResult["unsigned"] = [];
  const byNameAndClient = new Map<string, Set<number>>();
  let totalBytes = 0;
  let unshared = 0;

  for (const doc of documents) {
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
    byClient[doc.clientId] = (byClient[doc.clientId] ?? 0) + 1;
    totalBytes += doc.sizeBytes;
    if (!doc.signed) unsigned.push({ id: doc.id, name: doc.name, category: doc.category });
    if (!doc.sharedWithClient) unshared += 1;

    const key = `${doc.clientId}|${doc.name}`;
    const versions = byNameAndClient.get(key) ?? new Set<number>();
    versions.add(doc.version);
    byNameAndClient.set(key, versions);

    const rule = rules.find((r) => r.category === doc.category) ?? {
      category: doc.category,
      years: 6,
      source: "Practice policy default",
    };
    const dueDate = retentionDueDate(doc.uploadedAt, rule.years);
    const daysRemaining = daysBetween(asOfDate, dueDate);
    retention.push({
      id: doc.id,
      name: doc.name,
      category: doc.category,
      uploadedAt: doc.uploadedAt,
      dueDate,
      retentionYears: rule.years,
      source: rule.source,
      expired: daysRemaining < 0,
      daysRemaining,
    });
  }

  retention.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const present = Array.from(new Set(documents.map((d) => d.category))).filter((c) => required.includes(c));
  const missing = required.filter((c) => !present.includes(c));

  const versionConflicts = Array.from(byNameAndClient.entries())
    .filter(([, versions]) => versions.size > 1)
    .map(([key, versions]) => {
      const [clientId, name] = key.split("|");
      return { name: name ?? "", clientId: clientId ?? "", versions: Array.from(versions).sort((a, b) => a - b) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    totalDocuments: documents.length,
    totalBytes,
    byCategory,
    byClient,
    retention,
    expired: retention.filter((r) => r.expired),
    expiringSoon: retention.filter((r) => !r.expired && r.daysRemaining <= soonDays),
    completeness: { required: [...required], present, missing, complete: missing.length === 0 },
    versionConflicts,
    unsigned,
    unshared,
    methodology: [
      "Retention due date = date filed + the rule's years, with each period carrying the provision it follows.",
      `A record whose due date has passed is reported as expired; records expiring within ${soonDays} days are flagged as expiring soon.`,
      "Completeness compares the categories present against the required set for a completed engagement.",
      "A version conflict is two or more versions of the same document name for the same client.",
      "Sharing is per document — the register reports counts, the caller enforces who may read what.",
    ],
  };
}

export interface PortalFolder {
  category: DocumentCategory;
  documents: {
    id: string;
    name: string;
    uploadedAt: string;
    sizeBytes: number;
    signed: boolean;
  }[];
}

export interface ClientPortalView {
  clientId: string;
  clientName: string;
  folders: PortalFolder[];
  sharedCount: number;
  totalBytes: number;
  visibleDocumentIds: string[];
  /** Documents the practice still needs from the client. */
  awaitingFromClient: DocumentCategory[];
  checklist: string[];
}

/**
 * The client-facing slice of the register: only documents flagged as shared.
 *
 * Callers MUST pass the already-scoped documents for this client; the view is a
 * presentation of the share flag, not an authorisation check.
 */
export function buildClientPortalView(
  client: { clientId: string; clientName: string },
  documents: DocumentRecord[],
  options: { requiredCategories?: readonly DocumentCategory[]; awaiting?: readonly DocumentCategory[] } = {},
): ClientPortalView {
  const shared = documents.filter((d) => d.clientId === client.clientId && d.sharedWithClient);
  const byCategory = new Map<DocumentCategory, PortalFolder>();

  for (const doc of shared) {
    const folder = byCategory.get(doc.category) ?? { category: doc.category, documents: [] };
    folder.documents.push({
      id: doc.id,
      name: doc.name,
      uploadedAt: doc.uploadedAt,
      sizeBytes: doc.sizeBytes,
      signed: doc.signed,
    });
    byCategory.set(doc.category, folder);
  }

  const folders = Array.from(byCategory.values())
    .map((f) => ({
      ...f,
      documents: f.documents.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const awaiting = [...(options.awaiting ?? options.requiredCategories ?? DEFAULT_REQUIRED_CATEGORIES)];

  return {
    clientId: client.clientId,
    clientName: client.clientName,
    folders,
    sharedCount: shared.length,
    totalBytes: shared.reduce((s, d) => s + d.sizeBytes, 0),
    visibleDocumentIds: shared.map((d) => d.id).sort(),
    awaitingFromClient: awaiting,
    checklist: awaiting.map((c) => `Upload / confirm the ${c.replace(/-/g, " ")} for ${client.clientName}.`),
  };
}
