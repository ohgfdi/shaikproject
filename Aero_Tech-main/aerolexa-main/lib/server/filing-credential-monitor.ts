/**
 * Scheduled live-filing credential monitor.
 *
 * A live filing deployment can only file while its portal credentials are
 * valid, and those expire, rotate or get revoked. Without a monitor that
 * failure surfaces at filing time — on a due date. This job runs the filing
 * credential **preflight** on the scheduler's cadence and raises an in-app alert
 * to firm admins the moment the handshake stops working (and again when it
 * recovers), with a cooldown so a flapping portal cannot spam the inbox.
 *
 * It transmits nothing: the preflight is the auth handshake only — no IRN is
 * created and no return is lodged (see `filingGatewayPreflight`). It is a no-op
 * unless `FILING_GATEWAY=live` and the monitor is enabled.
 *
 * Design notes (mirrors the alert/digest jobs):
 *  - env-gated and idempotent; the scheduler calls it and isolates failures.
 *  - the fire → cooldown → recover decision is a PURE function, oracle-tested
 *    without a portal, DB or clock.
 *  - the DB/notify side is injectable, so the alerting path is tested without a
 *    database.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - filing credential monitor is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { filingGatewayPreflight, filingProviderKind } from "@/lib/engine/filing/gateway";
import type { FilingPreflightResult } from "@/lib/engine/filing/types";
import { serverEnv } from "@/lib/env";
import { notify, type NotificationInput } from "@/lib/server/activity";

export type FilingCredentialOutcome = "skipped" | "healthy" | "degraded" | "alerted" | "recovered";

export interface FilingCredentialState {
  /** Whether the most recent check passed. */
  readonly ok: boolean;
  /** When the monitor last ran, or null before the first run. */
  readonly checkedAtMs: number | null;
  /** When a failing alert was last sent, or null. */
  readonly alertedAtMs: number | null;
}

export const INITIAL_FILING_CREDENTIAL_STATE: FilingCredentialState = {
  ok: true,
  checkedAtMs: null,
  alertedAtMs: null,
};

/**
 * Decide what a check result means, given the previous state and the cooldown.
 *
 * Rules:
 *  - the FIRST failure always alerts;
 *  - further failures inside the cooldown stay silent;
 *  - a failure after the cooldown alerts again;
 *  - a pass after an alerted failure raises a one-time "recovered" (and resets
 *    the cooldown so a fresh outage alerts immediately);
 *  - a pass while healthy is silent.
 *
 * Pure — no clock, no I/O, no module state.
 */
export function nextFilingCredentialAction(
  prev: FilingCredentialState,
  ok: boolean,
  nowMs: number,
  cooldownMs: number,
): { state: FilingCredentialState; action: "none" | "alert" | "recovered" } {
  const wasFailing = !prev.ok && prev.checkedAtMs !== null;

  if (ok) {
    const action = wasFailing && prev.alertedAtMs !== null ? "recovered" : "none";
    return { state: { ok: true, checkedAtMs: nowMs, alertedAtMs: null }, action };
  }

  const inCooldown = prev.alertedAtMs !== null && nowMs - prev.alertedAtMs < cooldownMs;
  if (wasFailing && inCooldown) {
    return { state: { ok: false, checkedAtMs: nowMs, alertedAtMs: prev.alertedAtMs }, action: "none" };
  }
  return { state: { ok: false, checkedAtMs: nowMs, alertedAtMs: nowMs }, action: "alert" };
}

export interface FilingCredentialCheckDeps {
  /** Preflight probe (defaults to the real gateway preflight). */
  preflight?: () => Promise<FilingPreflightResult>;
  /** Recipient user ids (defaults to firm admins + workspace owners). */
  recipients?: () => Promise<string[]>;
  /** Delivery (defaults to the in-app notify()). */
  send?: (userId: string, input: NotificationInput) => Promise<void>;
}

export interface FilingCredentialCheckResult {
  readonly outcome: FilingCredentialOutcome;
  readonly detail: string;
  /** How many users the alert/recovery was delivered to. */
  readonly recipients: number;
}

// In-memory state for the process. The scheduler is a single-instance poller
// (see lib/server/scheduler.ts), and a restart simply re-checks on first tick.
let state: FilingCredentialState = INITIAL_FILING_CREDENTIAL_STATE;

/** Test-only: drop the memoized state so cases are order-independent. */
export function __resetFilingCredentialMonitorForTests(): void {
  state = INITIAL_FILING_CREDENTIAL_STATE;
}

export function filingCredentialMonitorState(): FilingCredentialState {
  return state;
}

/**
 * Firm admins (organization OWNER/ADMIN) plus workspace owners, deduped. A
 * deployment-wide credential fault concerns everyone who files, so we reach
 * both tenancy models; the workspace branch also covers single-user installs
 * that have no organization.
 */
async function filingAlertRecipients(): Promise<string[]> {
  const ids = new Set<string>();
  const orgAdmins = await prisma.organizationMember.findMany({
    where: { role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
    take: 1000,
  });
  for (const member of orgAdmins) ids.add(member.userId);
  const workspaces = await prisma.workspace.findMany({ select: { user: { select: { id: true } } }, take: 1000 });
  for (const workspace of workspaces) {
    if (workspace.user?.id) ids.add(workspace.user.id);
  }
  return [...ids];
}

/**
 * Run one credential check. Skips (without touching the network or DB) unless
 * the monitor is enabled AND the filing provider is live.
 */
export async function runFilingCredentialCheck(
  now: Date = new Date(),
  deps: FilingCredentialCheckDeps = {},
): Promise<FilingCredentialCheckResult> {
  const env = serverEnv();
  if (!env.FILING_CREDENTIAL_MONITOR_ENABLED) {
    return { outcome: "skipped", detail: "monitor disabled (FILING_CREDENTIAL_MONITOR_ENABLED=false)", recipients: 0 };
  }
  if (filingProviderKind() !== "live") {
    return { outcome: "skipped", detail: "filing provider is not live — nothing to monitor", recipients: 0 };
  }

  // Throttle PROBES. The scheduler ticks every 60s; a portal auth round-trip
  // every minute is needless and rate-limit bait, so re-check at most once per
  // FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES. (The alert cooldown governs how
  // often a REPEAT ALERT goes out — a separate concern.)
  const intervalMs = env.FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES * 60_000;
  if (state.checkedAtMs !== null && now.getTime() - state.checkedAtMs < intervalMs) {
    const agoMin = Math.round((now.getTime() - state.checkedAtMs) / 60_000);
    return {
      outcome: "skipped",
      detail: `checked ~${agoMin}m ago — next probe due at the ${env.FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES}m interval`,
      recipients: 0,
    };
  }

  const preflight = deps.preflight ?? filingGatewayPreflight;
  let report: FilingPreflightResult;
  try {
    report = await preflight();
  } catch (err) {
    // A throwing probe is a failure, not a crash: record it and alert.
    report = {
      provider: "live",
      channel: "none",
      ok: false,
      detail: err instanceof Error ? err.message : "preflight threw",
      sandbox: false,
      httpStatus: null,
      checkedAt: now.toISOString(),
    };
  }

  const cooldownMs = env.FILING_CREDENTIAL_ALERT_COOLDOWN_MINUTES * 60_000;
  const { state: next, action } = nextFilingCredentialAction(state, report.ok, now.getTime(), cooldownMs);
  state = next;

  if (action === "none") {
    return { outcome: report.ok ? "healthy" : "degraded", detail: report.detail, recipients: 0 };
  }

  const recipients = deps.recipients ? await deps.recipients() : await filingAlertRecipients();
  const send = deps.send ?? notify;
  const channel = report.channel === "none" ? "the live filing gateway" : `the "${report.channel}" channel`;
  const title =
    action === "alert"
      ? `Live filing credentials failing (${report.channel === "none" ? "unknown channel" : report.channel})`
      : `Live filing credentials restored (${report.channel === "none" ? "unknown channel" : report.channel})`;
  const message =
    action === "alert"
      ? `${report.detail}${report.sandbox ? " (sandbox endpoint)" : ""} — filing through ${channel} will fail until this is fixed. Check the FILING_* credentials, then re-test with action=gateway-preflight.`
      : `The live filing credential handshake for ${channel} is working again.`;

  let delivered = 0;
  for (const userId of recipients) {
    try {
      await send(userId, { type: "system", title, message });
      delivered += 1;
    } catch {
      // One bad recipient never blocks the rest (or the scheduler tick).
    }
  }

  return { outcome: action === "alert" ? "alerted" : "recovered", detail: report.detail, recipients: delivered };
}
