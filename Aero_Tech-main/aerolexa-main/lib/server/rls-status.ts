/**
 * RLS wiring status — one truthful source.
 *
 * `withTenantContext()` sets the transaction-scoped GUCs the policies compare
 * against, but the application still queries `prisma` directly in most places.
 * Enabling RLS before those call sites are wrapped hides every row, so this
 * constant was FALSE until a tenancy audit reported zero unwrapped tenant files.
 *
 * Keeping this as a pure module (no runtime deps) lets both the runtime guard
 * and the health/posture report agree without importing Prisma.
 *
 * STATUS: NOT WIRED. `npm run tenancy:audit` still reports unwrapped tenant
 * files (the measured baseline below), so enabling RLS now would hide every
 * row those call sites read. The flag flips to true only when the audit
 * reports zero unwrapped files — the docs, the posture report and the tests
 * all move together at that point.
 */
export const RLS_QUERY_LAYER_WIRED = false;

/**
 * Measured `npm run tenancy:audit` count at the time this baseline was set.
 *
 * A ratchet, not a target: unwrappedFiles may fall below it as files are
 * wrapped, and must never rise above it. Adding a direct Prisma access path on
 * a tenant model fails tenancy-ratchet.test.ts, which forces the choice
 * between wrapping the file and consciously raising this number with a reason.
 * When the audit reaches zero, RLS_ENABLED=true is safe to keep on; the ratchet
 * still prevents new direct accesses from being added without wrapping.
 *
 * History: 169 at first measurement, 160 after batch 2 (search, comments,
 * organization admin, reports/presentations/dashboards/insights routes, chat).
 * Lower it in the same PR that wraps files — never raise it silently.
 */
export const RLS_UNWRAPPED_BASELINE = 160;

/**
 * Tenant-scoped Prisma accessors covered by the audit.
 */
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