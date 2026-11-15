/**
 * Client portal — tokenised, read-only access for one client engagement.
 *
 * Security model:
 *  - A link is a 256-bit random token. Only its SHA-256 hash is stored; the raw
 *    value is returned exactly once, at creation.
 *  - Links expire (default 30 days, max 90), can be revoked, and stop working
 *    when the engagement is archived.
 *  - The portal exposes only CLIENT-variant deliverables in ISSUED status. Drafts,
 *    reviewer variants, working papers and ledgers are never reachable.
 *  - Uploads are size-capped, extension/MIME allow-listed, magic-byte checked,
 *    stored under a content-derived name, and recorded against the engagement.
 *  - Every firm-side operation goes through `requireEngagementRole`; links are
 *    created/revoked only by roles that may manage access (PARTNER/MANAGER).
 */

import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  buildClientComplianceCalendar,
  complianceTaskState,
  financialYearFor,
  type ClientComplianceProfileInput,
  type ComplianceTask,
} from "@/lib/engine/compliance-calendar";
import { serverEnv } from "@/lib/env";
import { renderDeliverableVersion } from "@/lib/server/deliverable-render";
import { canManageAccess, requireEngagementRole } from "@/lib/server/engagement";
import { readFile, saveFile } from "@/lib/server/storage";
import type { PracticeRole } from "@/lib/types";

import { signApprovalReceipt } from "./approval-receipt-signing";
import { buildPortalApprovalReceipt, type PortalApprovalReceipt } from "./portal-approval-receipt";
import { createInvoiceOrder, razorpayConfigured, razorpayPublicKey, verifyCheckoutSignature } from "./practice-payments";

// ---------------------------------------------------------------------------
// Pure token + upload validation (oracle-tested)
// ---------------------------------------------------------------------------

export const PORTAL_TOKEN_PREFIX = "lpl_";
export const DEFAULT_PORTAL_DAYS = 30;
export const MAX_PORTAL_DAYS = 90;
export const MAX_PORTAL_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Deterministic SHA-256 of a raw portal token. */
export function hashPortalToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a raw token, its stored hash and a display prefix. */
export function newPortalToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${PORTAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashPortalToken(raw), prefix: raw.slice(0, 12) };
}

export type PortalLinkState = "active" | "revoked" | "expired";

export function portalLinkState(
  link: { expiresAt: Date; revokedAt: Date | null },
  now: Date = new Date(),
): PortalLinkState {
  if (link.revokedAt) return "revoked";
  return link.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

/**
 * The one visibility rule for client-facing deliverables. A link may show a
 * deliverable only when it is the client variant AND has been issued. Signed
 * off but not yet issued is still internal work.
 */
export function portalDeliverableVisible(version: { variant: string; status: string }): boolean {
  return version.variant === "CLIENT" && version.status === "ISSUED";
}

const EXTENSION_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Strip directories and control characters; never trust a client filename. */
export function sanitizeUploadFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const limited = cleaned.slice(0, 180);
  return limited || "upload";
}

function hasMagic(ext: string, bytes: Buffer): boolean {
  if (ext === "pdf") return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === "png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (ext === "jpg" || ext === "jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === "xlsx" || ext === "docx") {
    return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  // CSV: text by definition — reject binary content rather than pretending to
  // sniff a schema.
  if (ext === "csv") return !bytes.includes(0);
  return false;
}

export interface PortalUploadCandidate {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface PortalUploadAccepted {
  filename: string;
  mimeType: string;
  extension: string;
}

/**
 * Validate an upload before a byte is written. Throws ApiError so the public
 * route returns the same envelope as every other API failure.
 */
export function validatePortalUpload(candidate: PortalUploadCandidate): PortalUploadAccepted {
  const filename = sanitizeUploadFilename(candidate.filename);
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const expectedMime = EXTENSION_MIME[extension];
  if (!expectedMime) {
    throw new ApiError(
      400,
      "UNSUPPORTED_FILE",
      "Upload a PDF, PNG, JPEG, CSV, XLSX or DOCX file.",
    );
  }
  if (candidate.sizeBytes <= 0 || candidate.bytes.length === 0) {
    throw new ApiError(400, "EMPTY_FILE", "The uploaded file is empty.");
  }
  if (candidate.sizeBytes > MAX_PORTAL_UPLOAD_BYTES || candidate.bytes.length > MAX_PORTAL_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Files must be ${Math.round(MAX_PORTAL_UPLOAD_BYTES / 1024 / 1024)} MB or smaller.`,
    );
  }
  const declared = (candidate.mimeType.toLowerCase().split(";")[0] ?? "").trim();
  const unknownMime = declared === "" || declared === "application/octet-stream";
  const compatible =
    unknownMime ||
    declared === expectedMime ||
    (expectedMime === "text/csv" && declared.startsWith("text/"));
  if (!compatible) {
    throw new ApiError(
      400,
      "UNSUPPORTED_FILE",
      `“${filename}” does not match its file type (${candidate.mimeType}).`,
    );
  }
  if (!hasMagic(extension, candidate.bytes)) {
    throw new ApiError(400, "FILE_INVALID", `“${filename}” is not a valid .${extension} file.`);
  }
  return { filename, mimeType: expectedMime, extension };
}

// ---------------------------------------------------------------------------
// Firm-side link management
// ---------------------------------------------------------------------------

export interface PortalLinkView {
  id: string;
  label: string | null;
  prefix: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  state: PortalLinkState;
}

export interface PortalUploadView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  note: string | null;
  uploadedAt: string;
}

type TokenRow = {
  id: string;
  organizationId: string;
  engagementId: string;
  tokenPrefix: string;
  label: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function toLinkView(row: TokenRow): PortalLinkView {
  return {
    id: row.id,
    label: row.label,
    prefix: row.tokenPrefix,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    state: portalLinkState(row),
  };
}

async function requireLinkManager(ctx: AuthContext, engagementId: string): Promise<PracticeRole> {
  const { role } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!canManageAccess(role)) {
    throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can manage client portal links.");
  }
  return role;
}

/**
 * Mint a client link. The raw token is returned here and nowhere else; the
 * database only keeps its hash.
 */
export async function createPortalLink(
  ctx: AuthContext,
  engagementId: string,
  input: { label?: string | null; expiresInDays?: number } = {},
): Promise<PortalLinkView & { raw: string }> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  await requireLinkManager(ctx, engagementId);

  const requestedDays = Number.isFinite(input.expiresInDays) ? Math.floor(input.expiresInDays as number) : DEFAULT_PORTAL_DAYS;
  const days = Math.min(Math.max(requestedDays, 1), MAX_PORTAL_DAYS);
  const label = input.label?.trim().slice(0, 120) || null;
  const { raw, hash, prefix } = newPortalToken();

  const row = await prisma.clientPortalToken.create({
    data: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      tokenHash: hash,
      tokenPrefix: prefix,
      label,
      createdById: ctx.user.id,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    },
  });

  return { ...toLinkView(row), raw };
}

/** Links for one engagement (hashes never leave the server). */
export async function listPortalLinks(ctx: AuthContext, engagementId: string): Promise<PortalLinkView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.clientPortalToken.findMany({
    where: { engagementId: engagement.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(toLinkView);
}

export async function revokePortalLink(
  ctx: AuthContext,
  engagementId: string,
  tokenId: string,
): Promise<PortalLinkView> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  await requireLinkManager(ctx, engagementId);

  const row = await prisma.clientPortalToken.findFirst({
    where: { id: tokenId, engagementId: engagement.id },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Portal link not found.");
  const updated = row.revokedAt
    ? row
    : await prisma.clientPortalToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return toLinkView(updated);
}

/** Documents the client has uploaded for this engagement. */
export async function listPortalUploads(ctx: AuthContext, engagementId: string): Promise<PortalUploadView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.clientPortalUpload.findMany({
    where: { engagementId: engagement.id },
    orderBy: { uploadedAt: "desc" },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    note: row.note,
    uploadedAt: row.uploadedAt.toISOString(),
  }));
}

export interface PortalUploadFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Read one client upload for a firm member. The lookup is scoped to the
 * engagement, so an upload id from another client can never be fetched even by
 * a firm-wide admin.
 */
export async function readPortalUpload(
  ctx: AuthContext,
  engagementId: string,
  uploadId: string,
): Promise<PortalUploadFile> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const row = await prisma.clientPortalUpload.findFirst({
    where: { id: uploadId, engagementId: engagement.id },
    select: { filename: true, mimeType: true, storageKey: true },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Upload not found.");
  return {
    filename: row.filename,
    mimeType: row.mimeType,
    bytes: await readFile(row.storageKey),
  };
}

// ---------------------------------------------------------------------------
// Public (token-addressed) access
// ---------------------------------------------------------------------------

export interface PortalTokenContext {
  token: TokenRow;
  engagement: { id: string; name: string; code: string | null; organizationId: string; status: string };
}

function invalidLink(): ApiError {
  // Deliberately indistinguishable: revoked, expired and unknown all look the
  // same to someone guessing, so the portal is not a token oracle.
  return new ApiError(404, "PORTAL_LINK_INVALID", "This client link is invalid or has expired.");
}

/**
 * Resolve a raw token to its engagement, or throw a uniform 404. Also records a
 * best-effort last-used timestamp (never allowed to fail the request).
 */
export async function resolvePortalToken(raw: string): Promise<PortalTokenContext> {
  if (!raw || raw.length < 20 || raw.length > 200) throw invalidLink();
  const token = await prisma.clientPortalToken.findUnique({
    where: { tokenHash: hashPortalToken(raw) },
    include: {
      engagement: {
        select: { id: true, name: true, code: true, organizationId: true, status: true },
      },
    },
  });
  if (!token) throw invalidLink();
  if (token.revokedAt) throw invalidLink();
  if (token.expiresAt.getTime() <= Date.now()) throw invalidLink();
  if (token.engagement.status === "ARCHIVED") throw invalidLink();

  void prisma.clientPortalToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    token: {
      id: token.id,
      organizationId: token.organizationId,
      engagementId: token.engagementId,
      tokenPrefix: token.tokenPrefix,
      label: token.label,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
      lastUsedAt: token.lastUsedAt,
      createdAt: token.createdAt,
    },
    engagement: token.engagement,
  };
}

export interface PortalSnapshot {
  engagement: { name: string; code: string | null };
  firmName: string;
  linkExpiresAt: string;
  deliverables: {
    id: string;
    formatCode: string;
    label: string;
    revision: number;
    issuedAt: string | null;
    udin: string | null;
    documentReference: string | null;
  }[];
  uploads: {
    id: string;
    filename: string;
    sizeBytes: number;
    note: string | null;
    uploadedAt: string;
  }[];
  /** Open document requests the firm created for this engagement. */
  requests: {
    id: string;
    title: string;
    category: string;
    period: string | null;
    dueDate: string;
    notes: string | null;
  }[];
  /** Generated statutory obligations for this client, minus the settled ones. */
  compliance: {
    id: string;
    title: string;
    authority: string;
    period: string;
    dueDate: string;
    /** overdue | due-soon | upcoming */
    state: string;
  }[];
  /** Filing work the client can see: reviewed, approved, filed or acknowledged. */
  filings: {
    id: string;
    title: string;
    authority: string;
    dueDate: string;
    stage: string;
    acknowledgementReference: string | null;
    /** True only while the filing is waiting for the client's approval. */
    canApprove: boolean;
    /** Set once the firm reconciled the submission with the portal. */
    verificationStatus: string;
    verificationNote: string | null;
    filedAt: string | null;
    /** When this client approved, and the receipt digest they can hold. */
    clientApprovedAt: string | null;
    clientApprovalDigest: string | null;
  }[];
  /** Client invoices, including the ones already settled. */
  invoices: {
    id: string;
    number: string;
    issuedOn: string;
    dueDate: string;
    totalMinor: number;
    status: string;
    paidOn: string | null;
    paymentReference: string | null;
  }[];
  /** Running account statement: invoices debit, payments credit. */
  statement: ClientStatementRow[];
  /** Issued and unpaid, in paise. */
  balanceMinor: number;
  payments: { enabled: boolean; keyId: string | null };
}

export interface ClientStatementRow {
  date: string;
  kind: "invoice" | "payment";
  reference: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface StatementSourceInvoice {
  id: string;
  number: string;
  issuedOn: string;
  totalMinor: number;
  status: string;
  paidOn: string | null;
  paymentReference: string | null;
}

/**
 * Build the client's account statement from the same invoice rows they can see.
 * An invoice debits on its issue date; a settled invoice credits on the date the
 * money arrived. Void invoices never appear. The running balance is the honest
 * answer to "what do I owe you", not a separate ledger that could drift.
 */
export function buildClientStatement(invoices: StatementSourceInvoice[]): ClientStatementRow[] {
  const rows: Omit<ClientStatementRow, "balanceMinor">[] = [];
  for (const invoice of invoices) {
    if (invoice.status === "void") continue;
    rows.push({
      date: invoice.issuedOn,
      kind: "invoice",
      reference: invoice.number,
      description: `Invoice ${invoice.number}`,
      debitMinor: invoice.totalMinor,
      creditMinor: 0,
    });
    if (invoice.status === "paid" && invoice.paidOn) {
      rows.push({
        date: invoice.paidOn,
        kind: "payment",
        reference: invoice.paymentReference ?? invoice.number,
        description: `Payment received — ${invoice.number}`,
        debitMinor: 0,
        creditMinor: invoice.totalMinor,
      });
    }
  }
  rows.sort((a, b) => (a.date === b.date ? (a.kind === b.kind ? 0 : a.kind === "invoice" ? -1 : 1) : a.date.localeCompare(b.date)));

  let balance = 0;
  return rows.map((row) => {
    balance += row.debitMinor - row.creditMinor;
    return { ...row, balanceMinor: balance };
  });
}

/**
 * The client's own statutory calendar, generated from the stored profile.
 *
 * Only unsettled obligations are returned — a filed/waived task is history, not
 * a reminder. A missing or malformed profile yields an empty list rather than a
 * conservative guess: the firm must confirm the registration facts first.
 */
const COMPLIANCE_ENTITY_KINDS = new Set(["company", "llp", "partnership", "proprietorship", "trust", "individual"]);
const COMPLIANCE_GST_FREQUENCIES = new Set(["monthly", "quarterly"]);

type StoredComplianceProfile = Omit<ClientComplianceProfileInput, "clientId" | "clientName">;

function readStoredProfile(raw: string | null): StoredComplianceProfile | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.entityKind !== "string" || !COMPLIANCE_ENTITY_KINDS.has(value.entityKind)) return null;
  if (typeof value.gstFrequency !== "string" || !COMPLIANCE_GST_FREQUENCIES.has(value.gstFrequency)) return null;
  return parsed as StoredComplianceProfile;
}

/** Pure: tasks + recorded statuses → the rows a client should see. */
export function buildPortalCompliance(input: {
  profile: string | null;
  clientId: string;
  clientName: string;
  statuses: { taskId: string; status: string }[];
  today: string;
  limit?: number;
}): PortalSnapshot["compliance"] {
  const profile = readStoredProfile(input.profile);
  if (!profile) return [];

  const statusByTask = new Map<string, "filed" | "waived" | null>(
    input.statuses.map((row) => [
      row.taskId,
      row.status === "filed" || row.status === "waived" ? (row.status as "filed" | "waived") : null,
    ]),
  );

  let tasks: ComplianceTask[];
  try {
    tasks = buildClientComplianceCalendar({
      ...profile,
      clientId: input.clientId,
      clientName: input.clientName,
      financialYear: profile.financialYear || financialYearFor(input.today),
    });
  } catch {
    return [];
  }

  return tasks
    .map((task) => ({
      id: task.id,
      title: task.title,
      authority: task.authority,
      period: task.period,
      dueDate: task.dueDate,
      state: complianceTaskState(task.dueDate, input.today, statusByTask.get(task.id) ?? null),
    }))
    .filter((task) => task.state !== "filed" && task.state !== "waived")
    .slice(0, input.limit ?? 12);
}

/**
 * A client may approve only a reviewed filing. Prepared/computed work is still
 * internal, and anything already approved must not be approvable twice.
 */
export function canClientApprove(stage: string): boolean {
  return stage === "reviewed";
}

/** What the client sees on opening their link. Issued client deliverables only. */
export async function getPortalSnapshot(raw: string): Promise<PortalSnapshot> {
  const { token, engagement } = await resolvePortalToken(raw);

  const [organization, deliverables, uploads, requests, filings, invoices, complianceProfile, complianceStatuses] =
    await Promise.all([
    prisma.organization.findUnique({ where: { id: token.organizationId }, select: { name: true } }),
    prisma.engagementDeliverableVersion.findMany({
      where: {
        engagementId: engagement.id,
        variant: "CLIENT",
        status: "ISSUED",
      },
      select: {
        id: true,
        formatCode: true,
        revision: true,
        issuedAt: true,
        udin: true,
        documentReference: true,
        format: { select: { label: true } },
      },
      orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
    prisma.clientPortalUpload.findMany({
      where: { engagementId: engagement.id, tokenId: token.id },
      select: { id: true, filename: true, sizeBytes: true, note: true, uploadedAt: true },
      orderBy: { uploadedAt: "desc" },
      take: 50,
    }),
    prisma.clientDocumentRequest.findMany({
      where: { engagementId: engagement.id, status: "requested" },
      select: { id: true, title: true, category: true, period: true, dueDate: true, notes: true },
      orderBy: { dueDate: "asc" },
      take: 50,
    }),
    prisma.complianceFilingRun.findMany({
      where: {
        engagementId: engagement.id,
        stage: { in: ["reviewed", "client-approved", "filed", "acknowledged"] },
      },
      select: {
        id: true,
        title: true,
        authority: true,
        dueDate: true,
        stage: true,
        acknowledgementReference: true,
        verificationStatus: true,
        verificationNote: true,
        filedAt: true,
        clientApprovedAt: true,
        clientApprovalDigest: true,
      },
      orderBy: { dueDate: "asc" },
      take: 50,
    }),
    prisma.practiceInvoice.findMany({
      where: { engagementId: engagement.id, status: { in: ["issued", "paid"] } },
      select: {
        id: true,
        number: true,
        issuedOn: true,
        dueDate: true,
        totalMinor: true,
        status: true,
        paidOn: true,
        paymentReference: true,
      },
      orderBy: { issuedOn: "desc" },
      take: 100,
    }),
    prisma.clientComplianceProfile.findUnique({
      where: { engagementId: engagement.id },
      select: { profile: true },
    }),
    prisma.clientComplianceStatus.findMany({
      where: { engagementId: engagement.id },
      select: { taskId: true, status: true },
    }),
  ]);

  return {
    engagement: { name: engagement.name, code: engagement.code },
    firmName: organization?.name ?? "Your CA firm",
    linkExpiresAt: token.expiresAt.toISOString(),
    deliverables: deliverables.map((d) => ({
      id: d.id,
      formatCode: d.formatCode,
      label: d.format?.label ?? d.formatCode,
      revision: d.revision,
      issuedAt: d.issuedAt ? d.issuedAt.toISOString() : null,
      udin: d.udin,
      documentReference: d.documentReference,
    })),
    uploads: uploads.map((u) => ({
      id: u.id,
      filename: u.filename,
      sizeBytes: u.sizeBytes,
      note: u.note,
      uploadedAt: u.uploadedAt.toISOString(),
    })),
    requests,
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      issuedOn: invoice.issuedOn,
      dueDate: invoice.dueDate,
      totalMinor: invoice.totalMinor,
      status: invoice.status,
      paidOn: invoice.paidOn,
      paymentReference: invoice.paymentReference,
    })),
    compliance: buildPortalCompliance({
      profile: complianceProfile?.profile ?? null,
      clientId: engagement.id,
      clientName: engagement.name,
      statuses: complianceStatuses,
      today: new Date().toISOString().slice(0, 10),
    }),
    statement: buildClientStatement(invoices),
    balanceMinor: invoices
      .filter((invoice) => invoice.status === "issued")
      .reduce((sum, invoice) => sum + invoice.totalMinor, 0),
    payments: { enabled: razorpayConfigured(), keyId: razorpayPublicKey() },
    filings: filings.map((filing) => ({
      id: filing.id,
      title: filing.title,
      authority: filing.authority,
      dueDate: filing.dueDate,
      stage: filing.stage,
      acknowledgementReference: filing.acknowledgementReference,
      canApprove: canClientApprove(filing.stage),
      verificationStatus: filing.verificationStatus,
      verificationNote: filing.verificationNote,
      filedAt: filing.filedAt ? filing.filedAt.toISOString() : null,
      clientApprovedAt: filing.clientApprovedAt ? filing.clientApprovedAt.toISOString() : null,
      clientApprovalDigest: filing.clientApprovalDigest,
    })),
  };
}

export interface PortalPaymentOrder {
  orderId: string;
  amountMinor: number;
  currency: string;
  keyId: string;
  invoiceNumber: string;
}

/**
 * Start an online payment for one of the client's own issued invoices.
 * The amount is the stored invoice total — the request cannot choose it.
 */
export async function payPortalInvoice(raw: string, invoiceId: string): Promise<PortalPaymentOrder> {
  const { engagement } = await resolvePortalToken(raw);
  const invoice = await prisma.practiceInvoice.findFirst({
    where: { id: invoiceId, engagementId: engagement.id },
    select: { id: true, number: true, totalMinor: true, status: true, razorpayOrderId: true },
  });
  if (!invoice) throw new ApiError(404, "NOT_FOUND", "Invoice not found.");
  if (invoice.status === "paid") {
    throw new ApiError(409, "ALREADY_PAID", "This invoice has already been paid. No second payment is needed.");
  }
  if (invoice.status !== "issued") {
    throw new ApiError(409, "INVALID_TRANSITION", "This invoice is not payable.");
  }
  if (!razorpayConfigured()) {
    throw new ApiError(
      503,
      "PAYMENTS_NOT_CONFIGURED",
      "Online payment is not enabled for this firm. Pay by bank transfer and ask your CA firm to record the receipt.",
    );
  }

  const order = await createInvoiceOrder({
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    totalMinor: invoice.totalMinor,
  });
  if (invoice.razorpayOrderId !== order.id) {
    await prisma.practiceInvoice.update({ where: { id: invoice.id }, data: { razorpayOrderId: order.id } });
  }

  return {
    orderId: order.id,
    amountMinor: order.amount,
    currency: order.currency,
    keyId: razorpayPublicKey() ?? "",
    invoiceNumber: invoice.number,
  };
}

/**
 * Verify the Razorpay checkout callback for a client invoice and settle it.
 * Idempotent for the same payment id; a different payment on an already-paid
 * invoice is refused rather than silently creating a second receipt.
 */
export async function verifyPortalInvoicePayment(
  raw: string,
  invoiceId: string,
  input: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string },
): Promise<{ invoiceId: string; status: string; paidOn: string }> {
  const { engagement } = await resolvePortalToken(raw);
  const invoice = await prisma.practiceInvoice.findFirst({
    where: { id: invoiceId, engagementId: engagement.id },
    select: { id: true, status: true, razorpayOrderId: true, razorpayPaymentId: true, issuedOn: true },
  });
  if (!invoice) throw new ApiError(404, "NOT_FOUND", "Invoice not found.");

  if (invoice.status === "paid") {
    if (invoice.razorpayPaymentId === input.razorpayPaymentId) {
      return { invoiceId: invoice.id, status: "paid", paidOn: new Date().toISOString().slice(0, 10) };
    }
    throw new ApiError(409, "ALREADY_PAID", "This invoice has already been paid.");
  }
  if (invoice.status !== "issued") {
    throw new ApiError(409, "INVALID_TRANSITION", "This invoice is not payable.");
  }
  if (invoice.razorpayOrderId && invoice.razorpayOrderId !== input.razorpayOrderId) {
    throw new ApiError(409, "ORDER_MISMATCH", "That payment does not belong to this invoice.");
  }

  const secret = serverEnv().RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new ApiError(503, "PAYMENTS_NOT_CONFIGURED", "Online payment is not configured on this deployment.");
  }
  if (!verifyCheckoutSignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature, secret)) {
    throw new ApiError(
      400,
      "PAYMENT_SIGNATURE_INVALID",
      "The payment could not be verified. Nothing was marked as paid — no money should be sent again until your firm confirms.",
    );
  }

  const paidOn = new Date().toISOString().slice(0, 10);
  await prisma.practiceInvoice.update({
    where: { id: invoice.id },
    data: {
      status: "paid",
      paidOn,
      paymentReference: input.razorpayPaymentId.slice(0, 120),
      paymentMethod: "razorpay",
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId.slice(0, 120),
    },
  });
  return { invoiceId: invoice.id, status: "paid", paidOn };
}

/**
 * The client approves a reviewed filing from their portal link.
 *
 * The approval is recorded as a filing event attributed to the portal token,
 * so the firm's audit trail shows a client decision rather than an internal
 * manager click. Already-approved runs are idempotent; anything earlier than
 * `reviewed` is refused because the work has not been reviewed yet.
 */
export interface PortalFilingApprovalResult {
  id: string;
  title: string;
  stage: string;
  /** Portable evidence of this exact approval; null on an idempotent re-read. */
  receipt: PortalApprovalReceipt | null;
}

/**
 * The signed-in client the approval is attributed to. Passed by the route from
 * the portal session cookie — never from the request body, so a client cannot
 * claim someone else's identity.
 */
export interface PortalApprovalActor {
  accountId: string;
  engagementId: string;
  email: string;
  name: string | null;
}

export async function approveFilingRunFromPortal(
  raw: string,
  runId: string,
  note?: string | null,
  approvedBy?: string | null,
  actor?: PortalApprovalActor | null,
): Promise<PortalFilingApprovalResult> {
  const { token, engagement } = await resolvePortalToken(raw);
  const run = await prisma.complianceFilingRun.findFirst({
    where: { id: runId, engagementId: engagement.id },
    select: {
      id: true,
      taskId: true,
      title: true,
      authority: true,
      dueDate: true,
      stage: true,
      clientApprovalReceipt: true,
    },
  });
  if (!run) throw new ApiError(404, "NOT_FOUND", "That filing is not part of this portal.");
  if (run.stage === "client-approved") {
    // Approving twice must not mint a second receipt: return the stored one, so
    // the digest the client holds keeps matching the database.
    return {
      id: run.id,
      title: run.title,
      stage: run.stage,
      receipt: (run.clientApprovalReceipt as unknown as PortalApprovalReceipt | null) ?? null,
    };
  }
  if (!canClientApprove(run.stage)) {
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      "This filing is not waiting for your approval. Ask your CA firm for its current status.",
    );
  }

  const approvedAt = new Date().toISOString();
  // A session for a DIFFERENT engagement cannot upgrade this approval: the
  // link still proves possession, but only the matching account proves who.
  const signedIn = actor && actor.engagementId === engagement.id ? actor : null;
  const identity = signedIn ? ("magic-link" as const) : ("portal-link" as const);
  const actorLabel = signedIn?.name?.trim() || signedIn?.email || null;
  const receipt = buildPortalApprovalReceipt({
    run: {
      id: run.id,
      taskId: run.taskId,
      title: run.title,
      authority: run.authority,
      dueDate: run.dueDate,
    },
    engagement: {
      id: engagement.id,
      name: engagement.name,
      organizationId: token.organizationId,
    },
    approval: {
      stage: "client-approved",
      approvedAt,
      approvedBy: approvedBy?.trim().slice(0, 120) || actorLabel,
      note: note?.trim().slice(0, 1000) || null,
      tokenId: token.id,
      identity,
      accountId: signedIn?.accountId ?? null,
    },
  });

  // Signs with the external service when one is configured; refuses rather than
  // silently storing an unsigned receipt after the firm opted into signing.
  const signedReceipt = await signApprovalReceipt(receipt);

  await prisma.$transaction([
    prisma.complianceFilingRun.update({
      where: { id: run.id },
      data: {
        stage: "client-approved",
        clientApprovedAt: new Date(approvedAt),
        clientApprovalDigest: signedReceipt.digest,
        clientApprovalReceipt: signedReceipt as unknown as Prisma.InputJsonValue,
        updatedById: signedIn ? `client:${signedIn.accountId}` : `portal:${token.id}`,
      },
    }),
    prisma.complianceFilingEvent.create({
      data: {
        runId: run.id,
        organizationId: token.organizationId,
        fromStage: "reviewed",
        toStage: "client-approved",
        note:
          [
            approvedBy?.trim() ? `Approved by ${approvedBy.trim()}.` : "Approved by the client through the portal.",
            signedIn ? `Signed in as ${signedIn.email}.` : null,
            note?.trim(),
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1000) || null,
        actorId: signedIn ? `client:${signedIn.accountId}` : `portal:${token.id}`,
      },
    }),
  ]);

  return { id: run.id, title: run.title, stage: "client-approved", receipt: signedReceipt };
}

/**
 * Read the client's own approval receipt back. Scoped by the portal token, so a
 * link can never read another engagement's evidence.
 */
export async function getPortalFilingApprovalReceipt(
  raw: string,
  runId: string,
): Promise<{ receipt: unknown; digest: string | null; approvedAt: string | null }> {
  const { engagement } = await resolvePortalToken(raw);
  const run = await prisma.complianceFilingRun.findFirst({
    where: { id: runId, engagementId: engagement.id },
    select: { clientApprovalReceipt: true, clientApprovalDigest: true, clientApprovedAt: true },
  });
  if (!run || !run.clientApprovalReceipt) {
    throw new ApiError(404, "NO_APPROVAL_RECEIPT", "No approval receipt is stored for this filing.");
  }
  return {
    receipt: run.clientApprovalReceipt,
    digest: run.clientApprovalDigest,
    approvedAt: run.clientApprovedAt ? run.clientApprovedAt.toISOString() : null,
  };
}

export interface PortalDeliverableView {
  versionId: string;
  formatCode: string;
  formatLabel: string;
  revision: number;
  issuedAt: string | null;
  udin: string | null;
  documentReference: string | null;
  contentHash: string;
  assembledBody: string;
  parts: { heading: string; body: string }[];
}

/** Render one issued client deliverable. Anything else is a 404. */
export async function getPortalDeliverable(
  raw: string,
  versionId: string,
): Promise<PortalDeliverableView> {
  const { engagement } = await resolvePortalToken(raw);
  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId: engagement.id },
    select: { id: true, variant: true, status: true, issuedAt: true, udin: true, documentReference: true },
  });
  // The single tested visibility rule applies here too — a draft or reviewer
  // copy is not merely hidden from the list, it is unreachable by id.
  if (!version || !portalDeliverableVisible(version)) {
    throw new ApiError(404, "NOT_FOUND", "Deliverable not found.");
  }

  const rendered = await renderDeliverableVersion({
    engagementId: engagement.id,
    versionId: version.id,
    variant: "CLIENT",
  });
  if (!rendered) throw new ApiError(404, "NOT_FOUND", "Deliverable not found.");

  return {
    versionId: rendered.versionId,
    formatCode: rendered.formatCode,
    formatLabel: rendered.formatLabel,
    revision: rendered.revision,
    issuedAt: version.issuedAt ? version.issuedAt.toISOString() : null,
    udin: version.udin,
    documentReference: version.documentReference,
    contentHash: rendered.contentHash,
    assembledBody: rendered.assembledBody,
    // Deliberately omit source/sourceRef/traceability: the client sees the
    // document body, not the firm's internal binder references.
    parts: rendered.parts.map((part) => ({ heading: part.heading, body: part.body })),
  };
}

export interface PortalUploadResult extends PortalUploadView {
  /** The document request this upload answered, if the client selected one. */
  fulfilledRequestId: string | null;
}

/**
 * Accept, validate and store a client upload, attributed to the link used.
 *
 * When the client selects an open document request, the upload and the request's
 * move to `received` happen in one transaction: the firm never sees a closed
 * request without the answering file, and never a file that silently leaves the
 * request open. The link proves the engagement, so a request id from another
 * client is rejected before anything is written.
 */
export async function savePortalUpload(
  raw: string,
  input: {
    bytes: Buffer;
    filename: string;
    mimeType: string;
    note?: string | null;
    requestId?: string | null;
  },
): Promise<PortalUploadResult> {
  const { token, engagement } = await resolvePortalToken(raw);
  const accepted = validatePortalUpload({
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.length,
    bytes: input.bytes,
  });

  const requestId = input.requestId?.trim() || null;
  if (requestId) {
    const open = await prisma.clientDocumentRequest.findFirst({
      where: { id: requestId, engagementId: engagement.id, status: "requested" },
      select: { id: true },
    });
    if (!open) throw new ApiError(404, "NOT_FOUND", "That document request is no longer open.");
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const key = `portal/${token.organizationId}/${engagement.id}/${Date.now()}-${sha256.slice(0, 12)}.${accepted.extension}`;
  await saveFile(key, input.bytes);

  const note = input.note?.trim().slice(0, 1000) || null;
  const row = await prisma.$transaction(async (tx) => {
    const upload = await tx.clientPortalUpload.create({
      data: {
        organizationId: token.organizationId,
        engagementId: engagement.id,
        tokenId: token.id,
        filename: accepted.filename,
        mimeType: accepted.mimeType,
        sizeBytes: input.bytes.length,
        storageKey: key,
        sha256,
        note,
      },
    });
    if (requestId) {
      await tx.clientDocumentRequest.updateMany({
        where: { id: requestId, engagementId: engagement.id, status: "requested" },
        data: { status: "received", receivedAt: new Date(), fulfilledByUploadId: upload.id },
      });
    }
    return upload;
  });

  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    note: row.note,
    uploadedAt: row.uploadedAt.toISOString(),
    fulfilledRequestId: requestId,
  };
}
