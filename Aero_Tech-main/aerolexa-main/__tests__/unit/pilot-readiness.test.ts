/**
 * Pilot readiness — hand-pinned matrix.
 *
 * The rules that matter are the ones that stop a pilot: no distribution
 * entitlement, mail that never leaves the server, an unproven restore, and a
 * live filing channel with nothing reconciled. The rest are warnings the
 * operator is expected to say out loud.
 */

import { assessPilot, type PilotSnapshot } from "@/lib/server/pilot-readiness";

function snapshot(overrides: Partial<PilotSnapshot> = {}): PilotSnapshot {
  return {
    workspaces: 3,
    paidWorkspaces: 2,
    engagements: 4,
    portalAccounts: 2,
    liveFilings: 1,
    reconciledFilings: 1,
    mailTransport: "smtp",
    smtpHost: "smtp.example.com",
    workerEnabled: true,
    backup: { severity: "ok", summary: "A restore was verified today.", remedy: "No action." },
    queue: { severity: "ok", summary: "The queue is empty.", remedy: "No action.", pending: 0 },
    rls: {
      severity: "warn",
      summary: "PostgreSQL is running with RLS off.",
      remedy: "Apply prisma/rls.sql.",
      database: "postgres",
      enforced: false,
    },
    filing: { provider: "live", liveEligible: true, activeChannel: "irp-irn" },
    ...overrides,
  };
}

describe("assessPilot", () => {
  it("is ready when entitlement, mail, restore and filing reconciliation are all real", () => {
    const result = assessPilot(snapshot());
    expect(result.verdict).toBe("ready");
    expect(result.blockers).toHaveLength(0);
    // RLS is off by design here, so it is stated as info, never as enforcement.
    expect(result.checks.find((c) => c.id === "isolation-posture")?.level).toBe("info");
  });

  it("blocks a pilot with no paid workspace", () => {
    const result = assessPilot(snapshot({ paidWorkspaces: 0 }));
    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((c) => c.id)).toContain("plan");
    expect(result.nextActions[0]).toContain("Pro trial");
  });

  it("blocks a pilot whose mail only prints to the server log", () => {
    const result = assessPilot(snapshot({ mailTransport: "console", smtpHost: "" }));
    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((c) => c.id)).toContain("mail");
  });

  it("treats an smtp transport without a host as not configured", () => {
    const result = assessPilot(snapshot({ mailTransport: "smtp", smtpHost: "   " }));
    expect(result.verdict).toBe("blocked");
  });

  it("blocks on a critical restore or queue posture", () => {
    const failedRestore = assessPilot(
      snapshot({ backup: { severity: "critical", summary: "The last drill failed.", remedy: "Re-run it." } }),
    );
    expect(failedRestore.verdict).toBe("blocked");
    expect(failedRestore.blockers.map((c) => c.id)).toContain("backup");

    const stuckQueue = assessPilot(
      snapshot({
        queue: { severity: "critical", summary: "The worker is not draining.", remedy: "Start it.", pending: 9 },
      }),
    );
    expect(stuckQueue.verdict).toBe("blocked");
    expect(stuckQueue.blockers.map((c) => c.id)).toContain("queue");
  });

  it("blocks when RLS is requested but the query layer is unwired", () => {
    const result = assessPilot(
      snapshot({
        rls: {
          severity: "critical",
          summary: "RLS was requested before the query layer was wrapped.",
          remedy: "Leave RLS_ENABLED=false.",
          database: "postgres",
          enforced: false,
        },
      }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((c) => c.id)).toContain("rls");
  });

  it("warns when the live gateway has transmitted but never reconciled", () => {
    const result = assessPilot(snapshot({ liveFilings: 1, reconciledFilings: 0 }));
    expect(result.verdict).toBe("ready");
    expect(result.warnings.map((c) => c.id)).toContain("filing");
  });

  it("keeps an offline gateway informational rather than a warning", () => {
    const result = assessPilot(
      snapshot({
        filing: { provider: "reference", liveEligible: false, activeChannel: "irp-irn" },
        liveFilings: 0,
        reconciledFilings: 0,
      }),
    );
    expect(result.verdict).toBe("ready");
    expect(result.checks.find((c) => c.id === "filing")?.level).toBe("info");
    expect(result.warnings.map((c) => c.id)).not.toContain("filing");
  });

  it("warns about a pilot with no client engagement or portal account", () => {
    const result = assessPilot(snapshot({ engagements: 0, portalAccounts: 0 }));
    expect(result.verdict).toBe("ready");
    expect(result.warnings.map((c) => c.id)).toEqual(expect.arrayContaining(["engagements", "portal"]));
  });

  it("deduplicates next actions and never includes a satisfied check", () => {
    const result = assessPilot(snapshot({ mailTransport: "console", smtpHost: "", paidWorkspaces: 0 }));
    expect(new Set(result.nextActions).size).toBe(result.nextActions.length);
    expect(result.nextActions.some((action) => action.includes("PostgreSQL"))).toBe(false);
  });
});
