/**
 * Pilot readiness — a CHECKLIST, not a score.
 *
 * The question this answers is narrow and operational: can this instance put a
 * real firm's client data through the product this week without an incident
 * that a runbook cannot fix? It deliberately does NOT report feature coverage —
 * the capability scorecard owns that, and a pilot is not a percentage.
 *
 * Severity comes from the postures the app already computes (backup, queue,
 * RLS, filing), so there is one truth per subject rather than a second opinion
 * that can drift. The two checks that only make sense for a pilot are added
 * here: is any workspace actually entitled to distribute work, and has a filing
 * ever been reconciled (as opposed to merely rendered)?
 *
 * Pure and clock-free: `assessPilot` takes a snapshot, so every rule is
 * unit-testable without a database or a mail server.
 */

import type { FilingGatewayHealth } from "@/lib/engine/filing/types";
import type { BackupSeverity } from "@/lib/server/backup-evidence";
import type { QueueSeverity } from "@/lib/server/queue-health";
import type { RlsPostureSeverity } from "@/lib/server/rls-posture";

export type PilotCheckLevel = "blocker" | "warning" | "info" | "ok";

export interface PilotCheck {
  id: string;
  level: PilotCheckLevel;
  summary: string;
  /** The exact next action. Absent only when the check is already satisfied. */
  remedy?: string;
}

export interface PilotSnapshot {
  workspaces: number;
  /** Workspaces holding a live (non-lapsed-trial) Pro or Firm subscription. */
  paidWorkspaces: number;
  engagements: number;
  /** Non-revoked client-portal accounts — a firm can invite, but has it? */
  portalAccounts: number;
  /** Filing runs that reached the portal (filedAt set). */
  liveFilings: number;
  /** Filing runs whose acknowledgement reconciled (verificationStatus verified). */
  reconciledFilings: number;
  mailTransport: string;
  smtpHost: string;
  workerEnabled: boolean;
  backup: { severity: BackupSeverity; summary: string; remedy: string };
  queue: { severity: QueueSeverity; summary: string; remedy: string; pending: number };
  rls: {
    severity: RlsPostureSeverity;
    summary: string;
    remedy: string;
    database: "postgres" | "other";
    enforced: boolean;
  };
  filing: Pick<FilingGatewayHealth, "provider" | "liveEligible" | "activeChannel">;
}

export interface PilotAssessment {
  verdict: "ready" | "blocked";
  blockers: PilotCheck[];
  warnings: PilotCheck[];
  checks: PilotCheck[];
  /** Deduplicated remedies, most important first. */
  nextActions: string[];
}

const SEVERITY: Record<"ok" | "warn" | "critical", PilotCheckLevel> = {
  ok: "ok",
  warn: "warning",
  critical: "blocker",
};

function fromPosture(id: string, severity: "ok" | "warn" | "critical", summary: string, remedy: string): PilotCheck {
  const level = SEVERITY[severity];
  return { id, level, summary, remedy: level === "ok" ? undefined : remedy };
}

export function assessPilot(snapshot: PilotSnapshot): PilotAssessment {
  const checks: PilotCheck[] = [];

  // 1. Distribution must be unlocked, or the pilot's first share link and first
  //    scheduled delivery fail with a 402 in front of the client.
  checks.push(
    snapshot.paidWorkspaces > 0
      ? {
          id: "plan",
          level: "ok",
          summary: `${snapshot.paidWorkspaces} of ${snapshot.workspaces} workspace(s) hold a live Pro/Firm entitlement.`,
        }
      : {
          id: "plan",
          level: "blocker",
          summary: `No workspace holds a live Pro/Firm subscription (${snapshot.workspaces} workspace(s) total).`,
          remedy:
            "Start the pilot workspace's Pro trial or record the subscription in Settings → Billing; " +
            "share links, scheduled delivery and API keys are distribution features and stay closed on free.",
        },
  );

  // 2. Mail. A portal invite that prints to the server log is not an invite.
  const smtpConfigured = snapshot.mailTransport === "smtp" && snapshot.smtpHost.trim() !== "";
  checks.push(
    smtpConfigured
      ? {
          id: "mail",
          level: "ok",
          summary: `Client mail is delivered over SMTP (${snapshot.smtpHost.trim()}).`,
        }
      : {
          id: "mail",
          level: "blocker",
          summary: `MAIL_TRANSPORT is "${snapshot.mailTransport}"; portal invitations, approvals and reports never leave the server.`,
          remedy:
            "Set MAIL_TRANSPORT=smtp with SMTP_HOST/SMTP_USER/SMTP_PASS and AUTH_REQUIRE_EMAIL_VERIFY=true, then re-send pending invites.",
        },
  );

  // 3. The postures the app already computes.
  checks.push(fromPosture("backup", snapshot.backup.severity, snapshot.backup.summary, snapshot.backup.remedy));
  checks.push(fromPosture("queue", snapshot.queue.severity, snapshot.queue.summary, snapshot.queue.remedy));
  checks.push(fromPosture("rls", snapshot.rls.severity, snapshot.rls.summary, snapshot.rls.remedy));

  // 4. Isolation wording must not overstate what is running.
  if (snapshot.rls.severity !== "critical") {
    checks.push({
      id: "isolation-posture",
      level: snapshot.rls.enforced ? "ok" : "info",
      summary: snapshot.rls.enforced
        ? "Database-level RLS is enforcing; the application guards are a second layer."
        : "Tenant isolation is enforced in the application layer only (no database policies active). Say so in the pilot agreement.",
      remedy: snapshot.rls.enforced
        ? undefined
        : "No code change: application guards (lib/auth/guard.ts, dataset-access.ts) are the boundary. Run `npm run tenancy:audit` and keep the number in the agreement.",
    });
  }

  // 5. A separate worker (or an in-process one).
  checks.push(
    snapshot.workerEnabled
      ? { id: "worker", level: "ok", summary: "A job worker is enabled on this host." }
      : {
          id: "worker",
          level: "warning",
          summary: `JOB_WORKER_ENABLED is off and ${snapshot.queue.pending} job(s) are pending.`,
          remedy:
            "Run `npm run worker` as its own process, or set JOB_WORKER_ENABLED=true on a single-host install; " +
            "otherwise scheduled deliveries and filing jobs wait indefinitely.",
        },
  );

  // 6. Filing: transmitting nothing is fine until go-live, but a live channel
  //    with no reconciled acknowledgement is a pilot, not a proven transport.
  if (snapshot.filing.provider !== "live") {
    checks.push({
      id: "filing",
      level: "info",
      summary: `Filing gateway is "${snapshot.filing.provider}" — nothing is transmitted. Run the pilot as a shadow/simulation rehearsal.`,
      remedy:
        "When the credentials arrive: `npm run filing:conformance`, then preflight, then one live submission per channel — see docs/filing-go-live-runbook.md.",
    });
  } else if (snapshot.reconciledFilings === 0) {
    checks.push({
      id: "filing",
      level: "warning",
      summary: `The live gateway is configured but no filing has been reconciled (${snapshot.liveFilings} transmitted).`,
      remedy:
        "Submit ONE filing and reconcile the returned ack/IRN against the portal before promoting any client to live " +
        "(GET …/filing-go-live lists the remaining blockers).",
    });
  } else {
    checks.push({
      id: "filing",
      level: "ok",
      summary: `${snapshot.reconciledFilings} filing(s) reconciled out of ${snapshot.liveFilings} transmitted on the live gateway.`,
    });
  }

  // 7. Pilot substance: a firm, a client, and a portal account that works.
  checks.push(
    snapshot.engagements > 0
      ? { id: "engagements", level: "ok", summary: `${snapshot.engagements} client engagement(s) exist.` }
      : {
          id: "engagements",
          level: "warning",
          summary: "No client engagements exist yet.",
          remedy:
            "Create the first engagement (or import the client list with POST /api/organization/engagements/import) before inviting a client.",
        },
  );

  checks.push(
    snapshot.portalAccounts > 0
      ? { id: "portal", level: "ok", summary: `${snapshot.portalAccounts} active client-portal account(s).` }
      : {
          id: "portal",
          level: "warning",
          summary: "No client has an active portal account, so the client-facing half of the pilot is unexercised.",
          remedy: "Invite one named client from the engagement portal panel and confirm they can sign in and upload.",
        },
  );

  const blockers = checks.filter((check) => check.level === "blocker");
  const warnings = checks.filter((check) => check.level === "warning");
  const nextActions = [
    ...new Set(
      [...blockers, ...warnings]
        .map((check) => check.remedy)
        .filter((remedy): remedy is string => typeof remedy === "string" && remedy.trim() !== ""),
    ),
  ].slice(0, 6);

  return { verdict: blockers.length === 0 ? "ready" : "blocked", blockers, warnings, checks, nextActions };
}
