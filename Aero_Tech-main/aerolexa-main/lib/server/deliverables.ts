// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - deliverables versioning is a deployment-wide aggregate operation
import { ApiError, forbiddenError, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson, stringifyJson } from "@/lib/json";
import type { EngagementRow, PracticeRole } from "@/lib/server/engagement";
import {
  canPrepareWork,
  canReview,
  canSignOff,
  redactSensitiveValue,
  stableToken,
  type SensitiveCategory,
} from "@/lib/server/engagement";
import { requireEngagementRole } from "@/lib/server/engagement";
import { appendLedgerEntry, contentHash } from "@/lib/server/governance";
import { requireOrgRole } from "@/lib/server/members";
import type {
  DeliverableFormatCategory,
  DeliverableFormatCode,
  DeliverablePartKind,
  DeliverableSignOffStep,
  DeliverableSourceKind,
  DeliverableStatus,
  DeliverableVariant,
  RedactionPolicy,
  ReportTemplateBody,
  ReportTemplatePartSpec,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Format catalogue — the kinds of deliverable an Indian CA practice issues.
// ---------------------------------------------------------------------------

export interface DeliverableFormatDef {
  code: DeliverableFormatCode;
  label: string;
  category: DeliverableFormatCategory;
  description: string;
  /** Statutory/standards anchor rendered as a badge in the UI. */
  anchor: string;
  defaultVariant: DeliverableVariant;
  /** Whether the format is a document a partner signs off on (vs. internal). */
  signable: boolean;
}

export const DELIVERABLE_FORMATS: readonly DeliverableFormatDef[] = [
  {
    code: "FINANCIALS",
    label: "Financial Statements",
    category: "FINANCIALS",
    description: "Complete financial statements with auditor's report, primary statements and notes.",
    anchor: "SA 700 / Companies Act s.143",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "PROFIT_LOSS",
    label: "Statement of Profit and Loss",
    category: "FINANCIALS",
    description: "Statement of profit and loss as part of the financial statements.",
    anchor: "Schedule III, Companies Act 2013",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "BALANCE_SHEET",
    label: "Balance Sheet",
    category: "FINANCIALS",
    description: "Balance sheet (statement of assets and liabilities).",
    anchor: "Schedule III, Companies Act 2013",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "NOTES",
    label: "Notes to Accounts",
    category: "FINANCIALS",
    description: "Notes to the financial statements forming part of the accounts.",
    anchor: "Schedule III / Accounting Standards",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "SCHEDULES",
    label: "Schedules & Annexures",
    category: "FINANCIALS",
    description: "Supporting schedules and annexures referenced from the statements.",
    anchor: "Schedule III",
    defaultVariant: "CLIENT",
    signable: false,
  },
  {
    code: "MGMT_LETTER",
    label: "Management Letter",
    category: "AUDIT",
    description: "Audit findings and internal-control observations communicated to management.",
    anchor: "SA 260 / SA 265",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "TAX_COMPUTATION",
    label: "Tax Computation",
    category: "TAX",
    description: "Computation of total income and tax liability for the relevant assessment year.",
    anchor: "Income-tax Act, 1961",
    defaultVariant: "REVIEWER",
    signable: false,
  },
  {
    code: "CERTIFICATE_44AB",
    label: "Audit Report u/s 44AB (Form 3CB/3CD)",
    category: "CERTIFICATE",
    description: "Tax audit report and statements under section 44AB.",
    anchor: "s.44AB / Form 3CB-3CD",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "CERTIFICATE_44ADA",
    label: "Certificate u/s 44ADA",
    category: "CERTIFICATE",
    description: "Presumptive taxation certificate for eligible professionals.",
    anchor: "s.44ADA",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "CERTIFICATE_44AD",
    label: "Certificate u/s 44AD",
    category: "CERTIFICATE",
    description: "Presumptive taxation certificate for eligible businesses.",
    anchor: "s.44AD",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "TAX_CONCLUSION",
    label: "Tax Conclusion Memo",
    category: "TAX",
    description: "Internal conclusion memo tying the tax position to the working papers.",
    anchor: "Firm methodology",
    defaultVariant: "REVIEWER",
    signable: false,
  },
  {
    code: "AUDIT_FINDINGS",
    label: "Audit Findings Summary",
    category: "AUDIT",
    description: "Consolidated findings and their disposition across the audit.",
    anchor: "SA 230 / SA 240",
    defaultVariant: "REVIEWER",
    signable: false,
  },
  {
    code: "MANAGING_AGENT_LETTER",
    label: "Managing Agent Letter",
    category: "LETTER",
    description: "Formal letter issued by the signing partner in the managing-agent capacity.",
    anchor: "Client instruction",
    defaultVariant: "CLIENT",
    signable: true,
  },
  {
    code: "LETTER_TO_CLIENT",
    label: "Letter to Client",
    category: "LETTER",
    description: "General correspondence issued to the client with the deliverable.",
    anchor: "Client instruction",
    defaultVariant: "CLIENT",
    signable: true,
  },
];

const FORMAT_BY_CODE: Record<string, DeliverableFormatDef> = Object.fromEntries(
  DELIVERABLE_FORMATS.map((f) => [f.code, f]),
);

export function deliverableFormatDef(code: string): DeliverableFormatDef | null {
  return FORMAT_BY_CODE[code] ?? null;
}

// ---------------------------------------------------------------------------
// Built-in default template bodies (the firm's starting skeleton)
// ---------------------------------------------------------------------------

const SA700_REPORTING_LANGUAGE = `We have audited the accompanying financial statements of **^^ENGAGEMENT_NAME^^**, which comprise the Balance Sheet as at ^^DATE_LABEL^^, the Statement of Profit and Loss and the Cash Flow Statement for the period then ended, and a summary of significant accounting policies and other explanatory information.

In our opinion and to the best of our information and according to the explanations given to us, the aforesaid financial statements give the information required by the Companies Act, 2013 in the manner so required and give a true and fair view in conformity with the accounting standards.

Basis for Opinion — We conducted our audit in accordance with the Standards on Auditing issued by the Institute of Chartered Accountants of India. Our responsibilities under those Standards are further described in the Auditor's Responsibilities section.

For **^^FIRM_NAME^^**
Chartered Accountants
Firm Registration No.: ^^FIRM_REG_NO^^

**^^SIGNATORY_NAME^^**
^^SIGNATORY_DESIGNATION^^
Membership No.: ^^SIGNATORY_MEMBERSHIP^^
Place: ^^PLACE^^
Date: ^^DATE_LABEL^^`;

function defaultTemplateBody(code: string): ReportTemplateBody {
  const def = FORMAT_BY_CODE[code];
  const label = def?.label ?? code;
  const parts: ReportTemplatePartSpec[] = [
    {
      kind: "COVER",
      ref: "COVER",
      heading: label,
      body: `**^^FIRM_NAME^^**\n^^FIRM_ADDRESS^^\n\n### ${label}\n\nfor **^^ENGAGEMENT_NAME^^**\n\nPeriod: ^^DATE_LABEL^^`,
    },
  ];

  switch (code) {
    case "FINANCIALS":
      parts.push(
        {
          kind: "REPORTING_LANGUAGE",
          ref: "AR-01",
          heading: "Independent Auditor's Report",
          body: SA700_REPORTING_LANGUAGE,
        },
        {
          kind: "PRIMARY_STATEMENT",
          ref: "A-100",
          heading: "Financial Statements",
          body: "Refer to the attached Balance Sheet, Statement of Profit and Loss and Cash Flow Statement.",
        },
        {
          kind: "NOTE",
          ref: "N-01",
          heading: "Notes to the Financial Statements",
          body: "[Insert the significant accounting policies and notes, each cross-referenced to its working paper.]",
        },
      );
      break;
    case "PROFIT_LOSS":
      parts.push({
        kind: "PRIMARY_STATEMENT",
        ref: "A-110",
        heading: "Statement of Profit and Loss",
        body: "[Insert the statement prepared from the trial balance, tracing each line to a working paper.]",
      });
      break;
    case "BALANCE_SHEET":
      parts.push({
        kind: "PRIMARY_STATEMENT",
        ref: "A-120",
        heading: "Balance Sheet",
        body: "[Insert the balance sheet prepared from the trial balance, tracing each line to a working paper.]",
      });
      break;
    case "NOTES":
      parts.push({
        kind: "NOTE",
        ref: "N-01",
        heading: "Notes to the Financial Statements",
        body: "[Insert the note titles and their disclosed values; every figure should trace to a schedule.]",
      });
      break;
    case "SCHEDULES":
      parts.push({
        kind: "SCHEDULE",
        ref: "S-01",
        heading: "Schedule",
        body: "[Insert the schedule figures and their composition.]",
      });
      break;
    case "MGMT_LETTER":
      parts.push({
        kind: "FINDING",
        ref: "ML-01",
        heading: "Observations",
        body: "[Insert internal-control observations, their risk and management's response.]",
      });
      break;
    case "TAX_COMPUTATION":
      parts.push(
        {
          kind: "TAX_COMPUTATION",
          ref: "TC-01",
          heading: "Computation of Total Income",
          body: "[Insert the computation of business/professional income, deductions and total income.]",
        },
        {
          kind: "TAX_COMPUTATION",
          ref: "TC-02",
          heading: "Computation of Tax Liability",
          body: "[Insert tax on total income, surcharge, cess, TDS/advance tax and net payable/refundable.]",
        },
      );
      break;
    case "CERTIFICATE_44AB":
      parts.push({
        kind: "CERTIFICATE",
        ref: "44AB-01",
        heading: "Audit Report under Section 44AB",
        body: `We have audited the accounts of **^^ENGAGEMENT_NAME^^** for the period ^^DATE_LABEL^^ and report that the particulars required under section 44AB of the Income-tax Act, 1961 are true and correct, as set out in the statements annexed (Form 3CD).\n\nFor **^^FIRM_NAME^^**\nChartered Accountants\n\n**^^SIGNATORY_NAME^^**\n^^SIGNATORY_DESIGNATION^^`,
      });
      break;
    case "CERTIFICATE_44ADA":
      parts.push({
        kind: "CERTIFICATE",
        ref: "44ADA-01",
        heading: "Certificate under Section 44ADA",
        body: `We certify that **^^ENGAGEMENT_NAME^^** is eligible to declare income on a presumptive basis under section 44ADA of the Income-tax Act, 1961 for the period ^^DATE_LABEL^^, and that the prescribed conditions are satisfied.\n\nFor **^^FIRM_NAME^^**\nChartered Accountants\n\n**^^SIGNATORY_NAME^^**\n^^SIGNATORY_DESIGNATION^^`,
      });
      break;
    case "CERTIFICATE_44AD":
      parts.push({
        kind: "CERTIFICATE",
        ref: "44AD-01",
        heading: "Certificate under Section 44AD",
        body: `We certify that **^^ENGAGEMENT_NAME^^** is eligible to declare income on a presumptive basis under section 44AD of the Income-tax Act, 1961 for the period ^^DATE_LABEL^^, and that the prescribed conditions are satisfied.\n\nFor **^^FIRM_NAME^^**\nChartered Accountants\n\n**^^SIGNATORY_NAME^^**\n^^SIGNATORY_DESIGNATION^^`,
      });
      break;
    case "TAX_CONCLUSION":
      parts.push(
        {
          kind: "TAX_COMPUTATION",
          ref: "TC-01",
          heading: "Computation of Total Income",
          body: "[Insert the computation chain.]",
        },
        {
          kind: "NOTE",
          ref: "TE-01",
          heading: "Conclusion & Basis",
          body: "[State the tax position adopted and the working papers it rests on.]",
        },
      );
      break;
    case "AUDIT_FINDINGS":
      parts.push({
        kind: "FINDING",
        ref: "AF-01",
        heading: "Findings",
        body: "[Insert findings, severity and disposition.]",
      });
      break;
    case "MANAGING_AGENT_LETTER":
    case "LETTER_TO_CLIENT":
      parts.push({
        kind: "APPENDIX",
        ref: "L-01",
        heading: "Letter Body",
        body: "[Insert the letter body addressed to the client.]",
      });
      break;
    default:
      parts.push({ kind: "APPENDIX", ref: "X-01", heading: label, body: "[Insert content.]" });
  }

  parts.push({
    kind: "SIGNATURE",
    ref: "SIG",
    heading: "Signature",
    body: `For **^^FIRM_NAME^^**\nChartered Accountants\n\n**^^SIGNATORY_NAME^^**\n^^SIGNATORY_DESIGNATION^^\nPlace: ^^PLACE^^\nDate: ^^DATE_LABEL^^`,
  });

  return { parts, notation: def?.anchor };
}

// ---------------------------------------------------------------------------
// View shapes returned to the API/UI
// ---------------------------------------------------------------------------

export interface AttachmentRef {
  name: string;
  ref?: string;
  kind: "attached" | "workingPaper";
}

export interface EngagementReportFormatView {
  id: string;
  organizationId: string;
  engagementId: string;
  code: string;
  label: string;
  description: string | null;
  status: string;
  defaultVariant: DeliverableVariant;
  clauses: Record<string, string>;
  anchor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportTemplateView {
  id: string;
  organizationId: string;
  engagementId: string | null;
  formatCode: string;
  masterRef: string | null;
  label: string;
  description: string | null;
  firmName: string;
  firmAddress: string;
  signatoryName: string;
  signatoryDesignation: string;
  dateLabel: string;
  body: ReportTemplateBody;
  notes: string[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: string;
  origin: "engagement" | "master";
  createdAt: string;
  updatedAt: string;
}

export interface DeliverablePartView {
  id: string;
  versionId: string;
  kind: DeliverablePartKind | string;
  ref: string | null;
  heading: string;
  bodyMarkdown: string;
  attachments: AttachmentRef[];
  source: DeliverableSourceKind | string | null;
  sourceRef: string | null;
  order: number;
  createdById: string | null;
  createdAt: string;
}

export interface DeliverableSignOffView {
  id: string;
  step: DeliverableSignOffStep | string;
  role: string;
  performedById: string;
  performedAt: string;
  note: string | null;
}

export interface DeliverableRedactionView {
  id: string;
  policy: RedactionPolicy | string;
  appliesTo: string;
  note: string | null;
  effectiveForVariant: string;
  createdAt: string;
}

export interface DeliverableContent {
  formatCode: string;
  formatLabel: string;
  title: string;
  variant: DeliverableVariant;
  revision: number;
  firmName: string;
  firmAddress: string;
  signatoryName: string;
  signatoryDesignation: string;
  dateLabel: string;
  clauses: Record<string, string>;
  notation?: string;
  parts: ReportTemplatePartSpec[];
}

export interface DeliverableVersionView {
  id: string;
  organizationId: string;
  engagementId: string;
  formatId: string;
  formatCode: string;
  formatLabel: string;
  templateId: string | null;
  revision: number;
  status: DeliverableStatus;
  variant: DeliverableVariant;
  issuedAtLabel: string | null;
  filepath: string | null;
  bodyHash: string | null;
  preparedById: string | null;
  preparedAt: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  signedOffById: string | null;
  signedOffAt: string | null;
  signOffRole: string | null;
  issuedById: string | null;
  issuedAt: string | null;
  issuedFor: string | null;
  remarks: string | null;
  content: DeliverableContent | null;
  parts: DeliverablePartView[];
  signOffs: DeliverableSignOffView[];
  redactions: DeliverableRedactionView[];
  ledgerSeq?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableTrace {
  totalParts: number;
  tracedParts: number;
  manualParts: number;
  bySource: Record<string, number>;
  /** Working papers actually referenced by the deliverable's parts. */
  workingPaperRefs: string[];
  complete: boolean;
}

export interface DeliverablePreviewSection {
  heading: string;
  kind: string;
  ref: string | null;
  body: string;
  source: string | null;
  sourceRef: string | null;
  redacted: boolean;
}

export interface DeliverablePreview {
  version: DeliverableVersionView;
  variant: DeliverableVariant;
  title: string;
  sections: DeliverablePreviewSection[];
  trace: DeliverableTrace;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const PLACEHOLDER = /^\^\^[A-Z0-9_]+\^\^$/;

function isPlaceholder(value: string | null | undefined): boolean {
  return !value || PLACEHOLDER.test(value) || value.trim().length === 0;
}

function resolveIdentityField(value: string | null | undefined, fallback: string): string {
  return isPlaceholder(value) ? fallback : (value as string);
}

function resolvePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\^\^([A-Z0-9_]+)\^\^/g, (_m, key: string) => vars[key] ?? _m);
}

function dateLabelFor(at: Date): string {
  return `as on ${at.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}`;
}

function normalizeVariant(value: string | null | undefined): DeliverableVariant {
  return value === "REVIEWER" ? "REVIEWER" : "CLIENT";
}

function normalizePartKind(value: string | null | undefined): DeliverablePartKind | string {
  return value && value.length ? value : "APPENDIX";
}

/** Parse a stored template body defensively. */
function parseTemplateBody(raw: string | null | undefined): ReportTemplateBody {
  const parsed = parseJson<ReportTemplateBody | null>(raw, null);
  if (parsed && Array.isArray(parsed.parts)) {
    return {
      parts: parsed.parts
        .filter((p) => p && typeof p.heading === "string")
        .map((p) => ({
          kind: normalizePartKind(p.kind) as DeliverablePartKind,
          heading: p.heading,
          body: typeof p.body === "string" ? p.body : "",
          ref: p.ref,
        })),
      notation: parsed.notation,
    };
  }
  return { parts: [] };
}

function parseAttachments(raw: string | null | undefined): AttachmentRef[] {
  const parsed = parseJson<AttachmentRef[]>(raw, []);
  return Array.isArray(parsed) ? parsed.filter((a) => a && typeof a.name === "string") : [];
}

async function requireWorkRole(
  ctx: AuthContext,
  engagementId: string,
): Promise<{ role: PracticeRole; engagement: EngagementRow }> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canPrepareWork(role)) throw forbiddenError("Auditors have read-only access to deliverables.");
  return { role, engagement };
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

function formatRowToView(row: {
  id: string;
  organizationId: string;
  engagementId: string;
  code: string;
  label: string;
  description: string | null;
  status: string;
  defaultVariant: string;
  clauses: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EngagementReportFormatView {
  const def = deliverableFormatDef(row.code);
  return {
    id: row.id,
    organizationId: row.organizationId,
    engagementId: row.engagementId,
    code: row.code,
    label: row.label,
    description: row.description,
    status: row.status,
    defaultVariant: normalizeVariant(row.defaultVariant),
    clauses: parseJson<Record<string, string>>(row.clauses, {}),
    anchor: def?.anchor ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Enable every catalogue format for an engagement that has none yet. */
export async function seedEngagementFormats(ctx: AuthContext, engagementId: string): Promise<number> {
  const { engagement } = await requireWorkRole(ctx, engagementId);
  const existing = await prisma.engagementReportFormat.count({ where: { engagementId: engagement.id } });
  if (existing > 0) return 0;
  await prisma.engagementReportFormat.createMany({
    data: DELIVERABLE_FORMATS.map((f) => ({
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      code: f.code,
      label: f.label,
      description: f.description,
      status: "ACTIVE",
      defaultVariant: f.defaultVariant,
      clauses: stringifyJson({ anchor: f.anchor, category: f.category }),
    })),
  });
  return DELIVERABLE_FORMATS.length;
}

export async function listEngagementFormats(
  ctx: AuthContext,
  engagementId: string,
): Promise<EngagementReportFormatView[]> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const count = await prisma.engagementReportFormat.count({ where: { engagementId: engagement.id } });
  if (count === 0 && canPrepareWork(role)) {
    await seedEngagementFormats(ctx, engagementId);
  }
  const rows = await prisma.engagementReportFormat.findMany({
    where: { engagementId: engagement.id },
    orderBy: [{ status: "asc" }, { label: "asc" }],
  });
  return rows.map(formatRowToView);
}

export async function upsertEngagementFormat(
  ctx: AuthContext,
  engagementId: string,
  input: {
    code: string;
    label?: string;
    description?: string | null;
    status?: string;
    defaultVariant?: DeliverableVariant;
    clauses?: Record<string, string>;
  },
): Promise<EngagementReportFormatView> {
  const { engagement } = await requireWorkRole(ctx, engagementId);
  const def = deliverableFormatDef(input.code);
  if (!def) throw new ApiError(400, "VALIDATION", `Unknown report format "${input.code}".`);
  const existing = await prisma.engagementReportFormat.findUnique({
    where: { engagementId_code: { engagementId: engagement.id, code: input.code } },
  });
  const row = existing
    ? await prisma.engagementReportFormat.update({
        where: { id: existing.id },
        data: {
          label: input.label ?? existing.label,
          description: input.description === undefined ? existing.description : input.description,
          status: input.status ?? existing.status,
          defaultVariant: input.defaultVariant ?? existing.defaultVariant,
          clauses: input.clauses ? stringifyJson(input.clauses) : existing.clauses,
        },
      })
    : await prisma.engagementReportFormat.create({
        data: {
          organizationId: engagement.organizationId,
          engagementId: engagement.id,
          code: input.code,
          label: input.label ?? def.label,
          description: input.description ?? def.description,
          status: input.status ?? "ACTIVE",
          defaultVariant: input.defaultVariant ?? def.defaultVariant,
          clauses: stringifyJson(input.clauses ?? { anchor: def.anchor, category: def.category }),
        },
      });
  return formatRowToView(row);
}

export async function retireEngagementFormat(
  ctx: AuthContext,
  engagementId: string,
  formatId: string,
): Promise<EngagementReportFormatView> {
  const { engagement } = await requireWorkRole(ctx, engagementId);
  const existing = await prisma.engagementReportFormat.findFirst({
    where: { id: formatId, engagementId: engagement.id },
  });
  if (!existing) throw notFoundError("Report format not found.");
  const row = await prisma.engagementReportFormat.update({
    where: { id: existing.id },
    data: { status: "RETIRED" },
  });
  return formatRowToView(row);
}

// ---------------------------------------------------------------------------
// Engagement templates
// ---------------------------------------------------------------------------

function templateRowToView(
  row: {
    id: string;
    organizationId: string;
    engagementId: string | null;
    formatCode: string;
    masterRef: string | null;
    label: string;
    description: string | null;
    firmName: string;
    firmAddress: string;
    signatoryName: string;
    signatoryDesignation: string;
    dateLabel: string;
    body: string;
    notes: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  },
  origin: "engagement" | "master",
): ReportTemplateView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    engagementId: row.engagementId,
    formatCode: row.formatCode,
    masterRef: row.masterRef,
    label: row.label,
    description: row.description,
    firmName: row.firmName,
    firmAddress: row.firmAddress,
    signatoryName: row.signatoryName,
    signatoryDesignation: row.signatoryDesignation,
    dateLabel: row.dateLabel,
    body: parseTemplateBody(row.body),
    notes: parseJson<string[]>(row.notes, []),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    status: row.status,
    origin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listEngagementTemplates(
  ctx: AuthContext,
  engagementId: string,
  formatCode?: string,
): Promise<ReportTemplateView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.engagementReportTemplate.findMany({
    where: { engagementId: engagement.id, formatCode: formatCode ?? undefined },
    orderBy: [{ updatedAt: "desc" }],
  });
  return rows.map((r) => templateRowToView(r, "engagement"));
}

export async function createEngagementTemplate(
  ctx: AuthContext,
  engagementId: string,
  input: {
    formatCode: string;
    label: string;
    description?: string | null;
    masterRef?: string | null;
    firmName?: string;
    firmAddress?: string;
    signatoryName?: string;
    signatoryDesignation?: string;
    dateLabel?: string;
    body?: ReportTemplateBody;
    notes?: string[];
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  },
): Promise<ReportTemplateView> {
  const { engagement } = await requireWorkRole(ctx, engagementId);
  if (!deliverableFormatDef(input.formatCode)) {
    throw new ApiError(400, "VALIDATION", `Unknown report format "${input.formatCode}".`);
  }
  if (!input.label?.trim()) throw new ApiError(400, "VALIDATION", "label is required.");

  let master: Awaited<ReturnType<typeof prisma.organizationReportTemplate.findFirst>> | null = null;
  if (input.masterRef) {
    master = await prisma.organizationReportTemplate.findFirst({
      where: { id: input.masterRef, organizationId: engagement.organizationId },
    });
    if (!master) throw notFoundError("Master template not found.");
  }

  const body = input.body ?? (master ? parseTemplateBody(master.body) : defaultTemplateBody(input.formatCode));
  const row = await prisma.engagementReportTemplate.create({
    data: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      formatCode: input.formatCode,
      masterRef: input.masterRef ?? null,
      label: input.label.trim(),
      description: input.description ?? null,
      firmName: input.firmName ?? master?.firmName ?? "^^FIRM_NAME^^",
      firmAddress: input.firmAddress ?? master?.firmAddress ?? "^^FIRM_ADDRESS^^",
      signatoryName: input.signatoryName ?? master?.signatoryName ?? "^^SIGNATORY_NAME^^",
      signatoryDesignation: input.signatoryDesignation ?? master?.signatoryDesignation ?? "^^SIGNATORY_DESIGNATION^^",
      dateLabel: input.dateLabel ?? master?.dateLabel ?? "^^DATE_LABEL^^",
      body: stringifyJson(body),
      notes: input.notes ? stringifyJson(input.notes) : (master?.notes ?? null),
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      status: "ACTIVE",
    },
  });
  return templateRowToView(row, "engagement");
}

export async function updateEngagementTemplate(
  ctx: AuthContext,
  engagementId: string,
  templateId: string,
  input: Partial<{
    label: string;
    description: string | null;
    firmName: string;
    firmAddress: string;
    signatoryName: string;
    signatoryDesignation: string;
    dateLabel: string;
    body: ReportTemplateBody;
    notes: string[];
    effectiveFrom: string | null;
    effectiveTo: string | null;
    status: string;
  }>,
): Promise<ReportTemplateView> {
  const { engagement } = await requireWorkRole(ctx, engagementId);
  const existing = await prisma.engagementReportTemplate.findFirst({
    where: { id: templateId, engagementId: engagement.id },
  });
  if (!existing) throw notFoundError("Template not found.");
  const row = await prisma.engagementReportTemplate.update({
    where: { id: existing.id },
    data: {
      label: input.label?.trim() || existing.label,
      description: input.description === undefined ? existing.description : input.description,
      firmName: input.firmName ?? existing.firmName,
      firmAddress: input.firmAddress ?? existing.firmAddress,
      signatoryName: input.signatoryName ?? existing.signatoryName,
      signatoryDesignation: input.signatoryDesignation ?? existing.signatoryDesignation,
      dateLabel: input.dateLabel ?? existing.dateLabel,
      body: input.body ? stringifyJson(input.body) : existing.body,
      notes: input.notes ? stringifyJson(input.notes) : existing.notes,
      effectiveFrom: input.effectiveFrom === undefined ? existing.effectiveFrom : input.effectiveFrom,
      effectiveTo: input.effectiveTo === undefined ? existing.effectiveTo : input.effectiveTo,
      status: input.status ?? existing.status,
    },
  });
  return templateRowToView(row, "engagement");
}

export async function deleteEngagementTemplate(
  ctx: AuthContext,
  engagementId: string,
  templateId: string,
): Promise<void> {
  const { engagement } = await requireWorkRole(ctx, engagementId);
  const existing = await prisma.engagementReportTemplate.findFirst({
    where: { id: templateId, engagementId: engagement.id },
  });
  if (!existing) throw notFoundError("Template not found.");
  await prisma.engagementReportTemplate.delete({ where: { id: existing.id } });
}

// ---------------------------------------------------------------------------
// Org-level master templates
// ---------------------------------------------------------------------------

async function requireOrgMasterWrite(ctx: AuthContext): Promise<string> {
  if (!ctx.organization) throw notFoundError("Organization not found.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");
  return ctx.organization.id;
}

export async function listOrganizationTemplates(ctx: AuthContext, formatCode?: string): Promise<ReportTemplateView[]> {
  if (!ctx.organization) throw notFoundError("Organization not found.");
  await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
  const rows = await prisma.organizationReportTemplate.findMany({
    where: { organizationId: ctx.organization.id, formatCode: formatCode ?? undefined },
    orderBy: [{ status: "asc" }, { label: "asc" }],
  });
  return rows.map((r) => templateRowToView({ ...r, engagementId: null, masterRef: null }, "master"));
}

export async function createOrganizationTemplate(
  ctx: AuthContext,
  input: {
    formatCode: string;
    label: string;
    description?: string | null;
    firmName?: string;
    firmAddress?: string;
    signatoryName?: string;
    signatoryDesignation?: string;
    dateLabel?: string;
    body?: ReportTemplateBody;
    notes?: string[];
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  },
): Promise<ReportTemplateView> {
  const organizationId = await requireOrgMasterWrite(ctx);
  if (!deliverableFormatDef(input.formatCode)) {
    throw new ApiError(400, "VALIDATION", `Unknown report format "${input.formatCode}".`);
  }
  if (!input.label?.trim()) throw new ApiError(400, "VALIDATION", "label is required.");
  const row = await prisma.organizationReportTemplate.create({
    data: {
      organizationId,
      formatCode: input.formatCode,
      label: input.label.trim(),
      description: input.description ?? null,
      firmName: input.firmName ?? "^^FIRM_NAME^^",
      firmAddress: input.firmAddress ?? "^^FIRM_ADDRESS^^",
      signatoryName: input.signatoryName ?? "^^SIGNATORY_NAME^^",
      signatoryDesignation: input.signatoryDesignation ?? "^^SIGNATORY_DESIGNATION^^",
      dateLabel: input.dateLabel ?? "^^DATE_LABEL^^",
      body: stringifyJson(input.body ?? defaultTemplateBody(input.formatCode)),
      notes: input.notes ? stringifyJson(input.notes) : null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      status: "ACTIVE",
    },
  });
  return templateRowToView({ ...row, engagementId: null, masterRef: null }, "master");
}

export async function updateOrganizationTemplate(
  ctx: AuthContext,
  templateId: string,
  input: Partial<{
    label: string;
    description: string | null;
    firmName: string;
    firmAddress: string;
    signatoryName: string;
    signatoryDesignation: string;
    dateLabel: string;
    body: ReportTemplateBody;
    notes: string[];
    effectiveFrom: string | null;
    effectiveTo: string | null;
    status: string;
  }>,
): Promise<ReportTemplateView> {
  const organizationId = await requireOrgMasterWrite(ctx);
  const existing = await prisma.organizationReportTemplate.findFirst({
    where: { id: templateId, organizationId },
  });
  if (!existing) throw notFoundError("Master template not found.");
  const row = await prisma.organizationReportTemplate.update({
    where: { id: existing.id },
    data: {
      label: input.label?.trim() || existing.label,
      description: input.description === undefined ? existing.description : input.description,
      firmName: input.firmName ?? existing.firmName,
      firmAddress: input.firmAddress ?? existing.firmAddress,
      signatoryName: input.signatoryName ?? existing.signatoryName,
      signatoryDesignation: input.signatoryDesignation ?? existing.signatoryDesignation,
      dateLabel: input.dateLabel ?? existing.dateLabel,
      body: input.body ? stringifyJson(input.body) : existing.body,
      notes: input.notes ? stringifyJson(input.notes) : existing.notes,
      effectiveFrom: input.effectiveFrom === undefined ? existing.effectiveFrom : input.effectiveFrom,
      effectiveTo: input.effectiveTo === undefined ? existing.effectiveTo : input.effectiveTo,
      status: input.status ?? existing.status,
    },
  });
  return templateRowToView({ ...row, engagementId: null, masterRef: null }, "master");
}

export async function deleteOrganizationTemplate(ctx: AuthContext, templateId: string): Promise<void> {
  const organizationId = await requireOrgMasterWrite(ctx);
  const existing = await prisma.organizationReportTemplate.findFirst({
    where: { id: templateId, organizationId },
  });
  if (!existing) throw notFoundError("Master template not found.");
  await prisma.organizationReportTemplate.delete({ where: { id: existing.id } });
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

interface RedactionRule {
  policy: string;
  appliesTo: string;
  effectiveForVariant: string;
}

interface RedactionTargetSpec {
  key: string;
  label: string;
  re: RegExp;
  category?: SensitiveCategory;
}

const REDACTION_TARGETS: RedactionTargetSpec[] = [
  { key: "GSTIN", label: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g, category: "gstin" },
  { key: "PAN", label: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, category: "pan" },
  { key: "TAN", label: "TAN", re: /\b[A-Z]{4}\d{5}[A-Z]\b/g, category: "tan" },
  { key: "CIN", label: "CIN", re: /\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/g, category: "cin" },
  { key: "DIN", label: "DIN", re: /\b\d{8}\b/g, category: "din" },
  { key: "Aadhaar", label: "Aadhaar", re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, category: "aadhaar_partial" },
  { key: "IFSC", label: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  {
    key: "bankAccount",
    label: "Bank account",
    re: /\b\d{9,18}\b/g,
    category: "bank_account_partial",
  },
  { key: "email", label: "Email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { key: "phone", label: "Phone", re: /\b(?:\+91[-\s]?)?[6-9]\d{9}\b/g },
  {
    key: "name",
    label: "Name",
    re: /\b(?:Mr|Mrs|Ms|Shri|Smt)\.?\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\b/g,
    category: "taxpayer_name",
  },
];

const ALL_TAXPAYER_KEYS = new Set(["GSTIN", "PAN", "TAN", "CIN", "DIN", "Aadhaar"]);

function targetActive(spec: RedactionTargetSpec, appliesTo: string): boolean {
  const norm = appliesTo.trim();
  if (norm === "all-taxpayer-identifiers") return ALL_TAXPAYER_KEYS.has(spec.key);
  return spec.key.toLowerCase() === norm.toLowerCase();
}

function redundancyNotice(policy: string): string {
  switch (policy) {
    case "OMITTED":
      return "[redacted]";
    case "TOKENIZED":
      return "";
    default:
      return "";
  }
}

function maskMatch(spec: RedactionTargetSpec, policy: string, match: string): string {
  if (policy === "OMITTED") return "[redacted]";
  if (policy === "TOKENIZED") return `<${spec.key}_${stableToken(match)}>`;
  // MASKED
  if (spec.category) return redactSensitiveValue(spec.category, match, false);
  void redundancyNotice;
  if (spec.key === "email") {
    const [local, domain] = match.split("@");
    const l = local && local.length > 1 ? `${local[0]}•••` : "•••";
    return `${l}@${domain ?? "•••"}`;
  }
  if (spec.key === "phone") {
    const last4 = match.slice(-4);
    return `•••• ${last4}`;
  }
  return "••••";
}

/**
 * Apply a version's redaction rules to a piece of text for the requested
 * variant. Rules for the other variant are skipped, so a REVIEWER preview is
 * the true, un-redacted record while a CLIENT preview shows only what the
 * client is meant to see.
 */
export function applyRedactions(text: string, rules: RedactionRule[], variant: DeliverableVariant): string {
  let out = text;
  for (const rule of rules) {
    if (rule.policy === "FULL" || rule.policy === "NOT_REQUIRED") continue;
    if (rule.effectiveForVariant !== "BOTH" && rule.effectiveForVariant !== variant) continue;
    for (const spec of REDACTION_TARGETS) {
      if (!targetActive(spec, rule.appliesTo)) continue;
      out = out.replace(spec.re, (match) => maskMatch(spec, rule.policy, match));
    }
  }
  return out;
}

export function listRedactionTargets(): { key: string; label: string }[] {
  return [
    ...REDACTION_TARGETS.map((t) => ({ key: t.key, label: t.label })),
    { key: "all-taxpayer-identifiers", label: "All taxpayer identifiers" },
    { key: "none", label: "None" },
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleDeliverableInput {
  formatCode: string;
  variant?: DeliverableVariant;
  templateId?: string | null;
  title?: string;
  revision?: number;
  baseVersionId?: string | null;
  issueDateLabel?: string | null;
  parts?: {
    kind?: DeliverablePartKind | string;
    ref?: string | null;
    heading: string;
    body?: string;
    source?: DeliverableSourceKind | string | null;
    sourceRef?: string | null;
    attachments?: AttachmentRef[];
  }[];
  note?: string;
}

interface ResolvedTemplate {
  templateId: string | null;
  firmName: string;
  firmAddress: string;
  signatoryName: string;
  signatoryDesignation: string;
  dateLabel: string;
  body: ReportTemplateBody;
  clauses: Record<string, string>;
}

async function resolveTemplateForAssembly(
  organizationId: string,
  engagement: EngagementRow,
  format: EngagementReportFormatView,
  explicitTemplateId: string | null | undefined,
): Promise<ResolvedTemplate> {
  if (explicitTemplateId) {
    const t = await prisma.engagementReportTemplate.findFirst({
      where: { id: explicitTemplateId, engagementId: engagement.id },
    });
    if (!t) throw notFoundError("Template not found.");
    return {
      templateId: t.id,
      firmName: t.firmName,
      firmAddress: t.firmAddress,
      signatoryName: t.signatoryName,
      signatoryDesignation: t.signatoryDesignation,
      dateLabel: t.dateLabel,
      body: parseTemplateBody(t.body),
      clauses: format.clauses,
    };
  }

  const engagementTemplate = await prisma.engagementReportTemplate.findFirst({
    where: { engagementId: engagement.id, formatCode: format.code, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
  });
  if (engagementTemplate) {
    return {
      templateId: engagementTemplate.id,
      firmName: engagementTemplate.firmName,
      firmAddress: engagementTemplate.firmAddress,
      signatoryName: engagementTemplate.signatoryName,
      signatoryDesignation: engagementTemplate.signatoryDesignation,
      dateLabel: engagementTemplate.dateLabel,
      body: parseTemplateBody(engagementTemplate.body),
      clauses: {},
    };
  }

  const master = await prisma.organizationReportTemplate.findFirst({
    where: { organizationId, formatCode: format.code, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
  });
  if (master) {
    return {
      templateId: null,
      firmName: master.firmName,
      firmAddress: master.firmAddress,
      signatoryName: master.signatoryName,
      signatoryDesignation: master.signatoryDesignation,
      dateLabel: master.dateLabel,
      body: parseTemplateBody(master.body),
      clauses: {},
    };
  }

  return {
    templateId: null,
    firmName: "^^FIRM_NAME^^",
    firmAddress: "^^FIRM_ADDRESS^^",
    signatoryName: "^^SIGNATORY_NAME^^",
    signatoryDesignation: "^^SIGNATORY_DESIGNATION^^",
    dateLabel: "^^DATE_LABEL^^",
    body: defaultTemplateBody(format.code),
    clauses: {},
  };
}

export async function assembleDeliverable(
  ctx: AuthContext,
  engagementId: string,
  input: AssembleDeliverableInput,
): Promise<DeliverableVersionView> {
  const { role, engagement } = await requireWorkRole(ctx, engagementId);
  const def = deliverableFormatDef(input.formatCode);
  if (!def) throw new ApiError(400, "VALIDATION", `Unknown report format "${input.formatCode}".`);

  let format = await prisma.engagementReportFormat.findUnique({
    where: { engagementId_code: { engagementId: engagement.id, code: input.formatCode } },
  });
  if (!format) {
    format = await prisma.engagementReportFormat.create({
      data: {
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        code: input.formatCode,
        label: def.label,
        description: def.description,
        status: "ACTIVE",
        defaultVariant: def.defaultVariant,
        clauses: stringifyJson({ anchor: def.anchor, category: def.category }),
      },
    });
  }
  if (format.status === "RETIRED") {
    throw new ApiError(409, "FORMAT_RETIRED", "This report format has been retired.");
  }

  const variant = input.variant ?? normalizeVariant(format.defaultVariant);
  const formatView = formatRowToView(format);
  const resolved = await resolveTemplateForAssembly(
    engagement.organizationId,
    engagement,
    formatView,
    input.templateId,
  );

  const now = new Date();
  const dateLabel = input.issueDateLabel || resolveIdentityField(resolved.dateLabel, dateLabelFor(now));

  const org = await prisma.organization.findUnique({
    where: { id: engagement.organizationId },
    select: { name: true },
  });

  const vars: Record<string, string> = {
    FIRM_NAME: resolveIdentityField(resolved.firmName, org?.name ?? ""),
    FIRM_ADDRESS: isPlaceholder(resolved.firmAddress) ? "" : resolved.firmAddress,
    SIGNATORY_NAME: isPlaceholder(resolved.signatoryName) ? "" : resolved.signatoryName,
    SIGNATORY_DESIGNATION: isPlaceholder(resolved.signatoryDesignation)
      ? "Chartered Accountants"
      : resolved.signatoryDesignation,
    SIGNATORY_MEMBERSHIP: "^^SIGNATORY_MEMBERSHIP^^",
    FIRM_REG_NO: "^^FIRM_REG_NO^^",
    DATE_LABEL: dateLabel,
    PLACE: "^^PLACE^^",
    ENGAGEMENT_NAME: engagement.name ?? "the client",
  };

  // Determine revision.
  let revision = input.revision ?? null;
  if (revision === null) {
    const last = await prisma.engagementDeliverableVersion.findFirst({
      where: { engagementId: engagement.id, formatCode: format.code, variant },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    revision = (last?.revision ?? 0) + 1;
  }

  // Resolve a base version to clone from, when provided.
  let baseParts: ReportTemplatePartSpec[] | null = null;
  if (input.baseVersionId) {
    const base = await prisma.engagementDeliverableVersion.findFirst({
      where: { id: input.baseVersionId, engagementId: engagement.id },
      include: { parts: { orderBy: { order: "asc" } } },
    });
    if (!base) throw notFoundError("Base deliverable not found.");
    baseParts = base.parts.map((p) => ({
      kind: p.kind as DeliverablePartKind,
      heading: p.heading,
      body: p.bodyMarkdown,
      ref: p.ref ?? undefined,
    }));
  }

  const sourceParts: ReportTemplatePartSpec[] =
    input.parts?.map((p) => ({
      kind: normalizePartKind(p.kind) as DeliverablePartKind,
      heading: p.heading,
      body: p.body ?? "",
      ref: p.ref ?? undefined,
    })) ??
    baseParts ??
    resolved.body.parts;

  const title =
    input.title?.trim() ||
    `${format.label} — ${engagement.name ?? "Engagement"}${variant === "REVIEWER" ? " (Reviewer copy)" : ""}`;

  const content: DeliverableContent = {
    formatCode: format.code,
    formatLabel: format.label,
    title,
    variant,
    revision,
    firmName: vars.FIRM_NAME ?? "",
    firmAddress: vars.FIRM_ADDRESS ?? "",
    signatoryName: vars.SIGNATORY_NAME ?? "",
    signatoryDesignation: vars.SIGNATORY_DESIGNATION ?? "",
    dateLabel,
    clauses: formatView.clauses,
    notation: resolved.body.notation,
    parts: sourceParts.map((p) => ({
      kind: p.kind,
      heading: p.heading,
      body: resolvePlaceholders(p.body, vars),
      ref: p.ref,
    })),
  };

  const bodyHash = contentHash({
    engagementId: engagement.id,
    format: format.code,
    revision,
    variant,
    parts: content.parts,
  });

  const created = await prisma.$transaction(async (tx) => {
    const version = await tx.engagementDeliverableVersion.create({
      data: {
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        formatCode: format.code,
        templateId: resolved.templateId,
        revision,
        status: "DRAFT",
        variant,
        issuedAtLabel: dateLabel,
        bodyHash,
        preparedById: ctx.user.id,
        preparedAt: now,
        content: stringifyJson(content),
      },
    });
    await tx.engagementDeliverablePart.createMany({
      data: content.parts.map((p, index) => {
        const inputPart = input.parts?.[index];
        return {
          organizationId: engagement.organizationId,
          engagementId: engagement.id,
          versionId: version.id,
          kind: p.kind,
          ref: p.ref ?? null,
          heading: p.heading,
          bodyMarkdown: p.body,
          attachments: stringifyJson(inputPart?.attachments ?? []),
          source: inputPart?.source ?? "MANUAL",
          sourceRef: inputPart?.sourceRef ?? null,
          order: index,
          createdById: ctx.user.id,
        };
      }),
    });
    await tx.engagementDeliverableSignOff.create({
      data: {
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        versionId: version.id,
        step: "PREPARED",
        role: "AUTHOR",
        performedById: ctx.user.id,
        note: input.note ?? null,
      },
    });
    return version;
  });

  const ledger = await appendLedgerEntry(ctx, engagement, role, {
    action: "deliverable.assembled",
    targetType: "deliverable",
    targetId: created.id,
    summary: `Assembled ${format.label} (rev ${revision}, ${variant})`,
    meta: { format: format.code, revision, variant, bodyHash },
  });

  const view = await getDeliverable(ctx, engagementId, created.id);
  return { ...view, ledgerSeq: ledger.seq };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type VersionRowWithRelations = {
  id: string;
  organizationId: string;
  engagementId: string;
  formatCode: string;
  templateId: string | null;
  revision: number;
  status: string;
  variant: string;
  issuedAtLabel: string | null;
  filepath: string | null;
  bodyHash: string | null;
  preparedById: string | null;
  preparedAt: Date | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  signedOffById: string | null;
  signedOffAt: Date | null;
  signOffRole: string | null;
  issuedById: string | null;
  issuedAt: Date | null;
  issuedFor: string | null;
  remarks: string | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  format?: { code: string; label: string } | null;
  parts?: {
    id: string;
    versionId: string;
    kind: string;
    ref: string | null;
    heading: string;
    bodyMarkdown: string;
    attachments: string;
    source: string | null;
    sourceRef: string | null;
    order: number;
    createdById: string | null;
    createdAt: Date;
  }[];
  signoffs?: {
    id: string;
    step: string;
    role: string;
    performedById: string;
    performedAt: Date;
    note: string | null;
  }[];
  engagementDeliverableRedactions?: {
    id: string;
    policy: string;
    appliesTo: string;
    note: string | null;
    effectiveForVariant: string;
    createdAt: Date;
  }[];
};

function versionRowToView(row: VersionRowWithRelations): DeliverableVersionView {
  const content = parseJson<DeliverableContent | null>(row.content, null);
  return {
    id: row.id,
    organizationId: row.organizationId,
    engagementId: row.engagementId,
    formatId: row.formatCode,
    formatCode: row.format?.code ?? content?.formatCode ?? row.formatCode,
    formatLabel: row.format?.label ?? content?.formatLabel ?? "Deliverable",
    templateId: row.templateId,
    revision: row.revision,
    status: row.status as DeliverableStatus,
    variant: normalizeVariant(row.variant),
    issuedAtLabel: row.issuedAtLabel,
    filepath: row.filepath,
    bodyHash: row.bodyHash,
    preparedById: row.preparedById,
    preparedAt: row.preparedAt?.toISOString() ?? null,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    signedOffById: row.signedOffById,
    signedOffAt: row.signedOffAt?.toISOString() ?? null,
    signOffRole: row.signOffRole,
    issuedById: row.issuedById,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    issuedFor: row.issuedFor,
    remarks: row.remarks,
    content,
    parts: (row.parts ?? []).map((p) => ({
      id: p.id,
      versionId: p.versionId,
      kind: p.kind,
      ref: p.ref,
      heading: p.heading,
      bodyMarkdown: p.bodyMarkdown,
      attachments: parseAttachments(p.attachments),
      source: p.source,
      sourceRef: p.sourceRef,
      order: p.order,
      createdById: p.createdById,
      createdAt: p.createdAt.toISOString(),
    })),
    signOffs: (row.signoffs ?? []).map((s) => ({
      id: s.id,
      step: s.step,
      role: s.role,
      performedById: s.performedById,
      performedAt: s.performedAt.toISOString(),
      note: s.note,
    })),
    redactions: (row.engagementDeliverableRedactions ?? []).map((r) => ({
      id: r.id,
      policy: r.policy,
      appliesTo: r.appliesTo,
      note: r.note,
      effectiveForVariant: r.effectiveForVariant,
      createdAt: r.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const VERSION_INCLUDE = {
  format: { select: { code: true, label: true } },
  parts: { orderBy: { order: "asc" as const } },
  signoffs: { orderBy: { performedAt: "asc" as const } },
  engagementDeliverableRedactions: { orderBy: { createdAt: "asc" as const } },
} as const;

export async function listDeliverables(
  ctx: AuthContext,
  engagementId: string,
  opts?: { formatCode?: string; status?: string },
): Promise<DeliverableVersionView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.engagementDeliverableVersion.findMany({
    where: {
      engagementId: engagement.id,
      status: opts?.status,
      format: opts?.formatCode ? { code: opts.formatCode } : undefined,
    },
    include: VERSION_INCLUDE,
    orderBy: [{ createdAt: "desc" }],
  });
  return rows.map(versionRowToView);
}

export async function getDeliverable(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
): Promise<DeliverableVersionView> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const row = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId: engagement.id },
    include: VERSION_INCLUDE,
  });
  if (!row) throw notFoundError("Deliverable not found.");
  return versionRowToView(row);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function loadVersionForWrite(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
): Promise<{ role: PracticeRole; engagement: EngagementRow; row: VersionRowWithRelations }> {
  const { role, engagement } = await requireWorkRole(ctx, engagementId);
  const row = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId: engagement.id },
    include: VERSION_INCLUDE,
  });
  if (!row) throw notFoundError("Deliverable not found.");
  return { role, engagement, row };
}

const LEGAL_TRANSITIONS: Record<DeliverableStatus, DeliverableStatus[]> = {
  DRAFT: ["IN_REVIEW", "ARCHIVED"],
  IN_REVIEW: ["DRAFT", "REVIEWED", "SIGNED_OFF", "ARCHIVED", "WITHDRAWN"],
  REVIEWED: ["SIGNED_OFF", "DRAFT", "ARCHIVED", "WITHDRAWN"],
  SIGNED_OFF: ["ISSUED", "ARCHIVED", "WITHDRAWN"],
  ISSUED: ["SUPERSEDED", "ARCHIVED", "WITHDRAWN"],
  WITHDRAWN: ["ARCHIVED"],
  SUPERSEDED: ["ARCHIVED"],
  ARCHIVED: [],
};

function assertTransition(from: DeliverableStatus, to: DeliverableStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new ApiError(409, "INVALID_TRANSITION", `Cannot move a deliverable from ${from} to ${to}.`);
  }
}

async function recordSignOff(
  engagement: EngagementRow,
  versionId: string,
  step: DeliverableSignOffStep,
  role: string,
  actorId: string,
  note?: string | null,
): Promise<void> {
  await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      versionId,
      step,
      role,
      performedById: actorId,
      note: note ?? null,
    },
  });
}

export async function updateDeliverableDraft(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  input: { title?: string; parts?: AssembleDeliverableInput["parts"]; note?: string },
): Promise<DeliverableVersionView> {
  const { engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (row.status !== "DRAFT") {
    throw new ApiError(409, "NOT_DRAFT", "Only a DRAFT deliverable can be edited.");
  }
  const content = parseJson<DeliverableContent | null>(row.content, null);
  if (!content) throw new ApiError(500, "CONTENT_MISSING", "Deliverable content is missing.");

  if (input.title?.trim()) content.title = input.title.trim();
  if (input.parts) {
    content.parts = input.parts.map((p) => ({
      kind: normalizePartKind(p.kind) as DeliverablePartKind,
      heading: p.heading,
      body: p.body ?? "",
      ref: p.ref ?? undefined,
    }));
  }
  const bodyHash = contentHash({
    engagementId: engagement.id,
    format: content.formatCode,
    revision: row.revision,
    variant: row.variant,
    parts: content.parts,
  });

  await prisma.$transaction(async (tx) => {
    await tx.engagementDeliverablePart.deleteMany({ where: { versionId: row.id } });
    await tx.engagementDeliverablePart.createMany({
      data: content.parts.map((p, index) => ({
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        versionId: row.id,
        kind: p.kind,
        ref: p.ref ?? null,
        heading: p.heading,
        bodyMarkdown: p.body,
        attachments: stringifyJson(input.parts?.[index]?.attachments ?? []),
        source: input.parts?.[index]?.source ?? "MANUAL",
        sourceRef: input.parts?.[index]?.sourceRef ?? null,
        order: index,
        createdById: ctx.user.id,
      })),
    });
    await tx.engagementDeliverableVersion.update({
      where: { id: row.id },
      data: { content: stringifyJson(content), bodyHash },
    });
  });

  await appendLedgerEntry(ctx, engagement, "SENIOR", {
    action: "deliverable.updated",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Updated draft ${content.formatLabel} rev ${row.revision} (${row.variant})`,
    meta: { bodyHash },
  });
  return getDeliverable(ctx, engagementId, versionId);
}

export async function submitDeliverable(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  note?: string,
): Promise<DeliverableVersionView> {
  const { engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  const status = row.status as DeliverableStatus;
  assertTransition(status, "IN_REVIEW");
  await prisma.engagementDeliverableVersion.update({
    where: { id: row.id },
    data: { status: "IN_REVIEW" },
  });
  await appendLedgerEntry(ctx, engagement, "SENIOR", {
    action: "deliverable.submitted",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Submitted ${row.variant} revision ${row.revision} for review`,
    meta: note ? { note } : null,
  });
  return getDeliverable(ctx, engagementId, versionId);
}

export async function reviewDeliverable(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  input: { decision: "REVIEWED" | "CHANGES_REQUESTED"; note?: string },
): Promise<DeliverableVersionView> {
  const { role, engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (!canReview(role as PracticeRole))
    throw forbiddenError("Only a Reviewer, Manager or Partner can review a deliverable.");
  if (row.status !== "IN_REVIEW") {
    throw new ApiError(409, "NOT_IN_REVIEW", "Only a deliverable in review can be reviewed.");
  }
  const isRejected = input.decision === "CHANGES_REQUESTED";
  const now = new Date();
  await prisma.engagementDeliverableVersion.update({
    where: { id: row.id },
    data: {
      status: isRejected ? "DRAFT" : "REVIEWED",
      reviewedById: ctx.user.id,
      reviewedAt: now,
      reviewNote: input.note ?? null,
    },
  });
  await recordSignOff(engagement, row.id, "REVIEWED", role, ctx.user.id, input.note ?? null);
  await appendLedgerEntry(ctx, engagement, role, {
    action: isRejected ? "deliverable.changes_requested" : "deliverable.reviewed",
    targetType: "deliverable",
    targetId: row.id,
    summary: isRejected
      ? `Requested changes on ${row.variant} revision ${row.revision}`
      : `Reviewed ${row.variant} revision ${row.revision}`,
    meta: input.note ? { note: input.note } : null,
  });
  return getDeliverable(ctx, engagementId, versionId);
}

export async function signOffDeliverable(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  note?: string,
): Promise<DeliverableVersionView> {
  const { role, engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (!canSignOff(role as PracticeRole)) throw forbiddenError("Only a Manager or Partner can sign off a deliverable.");
  const status = row.status as DeliverableStatus;
  if (status !== "REVIEWED" && status !== "IN_REVIEW") {
    throw new ApiError(409, "NOT_READY", "A deliverable must be in review or reviewed before sign-off.");
  }
  const now = new Date();
  await prisma.engagementDeliverableVersion.update({
    where: { id: row.id },
    data: {
      status: "SIGNED_OFF",
      signedOffById: ctx.user.id,
      signedOffAt: now,
      signOffRole: role,
    },
  });
  await recordSignOff(engagement, row.id, "SIGNED_OFF", role, ctx.user.id, note ?? null);
  await appendLedgerEntry(ctx, engagement, role, {
    action: "deliverable.signed_off",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Signed off ${row.variant} revision ${row.revision} as ${role}`,
    meta: { signOffRole: role, note: note ?? null },
  });
  return getDeliverable(ctx, engagementId, versionId);
}

export async function issueDeliverable(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  input: { issuedFor?: string; remarks?: string; issueDateLabel?: string },
): Promise<DeliverableVersionView> {
  const { role, engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (!canSignOff(role)) throw forbiddenError("Only a Manager or Partner can issue a deliverable.");
  if (row.status !== "SIGNED_OFF") {
    throw new ApiError(409, "NOT_SIGNED_OFF", "A deliverable must be signed off before it can be issued.");
  }
  const now = new Date();
  const content = parseJson<DeliverableContent | null>(row.content, null);
  if (content && input.issueDateLabel) content.dateLabel = input.issueDateLabel;

  // Render the CLIENT-facing HTML artifact and store it.
  let filepath: string | null = row.filepath;
  try {
    const { renderDeliverableDocument } = await import("@/lib/export/deliverable-doc");
    const preview = renderDeliverablePreview(versionRowToView(row), "CLIENT");
    const html = renderDeliverableDocument(preview, {
      firmName: content?.firmName ?? "",
      signatoryName: content?.signatoryName ?? "",
      signatoryDesignation: content?.signatoryDesignation ?? "",
      issuedFor: input.issuedFor ?? null,
      generatedAt: now,
    });
    const key = `deliverables/${engagement.id}/${row.id}.html`;
    const { saveFile } = await import("@/lib/server/storage");
    await saveFile(key, html);
    filepath = key;
  } catch {
    filepath = row.filepath;
  }

  await prisma.$transaction(async (tx) => {
    // Supersede any previous ISSUED version of the same format + variant.
    await tx.engagementDeliverableVersion.updateMany({
      where: {
        engagementId: engagement.id,
        formatCode: row.formatCode,
        variant: row.variant,
        status: "ISSUED",
        id: { not: row.id },
      },
      data: { status: "SUPERSEDED" },
    });
    await tx.engagementDeliverableVersion.update({
      where: { id: row.id },
      data: {
        status: "ISSUED",
        issuedById: ctx.user.id,
        issuedAt: now,
        issuedFor: input.issuedFor ?? null,
        remarks: input.remarks ?? row.remarks,
        issuedAtLabel: input.issueDateLabel ?? row.issuedAtLabel,
        filepath,
        content: content ? stringifyJson(content) : row.content,
      },
    });
  });
  await recordSignOff(engagement, row.id, "ISSUED", role, ctx.user.id, input.remarks ?? null);
  await appendLedgerEntry(ctx, engagement, role, {
    action: "deliverable.issued",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Issued ${row.variant} revision ${row.revision}${input.issuedFor ? ` to ${input.issuedFor}` : ""}`,
    meta: { issuedFor: input.issuedFor ?? null, filepath },
  });
  return getDeliverable(ctx, engagementId, versionId);
}

export async function archiveDeliverable(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
): Promise<DeliverableVersionView> {
  const { role, engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (!canPrepareWork(role)) throw forbiddenError("Auditors cannot archive deliverables.");
  const status = row.status as DeliverableStatus;
  if (status === "ARCHIVED") return getDeliverable(ctx, engagementId, versionId);
  assertTransition(status, "ARCHIVED");
  await prisma.engagementDeliverableVersion.update({
    where: { id: row.id },
    data: { status: "ARCHIVED" },
  });
  await appendLedgerEntry(ctx, engagement, "SENIOR", {
    action: "deliverable.archived",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Archived ${row.variant} revision ${row.revision}`,
  });
  return getDeliverable(ctx, engagementId, versionId);
}

export async function createDeliverableRevision(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
): Promise<DeliverableVersionView> {
  const { engagement: _engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (row.status !== "ISSUED" && row.status !== "SIGNED_OFF" && row.status !== "SUPERSEDED") {
    throw new ApiError(409, "NOT_FINAL", "Only a signed-off or issued deliverable can be revised.");
  }
  const content = parseJson<DeliverableContent | null>(row.content, null);
  const parts = (row.parts ?? []).map((p) => ({
    kind: p.kind,
    heading: p.heading,
    body: p.bodyMarkdown,
    ref: p.ref ?? undefined,
    source: p.source,
    sourceRef: p.sourceRef,
    attachments: parseAttachments(p.attachments),
  }));
  return assembleDeliverable(ctx, engagementId, {
    formatCode: content?.formatCode ?? "",
    variant: normalizeVariant(row.variant),
    templateId: row.templateId,
    title: content?.title,
    revision: row.revision + 1,
    parts,
    note: `Revision from rev ${row.revision}`,
  });
}

// ---------------------------------------------------------------------------
// Redactions
// ---------------------------------------------------------------------------

export async function addRedaction(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  input: {
    policy?: RedactionPolicy;
    appliesTo: string;
    note?: string;
    effectiveForVariant?: "CLIENT" | "REVIEWER" | "BOTH";
  },
): Promise<DeliverableRedactionView> {
  const { role, engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (!canSignOff(role)) throw forbiddenError("Only a Manager or Partner can change redaction rules.");
  if (!input.appliesTo?.trim()) throw new ApiError(400, "VALIDATION", "appliesTo is required.");
  const created = await prisma.engagementDeliverableRedaction.create({
    data: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      versionId: row.id,
      policy: input.policy ?? "MASKED",
      appliesTo: input.appliesTo.trim(),
      note: input.note ?? null,
      effectiveForVariant: input.effectiveForVariant ?? "CLIENT",
    },
  });
  await appendLedgerEntry(ctx, engagement, role, {
    action: "deliverable.redaction_added",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Redaction ${created.policy} on ${created.appliesTo} for ${created.effectiveForVariant}`,
    meta: { policy: created.policy, appliesTo: created.appliesTo, effectiveForVariant: created.effectiveForVariant },
  });
  return {
    id: created.id,
    policy: created.policy,
    appliesTo: created.appliesTo,
    note: created.note,
    effectiveForVariant: created.effectiveForVariant,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function removeRedaction(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  redactionId: string,
): Promise<void> {
  const { role, engagement, row } = await loadVersionForWrite(ctx, engagementId, versionId);
  if (!canSignOff(role)) throw forbiddenError("Only a Manager or Partner can change redaction rules.");
  const existing = await prisma.engagementDeliverableRedaction.findFirst({
    where: { id: redactionId, versionId: row.id },
  });
  if (!existing) throw notFoundError("Redaction rule not found.");
  await prisma.engagementDeliverableRedaction.delete({ where: { id: existing.id } });
  await appendLedgerEntry(ctx, engagement, role, {
    action: "deliverable.redaction_removed",
    targetType: "deliverable",
    targetId: row.id,
    summary: `Removed redaction ${existing.appliesTo}`,
  });
}

// ---------------------------------------------------------------------------
// Rendering + traceability
// ---------------------------------------------------------------------------

export function deliverableTrace(view: DeliverableVersionView): DeliverableTrace {
  const bySource: Record<string, number> = {};
  const workingPaperRefs: string[] = [];
  let traced = 0;
  let manual = 0;
  for (const part of view.parts) {
    const source = part.source ?? "MANUAL";
    bySource[source] = (bySource[source] ?? 0) + 1;
    if (source === "MANUAL" || source === "COMPUTED") {
      manual += 1;
    } else {
      traced += 1;
    }
    if (source === "WORKING_PAPER" && part.sourceRef) workingPaperRefs.push(part.sourceRef);
    for (const att of part.attachments) {
      if (att.kind === "workingPaper" && att.ref) workingPaperRefs.push(att.ref);
    }
  }
  const totalParts = view.parts.length;
  return {
    totalParts,
    tracedParts: traced,
    manualParts: manual,
    bySource,
    workingPaperRefs: [...new Set(workingPaperRefs)],
    complete: totalParts > 0 && manual === 0,
  };
}

export function renderDeliverablePreview(
  view: DeliverableVersionView,
  variant: DeliverableVariant,
): DeliverablePreview {
  const rules = view.redactions.map((r) => ({
    policy: r.policy,
    appliesTo: r.appliesTo,
    effectiveForVariant: r.effectiveForVariant,
  }));
  const sections: DeliverablePreviewSection[] = view.parts.map((part) => {
    const masked = applyRedactions(part.bodyMarkdown, rules, variant);
    const heading = applyRedactions(part.heading, rules, variant);
    return {
      heading,
      kind: part.kind,
      ref: part.ref,
      body: masked,
      source: part.source,
      sourceRef: part.sourceRef,
      redacted: masked !== part.bodyMarkdown,
    };
  });
  return {
    version: view,
    variant,
    title: view.content?.title ?? view.formatLabel,
    sections,
    trace: deliverableTrace(view),
  };
}

export async function getDeliverablePreview(
  ctx: AuthContext,
  engagementId: string,
  versionId: string,
  variant?: DeliverableVariant,
): Promise<DeliverablePreview> {
  const view = await getDeliverable(ctx, engagementId, versionId);
  return renderDeliverablePreview(view, variant ?? view.variant);
}

export { requireEngagementRole };
