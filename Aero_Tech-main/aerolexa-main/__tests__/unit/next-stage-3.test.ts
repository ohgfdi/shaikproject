import { assessGoLive } from "@/lib/engine/filing/go-live";
import { evaluateOpsAlerts } from "@/lib/server/slo";
import { summarizeStatuteReview } from "@/lib/server/statute-review";

describe("go-live readiness", () => {
  const ready = {
    provider: "live" as const,
    channel: "irp-irn",
    channelConfigured: true,
    missingCredentials: [],
    signingRequired: false,
    signingConfigured: false,
    filedRuns: 0,
    verifiedRuns: 0,
  };

  it("is eligible with a live gateway, credentials and no evidence yet", () => {
    const result = assessGoLive(ready);
    expect(result.eligible).toBe(true);
    expect(result.summary).toContain("Ready to promote");
  });

  it("blocks a reference gateway and names the missing credential", () => {
    const result = assessGoLive({ ...ready, provider: "reference", channelConfigured: false, missingCredentials: ["FILING_IRP_CLIENT_ID"] });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("FILING_GATEWAY");
    expect(result.blockers.join(" ")).toContain("FILING_IRP_CLIENT_ID");
  });

  it("blocks an audit channel without DSC signing", () => {
    const result = assessGoLive({ ...ready, channel: "efiling-audit", signingRequired: true, signingConfigured: false });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("detached signature");
  });

  it("promotes with a warning when a live filing is unreconciled", () => {
    const result = assessGoLive({ ...ready, filedRuns: 1, verifiedRuns: 0 });
    expect(result.eligible).toBe(true);
    expect(result.warnings.join(" ")).toContain("none is reconciled");
  });
});

describe("operator alerts", () => {
  const quiet = {
    queue: { severity: "ok" as const, dead: 0, pending: 0 },
    outbox: { failed: 0, pending: 0, oldestPendingAgeMs: null },
    backup: { severity: "ok" as const, verified: true, ageDays: 1 },
    tenants: { critical: 0 },
    filing: { provider: "reference", channelConfigured: true },
  };

  it("is quiet when every posture is inside thresholds", () => {
    const result = evaluateOpsAlerts(quiet);
    expect(result.ok).toBe(true);
    expect(result.alerts).toEqual([]);
  });

  it("raises critical alerts for a stuck queue and incomplete live filing", () => {
    const result = evaluateOpsAlerts({
      ...quiet,
      queue: { severity: "critical", dead: 0, pending: 30 },
      filing: { provider: "live", channelConfigured: false },
    });
    expect(result.alerts.map((alert) => alert.id).sort()).toEqual(["filing-credentials", "queue-critical"]);
    expect(result.alerts[0]?.severity).toBe("critical");
  });

  it("warns about undelivered mail and tenants needing attention", () => {
    const result = evaluateOpsAlerts({
      ...quiet,
      outbox: { failed: 2, pending: 0, oldestPendingAgeMs: null },
      tenants: { critical: 1 },
    });
    expect(result.alerts.map((alert) => alert.id).sort()).toEqual(["outbox-failed", "tenant-attention"]);
    expect(result.summary).toContain("warning");
  });
});

describe("statute review summary", () => {
  it("counts pending decisions and flags missing dates", () => {
    const result = summarizeStatuteReview([
      { status: "new", warningCount: 0, effectiveFrom: null },
      { status: "reviewing", warningCount: 2, effectiveFrom: "2026-10-01" },
      { status: "applied", warningCount: 0, effectiveFrom: null },
    ]);
    expect(result.pending).toBe(2);
    expect(result.applied).toBe(1);
    expect(result.needsAttention).toBe(2);
    expect(result.summary).toContain("2 notification(s) await");
  });

  it("distinguishes no data from nothing pending", () => {
    expect(summarizeStatuteReview([]).summary).toContain("No statute notifications");
    expect(summarizeStatuteReview([{ status: "applied", warningCount: 0, effectiveFrom: null }]).summary).toContain(
      "No notification is awaiting review",
    );
  });
});
