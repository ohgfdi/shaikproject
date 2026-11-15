/**
 * Pilot-ledger oracles. The ledger is what an operator reads before claiming a
 * live filing capability, so each verdict and its next action are pinned here.
 */

import type { FilingGatewayHealth } from "@/lib/engine/filing/types";
import { buildPilotLedger, type PilotEvidence } from "@/lib/server/filing-pilot";

function availability(configured: boolean, missing: string[] = []) {
  return { configured, provider: configured ? ("live" as const) : ("n/a" as const), missing };
}

function health(overrides: Partial<FilingGatewayHealth> = {}): FilingGatewayHealth {
  return {
    provider: "live",
    activeChannel: "irp-irn",
    liveEligible: true,
    channels: {
      "irp-irn": availability(true),
      "efiling-return": availability(false, ["FILING_EFILING_CLIENT_ID"]),
      "efiling-audit": availability(false, ["FILING_SIGNING_URL"]),
    },
    ...overrides,
  };
}

function run(overrides: Partial<PilotEvidence["runs"][number]> = {}): PilotEvidence["runs"][number] {
  return {
    id: "run-1",
    taskId: "eng-1:GSTR-1:2026-10",
    title: "GSTR-1 Oct 2026",
    clientName: "Sharma Textiles",
    filedAt: new Date("2026-11-01T10:00:00Z"),
    provider: "live",
    acknowledgementReference: "ARN-1",
    verificationStatus: "unverified",
    ...overrides,
  };
}

describe("buildPilotLedger", () => {
  it("reports simulation as offline and asks for the live gateway", () => {
    const ledger = buildPilotLedger(
      health({ provider: "reference", liveEligible: false, activeChannel: "none" }),
      { runs: [] },
    );
    expect(ledger.verdict).toBe("simulation");
    expect(ledger.nextActions.join(" ")).toContain("FILING_GATEWAY=live");
    expect(ledger.summary).toContain("offline");
  });

  it("stays a pilot when the live gateway is configured but nothing was filed", () => {
    const ledger = buildPilotLedger(health(), { runs: [] });
    expect(ledger.verdict).toBe("pilot");
    expect(ledger.nextActions.join(" ")).toContain("filing:conformance");
  });

  it("names the missing credentials for an incomplete active channel", () => {
    const ledger = buildPilotLedger(
      health({
        channels: {
          "irp-irn": availability(false, ["FILING_IRP_CLIENT_ID", "FILING_IRP_PUBLIC_KEY"]),
          "efiling-return": availability(false),
          "efiling-audit": availability(false),
        },
      }),
      { runs: [] },
    );
    expect(ledger.verdict).toBe("pilot");
    expect(ledger.channels.find((channel) => channel.active)?.configured).toBe(false);
    expect(ledger.nextActions.join(" ")).toContain("FILING_IRP_CLIENT_ID");
  });

  it("asks for reconciliation when a live submission is unverified", () => {
    const ledger = buildPilotLedger(health(), { runs: [run()] });
    expect(ledger.verdict).toBe("pilot");
    expect(ledger.totals.liveSubmissions).toBe(1);
    expect(ledger.totals.verifiedFilings).toBe(0);
    expect(ledger.nextActions.join(" ")).toContain("Reconcile");
  });

  it("certifies only when a live filing was reconciled", () => {
    const ledger = buildPilotLedger(health(), {
      runs: [run({ verificationStatus: "verified" })],
    });
    expect(ledger.verdict).toBe("certified");
    expect(ledger.summary).toContain("1 reconciled live filing");
  });

  it("counts simulated attempts separately and attributes channel totals once", () => {
    const ledger = buildPilotLedger(health(), {
      runs: [run(), run({ id: "run-2", provider: "simulation" })],
    });
    expect(ledger.totals.liveSubmissions).toBe(1);
    expect(ledger.totals.simulatedSubmissions).toBe(1);
    expect(ledger.channels.find((channel) => channel.active)?.liveSubmissions).toBe(1);
    expect(ledger.channels.find((channel) => !channel.active)?.liveSubmissions).toBe(0);
  });
});
