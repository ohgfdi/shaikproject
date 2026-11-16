/**
 * Weekly partner digest — one email to owners/admins with the firm's real
 * numbers: deadlines, WIP, receivables and collected money.
 *
 * Same honesty rules as the dashboard: ratios with no denominator are printed as
 * "not recorded", and the email never adds a score or a forecast. Delivery is
 * best-effort per recipient; the send date is persisted on the Organization so a
 * restart does not re-send the same week's digest.
 */

import { mailFooter, sendMail } from "@/lib/auth/mail";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - partner digest is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { loadPartnerDashboard, type PartnerDashboard } from "@/lib/server/partner-dashboard";

const DAY_MS = 86_400_000;
export const PARTNER_DIGEST_INTERVAL_DAYS = 7;
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function pct(value: number | null): string {
  return value === null ? "not recorded" : `${value.toFixed(1)}%`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

/** Plain-text digest body. Pure so the wording is testable and stable. */
export function renderPartnerDigest(input: {
  name: string;
  dashboard: PartnerDashboard;
}): { subject: string; text: string } {
  const { name, dashboard } = input;
  const t = dashboard.totals;
  const subject = `${dashboard.firmName} — week ending ${dashboard.asOf}`;

  const risks =
    dashboard.risk.length === 0
      ? "No filing run is late or due within 7 days."
      : dashboard.risk
          .slice(0, 8)
          .map(
            (row) =>
              `• ${row.title} (${row.engagementName}) — due ${row.dueDate}` +
              `${row.daysLate > 0 ? `, ${row.daysLate} day(s) late` : ""}` +
              `${row.assigneeName ? ` · ${row.assigneeName}` : " · unassigned"}` +
              `${row.verificationStatus === "defective" ? " · DEFECTIVE" : ""}`,
          )
          .join("\n") +
        (dashboard.risk.length > 8 ? `\n… and ${dashboard.risk.length - 8} more.` : "");

  const clientEconomics =
    dashboard.clientEconomics.length === 0
      ? "No client has recorded billable value yet."
      : dashboard.clientEconomics
          .map(
            (row) =>
              `• ${row.engagementName} — outstanding ${money(row.outstandingMinor)}, unbilled ${money(row.unbilledMinor)}, realisation ${pct(row.realisationPct)}`,
          )
          .join("\n");

  const text =
    `Hi ${name},\n\n` +
    `${dashboard.firmName} — week ending ${dashboard.asOf}\n\n` +
    `Deadlines\n` +
    `• Open filing runs: ${t.openRuns}\n` +
    `• Overdue: ${t.overdueRuns} · due in 7 days: ${t.due7} · due in 30 days: ${t.due30}\n\n` +
    `${risks}\n\n` +
    `Money\n` +
    `• Unbilled WIP: ${money(t.wipMinor)}\n` +
    `• Outstanding: ${money(t.outstandingMinor)}\n` +
    `• Collected: ${money(t.collectedMinor)} of ${money(t.invoicedMinor)} invoiced\n` +
    `• Utilisation: ${pct(t.utilisationPct)} of recorded time\n` +
    `• Realisation: ${pct(t.realisationPct)}\n\n` +
    `Client economics (revenue side; cost rates are not recorded)\n` +
    `${clientEconomics}\n\n` +
    `Open the partner dashboard: ${appUrl()}/operations\n` +
    mailFooter();

  return { subject, text };
}

export interface PartnerDigestResult {
  organizations: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * One digest pass. Sends at most one email per firm per week, and only after a
 * week has elapsed since the recorded send date.
 */
export async function runPartnerDigest(now: Date = new Date()): Promise<PartnerDigestResult> {
  const today = now.toISOString().slice(0, 10);
  const result: PartnerDigestResult = { organizations: 0, sent: 0, skipped: 0, failed: 0 };

  const organizations = await prisma.organization.findMany({
    where: { members: { some: { role: { in: ["OWNER", "ADMIN"] } } } },
    select: {
      id: true,
      partnerDigestLastSentOn: true,
      members: {
        where: { role: { in: ["OWNER", "ADMIN"] } },
        select: { user: { select: { name: true, email: true } } },
        take: 20,
      },
    },
    take: 200,
  });

  for (const organization of organizations) {
    result.organizations += 1;
    if (
      organization.partnerDigestLastSentOn &&
      daysBetween(organization.partnerDigestLastSentOn, today) < PARTNER_DIGEST_INTERVAL_DAYS - 1
    ) {
      result.skipped += 1;
      continue;
    }
    const recipients = organization.members
      .map((member) => member.user)
      .filter((user) => Boolean(user.email));
    if (recipients.length === 0) {
      result.skipped += 1;
      continue;
    }

    try {
      const dashboard = await loadPartnerDashboard(organization.id, today);
      let delivered = 0;
      for (const recipient of recipients) {
        const { subject, text } = renderPartnerDigest({ name: recipient.name, dashboard });
        try {
          await sendMail({ to: recipient.email, subject, text });
          delivered += 1;
        } catch {
          result.failed += 1;
        }
      }
      if (delivered > 0) {
        await prisma.organization.update({
          where: { id: organization.id },
          data: { partnerDigestLastSentOn: today },
        });
        result.sent += delivered;
      }
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

// --- Scheduler loop (same pattern as notify-digest.ts) -----------------------

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let lastRunAt: number | null = null;
let lastResult: PartnerDigestResult | null = null;
let lastError: string | null = null;

export function maybeStartPartnerDigestScheduler(): void {
  if (process.env.PARTNER_DIGEST_ENABLED !== "true") return;
  startPartnerDigestScheduler();
}

export function startPartnerDigestScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export function stopPartnerDigestScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    lastResult = await runPartnerDigest(new Date());
    lastRunAt = Date.now();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "unknown partner digest error";
  } finally {
    inFlight = false;
  }
}

export function getPartnerDigestStatus(): {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastResult: PartnerDigestResult | null;
  lastError: string | null;
} {
  return {
    enabled: process.env.PARTNER_DIGEST_ENABLED === "true",
    running: inFlight,
    lastRunAt,
    lastResult,
    lastError,
  };
}
