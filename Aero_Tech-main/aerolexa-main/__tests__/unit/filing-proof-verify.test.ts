/**
 * Proof verification must fail closed. A recomputed digest that differs is a
 * failure, a tampered receipt is a failure, and a missing stored bundle digest
 * is reported as skipped — never as a pass.
 */

import { canonicalJson, sha256Hex } from "@/lib/engine/filing/signing";
import { buildFilingProof, filingProofDigest } from "@/lib/server/filing-proof";
import { verifyFilingProofBundle } from "@/lib/server/filing-proof-verify";

const payload = {
  invoice: { number: "INV-1", total: 1180 },
  seller: { gstin: "27AAPFU0939F1ZV" },
};

function proof() {
  return buildFilingProof({
    run: {
      id: "run-1",
      organizationId: "org-1",
      engagementId: "eng-1",
      taskId: "GSTR-1:2026-10",
      title: "GSTR-1 October 2026",
      authority: "GSTN",
      dueDate: "2026-11-11",
    },
    payload,
    receipt: {
      provider: "live",
      channel: "irp-irn",
      status: "filed",
      token: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      reference: "IRN-REF",
      irn: "a".repeat(64),
      ackNumber: "ARN-1",
      ackDate: "2026-11-09",
      portalMessage: null,
      submittedAt: "2026-11-09T08:00:00.000Z",
      digest: sha256Hex(canonicalJson(payload)),
      httpStatus: 200,
    },
    actorId: "user-1",
    capturedAt: new Date("2026-11-09T08:00:00.000Z"),
  });
}

describe("filing proof verification", () => {
  it("verifies an untouched bundle and its stored digest", () => {
    const bundle = proof();
    const result = verifyFilingProofBundle({ proof: bundle, bundleDigest: filingProofDigest(bundle) });
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "bundle-digest")?.ok).toBe(true);
    expect(result.bundleDigest).toBe(filingProofDigest(bundle));
  });

  it("reports a missing bundle digest as skipped, not as a pass", () => {
    const result = verifyFilingProofBundle(proof());
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "bundle-digest")?.ok).toBeNull();
  });

  it("fails when the payload was altered after capture", () => {
    const bundle = proof();
    const tampered = { ...bundle, payload: { ...payload, invoice: { number: "INV-1", total: 1 } } };
    const result = verifyFilingProofBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "payload-digest")?.ok).toBe(false);
  });

  it("fails when the receipt digest does not anchor the payload", () => {
    const bundle = proof();
    const tampered = { ...bundle, receipt: { ...bundle.receipt, digest: "0".repeat(64) } };
    const result = verifyFilingProofBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "receipt-digest")?.ok).toBe(false);
  });

  it("fails when a supplied bundle digest does not match", () => {
    const result = verifyFilingProofBundle({ proof: proof(), bundleDigest: "f".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "bundle-digest")?.ok).toBe(false);
  });

  it("rejects a non-object bundle without throwing", () => {
    const result = verifyFilingProofBundle("not-a-proof");
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.id).toBe("shape");
  });
});
