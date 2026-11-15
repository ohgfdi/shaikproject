/**
 * Portable approval audit bundle.
 *
 * A receipt proves one approval. An audit bundle packages the receipt, its
 * recomputation, the filing run's state and the append-only event trail into a
 * single downloadable artifact a firm can hand to a client, an auditor or a
 * tribunal. It is intentionally plain JSON: the recipient can recompute the
 * digest and verify the detached signature without this application.
 *
 * Honesty: this bundle is a record of what the app stored and recomputed. It is
 * not a legal opinion and it does not claim the portal accepted the filing.
 */

import { verifyApprovalReceiptSignature } from "./approval-receipt-signing";
import {
  verifyPortalApprovalReceipt,
  type PortalApprovalReceipt,
} from "./portal-approval-receipt";

export interface AuditBundleRun {
  id: string;
  taskId: string;
  title: string;
  authority: string;
  dueDate: string;
  stage: string;
  filedAt: string | null;
  acknowledgementReference: string | null;
  verificationStatus: string;
  clientApprovedAt: string | null;
  clientApprovalReceipt: unknown;
  clientApprovalDigest: string | null;
}

export interface AuditBundleEvent {
  id: string;
  fromStage: string | null;
  toStage: string;
  note: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface ApprovalAuditBundle {
  format: "ledgerly.approval-audit-bundle";
  version: 1;
  generatedAt: string;
  organization: { id: string; name: string } | null;
  filing: Omit<AuditBundleRun, "clientApprovalReceipt"> & { engagementName: string };
  approval: {
    receipt: unknown;
    digest: string | null;
    digestMatches: boolean | null;
    checks: ReturnType<typeof verifyPortalApprovalReceipt>["checks"];
    signatureVerified: boolean | null;
  };
  events: AuditBundleEvent[];
  notes: string[];
}

export function buildApprovalAuditBundle(input: {
  run: AuditBundleRun;
  engagementName: string;
  events: AuditBundleEvent[];
  organization: { id: string; name: string } | null;
  generatedAt: Date;
}): ApprovalAuditBundle {
  const receipt = input.run.clientApprovalReceipt;
  const verification = receipt ? verifyPortalApprovalReceipt(receipt) : null;
  const signatureVerified = receipt
    ? verifyApprovalReceiptSignature(receipt as PortalApprovalReceipt)
    : null;

  const notes: string[] = [];
  if (!receipt) {
    notes.push("No client approval receipt is stored for this run. The stage change has no portable evidence.");
  } else if (!verification?.ok) {
    notes.push("The stored receipt does not pass verification — do not rely on it until the cause is found.");
  }
  if (signatureVerified === null) {
    notes.push(
      "Signature verification was not performed: either the receipt is unsigned or FILING_SIGNING_CERT_PEM is not configured. The digest check still applies.",
    );
  }
  if (input.run.stage !== "filed" && input.run.stage !== "acknowledged") {
    notes.push("The run has not reached a filed/acknowledged stage; this bundle records approval, not submission.");
  }

  const { clientApprovalReceipt: _receipt, ...filing } = input.run;

  return {
    format: "ledgerly.approval-audit-bundle",
    version: 1,
    generatedAt: input.generatedAt.toISOString(),
    organization: input.organization,
    filing: { ...filing, engagementName: input.engagementName },
    approval: {
      receipt,
      digest: input.run.clientApprovalDigest,
      digestMatches: verification?.digest ? verification.digest === input.run.clientApprovalDigest : null,
      checks: verification?.checks ?? [],
      signatureVerified,
    },
    events: input.events,
    notes,
  };
}
