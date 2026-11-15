/**
 * RLS wiring status — one truthful source.
 *
 * `withTenantContext()` sets the transaction-scoped GUCs the policies compare
 * against, but the application still queries `prisma` directly in most places.
 * Enabling RLS before those call sites are wrapped hides every row, so this
 * constant is FALSE until a tenancy audit reports zero unwrapped tenant files.
 *
 * Keeping this here (a pure module) lets both the runtime guard and the
 * health/posture report agree without importing Prisma.
 */
export const RLS_QUERY_LAYER_WIRED = false;

/** Tenant-scoped Prisma accessors covered by the audit. */
export const TENANT_MODELS: readonly string[] = [
  "organization",
  "organizationMember",
  "engagement",
  "project",
  "dataset",
  "analysis",
  "insight",
  "dashboard",
  "report",
  "presentation",
  "activity",
  "complianceFilingRun",
  "complianceFilingEvent",
  "clientPortalToken",
  "clientPortalAccount",
  "clientPortalLoginToken",
  "clientPortalUpload",
  "clientComplianceProfile",
  "clientComplianceStatus",
  "filingRollout",
  "mailOutbox",
];

/** Command that measures the gap. */
export const RLS_AUDIT_COMMAND = "npm run tenancy:audit";
