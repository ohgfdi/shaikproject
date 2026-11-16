// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - activity logging is a deployment-wide aggregate operation
import type { AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson, stringifyJson } from "@/lib/json";
import { DEFAULT_WORKSPACE_SETTINGS, NOTIFICATION_TYPES, type WorkspaceSettings } from "@/lib/types";

export type ActivityKind =
  | "PROJECT_CREATED"
  | "PROJECT_UPDATED"
  | "PROJECT_ARCHIVED"
  | "DATASET_UPLOADED"
  | "DATASET_IMPORTED"
  | "DATASET_UPDATED"
  | "ANALYSIS_RUN"
  | "INSIGHTS_GENERATED"
  | "DASHBOARD_CREATED"
  | "DASHBOARD_UPDATED"
  | "REPORT_CREATED"
  | "REPORT_UPDATED"
  | "REPORT_EXPORTED"
  | "PRESENTATION_CREATED"
  | "PRESENTATION_UPDATED"
  | "PRESENTATION_EXPORTED"
  | "ADVISOR_ASKED"
  | "ARTIFACT_DELETED"
  | "NOTEBOOK_CREATED"
  | "NOTEBOOK_UPDATED"
  | "NOTEBOOK_CELL_RUN"
  | "SQL_QUERY_RUN"
  | "SQL_MATERIALIZED"
  | "MODEL_TRAINED"
  | "MODEL_PROMOTED"
  | "MODEL_RETIRED"
  | "SCHEDULE_CREATED"
  | "SCHEDULE_UPDATED"
  | "SCHEDULE_DELETED"
  | "SCHEDULE_RUN"
  | "WHATIF_RUN"
  | "NOTEBOOK_PUBLISHED"
  | "PUBLICATION_PUBLIC_LINK"
  | "PIVOT_TABLE"
  | "ANALYSIS_VERSION_DIFF"
  | "SCHEDULE_CREATED"
  | "SCHEDULE_UPDATED"
  | "SCHEDULE_RUN"
  | "PROMPT_CREATED"
  | "PROMPT_UPDATED"
  | "MEMBER_ADDED"
  | "MEMBER_UPDATED"
  | "MEMBER_REMOVED"
  | "COMMENT_ADDED"
  | "CONNECTOR_CREATED"
  | "CONNECTOR_UPDATED"
  | "CONNECTOR_DELETED"
  | "CONNECTOR_TESTED"
  | "CONNECTOR_IMPORTED"
  | "CONNECTOR_SYNCED"
  | "DATASET_VERSIONED"
  | "ANALYSIS_EXPORTED"
  | "MODEL_EXPORTED"
  | "NOTEBOOK_EXPORTED"
  | "WHATIF_EXPORTED"
  | "HYPOTHESIS_EXPORTED"
  | "CONNECTOR_SYNCED"
  | "SECURITY_SIGN_IN"
  | "SECURITY_SIGN_OUT"
  | "COPILOT"
  | "EXECUTIVE_SUMMARY"
  | "KEY_INFLUENCERS"
  | "DECOMPOSITION_TREE"
  | "DAX_MEASURE"
  | "MODEL_MEASURE"
  | "MODEL_RELATIONSHIP_REMOVED"
  | "TRANSFORM_PREVIEW"
  | "TRANSFORM_SAVE"
  | "KPI_EVAL"
  | "DATASET_CREATED"
  | "SECURITY_VERIFY"
  | "SECURITY_SSO"
  | "SECURITY_MFA_ENABLED"
  | "SECURITY_MFA_DISABLED"
  | "ORGANIZATION_CREATED"
  | "ORGANIZATION_UPDATED"
  | "ORGANIZATION_MEMBER_ADDED"
  | "ORGANIZATION_MEMBER_UPDATED"
  | "ORGANIZATION_MEMBER_REMOVED"
  | "ENGAGEMENT_CREATED"
  | "ENGAGEMENT_UPDATED"
  | "ENGAGEMENT_ARCHIVED"
  | "BILLING_CHECKOUT"
  | "BILLING_MANUAL_REQUESTED"
  | "BILLING_PAID"
  | "PHONE_LINK_REQUESTED"
  | "PHONE_VERIFIED"
  | "DPDP_ERASURE"
  | "RLS_RULES_UPDATED"
  | "STATUTE_INGESTED"
  | "STATUTE_SOURCE_ADDED"
  | "STATUTE_RULE_PUBLISHED"
  | "STATUTE_REGISTRY_SEEDED"
  | "CA_SOURCE_CREATED"
  | "CA_SOURCE_UPDATED"
  | "CA_SOURCE_DELETED"
  | "CA_SOURCE_INGESTED"
  | "CA_SOURCE_INGEST_FAILED"
  | "CA_SOURCE_PROFILE_SAVED"
  | "CA_MAPPING_PROFILE_CREATED"
  | "CA_MAPPING_PROFILE_UPDATED"
  | "CA_MAPPING_PROFILE_DELETED"
  | "COMPLIANCE_FILING_STARTED"
  | "COMPLIANCE_FILING_ADVANCED"
  | "COMPLIANCE_FILING_SUBMITTED"
  | "PRACTICE_TIME_LOGGED"
  | "PRACTICE_INVOICE_ISSUED"
  | "PRACTICE_INVOICE_PAID"
  | "PRACTICE_INVOICE_VOIDED"
  | "PRACTICE_AUTO_ASSIGNED"
  | "COMPLIANCE_FILING_VERIFIED"
  | "COMPLIANCE_FILING_DUE_DATE_MOVED"
  | "COMPLIANCE_FILING_BULK_ASSIGNED"
  | "XERO_CONNECTED"
  | "DOCUMENT_REQUEST_REMINDED";

/**
 * Record a security-relevant event (sign-in/out, SSO, member changes) onto
 * the audit trail. Uses workspace + actor from the session directly — called
 * from auth routes where an AuthContext may not exist yet.
 */
export async function logSecurityEvent(
  workspaceId: string,
  actorId: string | null,
  kind:
    | "SECURITY_SIGN_IN"
    | "SECURITY_SIGN_OUT"
    | "SECURITY_VERIFY"
    | "SECURITY_SSO"
  | "SECURITY_MFA_ENABLED"
  | "SECURITY_MFA_DISABLED"
    | "MEMBER_ADDED"
    | "MEMBER_UPDATED"
    | "MEMBER_REMOVED"
    | "SCHEDULE_RUN",
  message: string,
  projectId?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await prisma.activity.create({
    data: {
      workspaceId,
      projectId: projectId ?? null,
      actorId,
      type: kind,
      message,
      meta: meta ? stringifyJson(meta) : null,
    },
  });
}

export async function logActivity(
  ctx: AuthContext,
  kind: ActivityKind,
  message: string,
  projectId?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await prisma.activity.create({
    data: {
      workspaceId: ctx.workspace.id,
      projectId: projectId ?? null,
      actorId: ctx.user.id,
      type: kind,
      message,
      meta: meta ? stringifyJson(meta) : null,
    },
  });
}

export interface NotificationInput {
  type: "anomaly" | "data-quality" | "analysis" | "report" | "dashboard" | "system";
  title: string;
  message?: string;
}

/**
 * Create an in-app notification row (the bell icon reads these).
 * Respects the user's notification-type preferences stored in workspace
 * settings — silenced types are dropped before they reach the inbox.
 */
export async function notify(userId: string, input: NotificationInput): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspace: { select: { settings: true } } },
  });
  const prefs = parseJson<WorkspaceSettings>(user?.workspace?.settings, DEFAULT_WORKSPACE_SETTINGS);
  const allowed = prefs.notificationTypes?.length ? prefs.notificationTypes : [...NOTIFICATION_TYPES];
  if (!allowed.includes(input.type)) return;
  await prisma.notification.create({
    data: { userId, type: input.type, title: input.title, message: input.message },
  });
}
