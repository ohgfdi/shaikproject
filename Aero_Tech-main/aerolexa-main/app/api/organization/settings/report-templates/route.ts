import { z } from "zod";

import type { OrganizationReportTemplate } from "@/generated/prisma/client";
import { ApiError, requireAuth, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireOrgRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

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

const VALID_STATUSES = ["ACTIVE", "DRAFT", "RETIRED"] as const;

function orgId(ctx: AuthContext) {
  if (!ctx.organization) throw new Error("No organization.");
  return ctx.organization.id;
}

function serializeMaster(template: OrganizationReportTemplate): Record<string, unknown> {
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
    notes: template.notes ? JSON.parse(template.notes) : undefined,
    effectiveFrom: template.effectiveFrom,
    effectiveTo: template.effectiveTo,
    status: template.status,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    await requireOrgRole(ctx, orgId(ctx), "MEMBER");

    const searchParams = new URL(request.url).searchParams;
    const formatCode = searchParams.get("formatCode");
    const status = searchParams.get("status");

    const where: Record<string, unknown> = { organizationId: orgId(ctx) };
    if (formatCode) {
      if (!VALID_FORMAT_CODES.includes(formatCode as (typeof VALID_FORMAT_CODES)[number])) {
        throw new ApiError(400, "VALIDATION", `Invalid formatCode "${formatCode}".`);
      }
      where.formatCode = formatCode;
    }
    if (status) {
      if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
        throw new ApiError(400, "VALIDATION", `Invalid status "${status}".`);
      }
      where.status = status;
    }

    const templates = await prisma.organizationReportTemplate.findMany({
      where,
      orderBy: [{ formatCode: "asc" }, { label: "asc" }],
      include: {
        _count: { select: { engagements: true } },
      },
    });

    return ok({
      masters: templates.map((t) => ({
        ...serializeMaster(t),
        usedByEngagements: t._count.engagements,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    await requireOrgRole(ctx, orgId(ctx), "ADMIN");
    const body = await readJsonBody(request);

    const formatCode = z.enum(VALID_FORMAT_CODES).parse((body as Record<string, unknown>).formatCode as string);
    const label = z
      .string()
      .min(1)
      .parse((body as Record<string, unknown>).label as string);
    const description = z
      .string()
      .nullish()
      .parse((body as Record<string, unknown>).description as string | undefined | null);
    const firmName = z
      .string()
      .default("^^FIRM_NAME^^")
      .parse((body as Record<string, unknown>).firmName as string | undefined);
    const firmAddress = z
      .string()
      .default("^^FIRM_ADDRESS^^")
      .parse((body as Record<string, unknown>).firmAddress as string | undefined);
    const signatoryName = z
      .string()
      .default("^^SIGNATORY_NAME^^")
      .parse((body as Record<string, unknown>).signatoryName as string | undefined);
    const signatoryDesignation = z
      .string()
      .default("^^SIGNATORY_DESIGNATION^^")
      .parse((body as Record<string, unknown>).signatoryDesignation as string | undefined);
    const dateLabel = z
      .string()
      .default("^^DATE_LABEL^^")
      .parse((body as Record<string, unknown>).dateLabel as string | undefined);
    const bodyRaw = z
      .string()
      .min(1)
      .parse((body as Record<string, unknown>).body as string);
    const notes = z
      .string()
      .nullish()
      .parse((body as Record<string, unknown>).notes as string | undefined | null);
    const effectiveFrom = z
      .string()
      .nullish()
      .parse((body as Record<string, unknown>).effectiveFrom as string | undefined | null);
    const effectiveTo = z
      .string()
      .nullish()
      .parse((body as Record<string, unknown>).effectiveTo as string | undefined | null);
    const status = z
      .enum(VALID_STATUSES)
      .default("ACTIVE")
      .parse((body as Record<string, unknown>).status as string | undefined);

    const existing = await prisma.organizationReportTemplate.findUnique({
      where: { organizationId_formatCode_label: { organizationId: orgId(ctx), formatCode, label } },
    });
    if (existing) {
      throw new ApiError(409, "DUPLICATE", `A master template with label "${label}" already exists for ${formatCode}.`);
    }

    const template = await prisma.organizationReportTemplate.create({
      data: {
        organizationId: orgId(ctx),
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
        status,
      },
    });

    await prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "ORG_REPORT_TEMPLATE_CREATED",
        message: `Master report template "${label}" created for ${formatCode}`,
        targetType: "organization",
        targetId: orgId(ctx),
        meta: stringifyJson({ formatCode, label }),
      },
    });

    return ok({ master: serializeMaster(template), status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAuth();
    await requireOrgRole(ctx, orgId(ctx), "ADMIN");
    const body = await readJsonBody<{
      id: string;
      label?: string;
      description?: string | null;
      firmName?: string;
      firmAddress?: string;
      signatoryName?: string;
      signatoryDesignation?: string;
      dateLabel?: string;
      body?: string;
      notes?: string | null;
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
      status?: string;
    }>(request);

    const id = body.id;
    if (!id) throw new ApiError(400, "VALIDATION", "id is required.");

    const existing = await prisma.organizationReportTemplate.findFirst({
      where: {
        id,
        organizationId: orgId(ctx),
      },
    });
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", "Master template not found.");
    }

    const data: Record<string, unknown> = {};
    if (body.label !== undefined) {
      const label = z.string().min(1).parse(body.label);
      const dup = await prisma.organizationReportTemplate.findUnique({
        where: {
          organizationId_formatCode_label: { organizationId: orgId(ctx), formatCode: existing.formatCode, label },
        },
      });
      if (dup && dup.id !== id) {
        throw new ApiError(
          409,
          "DUPLICATE",
          `A master template with label "${label}" already exists for ${existing.formatCode}.`,
        );
      }
      data.label = label;
    }
    if (body.description !== undefined) data.description = body.description;
    if (body.firmName !== undefined) data.firmName = z.string().parse(body.firmName);
    if (body.firmAddress !== undefined) data.firmAddress = z.string().parse(body.firmAddress);
    if (body.signatoryName !== undefined) data.signatoryName = z.string().parse(body.signatoryName);
    if (body.signatoryDesignation !== undefined)
      data.signatoryDesignation = z.string().parse(body.signatoryDesignation);
    if (body.dateLabel !== undefined) data.dateLabel = z.string().parse(body.dateLabel);
    if (body.body !== undefined) data.body = z.string().min(1).parse(body.body);
    if (body.notes !== undefined) data.notes = body.notes ?? null;
    if (body.effectiveFrom !== undefined) data.effectiveFrom = body.effectiveFrom ?? null;
    if (body.effectiveTo !== undefined) data.effectiveTo = body.effectiveTo ?? null;
    if (body.status !== undefined) {
      const status = z.enum(VALID_STATUSES).parse(body.status);
      data.status = status;
    }

    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "VALIDATION", "Nothing to update.");
    }

    const updated = await prisma.organizationReportTemplate.update({
      where: { id },
      data,
    });

    await prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "ORG_REPORT_TEMPLATE_UPDATED",
        message: `Master report template "${updated.label}" updated`,
        targetType: "organization",
        targetId: orgId(ctx),
        meta: stringifyJson({ formatCode: updated.formatCode, label: updated.label }),
      },
    });

    return ok({ master: serializeMaster(updated) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireAuth();
    await requireOrgRole(ctx, orgId(ctx), "ADMIN");

    const searchParams = new URL(request.url).searchParams;
    const id = searchParams.get("id");
    if (!id) throw new ApiError(400, "VALIDATION", "id query param is required.");

    const existing = await prisma.organizationReportTemplate.findFirst({
      where: {
        id,
        organizationId: orgId(ctx),
      },
      include: {
        _count: { select: { engagements: true } },
      },
    });
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", "Master template not found.");
    }

    if (existing._count.engagements > 0) {
      throw new ApiError(
        400,
        "IN_USE",
        `This master template is referenced by ${existing._count.engagements} engagement(s). Retire it instead of deleting.`,
      );
    }

    await prisma.organizationReportTemplate.delete({ where: { id } });

    await prisma.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: orgId(ctx),
        type: "ORG_REPORT_TEMPLATE_DELETED",
        message: "Master report template deleted",
        targetType: "organization",
        targetId: orgId(ctx),
        meta: stringifyJson({ formatCode: existing.formatCode, label: existing.label }),
      },
    });

    return ok({ deleted: id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
