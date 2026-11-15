/**
 * Acknowledgement reconciliation rules. The important property is that "no
 * acknowledgement" is never reported as success, and that offline providers are
 * labelled unverifiable rather than quietly green.
 */

import {
  RECONCILE_AFTER_MS,
  shouldReconcile,
  verdictFromReceipt,
} from "@/lib/server/filing-reconciliation";

describe("verification verdicts", () => {
  it("verifies only when the portal returned an acknowledgement", () => {
    expect(
      verdictFromReceipt({ status: "filed", ackNumber: "ARN-123", portalMessage: null }, "live").status,
    ).toBe("verified");
  });

  it("keeps a live submission unverified while the acknowledgement is pending", () => {
    expect(
      verdictFromReceipt({ status: "accepted-pending", ackNumber: null, portalMessage: null }, "live").status,
    ).toBe("unverified");
    expect(verdictFromReceipt({ status: "filed", ackNumber: null, portalMessage: null }, "live").status).toBe(
      "unverified",
    );
  });

  it("marks a rejected or errored submission defective with the portal's message", () => {
    const verdict = verdictFromReceipt(
      { status: "rejected", ackNumber: null, portalMessage: "GSTIN inactive" },
      "live",
    );
    expect(verdict.status).toBe("defective");
    expect(verdict.note).toContain("GSTIN inactive");
  });

  it("never calls an offline submission verified", () => {
    expect(
      verdictFromReceipt({ status: "filed", ackNumber: null, portalMessage: null }, "reference").status,
    ).toBe("unverifiable");
    expect(
      verdictFromReceipt({ status: "filed", ackNumber: null, portalMessage: null }, "simulation").status,
    ).toBe("unverifiable");
  });
});

describe("reconcile eligibility", () => {
  const now = new Date("2026-11-10T12:00:00Z");

  it("waits for the settle window before checking", () => {
    expect(
      shouldReconcile(
        { stage: "filed", filedAt: new Date(now.getTime() - RECONCILE_AFTER_MS + 1), verificationStatus: "unverified" },
        now,
      ),
    ).toBe(false);
    expect(
      shouldReconcile(
        { stage: "filed", filedAt: new Date(now.getTime() - RECONCILE_AFTER_MS), verificationStatus: "unverified" },
        now,
      ),
    ).toBe(true);
  });

  it("only checks filed runs that are not already settled", () => {
    const old = new Date(now.getTime() - RECONCILE_AFTER_MS * 2);
    expect(shouldReconcile({ stage: "acknowledged", filedAt: old, verificationStatus: "unverified" }, now)).toBe(
      false,
    );
    expect(shouldReconcile({ stage: "filed", filedAt: old, verificationStatus: "verified" }, now)).toBe(false);
    expect(shouldReconcile({ stage: "filed", filedAt: old, verificationStatus: "defective" }, now)).toBe(false);
    expect(shouldReconcile({ stage: "filed", filedAt: null, verificationStatus: "unverified" }, now)).toBe(false);
  });
});
