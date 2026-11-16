/**
 * Monthly compliance report — server side.
 *
 * Assembles one client-month from the same facts the calendar and the filing
 * board read: the generated obligation, the firm's filed/waived status, and the
 * filing run that holds the acknowledgement and the proof digest. Nothing here
 * re-derives a due date or invents a tax amount; a missing amount stays missing
 * and the engine marks the exposure as incomplete.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { prisma } from "@/lib/db";
import {
  buildClientComplianceCalendar,
  financialYearFor,
  type EntityKind,
  type GstFrequency,
} from "@/lib/engine/compliance-calendar";
import {
  buildMonthlyComplianceReport,
  isReportMonth,
  type MonthlyComplianceReport,
  type ReportObligation,
} from "@/lib/engine/compliance-report";
import { resolvePortalToken } from "@/lib/server/client-portal";
import { defaultProfile, type ComplianceProfileSeed } from "@/lib/server/compliance-calendar";
import { requireEngagementRole } from "@/lib/server/engagement";

const ENTITY_KINDS = new Set<EntityKind>([
  "company",
  "llp",
  "partnership",
  "proprietorship",
  "trust",
  "individual",
]);
const GST_FREQUENCIES = new Set<GstFrequency>(["monthly", "quarterly"]);

function readProfile(raw: string | null): ComplianceProfileSeed | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ComplianceProfileSeed>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.financialYear !== "string") return null;
    if (parsed.entityKind && !ENTITY_KINDS.has(parsed.entityKind)) return null;
    if (parsed.gstFrequency && !GST_FREQUENCIES.has(parsed.gstFrequency)) return null;
    return {
      entityKind: parsed.entityKind ?? "company",
      financialYear: parsed.financialYear,
      gstRegistered: Boolean(parsed.gstRegistered),
      gstFrequency: parsed.gstFrequency === "quarterly" ? "quarterly" : "monthly",
      tdsDeductor: Boolean(parsed.tdsDeductor),
      taxAuditApplicable: Boolean(parsed.taxAuditApplicable),
      transferPricingApplicable: Boolean(parsed.transferPricingApplicable),
      listedCompany: Boolean(parsed.listedCompany),
      state: parsed.state ?? null,
      employsStaff: Boolean(parsed.employsStaff),
    };
  } catch {
    return null;
  }
}

function assertMonth(month: string): string {
  if (!isReportMonth(month)) {
    throw new ApiError(400, "VALIDATION", `“${month}” is not a month. Use yyyy-mm, e.g. 2026-10.`);
  }
  return month;
}

async function assembleReport(input: {
  organizationId: string;
  engagement: { id: string; name: string };
  month: string;
  asOf: string;
}): Promise<MonthlyComplianceReport> {
  const [profileRow, runs, statuses] = await Promise.all([
    withTenantDb(ctx, (db) =>
      withTenantDb(ctx, (db) =>
        db.clientComplianceProfile.findUnique({
          where: { engagementId: input.engagement.id },
          select: { profile: true },
        }),
    ),
    withTenantDb(ctx, (db) =>
      withTenantDb(ctx, (db) =>
        db.complianceFilingRun.findMany({
          where: { organizationId: input.organizationId, engagementId: input.engagement.id },
          select: {
            taskId: true,
            stage: true,
            dueDate: true,
            filedAt: true,
            acknowledgementReference: true,
            proofDigest: true,
            clientApprovedAt: true,
          },
          take: 500,
        }),
    ),
    withTenantDb(ctx, (db) =>
      withTenantDb(ctx, (db) =>
        db.clientComplianceStatus.findMany({
          where: { organizationId: input.organizationId, engagementId: input.engagement.id },
          select: { taskId: true, status: true, filedOn: true, reference: true },
        }),
    ),
  ]);

  const profile = readProfile(profileRow?.profile ?? null) ?? defaultProfile(financialYearFor(input.asOf), null);
  const generated = buildClientComplianceCalendar({
    ...profile,
    clientId: input.engagement.id,
    clientName: input.engagement.name,
  });

  const runByTask = new Map(runs.map((run) => [run.taskId, run]));
  const statusByTask = new Map(statuses.map((status) => [status.taskId, status]));

  const obligations: ReportObligation[] = generated.map((task) => {
    const run = runByTask.get(task.id);
    const status = statusByTask.get(task.id);
    const runFiled = run?.stage === "filed" || run?.stage === "acknowledged";
    const statusFiled = status?.status === "filed";
    const filed = runFiled || statusFiled;
    const filedDate = runFiled && run?.filedAt
      ? run.filedAt.toISOString().slice(0, 10)
      : statusFiled
        ? status.filedOn
        : null;

    return {
      taskId: task.id,
      code: task.code,
      title: task.title,
      authority: task.authority,
      dueDate: task.dueDate,
      filedDate,
      status: status?.status === "waived" ? "waived" : filed ? "filed" : run ? "in-progress" : "pending",
      reference: run?.acknowledgementReference ?? status?.reference ?? null,
      proofDigest: run?.proofDigest ?? null,
      clientApprovedAt: run?.clientApprovedAt ? run.clientApprovedAt.toISOString() : null,
      state: profile.state ?? null,
    };
  });

  return buildMonthlyComplianceReport({
    month: input.month,
    asOf: input.asOf,
    engagement: input.engagement,
    obligations,
  });
}

/** Firm-side report for one engagement. */
export async function getMonthlyComplianceReport(
  ctx: AuthContext,
  input: { engagementId: string; month?: string; asOf?: string },
): Promise<MonthlyComplianceReport> {
  const month = assertMonth(input.month ?? new Date().toISOString().slice(0, 7));
  const { engagement } = await requireEngagementRole(ctx, input.engagementId, "ASSISTANT");
  return assembleReport({
    organizationId: engagement.organizationId,
    engagement: { id: engagement.id, name: engagement.name ?? "Client" },
    month,
    asOf: input.asOf ?? new Date().toISOString().slice(0, 10),
  });
}

/** Client-portal report for the engagement the link belongs to. */
export async function getPortalMonthlyComplianceReport(
  rawToken: string,
  month: string,
): Promise<MonthlyComplianceReport> {
  const { token, engagement } = await resolvePortalToken(rawToken);
  return assembleReport({
    organizationId: token.organizationId,
    engagement: { id: engagement.id, name: engagement.name },
    month: assertMonth(month),
    asOf: new Date().toISOString().slice(0, 10),
  });
}
