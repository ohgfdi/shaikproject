/**
 * Audit logging — Gen-1 adapter.
 *
 * The append-only audit trail lives in the Activity table (one row per
 * significant event, workspace-scoped, never updated or deleted). This module
 * exposes the generic event API used across the codebase:
 *
 *   addAuditEvent({ workspaceId, actorId, eventType, targetType, targetId,
 *                   runId, projectId, payload })
 *
 * plus typed helpers for the common event kinds. `message` is derived from
 * the event type + a short payload summary so the trail stays human-readable
 * without a schema change.
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export type AuditEventType =
  | "execution.sandbox.created"
  | "execution.sandbox.completed"
  | "execution.sandbox.failed"
  | "execution.sandbox.killed"
  | "notebook.cell.run"
  | "sql.query.run"
  | "python.cell.run"
  | "schedule.created"
  | "schedule.updated"
  | "schedule.run.started"
  | "schedule.run.completed"
  | "schedule.run.failed"
  | "schedule.run.skipped"
  | "schedule.run.dead_lettered"
  | "schedule.run.missed"
  | "dataset.uploaded"
  | "dataset.imported"
  | "dataset.version.created"
  | "connector.sync.started"
  | "connector.sync.completed"
  | "connector.sync.failed"
  | "auth.login"
  | "auth.logout"
  | "auth.session.created"
  | "api.key.created"
  | "api.key.revoked"
  | "api.key.used";

export interface AuditEventPayload {
  [key: string]: unknown;
}

export interface AddAuditEventParams {
  workspaceId: string;
  actorId?: string | null;
  eventType: AuditEventType;
  targetType?: string | null;
  targetId?: string | null;
  runId?: string | null;
  projectId?: string | null;
  payload?: AuditEventPayload;
}

export interface AuditEventView {
  id: string;
  eventType: string;
  message: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  runId: string | null;
  projectId: string | null;
  payload: AuditEventPayload;
  createdAt: string;
}

/** Human-readable one-liner for a payload (kept short for the activity list). */
function summarize(eventType: string, payload?: AuditEventPayload): string {
  const p = payload ?? {};
  const bits: string[] = [];
  for (const key of ["status", "kernel", "rowCount", "runNumber", "tableName", "datasetId", "durationMs"]) {
    if (p[key] !== undefined) bits.push(`${key}=${String(p[key]).slice(0, 40)}`);
  }
  const summary = bits.length > 0 ? ` · ${bits.join(", ")}` : "";
  return `${eventType}${summary}`;
}

/** Append an audit event to the trail. Returns the created row. */
export async function addAuditEvent(params: AddAuditEventParams): Promise<{ id: string; createdAt: Date }> {
  const created = await prisma.activity.create({
    data: {
      workspaceId: params.workspaceId,
      projectId: params.projectId ?? null,
      actorId: params.actorId ?? null,
      type: params.eventType,
      message: summarize(params.eventType, params.payload),
      targetType: params.targetType ?? null,
      targetId: params.targetId ?? null,
      runId: params.runId ?? null,
      meta: params.payload ? stringifyJson(params.payload) : null,
    },
  });
  return { id: created.id, createdAt: created.createdAt };
}

export interface AuditQueryParams {
  workspaceId: string;
  eventType?: AuditEventType;
  targetType?: string;
  targetId?: string;
  runId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Map a persisted Activity row to its API view. Exported so the DB-free unit
 * tests can cover the column→view mapping without a live database.
 */
export function auditRowToView(row: {
  id: string;
  type: string;
  message: string;
  actorId: string | null;
  projectId: string | null;
  targetType: string | null;
  targetId: string | null;
  runId: string | null;
  meta: string | null;
  createdAt: Date;
}): AuditEventView {
  let payload: AuditEventPayload = {};
  try {
    payload = row.meta ? (JSON.parse(row.meta) as AuditEventPayload) : {};
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    eventType: row.type,
    message: row.message,
    actorId: row.actorId,
    targetType: row.targetType,
    targetId: row.targetId,
    runId: row.runId,
    projectId: row.projectId,
    payload,
    createdAt: row.createdAt.toISOString(),
  };
}

function toView(row: Parameters<typeof auditRowToView>[0]): AuditEventView {
  return auditRowToView(row);
}

/**
 * Where-clause for a single audit coordinate. Rows written before the
 * `targetType`/`targetId`/`runId` columns existed (null columns) are still
 * matched through the legacy free-text `meta` payload.
 */
function columnOrMetaClause(
  field: "targetType" | "targetId" | "runId",
  value?: string | null,
): Prisma.ActivityWhereInput {
  if (!value) return {};
  return {
    OR: [{ [field]: value }, { [field]: null, meta: { contains: value } }],
  };
}

/** Query audit events (newest first) within a workspace. */
export async function queryAuditEvents(params: AuditQueryParams): Promise<AuditEventView[]> {
  const ands: Prisma.ActivityWhereInput[] = [];
  for (const field of ["targetType", "targetId", "runId"] as const) {
    const clause = columnOrMetaClause(field, params[field]);
    if (Object.keys(clause).length > 0) ands.push(clause);
  }
  const rows = await prisma.activity.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.eventType ? { type: params.eventType } : {}),
      ...(ands.length ? { AND: ands } : {}),
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.from || params.to ? { createdAt: { gte: params.from, lte: params.to } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 200,
    skip: params.offset ?? 0,
  });
  return rows.map(toView);
}

/** All audit events linked to a run. */
export async function getAuditEventsForRun(runId: string): Promise<AuditEventView[]> {
  const rows = await prisma.activity.findMany({
    where: {
      AND: [columnOrMetaClause("runId", runId)],
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toView);
}

export interface AuditTargetQuery {
  workspaceId: string;
  targetType: string;
  targetId: string;
  limit?: number;
}

/** Audit events for a specific target. */
export async function getAuditEventsForTarget(params: AuditTargetQuery): Promise<AuditEventView[]> {
  const rows = await prisma.activity.findMany({
    where: {
      workspaceId: params.workspaceId,
      AND: [columnOrMetaClause("targetType", params.targetType), columnOrMetaClause("targetId", params.targetId)],
    },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 50,
  });
  return rows.map(toView);
}

export interface AuditExistsQuery {
  workspaceId: string;
  eventType: AuditEventType;
  runId?: string;
  targetId?: string;
}

/** Cheap existence check (used for idempotent event creation). */
export async function auditEventExists(params: AuditExistsQuery): Promise<boolean> {
  const row = await prisma.activity.findFirst({
    where: {
      workspaceId: params.workspaceId,
      type: params.eventType,
      ...(params.runId ? columnOrMetaClause("runId", params.runId) : {}),
      ...(params.targetId ? columnOrMetaClause("targetId", params.targetId) : {}),
    },
    select: { id: true },
  });
  return row !== null;
}

/** Typed helper: notebook cell run. */
export async function logNotebookCellRun(params: {
  workspaceId: string;
  actorId: string;
  notebookId: string;
  cellId?: string;
  cellPosition?: number;
  code?: string;
  status: "success" | "error";
  kernel?: string;
  durationMs?: number;
}): Promise<void> {
  await addAuditEvent({
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    eventType: "notebook.cell.run",
    targetType: "notebook",
    targetId: params.notebookId,
    payload: {
      cellId: params.cellId,
      cellPosition: params.cellPosition,
      code: params.code?.slice(0, 1000),
      status: params.status,
      kernel: params.kernel,
      durationMs: params.durationMs,
    },
  });
}

/** Typed helper: SQL query run. */
export async function logSqlQueryRun(params: {
  workspaceId: string;
  actorId: string;
  query: string;
  status: "success" | "error";
  rowCount?: number;
  executionTimeMs?: number;
}): Promise<void> {
  await addAuditEvent({
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    eventType: "sql.query.run",
    targetType: "sql_query",
    payload: {
      query: params.query.slice(0, 10000),
      status: params.status,
      rowCount: params.rowCount,
      executionTimeMs: params.executionTimeMs,
    },
  });
}

/** Typed helper: schedule run lifecycle. */
export async function logScheduleRun(params: {
  organizationId: string;
  actorId?: string | null;
  jobId: string;
  runId?: string;
  runNumber?: number;
  status: "started" | "completed" | "failed" | "skipped" | "dead_lettered" | "missed";
  error?: string;
  artifactPath?: string;
  triggeredBy?: string;
  durationMs?: number;
}): Promise<void> {
  await addAuditEvent({
    workspaceId: params.organizationId,
    actorId: params.actorId ?? null,
    eventType: `schedule.run.${params.status}` as AuditEventType,
    targetType: "schedule",
    targetId: params.jobId,
    runId: params.runId ?? null,
    payload: {
      runNumber: params.runNumber,
      status: params.status,
      error: params.error,
      artifactPath: params.artifactPath,
      triggeredBy: params.triggeredBy,
      durationMs: params.durationMs,
    },
  });
}

/** Typed helper: connector sync lifecycle. */
export async function logConnectorSync(params: {
  workspaceId: string;
  actorId?: string | null;
  connectorId: string;
  datasetId?: string;
  tableName?: string;
  status: "started" | "completed" | "failed";
  rowCount?: number;
  triggeredBy?: string;
  durationMs?: number;
}): Promise<void> {
  await addAuditEvent({
    workspaceId: params.workspaceId,
    actorId: params.actorId ?? null,
    eventType: `connector.sync.${params.status}` as AuditEventType,
    targetType: "connector",
    targetId: params.connectorId,
    payload: {
      datasetId: params.datasetId,
      tableName: params.tableName,
      status: params.status,
      rowCount: params.rowCount,
      triggeredBy: params.triggeredBy,
      durationMs: params.durationMs,
    },
  });
}
