/**
 * Firm operations — the partner's Monday-morning screen.
 *
 * Everything here is counted from rows the firm already owns: the generated
 * statutory calendar, the filing execution board, and open client document
 * requests. No utilisation percentage, WIP value or capacity model is invented;
 * the app does not track timesheets or billing inputs, so it does not pretend
 * to. What it does answer is: what is late, who owns it, and how old is it.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { getComplianceCalendar, type ComplianceTaskView } from "@/lib/server/compliance-calendar";
import { requireOrgRole } from "@/lib/server/members";

export type AgingBucket = "0-7" | "8-14" | "15-30" | "31+";

export interface OperationsSlaItem {
  kind: "obligation" | "document";
  engagementId: string;
  engagementName: string;
  title: string;
  dueDate: string;
  daysLate: number;
  ownerId: string | null;
  ownerName: string | null;
}

export interface OperationsWorkload {
  userId: string;
  name: string;
  email: string;
  role: string;
  openRuns: number;
  overdueRuns: number;
  openDocumentRequests: number;
}

export interface FirmOperations {
  asOf: string;
  totals: {
    clients: number;
    openObligations: number;
    overdueObligations: number;
    dueSoonObligations: number;
    openDocumentRequests: number;
    overdueDocumentRequests: number;
    filingRunsInProgress: number;
    filingRunsOverdue: number;
  };
  aging: { bucket: AgingBucket; obligations: number; documents: number }[];
  sla: OperationsSlaItem[];
  workload: OperationsWorkload[];
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

export function agingBucket(daysLate: number): AgingBucket {
  if (daysLate <= 7) return "0-7";
  if (daysLate <= 14) return "8-14";
  if (daysLate <= 30) return "15-30";
  return "31+";
}

function isOverdue(task: ComplianceTaskView, today: string): boolean {
  return task.state === "overdue" && task.dueDate < today;
}

export async function getFirmOperations(
  ctx: AuthContext,
  opts: { today?: string } = {},
): Promise<FirmOperations> {
  if (!ctx.organization) {
    throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  }
  const organizationId = ctx.organization.id;
  await requireOrgRole(ctx, organizationId, "MEMBER");

  const [calendar, runs, requests, members] = await Promise.all([
    getComplianceCalendar(ctx, { today: opts.today }),
    prisma.complianceFilingRun.findMany({
      where: { organizationId, stage: { not: "acknowledged" } },
      select: { id: true, assigneeId: true, dueDate: true, stage: true },
      take: 1000,
    }),
    prisma.clientDocumentRequest.findMany({
      where: {
        status: "requested",
        OR: [{ workspaceId: ctx.workspace.id }, { engagement: { organizationId } }],
      },
      select: {
        id: true,
        engagementId: true,
        clientName: true,
        title: true,
        dueDate: true,
        requestedById: true,
      },
      take: 1000,
    }),
    prisma.organizationMember.findMany({
      where: { organizationId },
      select: { userId: true, role: true, user: { select: { name: true, email: true } } },
    }),
  ]);

  const today = calendar.asOf;
  const obligations = calendar.tasks.filter(
    (task) => task.state !== "filed" && task.state !== "waived",
  );
  const overdueObligations = obligations.filter((task) => isOverdue(task, today));
  const dueSoonObligations = obligations.filter((task) => task.state === "due-soon");
  const overdueDocuments = requests.filter((request) => request.dueDate < today);

  const engagementNames = new Map(calendar.clients.map((client) => [client.id, client.name]));
  const nameByUser = new Map(
    members.map((member) => [member.userId, member.user.name || member.user.email]),
  );

  const sla: OperationsSlaItem[] = [
    ...overdueObligations.map((task) => ({
      kind: "obligation" as const,
      engagementId: task.clientId,
      engagementName: task.clientName,
      title: task.title,
      dueDate: task.dueDate,
      daysLate: Math.max(0, daysBetween(task.dueDate, today)),
      ownerId: null,
      ownerName: null,
    })),
    ...overdueDocuments.map((request) => ({
      kind: "document" as const,
      engagementId: request.engagementId ?? "",
      engagementName: request.engagementId
        ? (engagementNames.get(request.engagementId) ?? request.clientName)
        : request.clientName,
      title: request.title,
      dueDate: request.dueDate,
      daysLate: Math.max(0, daysBetween(request.dueDate, today)),
      ownerId: request.requestedById,
      ownerName: nameByUser.get(request.requestedById) ?? null,
    })),
  ].sort((a, b) => b.daysLate - a.daysLate);

  const aging: FirmOperations["aging"] = (["0-7", "8-14", "15-30", "31+"] as AgingBucket[]).map(
    (bucket) => ({
      bucket,
      obligations: overdueObligations.filter((task) => agingBucket(daysBetween(task.dueDate, today)) === bucket)
        .length,
      documents: overdueDocuments.filter((request) => agingBucket(daysBetween(request.dueDate, today)) === bucket)
        .length,
    }),
  );

  const workload: OperationsWorkload[] = members.map((member) => {
    const owned = runs.filter((run) => run.assigneeId === member.userId);
    return {
      userId: member.userId,
      name: member.user.name || member.user.email,
      email: member.user.email,
      role: member.role,
      openRuns: owned.length,
      overdueRuns: owned.filter((run) => run.dueDate < today).length,
      openDocumentRequests: requests.filter((request) => request.requestedById === member.userId).length,
    };
  });
  workload.sort((a, b) => b.overdueRuns - a.overdueRuns || b.openRuns - a.openRuns);

  return {
    asOf: today,
    totals: {
      clients: calendar.totals.clients,
      openObligations: obligations.length,
      overdueObligations: overdueObligations.length,
      dueSoonObligations: dueSoonObligations.length,
      openDocumentRequests: requests.length,
      overdueDocumentRequests: overdueDocuments.length,
      filingRunsInProgress: runs.length,
      filingRunsOverdue: runs.filter((run) => run.dueDate < today).length,
    },
    aging,
    sla,
    workload,
  };
}
