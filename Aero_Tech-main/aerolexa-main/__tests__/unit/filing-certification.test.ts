/**
 * Filing certification must never claim more than the evidence supports:
 * offline providers stay simulation, live credentials alone are a pilot, and
 * only a reconciled live filing earns "certified".
 */

import type { FilingGatewayHealth } from "@/lib/engine/filing/types";
import { buildFilingCertification } from "@/lib/server/filing-certification";

function health(overrides: Partial<FilingGatewayHealth> = {}): FilingGatewayHealth {
  return {
    provider: "live",
    liveEligible: true,
    activeChannel: "irp-irn",
    channels: {
      "irp-irn": { configured: true, provider: "live", missing: [] },
      "efiling-return": { configured: true, provider: "live", missing: [] },
      "efiling-audit": { configured: false, provider: "live", missing: ["FILING_SIGNING_URL"] },
    },
    ...overrides,
  };
}

const noEvidence = { liveSubmissions: 0, verifiedFilings: 0, lastLiveFilingAt: null };

describe("filing certification", () => {
  it("stays simulation for an offline provider even with receipts", () => {
    const result = buildFilingCertification(health({ provider: "simulation", liveEligible: false }), {
      liveSubmissions: 0,
      verifiedFilings: 0,
      lastLiveFilingAt: null,
    });
    expect(result.verdict).toBe("simulation");
    expect(result.steps.find((step) => step.id === "provider")?.state).toBe("blocked");
    expect(result.summary).toContain("offline");
  });

  it("calls a live deployment with complete credentials a pilot, not certified", () => {
    const result = buildFilingCertification(health(), noEvidence);
    expect(result.verdict).toBe("pilot");
    expect(result.steps.find((step) => step.id === "credentials")?.state).toBe("done");
    expect(result.steps.find((step) => step.id === "handshake")?.state).toBe("pending");
    expect(result.summary).toContain("controlled pilot");
  });

  it("reports the exact missing credential names and blocks the channel step", () => {
    const result = buildFilingCertification(
      health({
        activeChannel: "efiling-audit",
        channels: {
          "irp-irn": { configured: true, provider: "live", missing: [] },
          "efiling-return": { configured: true, provider: "live", missing: [] },
          "efiling-audit": { configured: false, provider: "live", missing: ["FILING_SIGNING_URL", "FILING_SIGNING_TOKEN"] },
        },
      }),
      noEvidence,
    );
    const step = result.steps.find((entry) => entry.id === "credentials");
    expect(step?.state).toBe("blocked");
    expect(step?.detail).toContain("FILING_SIGNING_URL");
  });

  it("certifies only a live, submitted and reconciled filing", () => {
    const result = buildFilingCertification(health(), {
      liveSubmissions: 2,
      verifiedFilings: 1,
      lastLiveFilingAt: "2026-11-09T08:00:00.000Z",
    });
    expect(result.verdict).toBe("certified");
    expect(result.steps.every((step) => step.state === "done")).toBe(true);
    expect(result.summary).toContain("certified");
  });

  it("keeps a live submission unreconciled as a pilot", () => {
    const result = buildFilingCertification(health(), {
      liveSubmissions: 1,
      verifiedFilings: 0,
      lastLiveFilingAt: "2026-11-09T08:00:00.000Z",
    });
    expect(result.verdict).toBe("pilot");
    expect(result.steps.find((step) => step.id === "reconciliation")?.state).toBe("pending");
  });
});
