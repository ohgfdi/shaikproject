/**
 * Filing proof oracle.
 *
 * A proof bundle is only useful if a reviewer can recompute it exactly. These
 * tests pin the canonicalisation, the payload digest, the receipt comparison
 * and the immutability-friendly shape — no portal or database involved.
 */
import { describe, expect, it } from "@jest/globals";

import { canonicalJson, sha256Hex } from "@/lib/engine/filing/signing";
import type { FilingReceipt } from "@/lib/engine/filing/types";
import { buildFilingProof, FILING_PROOF_VERSION, filingProofDigest } from "@/lib/server/filing-proof";

const payload = {
  formType: "GSTR-3B",
  runId: "run-1",
  period: "2026-03",
  dueDate: "2026-04-20",
};
const digest = sha256Hex(canonicalJson(payload));

const run = {
  id: "run-1",
  organizationId: "org-1",
  engagementId: "eng-1",
  taskId: "eng-1:GSTR-3B:Mar-2026:1",
  title: "GSTR-3B — March 2026",
  authority: "GSTN",
  dueDate: "2026-04-20",
};

const receipt: FilingReceipt = {
  provider: "simulation",
  channel: "irp-irn",
  status: "filed",
  token: "run-1",
  reference: "NAPR0123456789AB",
  irn: "a".repeat(64),
  ackNumber: "NAPR0123456789AB",
  ackDate: "2026-11-10",
  portalMessage: "Simulation only — no GSTN IRP was contacted.",
  submittedAt: "2026-11-10T12:00:00.000Z",
  digest,
  httpStatus: 200,
};

const capturedAt = new Date("2026-11-10T12:00:01.000Z");

function build(overrides: Partial<Parameters<typeof buildFilingProof>[0]> = {}) {
  return buildFilingProof({
    run,
    payload,
    receipt,
    actorId: "user-1",
    capturedAt,
    ...overrides,
  });
}

describe("filing proof bundle", () => {
  it("recomputes the payload digest and confirms it matches the receipt", () => {
    const proof = build();
    expect(proof.version).toBe(FILING_PROOF_VERSION);
    expect(proof.payloadDigest).toBe(digest);
    expect(proof.digestMatchesReceipt).toBe(true);
    expect(proof.payload).toEqual(payload);
    expect(proof.actorId).toBe("user-1");
    expect(proof.capturedAt).toBe("2026-11-10T12:00:01.000Z");
  });

  it("copies the receipt without adding credentials", () => {
    const proof = build();
    expect(proof.receipt).toEqual({
      provider: "simulation",
      channel: "irp-irn",
      status: "filed",
      token: "run-1",
      reference: "NAPR0123456789AB",
      irn: "a".repeat(64),
      ackNumber: "NAPR0123456789AB",
      ackDate: "2026-11-10",
      portalMessage: "Simulation only — no GSTN IRP was contacted.",
      submittedAt: "2026-11-10T12:00:00.000Z",
      digest,
      httpStatus: 200,
    });
    expect(JSON.stringify(proof)).not.toMatch(/password|secret|clientId/i);
  });

  it("records a digest mismatch instead of hiding it", () => {
    const proof = build({ receipt: { ...receipt, digest: "0".repeat(64) } });
    expect(proof.payloadDigest).toBe(digest);
    expect(proof.digestMatchesReceipt).toBe(false);
  });

  it("is stable across payload key order", () => {
    const reordered = { dueDate: payload.dueDate, period: payload.period, runId: payload.runId, formType: payload.formType };
    const a = build();
    const b = build({ payload: reordered });
    expect(b.payloadDigest).toBe(a.payloadDigest);
    expect(filingProofDigest(b)).toBe(filingProofDigest(a));
  });

  it("changes when the payload changes", () => {
    const a = build();
    const b = build({ payload: { ...payload, period: "2026-04" } });
    expect(b.payloadDigest).not.toBe(a.payloadDigest);
    expect(filingProofDigest(b)).not.toBe(filingProofDigest(a));
  });

  it("changes when the captured time changes (no silent re-dating)", () => {
    const a = build();
    const b = build({ capturedAt: new Date("2026-11-10T12:00:02.000Z") });
    expect(filingProofDigest(b)).not.toBe(filingProofDigest(a));
  });
});
