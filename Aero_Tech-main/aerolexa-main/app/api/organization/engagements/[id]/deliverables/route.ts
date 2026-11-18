// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - organization deliverables management is a deployment-wide aggregate operation
import { z } from "zod";

import type {
  EngagementReportFormat,
  EngagementReportTemplate,
  EngagementDeliverableVersion,
  EngagementDeliverablePart,
  EngagementDeliverableRedaction,
} from "@/generated/prisma/client";
import { ApiError, requireAuth, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  assemble,
  buildCertificatePartBody,
  hashContent,
  loadWorkingPapersForTrace,
  renderNotesSkeleton,
  renderWorkingPaperTracePart,
  type CertificateRequest,
  type PlaceholderValues,
  type RenderOptions,
  type WorkingPaperTracePart,
  PLACEHOLDER_KEYS,
} from "@/lib/engine/deliverable-assembly";
import { generateInternalUdinId, isValidUdinFormat, type UdinSource } from "@/lib/engine/udin";
import { esc, exportShell, htmlForText } from "@/lib/export/html";
import { stringifyJson } from "@/lib/json";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { canReview, canSignOff, requireEngagementRole } from "@/lib/server/engagement";
import { appendLedgerEntry } from "@/lib/server/governance";
import { saveFile } from "@/lib/server/storage";

export const dynamic = "force-dynamic";

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

type FormatCode =
  | "FINANCIALS"
  | "PROFIT_LOSS"
  | "BALANCE_SHEET"
  | "NOTES"
  | "SCHEDULES"
  | "MGMT_LETTER"
  | "TAX_COMPUTATION"
  | "CERTIFICATE_44AB"
  | "CERTIFICATE_44ADA"
  | "CERTIFICATE_44AD"
  | "TAX_CONCLUSION"
  | "AUDIT_FINDINGS"
  | "MANAGING_AGENT_LETTER"
  | "LETTER_TO_CLIENT";

const VALID_FORMAT_CODES = [
  "FINANCIALS",
  "PROFIT_LOSS",
  "BALANCE_SHEET",
  "NOTES",
  "SCHEDULES",
  "MGMT_LETTER",
  "TAX_COMPUTATION",
  "CERTIFICATE_44AB",
  "CERTIFICATE_44ADA",
  "CERTIFICATE_44AD",
  "TAX_CONCLUSION",
  "AUDIT_FINDINGS",
  "MANAGING_AGENT_LETTER",
  "LETTER_TO_CLIENT",
] as const;

const VALID_VARIANTS = ["CLIENT", "REVIEWER"] as const;

const VALID_REDACTION_POLICIES = ["MASKED", "TOKENIZED", "OMITTED"] as const;
const VALID_REDACTION_APPLIES_TO = [
  "GSTIN",
  "PAN",
  "CIN",
  "DIN",
  "TAN",
  "Aadhaar",
  "bankAccountId",
  "accountNumber",
  "email",
  "phone",
  "all-taxpayer-identifiers",
  "none",
] as const;
const VALID_REDACTION_VARIANTS = ["CLIENT", "REVIEWER", "BOTH"] as const;

function orgId(ctx: AuthContext): string {
  if (!ctx.organization) throw new ApiError(404, "NOT_FOUND", "No organization.");
  return ctx.organization.id;
}

function serializeTemplate(template: EngagementReportTemplate): Record<string, unknown> {
  return {
    id: template.id,
    formatCode: template.formatCode,
    label: template.label,
    description: template.description,
    firmName: template.firmName,
    firmAddress: template.firmAddress,
    signatoryName: template.signatoryName,
    signatoryDesignation: template.signatoryDesignation,
    dateLabel: template.dateLabel,
    notes: template.notes,
    effectiveFrom: template.effectiveFrom,
    effectiveTo: template.effectiveTo,
    status: template.status,
    masterRef: template.masterRef ?? null,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

function serializeFormat(
  format: EngagementReportFormat & {
    _count?: { versions: number; redactions: number };
  },
): Record<string, unknown> {
  return {
    id: format.id,
    code: format.code,
    label: format.label,
    description: format.description,
    status: format.status,
    defaultVariant: format.defaultVariant,
    clauses: format.clauses ? JSON.parse(format.clauses) : undefined,
    versionCount: format._count?.versions ?? 0,
    redactionCount: format._count?.redactions ?? 0,
    createdAt: format.createdAt.toISOString(),
    updatedAt: format.updatedAt.toISOString(),
  };
}

function serializeVersion(
  v: EngagementDeliverableVersion & {
    _count?: { parts: number; signoffs: number };
  },
): Record<string, unknown> {
  return {
    id: v.id,
    formatCode: v.formatCode,
    revision: v.revision,
    status: v.status,
    variant: v.variant,
    issuedAtLabel: v.issuedAtLabel,
    filepath: v.filepath,
    bodyHash: v.bodyHash,
    preparedById: v.preparedById,
    preparedAt: v.preparedAt?.toISOString() ?? null,
    reviewedById: v.reviewedById,
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
    reviewNote: v.reviewNote,
    signedOffById: v.signedOffById,
    signedOffAt: v.signedOffAt?.toISOString() ?? null,
    signOffRole: v.signOffRole,
    issuedById: v.issuedById,
    issuedAt: v.issuedAt?.toISOString() ?? null,
    issuedFor: v.issuedFor,
    remarks: v.remarks,
    udin: v.udin ?? null,
    udinSource: v.udinSource ?? null,
    documentReference: v.documentReference ?? null,
    udinIssuedAt: v.udinIssuedAt?.toISOString() ?? null,
    udinVerifyCount: v.udinVerifyCount,
    udinVerifiedById: v.udinVerifiedById ?? null,
    udinVerifiedAt: v.udinVerifiedAt?.toISOString() ?? null,
    templateId: v.templateId,
    content: v.content ? JSON.parse(v.content) : null,
    partCount: v._count?.parts ?? 0,
    signoffCount: v._count?.signoffs ?? 0,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

async function listFormats(_ctx: AuthContext, engagementId: string) {
  const formats = await prisma.engagementReportFormat.findMany({
    where: { engagementId },
    orderBy: { code: "asc" },
    include: { _count: { select: { versions: true, redactions: true } } },
  });
  return formats.map(serializeFormat);
}

async function listTemplates(_ctx: AuthContext, engagementId: string) {
  const templates = await prisma.engagementReportTemplate.findMany({
    where: { engagementId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { versions: true } },
    },
  });
  return templates.map((t) => ({
    ...serializeTemplate(t),
    masterRefLabel: t.masterRef ? "[master]" : null,
    versionCount: t._count.versions,
  }));
}

async function listVersions(_ctx: AuthContext, engagementId: string, formatCode: string) {
  const versions = await prisma.engagementDeliverableVersion.findMany({
    where: { engagementId, formatCode },
    orderBy: [{ revision: "desc" }, { variant: "asc" }, { createdAt: "desc" }],
    include: {
      _count: { select: { parts: true, signoffs: true } },
    },
  });
  return versions.map((v) => {
    const serialized = serializeVersion(v);
    return { ...serialized, latestSignOff: null };
  });
}

async function loadVersionRow(engagementId: string, versionId: string): Promise<EngagementDeliverableVersion> {
  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId },
  });
  if (!version) {
    throw new ApiError(404, "NOT_FOUND", "Version not found.");
  }
  return version;
}

async function loadVersionWith(engagementId: string, versionId: string) {
  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId },
    include: {
      format: { select: { label: true, code: true } },
      parts: true,
      engagementDeliverableRedactions: true,
      signoffs: true,
    },
  });
  if (!version) {
    throw new ApiError(404, "NOT_FOUND", "Version not found.");
  }
  return version;
}

async function loadVersionWithParts(engagementId: string, versionId: string) {
  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId },
    include: { parts: true },
  });
  if (!version) {
    throw new ApiError(404, "NOT_FOUND", "Version not found.");
  }
  return version;
}

/** Structural diff between two revisions of the same deliverable variant. */
function diffVersions(
  from: EngagementDeliverableVersion & { parts: EngagementDeliverablePart[] },
  to: EngagementDeliverableVersion & { parts: EngagementDeliverablePart[] },
) {
  const toParts = [...to.parts].sort((a, b) => a.order - b.order);
  const fromParts = [...from.parts].sort((a, b) => a.order - b.order);

  const toRefs = new Map(toParts.map((p) => [p.ref ?? `${p.kind}|${p.heading}`, p]));
  const fromRefs = new Map(fromParts.map((p) => [p.ref ?? `${p.kind}|${p.heading}`, p]));

  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const changed: Array<Record<string, unknown>> = [];

  for (const p of toParts) {
    const key = p.ref ?? `${p.kind}|${p.heading}`;
    const before = fromRefs.get(key);
    if (!before) {
      added.push({
        revision: to.revision,
        kind: p.kind,
        heading: p.heading,
        ref: p.ref,
        bodyHash: hashContent(p.bodyMarkdown),
      });
      continue;
    }
    if (hashContent(before.bodyMarkdown) !== hashContent(p.bodyMarkdown)) {
      changed.push({
        at: "to",
        from: {
          revision: from.revision,
          kind: before.kind,
          heading: before.heading,
          ref: before.ref,
          bodyHash: hashContent(before.bodyMarkdown),
        },
        to: {
          revision: to.revision,
          kind: p.kind,
          heading: p.heading,
          ref: p.ref,
          bodyHash: hashContent(p.bodyMarkdown),
        },
      });
    }
  }

  for (const p of fromParts) {
    const key = p.ref ?? `${p.kind}|${p.heading}`;
    const after = toRefs.get(key);
    if (!after) {
      removed.push({
        revision: from.revision,
        kind: p.kind,
        heading: p.heading,
        ref: p.ref,
        bodyHash: hashContent(p.bodyMarkdown),
      });
    }
  }

  return {
    fromRevision: from.revision,
    toRevision: to.revision,
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
    orderChanged:
      JSON.stringify(toParts.map((p) => p.ref ?? `${p.kind}|${p.heading}`)) !==
      JSON.stringify(fromParts.map((p) => p.ref ?? `${p.kind}|${p.heading}`)),
    bodyHashChanged: from.bodyHash !== to.bodyHash,
  };
}

/** Append an immutable ledger entry for the engagement the deliverable belongs to. */
async function ledger(
  ctx: AuthContext,
  engagement: { id: string; organizationId: string },
  role: Parameters<typeof appendLedgerEntry>[2],
  action: string,
  summary: string,
  meta?: Record<string, unknown>,
  targetId?: string,
) {
  await appendLedgerEntry(ctx, engagement, role, {
    action,
    targetType: "engagementDeliverableVersion",
    targetId: targetId ?? null,
    summary,
    meta: meta ?? null,
  });
}

// ------------------------------------------------------------------
// Route
// ------------------------------------------------------------------

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await requireEngagementRole(ctx, params.id, "ASSISTANT");

    const searchParams = new URL(request.url).searchParams;
    const kind = searchParams.get("kind");
    const formatCode = searchParams.get("formatCode");

    if (kind === "formats") {
      return ok({ formats: await listFormats(ctx, params.id) });
    }

    if (kind === "templates") {
      return ok({ templates: await listTemplates(ctx, params.id) });
    }

    if (kind === "versions" && formatCode) {
      if (!VALID_FORMAT_CODES.includes(formatCode as FormatCode)) {
        throw new ApiError(400, "VALIDATION", `Invalid formatCode "${formatCode}".`);
      }
      return ok({ versions: await listVersions(ctx, params.id, formatCode) });
    }

    if (kind === "version") {
      const versionId = searchParams.get("id");
      if (!versionId) throw new ApiError(400, "VALIDATION", "Missing version id.");
      const version = await loadVersionWith(params.id, versionId);
      return ok({
        version: {
          ...serializeVersion(version),
          formatLabel: version.format?.label ?? version.formatCode,
          parts: [...version.parts].sort((a, b) => a.order - b.order).map((p) => serializePart(p)),
          redactions: version.engagementDeliverableRedactions.map((r) => serializeRedaction(r)),
          signoffs: version.signoffs.map((s) => ({
            id: s.id,
            step: s.step,
            role: s.role,
            performedById: s.performedById,
            performedAt: s.performedAt.toISOString(),
            note: s.note,
          })),
        },
      });
    }

    if (kind === "diff") {
      const fromId = searchParams.get("fromId");
      const toId = searchParams.get("toId");
      if (!fromId || !toId) throw new ApiError(400, "VALIDATION", "Both fromId and toId are required for a diff.");
      const [from, to] = await Promise.all([
        loadVersionWithParts(params.id, fromId),
        loadVersionWithParts(params.id, toId),
      ]);
      if (from.formatCode !== to.formatCode) {
        throw new ApiError(400, "VALIDATION", "Diff requires two versions of the same format.");
      }
      return ok({ diff: diffVersions(from, to) });
    }

    const [formats, templates] = await Promise.all([listFormats(ctx, params.id), listTemplates(ctx, params.id)]);
    return ok({ formats, templates });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) throw new ApiError(404, "NOT_FOUND", "Engagement not found.");
    const { role, engagement } = await requireEngagementRole(ctx, params.id, "ASSISTANT");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const action = body.action as string | undefined;

    if (action === "create-format") {
      if (!canSignOff(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can create a deliverable format.");
      }
      return await handleCreateFormat(ctx, params.id, role, engagement, body);
    }

    if (action === "create-template") {
      if (!canReview(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner, manager, or reviewer can create a deliverable template.");
      }
      return await handleCreateTemplate(ctx, params.id, role, engagement, body);
    }

    if (action === "assemble") {
      if (!canReview(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner, manager, or reviewer can assemble a deliverable.");
      }
      return await handleAssemble(ctx, params.id, role, engagement, body);
    }

    if (action === "add-redaction") {
      if (!canReview(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner, manager, or reviewer can add redaction rules.");
      }
      return await handleAddRedaction(ctx, params.id, role, engagement, body);
    }

    if (action === "submit-for-review") {
      if (!canReview(role)) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Only a partner, manager, or reviewer can submit a deliverable for review.",
        );
      }
      return await handleSubmitForReview(ctx, params.id, role, engagement, body);
    }

    if (action === "approve") {
      if (!canReview(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner, manager, or reviewer can approve a deliverable.");
      }
      return await handleApprove(ctx, params.id, role, engagement, body);
    }

    if (action === "reject") {
      if (!canReview(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner, manager, or reviewer can reject a deliverable.");
      }
      return await handleReject(ctx, params.id, role, engagement, body);
    }

    if (action === "sign-off") {
      if (!canSignOff(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can sign off a deliverable.");
      }
      return await handleSignOff(ctx, params.id, role, engagement, body);
    }

    if (action === "issue") {
      if (!canSignOff(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can issue a deliverable.");
      }
      return await handleIssue(ctx, params.id, role, engagement, body);
    }

    if (action === "verify-udin") {
      return await handleVerifyUdin(ctx, params.id, role, engagement, body);
    }

    if (action === "withdraw") {
      if (!canSignOff(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can withdraw a deliverable.");
      }
      return await handleWithdraw(ctx, params.id, role, engagement, body);
    }

    if (action === "archive") {
      if (!canSignOff(role)) {
        throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can archive a deliverable.");
      }
      return await handleArchive(ctx, params.id, role, engagement, body);
    }

    throw new ApiError(400, "VALIDATION", `Unknown action "${action}".`);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ------------------------------------------------------------------
// Serializers used by action handlers
// ------------------------------------------------------------------

function serializePart(p: EngagementDeliverablePart): Record<string, unknown> {
  return {
    id: p.id,
    kind: p.kind,
    heading: p.heading,
    bodyMarkdown: p.bodyMarkdown,
    ref: p.ref,
    order: p.order,
    attachments: p.attachments ? JSON.parse(p.attachments) : [],
    source: p.source,
    sourceRef: p.sourceRef,
    createdById: p.createdById,
  };
}

function serializeRedaction(r: EngagementDeliverableRedaction): Record<string, unknown> {
  return {
    id: r.id,
    policy: r.policy,
    appliesTo: r.appliesTo,
    note: r.note,
    effectiveForVariant: r.effectiveForVariant,
    createdAt: r.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------------
// Action handlers
// ------------------------------------------------------------------

async function handleCreateFormat(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const code = z.enum(VALID_FORMAT_CODES).parse(body.code as string);
  const label = z
    .string()
    .min(1)
    .parse(body.label as string);
  const description = z
    .string()
    .nullish()
    .parse(body.description as string | undefined | null);
  const defaultVariant = z
    .enum(VALID_VARIANTS)
    .default("CLIENT")
    .parse(body.defaultVariant as string | undefined);
  const clauses = z
    .record(z.string())
    .nullish()
    .parse(body.clauses as Record<string, string> | undefined | null);

  const existing = await prisma.engagementReportFormat.findUnique({
    where: { engagementId_code: { engagementId, code } },
  });
  if (existing) {
    throw new ApiError(409, "DUPLICATE", `A format with code "${code}" already exists for this engagement.`);
  }

  const format = await prisma.engagementReportFormat.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      code,
      label,
      description: description ?? null,
      defaultVariant,
      clauses: clauses ? stringifyJson(clauses) : null,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_FORMAT_CREATED",
        message: `Deliverable format "${label}" (${code}) created for this engagement`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ formatCode: code, label }),
      },
    }),
    ledger(ctx, engagement, role, "DELIVERABLE_FORMAT_CREATED", `Deliverable format "${label}" (${code}) created`, {
      formatCode: code,
      label,
    }),
  ]);

  return ok({ format: serializeFormat(format), status: 201 });
}

async function handleCreateTemplate(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const b = body as Record<string, unknown>;
  const formatCode = z.enum(VALID_FORMAT_CODES).parse(b.formatCode as string);
  const label = z
    .string()
    .min(1)
    .parse(b.label as string);
  const description = z
    .string()
    .nullish()
    .parse(b.description as string | undefined | null);
  const firmName = z
    .string()
    .default("^^FIRM_NAME^^")
    .parse(b.firmName as string | undefined);
  const firmAddress = z
    .string()
    .default("^^FIRM_ADDRESS^^")
    .parse(b.firmAddress as string | undefined);
  const signatoryName = z
    .string()
    .default("^^SIGNATORY_NAME^^")
    .parse(b.signatoryName as string | undefined);
  const signatoryDesignation = z
    .string()
    .default("^^SIGNATORY_DESIGNATION^^")
    .parse(b.signatoryDesignation as string | undefined);
  const dateLabel = z
    .string()
    .default("^^DATE_LABEL^^")
    .parse(b.dateLabel as string | undefined);
  const bodyRaw = z
    .string()
    .min(1)
    .parse(b.body as string);
  const notes = z
    .string()
    .nullish()
    .parse(b.notes as string | undefined | null);
  const effectiveFrom = z
    .string()
    .nullish()
    .parse(b.effectiveFrom as string | undefined | null);
  const effectiveTo = z
    .string()
    .nullish()
    .parse(b.effectiveTo as string | undefined | null);
  const masterRef = z
    .string()
    .nullish()
    .parse(b.masterRef as string | undefined | null);

  if (masterRef) {
    const master = await prisma.organizationReportTemplate.findUnique({
      where: { id: masterRef },
    });
    if (!master) {
      throw new ApiError(404, "NOT_FOUND", "Master template not found.");
    }
    if (master.organizationId !== orgId(ctx)) {
      throw new ApiError(403, "FORBIDDEN", "You do not have access to that master template.");
    }
  }

  const existing = await prisma.engagementReportTemplate.findUnique({
    where: { engagementId_formatCode_label: { engagementId, formatCode, label } },
  });
  if (existing) {
    throw new ApiError(409, "DUPLICATE", `A template with label "${label}" already exists for this format.`);
  }

  const template = await prisma.engagementReportTemplate.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      formatCode,
      label,
      description: description ?? null,
      firmName,
      firmAddress,
      signatoryName,
      signatoryDesignation,
      dateLabel,
      body: bodyRaw,
      notes: notes ?? null,
      effectiveFrom: effectiveFrom ?? null,
      effectiveTo: effectiveTo ?? null,
      masterRef: masterRef ?? null,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_TEMPLATE_CREATED",
        message: `Deliverable template "${label}" created for ${formatCode}`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ formatCode, label, masterRef }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_TEMPLATE_CREATED",
      `Deliverable template "${label}" created for ${formatCode}`,
      { formatCode, label, masterRef },
    ),
  ]);

  return ok({ template: serializeTemplate(template), status: 201 });
}

const certificateRequestSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("CERTIFICATE_44AB"),
    params: z.object({
      turnoverGross: z.string(),
      turnoverExempt: z.string(),
      cashReceipts: z.string(),
      bookkeeping: z.string(),
      auditPerformedBy: z.string(),
      auditPerformedFrom: z.string(),
      auditPerformedTo: z.string(),
      notes: z.array(z.string()).default([]),
    }),
  }),
  z.object({
    format: z.literal("CERTIFICATE_44ADA"),
    params: z.object({
      grossReceiptsPerBooks: z.string(),
      grossReceiptsPerReturn: z.string(),
      bankingChannelPct: z.string(),
      presumptiveIncomeDeclared: z.string(),
      expensesClaimedOver80Pct: z.string(),
      auditPerformedBy: z.string(),
      auditPerformedFrom: z.string(),
      auditPerformedTo: z.string(),
      notes: z.array(z.string()).default([]),
    }),
  }),
  z.object({
    format: z.literal("CERTIFICATE_44AD"),
    params: z.object({
      turnoverGross: z.string(),
      cashReceipts: z.string(),
      bankingChannelPct: z.string(),
      presumptiveIncomeDeclared: z.string(),
      auditPerformedBy: z.string(),
      auditPerformedFrom: z.string(),
      auditPerformedTo: z.string(),
      notes: z.array(z.string()).default([]),
    }),
  }),
  z.object({
    format: z.literal("ADVANCE_TAX"),
    params: z.object({
      totalIncomeComputed: z.string(),
      taxLiabilityTotal: z.string(),
      tdsTcsCredit: z.string(),
      advanceTaxPaid: z.string(),
      selfAssessmentTaxPayable: z.string(),
      instalmentDueDates: z.array(z.object({ dueDate: z.string(), payable: z.string() })).default([]),
    }),
  }),
  z.object({
    format: z.literal("MGMT_LETTER"),
    params: z.object({
      findings: z.array(z.string()).default([]),
      suggestions: z.array(z.string()).default([]),
    }),
  }),
]);

async function handleAssemble(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const formatCode = z.enum(VALID_FORMAT_CODES).parse(body.formatCode as string);
  const templateId = z
    .string()
    .optional()
    .parse(body.templateId as string | undefined);
  const revision = z
    .number()
    .int()
    .min(1)
    .optional()
    .parse(body.revision as number | undefined);
  const variant = z
    .enum(VALID_VARIANTS)
    .default("CLIENT")
    .parse(body.variant as string | undefined);
  const placeholdersRaw = z
    .record(z.string())
    .optional()
    .parse(body.placeholders as Record<string, string> | undefined);
  const computedBody = z
    .string()
    .nullish()
    .parse(body.computedBody as string | undefined | null);
  const includeWorkingPapers = z
    .boolean()
    .default(true)
    .parse(body.includeWorkingPapers as boolean | undefined);
  const workingPaperRefs = z
    .array(z.string())
    .optional()
    .parse(body.workingPaperRefs as string[] | undefined);
  const precedents = z
    .array(z.string())
    .optional()
    .parse(body.precedents as string[] | undefined);
  const remarks = z
    .string()
    .nullish()
    .parse(body.remarks as string | undefined | null);
  const status = z
    .enum(["DRAFT"] as const)
    .default("DRAFT")
    .parse(body.status as string | undefined);
  const certificateRaw = body.certificate as unknown;
  const certificate = certificateRaw === undefined ? undefined : certificateRequestSchema.parse(certificateRaw);

  const placeholders: PlaceholderValues = {};
  for (const key of PLACEHOLDER_KEYS) {
    const v = placeholdersRaw?.[key];
    if (v !== undefined) placeholders[key as keyof PlaceholderValues] = v;
  }

  const where = templateId
    ? { id: templateId, engagementId, formatCode }
    : { engagementId, formatCode, status: "ACTIVE" };
  const template = await prisma.engagementReportTemplate.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });
  if (!template) {
    throw new ApiError(
      404,
      "NOT_FOUND",
      templateId
        ? `Template "${templateId}" not found.`
        : `No active template found for format "${formatCode}". Create one first.`,
    );
  }

  let targetRevision = revision;
  if (targetRevision === undefined) {
    const maxRev = await prisma.engagementDeliverableVersion.findFirst({
      where: { engagementId, formatCode, variant },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    targetRevision = (maxRev?.revision ?? 0) + 1;
  }

  const existing = await prisma.engagementDeliverableVersion.findUnique({
    where: {
      engagementId_formatCode_revision_variant: { engagementId, formatCode, revision: targetRevision, variant },
    },
  });
  if (existing) {
    throw new ApiError(409, "DUPLICATE", `A version at revision ${targetRevision}, variant ${variant} already exists.`);
  }

  let traceParts: WorkingPaperTracePart[] = [];
  if (includeWorkingPapers) {
    traceParts = await loadWorkingPapersForTrace(engagementId, workingPaperRefs);
  }

  const format = await prisma.engagementReportFormat.findUnique({
    where: { engagementId_code: { engagementId, code: formatCode } },
  });

  const renderOpts: RenderOptions = {
    variant,
    placeholders,
    precedents,
    extraBody: computedBody ?? undefined,
    // Persist `^^TOKEN^^` placeholders unresolved: the stored version is the
    // variant-neutral master copy. The render endpoint resolves it per request
    // — CLIENT masks PAN/GSTIN/… identifiers, REVIEWER keeps them in full — so a
    // version assembled as CLIENT can still produce its reviewer copy.
    preservePlaceholders: true,
  };

  const certificatePart = buildCertificatePartBody(certificate as CertificateRequest | undefined, renderOpts);

  const supplementaryParts = [];
  if (formatCode === "NOTES") {
    supplementaryParts.push({
      heading: "Notes to the financial statements — preparation status",
      body: renderNotesSkeleton(template.notes ?? undefined),
      source: "template",
      sourceRef: template.id,
    });
  }

  const assembled = await assemble({
    template,
    format: format ?? undefined,
    computedBody: computedBody ?? undefined,
    workingPapers: traceParts,
    renderOpts,
    certificate: certificatePart,
    supplementaryParts,
  });

  const version = await prisma.$transaction(async (tx) => {
    const v = await tx.engagementDeliverableVersion.create({
      data: {
        organizationId: orgId(ctx),
        engagementId,
        formatCode,
        templateId: template.id,
        revision: targetRevision,
        status,
        variant,
        content: stringifyJson({
          parts: assembled.parts.map((p) => ({
            kind: p.kind,
            heading: p.heading,
            bodyMarkdown: p.bodyMarkdown,
            ref: p.ref,
            order: p.order,
          })),
          assembledBody: assembled.fullBodyMarkdown,
          placeholders,
          variant,
          assembledAt: new Date().toISOString(),
        }),
        bodyHash: assembled.contentHash,
        preparedById: ctx.user.id,
        preparedAt: new Date(),
        remarks: (remarks ?? undefined) as string | null | undefined,
      },
    });

    for (const part of assembled.parts) {
      await tx.engagementDeliverablePart.create({
        data: {
          organizationId: orgId(ctx),
          engagementId,
          versionId: v.id,
          kind: part.kind,
          ref: part.ref ?? null,
          heading: part.heading,
          bodyMarkdown: part.bodyMarkdown,
          attachments: part.attachments ?? "[]",
          source: part.source ?? null,
          sourceRef: part.sourceRef ?? null,
          order: part.order,
          createdById: ctx.user.id,
        },
      });
    }

    for (const trace of traceParts) {
      const wpBody = renderWorkingPaperTracePart(trace, variant, placeholders);
      await tx.engagementDeliverablePart.create({
        data: {
          organizationId: orgId(ctx),
          engagementId,
          versionId: v.id,
          kind: "workingPaperTrace",
          ref: trace.wp.indexRef,
          heading: `Working paper: ${trace.wp.indexRef} \u2014 ${trace.wp.title}`,
          bodyMarkdown: wpBody,
          attachments: "[]",
          source: "workingPaper",
          sourceRef: trace.wp.id,
          order: assembled.parts.length + traceParts.indexOf(trace),
          createdById: ctx.user.id,
        },
      });
    }

    return v;
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_ASSEMBLED",
        message: `Deliverable assembled: ${formatCode} rev ${targetRevision} (${variant})`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({
          formatCode,
          revision: targetRevision,
          variant,
          contentHash: assembled.contentHash,
          partCount: assembled.parts.length,
        }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_ASSEMBLED",
      `Deliverable ${formatCode} rev ${targetRevision} (${variant}) assembled`,
      {
        formatCode,
        revision: targetRevision,
        variant,
        contentHash: assembled.contentHash,
        certificate: certificate?.format ?? null,
      },
      version.id,
    ),
  ]);

  return ok({
    version: serializeVersion(version),
    parts: assembled.parts.map((p) => ({
      kind: p.kind,
      heading: p.heading,
      bodyMarkdown: p.bodyMarkdown,
      ref: p.ref,
      order: p.order,
    })),
    contentHash: assembled.contentHash,
    status: 201,
  });
}

async function handleAddRedaction(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const policy = z.enum(VALID_REDACTION_POLICIES).parse(body.policy as string);
  const appliesTo = z.enum(VALID_REDACTION_APPLIES_TO).parse(body.appliesTo as string);
  const note = z
    .string()
    .nullish()
    .parse(body.note as string | undefined | null);
  const effectiveForVariant = z
    .enum(VALID_REDACTION_VARIANTS)
    .default("CLIENT")
    .parse(body.effectiveForVariant as string | undefined);

  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId },
    include: { format: true },
  });
  if (!version) {
    throw new ApiError(404, "NOT_FOUND", "Version not found.");
  }

  const redaction = await prisma.engagementDeliverableRedaction.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      policy,
      appliesTo,
      note: note ?? null,
      effectiveForVariant,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_REDACTION_ADDED",
        message: `Redaction rule added to version ${versionId}: ${policy} ${appliesTo}`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId, policy, appliesTo, effectiveForVariant }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_REDACTION_ADDED",
      `Redaction rule added to ${version.formatCode} rev ${version.revision}: ${policy} ${appliesTo}`,
      {
        versionId,
        policy,
        appliesTo,
        effectiveForVariant,
      },
      versionId,
    ),
  ]);

  return ok({ redaction: serializeRedaction(redaction) });
}

async function handleSubmitForReview(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const reviewNote = z
    .string()
    .nullish()
    .parse(body.reviewNote as string | undefined | null);

  const version = await loadVersionRow(engagementId, versionId);
  if (version.status !== "DRAFT" && version.status !== "IN_REVIEW") {
    throw new ApiError(400, "VALIDATION", "Version must be in DRAFT or IN_REVIEW status to submit for review.");
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: {
      status: "IN_REVIEW",
      reviewedById: ctx.user.id,
      reviewedAt: new Date(),
      reviewNote: reviewNote ?? version.reviewNote ?? null,
    },
  });

  await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      step: "REVIEW",
      role: "REVIEWER",
      performedById: ctx.user.id,
      note: reviewNote ?? null,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_SUBMITTED_FOR_REVIEW",
        message: `Deliverable version ${versionId} submitted for review`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_SUBMITTED_FOR_REVIEW",
      `Deliverable ${version.formatCode} rev ${version.revision} submitted for review`,
      { versionId },
      versionId,
    ),
  ]);

  return ok({ version: serializeVersion(updated) });
}

async function handleApprove(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const note = z
    .string()
    .nullish()
    .parse(body.note as string | undefined | null);

  const version = await loadVersionRow(engagementId, versionId);
  if (version.status !== "IN_REVIEW" && version.status !== "REVIEWED") {
    throw new ApiError(400, "VALIDATION", "Version must be IN_REVIEW to approve.");
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: {
      status: "REVIEWED",
      reviewNote: note ?? version.reviewNote ?? null,
    },
  });

  await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      step: "APPROVAL",
      role: "REVIEWER",
      performedById: ctx.user.id,
      note,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_APPROVED",
        message: `Deliverable version ${versionId} approved`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_APPROVED",
      `Deliverable ${version.formatCode} rev ${version.revision} reviewed and approved`,
      { versionId },
      versionId,
    ),
  ]);

  return ok({ version: serializeVersion(updated) });
}

async function handleReject(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const note = z
    .string()
    .optional()
    .parse(body.note as string | undefined);

  const version = await loadVersionRow(engagementId, versionId);
  if (version.status !== "IN_REVIEW" && version.status !== "REVIEWED") {
    throw new ApiError(400, "VALIDATION", "Version must be IN_REVIEW or REVIEWED to request changes.");
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: {
      status: "DRAFT",
      reviewNote: [version.reviewNote, `[changes requested] ${note ?? ""}`].filter(Boolean).join("\n") || null,
    },
  });

  await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      step: "REVIEW",
      role: "REVIEWER",
      performedById: ctx.user.id,
      note: `[changes requested] ${note ?? ""}`.trim() || null,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_CHANGES_REQUESTED",
        message: `Changes requested on deliverable version ${versionId}`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId, note }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_CHANGES_REQUESTED",
      `Changes requested on ${version.formatCode} rev ${version.revision}`,
      { versionId, note },
      versionId,
    ),
  ]);

  return ok({ version: serializeVersion(updated) });
}

async function handleSignOff(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const signOffRole = z
    .enum(["PARTNER", "MANAGER"])
    .default("PARTNER")
    .parse(body.signOffRole as string | undefined);
  const note = z
    .string()
    .nullish()
    .parse(body.note as string | undefined | null);

  const version = await loadVersionRow(engagementId, versionId);
  if (version.status !== "REVIEWED" && version.status !== "IN_REVIEW") {
    throw new ApiError(400, "VALIDATION", "Version must be REVIEWED or IN_REVIEW to sign off.");
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: {
      status: "SIGNED_OFF",
      signedOffById: ctx.user.id,
      signedOffAt: new Date(),
      signOffRole,
      reviewNote: note ?? version.reviewNote ?? null,
    },
  });

  await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      step: "SIGN_OFF",
      role: signOffRole,
      performedById: ctx.user.id,
      note,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_SIGNED_OFF",
        message: `Deliverable version ${versionId} signed off by ${signOffRole}`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId, signOffRole }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_SIGNED_OFF",
      `Deliverable ${version.formatCode} rev ${version.revision} signed off by ${signOffRole}`,
      { versionId, signOffRole },
      versionId,
    ),
  ]);

  return ok({ version: serializeVersion(updated) });
}

/** Build the standalone HTML artifact persisted to storage when a version is issued. */
function renderArtifactHtml(version: EngagementDeliverableVersion, parts: EngagementDeliverablePart[]): string {
  const ordered = [...parts].sort((a, b) => a.order - b.order);
  const sections = ordered
    .map((p, i) => {
      const body =
        p.bodyMarkdown.trim().length > 0
          ? htmlForText(p.bodyMarkdown)
          : `<p style="color:#9CA3AF;font-style:italic">Awaiting content for this part.</p>`;
      return `<section class="doc-section">
        <span class="sec-number">${i + 1}</span>
        <h2 style="font-size:18px;margin:1.4em 0 0.5em;color:#111827">${esc(p.heading)}</h2>
        <p style="display:inline-block;margin:2px 0 0;padding:2px 10px;border-radius:999px;font-size:11px;color:#5AA8AA;background:#ECF8F8">${esc(p.source ?? "Manual")}</p>
        ${body}
      </section>`;
    })
    .join("");

  const dated = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
  const issuanceLine = version.udin
    ? `Signed off · ${dated} · UDIN ${esc(version.udin)}`
    : version.documentReference
      ? `Signed off · ${dated} · Document ref ${esc(version.documentReference)} (not an ICAI UDIN)`
      : `Signed off · ${dated}`;
  const body = `
    <header class="doc-header">
      <h1>${esc(`${version.formatCode} — Revision ${version.revision} (${version.variant})`)}</h1>
      <p class="doc-sub">${issuanceLine}</p>
    </header>
    ${sections}
    <footer class="footer">
      <span>Generated by Ledgerly — traceable to underlying working papers and stored artifacts.</span>
      <span>Variant: ${esc(version.variant)} · Revision ${version.revision}</span>
    </footer>`;
  return exportShell({ title: `${version.formatCode} rev ${version.revision}`, body });
}

async function handleIssue(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const issuedFor = z
    .string()
    .nullish()
    .parse(body.issuedFor as string | undefined | null);
  const issuedAtLabel = z
    .string()
    .nullish()
    .parse(body.issuedAtLabel as string | undefined | null);
  const remarks = z
    .string()
    .nullish()
    .parse(body.remarks as string | undefined | null);
  const rawUdin = z.string().nullish().parse(body.udin as string | undefined | null);
  const udinSourceInput = z
    .enum(["icai-udin-portal", "dsc-based-generation", "captured-manually"])
    .nullish()
    .parse(body.udinSource as string | undefined | null);
  const noUdinAcknowledged = z.boolean().optional().parse(body.noUdinAcknowledged as boolean | undefined);

  const version = await loadVersionRow(engagementId, versionId);
  if (version.status !== "SIGNED_OFF") {
    throw new ApiError(400, "VALIDATION", "Version must be SIGNED_OFF to issue.");
  }

  const now = new Date();
  const udin = rawUdin?.trim().toUpperCase() || null;
  if (udin && !isValidUdinFormat(udin)) {
    throw new ApiError(
      400,
      "VALIDATION",
      "That is not a 21-character ICAI UDIN. The app never mints UDINs — copy the number issued by the ICAI UDIN portal.",
    );
  }
  if (!udin && noUdinAcknowledged !== true) {
    throw new ApiError(
      400,
      "VALIDATION",
      "A real ICAI UDIN is required to issue a signed deliverable. Enter the UDIN from the ICAI portal, or explicitly acknowledge issuing an internal copy without one.",
    );
  }
  const udinSource: UdinSource | null = udin ? (udinSourceInput ?? "captured-manually") : null;
  const documentReference = generateInternalUdinId(ctx.user.id, `${versionId}:${version.revision}`, now).value;

  const priorUpdated = await prisma.$transaction(async (tx) => {
    await tx.engagementDeliverableVersion.update({
      where: { id: versionId },
      data: {
        status: "ISSUED",
        issuedById: ctx.user.id,
        issuedAt: now,
        issuedFor: issuedFor ?? null,
        issuedAtLabel: issuedAtLabel ?? null,
        remarks: remarks ?? version.remarks ?? null,
        udin,
        udinSource,
        udinIssuedAt: udin ? now : null,
        documentReference,
      },
    });

    return tx.engagementDeliverableVersion.updateMany({
      where: {
        engagementId,
        formatCode: version.formatCode,
        variant: version.variant,
        status: "ISSUED",
        id: { not: versionId },
      },
      data: { status: "SUPERSEDED" },
    });
  });

  const signOffStep = await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      step: "ISSUANCE",
      role: version.signOffRole ?? "PARTNER",
      performedById: ctx.user.id,
      note: remarks ?? null,
    },
  });

  // Persist the generated HTML artifact so the issued document has an immutable
  // on-disk copy (the route and the "print / PDF" button both read it).
  const fileKey = `exports/deliverables/${versionId}.html`;
  let artifactPath: string | null = null;
  try {
    const parts = await prisma.engagementDeliverablePart.findMany({
      where: { versionId },
      orderBy: { order: "asc" },
    });
    const html = renderArtifactHtml(
      { ...version, status: "ISSUED", udin, udinSource, udinIssuedAt: udin ? now : null, documentReference },
      parts,
    );
    await saveFile(fileKey, html);
    artifactPath = fileKey;
    await prisma.engagementDeliverableVersion.update({
      where: { id: versionId },
      data: { filepath: artifactPath, remarks: null },
    });
  } catch {
    // A storage hiccup must not block issuance — the ledger still records it.
  }

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_ISSUED",
        message: `Deliverable version ${versionId} issued${issuedFor ? ` for ${issuedFor}` : ""}${
          udin ? ` (UDIN ${udin})` : ` (internal ref ${documentReference}; no ICAI UDIN)`
        }`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({
          versionId,
          issuedFor,
          issuedAtLabel,
          udin,
          udinSource,
          documentReference,
          noUdinAcknowledged: !udin,
          priorSuperseded: priorUpdated.count,
        }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_ISSUED",
      `Deliverable ${version.formatCode} rev ${version.revision} issued ${
        udin ? `(UDIN ${udin})` : `(internal ref ${documentReference}; no ICAI UDIN)`
      }`,
      {
        versionId,
        issuedFor,
        udin,
        udinSource,
        documentReference,
        priorSuperseded: priorUpdated.count,
      },
      versionId,
    ),
  ]);

  return ok({
    version: serializeVersion({
      ...version,
      status: "ISSUED",
      issuedById: ctx.user.id,
      issuedAt: now,
      issuedFor: issuedFor ?? null,
      issuedAtLabel: issuedAtLabel ?? null,
      remarks: remarks ?? version.remarks ?? null,
      udin,
      udinSource,
      udinIssuedAt: udin ? now : null,
      documentReference,
      filepath: artifactPath,
    }),
    udin,
    documentReference,
    warnings: udin
      ? []
      : ["Issued without an ICAI UDIN as an internal copy. Do not send this copy to a client or regulator."],
    artifactPath,
    signOffStep: { id: signOffStep.id, step: signOffStep.step },
  });
}

async function handleVerifyUdin(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);

  const version = await loadVersionRow(engagementId, versionId);
  if (!version.udin) {
    throw new ApiError(400, "VALIDATION", "This version has no ICAI UDIN. It was issued as an internal copy.");
  }
  if (!isValidUdinFormat(version.udin)) {
    throw new ApiError(400, "VALIDATION", "Stored UDIN is not 21 uppercase alphanumeric characters.");
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: {
      udinVerifyCount: { increment: 1 },
      udinVerifiedById: ctx.user.id,
      udinVerifiedAt: new Date(),
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_UDIN_VERIFIED",
        message: `UDIN ${version.udin} format validated for version ${versionId} (ICAI registry not contacted)`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId, udin: version.udin }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_UDIN_VERIFIED",
      `UDIN format validated for ${version.formatCode} rev ${version.revision} (ICAI registry not contacted)`,
      { versionId, udin: version.udin },
      versionId,
    ),
  ]);

  return ok({
    version: serializeVersion(updated),
    udin: updated.udin,
    valid: true,
    registryVerified: false,
    note: "Format validated only; the ICAI UDIN registry was not contacted.",
    verifyCount: updated.udinVerifyCount,
  });
}

async function handleWithdraw(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const reason = z
    .string()
    .nullish()
    .parse(body.reason as string | undefined | null);

  const version = await loadVersionRow(engagementId, versionId);
  if (["WITHDRAWN", "SUPERSEDED", "ARCHIVED"].includes(version.status)) {
    throw new ApiError(400, "VALIDATION", "This version is already in a terminal state.");
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: {
      status: "WITHDRAWN",
      remarks: reason ?? version.remarks ?? null,
    },
  });

  await prisma.engagementDeliverableSignOff.create({
    data: {
      organizationId: orgId(ctx),
      engagementId,
      versionId,
      step: "WITHDRAWAL",
      role: "PARTNER",
      performedById: ctx.user.id,
      note: reason ?? null,
    },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_WITHDRAWN",
        message: `Deliverable version ${versionId} withdrawn${reason ? `: ${reason}` : ""}`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId, reason }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_WITHDRAWN",
      `Deliverable ${version.formatCode} rev ${version.revision} withdrawn${reason ? `: ${reason}` : ""}`,
      { versionId, reason },
      versionId,
    ),
  ]);

  return ok({ version: serializeVersion(updated) });
}

async function handleArchive(
  ctx: AuthContext,
  engagementId: string,
  role: Parameters<typeof appendLedgerEntry>[2],
  engagement: { id: string; organizationId: string },
  body: Record<string, unknown>,
) {
  const versionId = z.string().parse(body.versionId as string);
  const version = await loadVersionRow(engagementId, versionId);
  if (version.status === "DRAFT" || version.status === "IN_REVIEW") {
    throw new ApiError(
      400,
      "VALIDATION",
      "Only non-draft deliverable versions can be archived; withdraw drafts instead.",
    );
  }

  const updated = await prisma.engagementDeliverableVersion.update({
    where: { id: versionId },
    data: { status: "ARCHIVED" },
  });

  await Promise.all([
    prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "DELIVERABLE_ARCHIVED",
        message: `Deliverable version ${versionId} archived`,
        targetType: "engagement",
        targetId: engagementId,
        meta: stringifyJson({ versionId }),
      },
    }),
    ledger(
      ctx,
      engagement,
      role,
      "DELIVERABLE_ARCHIVED",
      `Deliverable ${version.formatCode} rev ${version.revision} archived`,
      { versionId },
      versionId,
    ),
  ]);

  return ok({ version: serializeVersion(updated) });
}
