/**
 * Client approval receipt oracles.
 *
 * The receipt is click-to-approve evidence: it proves this run, this actor, this
 * time and no tampering since. The digest must be recomputable by the client and
 * must fail the moment a field changes.
 */

import {
  approvalReceiptDigest,
  attachApprovalReceiptSignature,
  buildPortalApprovalReceipt,
  PORTAL_APPROVAL_RECEIPT_VERSION,
  verifyPortalApprovalReceipt,
} from "@/lib/server/portal-approval-receipt";

const input = {
  run: {
    id: "run-1",
    taskId: "eng-1:GSTR-3B:2026-10",
    title: "GSTR-3B Oct 2026",
    authority: "GSTN",
    dueDate: "2026-10-20",
  },
  engagement: { id: "eng-1", name: "Sharma Textiles", organizationId: "org-1" },
  approval: {
    stage: "client-approved",
    approvedAt: "2026-10-22T10:00:00.000Z",
    approvedBy: "R. Sharma",
    note: "Checked against our sales register.",
    tokenId: "tok-1",
  },
};

describe("portal approval receipt", () => {
  it("builds a versioned receipt with a recomputable digest", () => {
    const receipt = buildPortalApprovalReceipt(input);
    expect(receipt.version).toBe(PORTAL_APPROVAL_RECEIPT_VERSION);
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.digest).toBe(approvalReceiptDigest(input));
    expect(verifyPortalApprovalReceipt(receipt).ok).toBe(true);
  });

  it("is stable regardless of object key order", () => {
    const reordered = {
      engagement: input.engagement,
      run: input.run,
      approval: input.approval,
    };
    expect(buildPortalApprovalReceipt(reordered).digest).toBe(
      buildPortalApprovalReceipt(input).digest,
    );
  });

  it("fails verification when any approval field is altered", () => {
    const receipt = buildPortalApprovalReceipt(input);
    const tampered = {
      ...receipt,
      approval: { ...receipt.approval, approvedBy: "Someone Else" },
    };
    const result = verifyPortalApprovalReceipt(tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "digest")?.ok).toBe(false);
  });

  it("fails verification when the note is added after issue", () => {
    const receipt = buildPortalApprovalReceipt(input);
    const result = verifyPortalApprovalReceipt({
      ...receipt,
      approval: { ...receipt.approval, note: "extra condition" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported version", () => {
    const receipt = buildPortalApprovalReceipt(input);
    const result = verifyPortalApprovalReceipt({ ...receipt, version: 4 });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "version")?.ok).toBe(false);
  });

  it("records a signed-in account when the approval came from a magic link", () => {
    const receipt = buildPortalApprovalReceipt({
      ...input,
      approval: { ...input.approval, identity: "magic-link", accountId: "acct-1" },
    });
    expect(receipt.approval.identity).toBe("magic-link");
    expect(receipt.approval.accountId).toBe("acct-1");
    expect(verifyPortalApprovalReceipt(receipt).ok).toBe(true);

    const tampered = {
      ...receipt,
      approval: { ...receipt.approval, accountId: "acct-2" },
    };
    expect(verifyPortalApprovalReceipt(tampered).ok).toBe(false);
  });

  it("promotes to v3 with a detached signature over the same digest", () => {
    const unsigned = buildPortalApprovalReceipt(input);
    const signed = attachApprovalReceiptSignature(unsigned, {
      algorithm: "SHA256withRSA",
      digest: unsigned.digest,
      signatureBase64: "c2lnbmF0dXJl",
      certificateSerial: "1A2B3C",
      signedAt: "2026-10-22T10:00:05.000Z",
      signerId: "http-signing-service",
    });
    expect(signed.version).toBe(3);
    expect(signed.digest).toBe(unsigned.digest);
    expect(signed.signature?.digest).toBe(unsigned.digest);
    const result = verifyPortalApprovalReceipt(signed);
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "signature")?.detail).toContain("Signed by");
  });

  it("rejects a v3 receipt whose signature points at another digest", () => {
    const unsigned = buildPortalApprovalReceipt(input);
    const signed = attachApprovalReceiptSignature(unsigned, {
      algorithm: "SHA256withRSA",
      digest: unsigned.digest,
      signatureBase64: "c2lnbmF0dXJl",
      certificateSerial: "1A2B3C",
      signedAt: "2026-10-22T10:00:05.000Z",
      signerId: "http-signing-service",
    });
    const tampered = {
      ...signed,
      signature: { ...signed.signature!, digest: "0".repeat(64) },
    };
    expect(verifyPortalApprovalReceipt(tampered).ok).toBe(false);
  });

  it("still verifies a version 1 link-only receipt already issued", () => {
    const v1 = {
      version: 1 as const,
      run: input.run,
      engagement: input.engagement,
      approval: { ...input.approval },
      digest: "",
    };
    v1.digest = approvalReceiptDigest(v1);
    const result = verifyPortalApprovalReceipt(v1);
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "version")?.detail).toContain("Version 1");
  });

  it("rejects a receipt that does not name the token or a real time", () => {
    const receipt = buildPortalApprovalReceipt(input);
    const noToken = verifyPortalApprovalReceipt({
      ...receipt,
      approval: { ...receipt.approval, tokenId: "" },
    });
    expect(noToken.ok).toBe(false);

    const badTime = verifyPortalApprovalReceipt({
      ...receipt,
      approval: { ...receipt.approval, approvedAt: "yesterday" },
    });
    expect(badTime.ok).toBe(false);
  });

  it("reports shape failure without throwing", () => {
    const result = verifyPortalApprovalReceipt("not-a-receipt");
    expect(result.ok).toBe(false);
    expect(result.digest).toBeNull();
    expect(result.checks[0]?.id).toBe("shape");
  });
});
