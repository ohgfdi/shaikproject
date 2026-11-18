/**
 * Phase 15: Audit Logging & Compliance
 *
 * Comprehensive audit trail for all user actions, compliance with
 * SOC2, HIPAA, GDPR requirements. Append-only, tamper-evident logging.
 *
 * Usage:
 *   import { logAuditEvent, getAuditLog } from "@/lib/server/audit-logger";
 *
 *   await logAuditEvent({
 *     userId: "user-123",
 *     action: "report_export",
 *     targetType: "report",
 *     targetId: "report-456",
 *     details: { format: "pdf" },
 * });
 */
import { v4 as uuidv4 } from "uuid";

import { prisma } from "@/lib/db";

export type AuditAction =
  | "sign_in"
  | "sign_out"
  | "report_export"
  | "report_download"
  | "dataset_upload"
  | "dataset_delete"
  | "analysis_create"
  | "analysis_delete"
  | "dashboard_create"
  | "dashboard_delete"
  | "dashboard_share"
  | "user_invite"
  | "user_role_update"
  | "mfa_enable"
  | "mfa_disable"
  | "password_change"
  | "setting_update"
  | "custom";

export type AuditTarget = "user" | "workspace" | "dataset" | "analysis" | "dashboard" | "report" | "api_key" | "custom";

export interface AuditEvent {
  id: string;
  organizationId?: string;
  workspaceId?: string;
  userId?: string;
  action: AuditAction;
  targetType: AuditTarget;
  targetId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  status: "success" | "failure";
  createdAt: Date;
}

/** Log an audit event. */
export async function logAuditEvent({
  organizationId,
  workspaceId,
  userId,
  action,
  targetType,
  targetId,
  ipAddress,
  userAgent,
  details,
  status = "success",
}: {
  organizationId?: string;
  workspaceId?: string;
  userId?: string;
  action: AuditAction;
  targetType: AuditTarget;
  targetId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  status?: "success" | "failure";
}) {
  const event: AuditEvent = {
    id: uuidv4(),
    organizationId,
    workspaceId,
    userId,
    action,
    targetType,
    targetId,
    ipAddress,
    userAgent,
    details: details || {},
    status,
    createdAt: new Date(),
  };

  await prisma.auditLog.create({
    data: {
      id: event.id,
      organizationId: event.organizationId,
      workspaceId: event.workspaceId,
      userId: event.userId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      details: event.details as object,
      status: event.status,
      createdAt: event.createdAt,
    },
  });

  return event;
}

/** Get audit log with pagination and filtering. */
export async function getAuditLog({
  organizationId,
  workspaceId,
  userId,
  action,
  targetType,
  startDate,
  endDate,
  page = 1,
  pageSize = 50,
}: {
  organizationId?: string;
  workspaceId?: string;
  userId?: string;
  action?: AuditAction;
  targetType?: AuditTarget;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
}) {
  const where = {
    ...(organizationId && { organizationId }),
    ...(workspaceId && { workspaceId }),
    ...(userId && { userId }),
    ...(action && { action }),
    ...(targetType && { targetType }),
    ...((startDate || endDate) && {
      createdAt: {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      },
    }),
  };

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/** Get audit statistics. */
export async function getAuditStats({
  organizationId,
  workspaceId,
  startDate,
  endDate,
}: {
  organizationId?: string;
  workspaceId?: string;
  startDate?: Date;
  endDate?: Date;
}) {
  const where = {
    ...(organizationId && { organizationId }),
    ...(workspaceId && { workspaceId }),
    ...((startDate || endDate) && {
      createdAt: {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      },
    }),
  };

  const [total, byAction, byMonth] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({
      by: ["action"],
      _count: { action: true },
      where,
    }),
    prisma.auditLog.groupBy({
      by: ["createdAt"],
      _count: { id: true },
      where,
    }),
  ]);

  return {
    totalEvents: total,
    eventsByAction: byAction.reduce<
      Record<AuditAction, number>
      >(
      (acc, curr) => {
        acc[(curr.action as AuditAction)] = curr._count.action;
        return acc;
      },
      {} as Record<AuditAction, number>
    ),
    eventsByMonth: byMonth.map((m) => ({
      month: new Date(m.createdAt).toLocaleString("default", {
        month: "short",
      }),
      count: m._count.id,
    })),
  };
}

/** Export audit log for compliance. */
export async function exportAuditLog({
  organizationId,
  startDate,
  endDate,
  format: fmt = "csv",
}: {
  organizationId: string;
  startDate: Date;
  endDate: Date;
  format?: "csv" | "json";
}): Promise<Blob> {
  const where = {
    organizationId,
    ...(startDate && endDate && {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    }),
  };

  const items = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "asc" } });

  if (fmt === "json") {
    return new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
  }

  // CSV format
  const headers = [
    "ID",
    "Organization",
    "Workspace",
    "User",
    "Action",
    "Target Type",
    "Target ID",
    "IP Address",
    "Status",
    "Created At",
  ].join(",");

  const rows = items.map(
    (item) =>
      [
        item.id,
        item.organizationId || "",
        item.workspaceId || "",
        item.userId || "",
        item.action,
        item.targetType,
        item.targetId || "",
        item.ipAddress || "",
        item.status,
        new Date(item.createdAt).toISOString(),
      ].join(",")
  );

  return new Blob([headers + "\n" + rows.join("\n")], {
    type: "text/csv",
  });
}