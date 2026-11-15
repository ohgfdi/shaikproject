/**
 * One-attempt filing certification.
 *
 * These tests pin the exit-code contract the operator runner trusts:
 *   0 = proven, 1 = attempted but not proven, 2 = cannot be proven offline.
 * A single clean attempt is still a pilot, never a deployment certificate.
 */

import { canonicalJson, sha256Hex } from "@/lib/engine/filing/signing";
import type { FilingGatewayHealth, FilingReceipt } from "@/lib/engine/filing/types";
import { certifyFilingAttempt } from "@/lib/server/filing-certify";
import { buildFilingProof, filingProofDigest } from "@/lib/server/filing-proof";

const payload = { formType: "GSTR-3B", runId: "run-1", schemaVersion: "2026-11" };

function receipt(overrides: Partial<FilingReceipt> = {}): FilingReceipt {
  return {
    provider: "live",
    channel: "efiling-return",
    status: "filed",
    token: "run-1",
    reference: "ARN-123",
    irn: null,
    ackNumber: "ARN-123",
    ackDate: "2026-11-11",
    portalMessage: null,
    submittedAt: "2026-11-11T10:00:00.000Z",
    digest: sha256Hex(canonicalJson(payload)),
    httpStatus: 200,
    ...overrides,
  };
}

function health(overrides: Partial<FilingGatewayHealth> = {}): FilingGatewayHealth {
  const configured = { configured: true, provider: "live" as const, missing: [] as string[] };
  return {
    provider: "live",
    activeChannel: "efiling-return",
    liveEligible: true,
    channels: {
      "irp-irn": configured,
      "efiling-return": configured,
      "efiling-audit": configured,
    },
    ...overrides,
  };
}

function proofFor(r: FilingReceipt) {
  return buildFilingProof({
    run: {
      id: "run-1",
      organizationId: "org-1",
      engagementId: "eng-1",
      taskId: "task-1",
      title: "GSTR-3B Oct 2026",
      authority: "GSTN",
      dueDate: "2026-10-20",
    },
    payload,
    receipt: r,
    actorId: "user-1",
    capturedAt: new Date("2026-11-11T10:01:00.000Z"),
  });
}

describe("certifyFilingAttempt", () => {
  it("cannot prove anything when the gateway is simulation (exit 2)", () => {
    const r = receipt({ provider: "simulation", ackNumber: null, reference: "sim" });
    const result = certifyFilingAttempt({ health: health({ provider: "simulation" }), proof: proofFor(r) });
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("simulation");
    expect(result.reason).toContain('FILING_GATEWAY is "simulation"');
  });

  it("proves a clean live attempt and still calls it a pilot (exit 0)", () => {
    const proof = proofFor(receipt());
    const result = certifyFilingAttempt({
      health: health(),
      proof,
      bundleDigest: filingProofDigest(proof),
    });
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("pilot");
    expect(result.reason).toContain("still requires reconciliation");
    expect(result.checks.every((check) => check.ok !== false)).toBe(true);
  });

  it("fails when the proof records a simulation receipt under a live gateway (exit 1)", () => {
    const result = certifyFilingAttempt({
      health: health(),
      proof: proofFor(receipt({ provider: "simulation" })),
    });
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('provider "simulation"');
  });

  it("fails when the portal returned no acknowledgement number (exit 1)", () => {
    const result = certifyFilingAttempt({
      health: health(),
      proof: proofFor(receipt({ ackNumber: null, reference: "ref-only" })),
    });
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no IRN/acknowledgement number");
  });

  it("fails when a credential preflight did not pass (exit 1)", () => {
    const result = certifyFilingAttempt({
      health: health(),
      preflight: {
        provider: "live",
        channel: "efiling-return",
        ok: false,
        detail: "GSTN rejected the client credentials",
        sandbox: false,
        httpStatus: 401,
        checkedAt: "2026-11-11T10:00:00.000Z",
      },
      proof: proofFor(receipt()),
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("Credential preflight failed");
  });

  it("fails when the active channel has no credentials (exit 1)", () => {
    const missing = {
      configured: false,
      provider: "n/a" as const,
      missing: ["EFILING_CLIENT_ID", "EFILING_CLIENT_SECRET"],
    };
    const result = certifyFilingAttempt({
      health: health({
        channels: {
          "irp-irn": missing,
          "efiling-return": missing,
          "efiling-audit": missing,
        },
      }),
      proof: proofFor(receipt()),
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("missing credentials");
  });

  it("fails when the stored bundle digest does not match (exit 1)", () => {
    const result = certifyFilingAttempt({
      health: health(),
      proof: proofFor(receipt()),
      bundleDigest: "f".repeat(64),
    });
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("one or more proof checks failed");
  });

  it("treats a rejected portal status as not proven (exit 1)", () => {
    const result = certifyFilingAttempt({
      health: health(),
      proof: proofFor(receipt({ status: "rejected", portalMessage: "Invalid GSTIN" })),
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('receipt status is "rejected"');
  });
});
