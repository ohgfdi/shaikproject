import { NextResponse } from "next/server";

import { verifyApprovalReceiptSignature } from "@/lib/server/approval-receipt-signing";
import {
  verifyPortalApprovalReceipt,
  type PortalApprovalReceipt,
} from "@/lib/server/portal-approval-receipt";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 200_000;

/**
 * POST — verify a pasted approval receipt.
 *
 * Public on purpose: a client or auditor holding the receipt must be able to
 * check it without an account. Nothing is stored, nothing is looked up, and the
 * response says exactly what was and was not verified.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Receipt is too large." }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body must be the receipt JSON." }, { status: 400 });
  }

  const verification = verifyPortalApprovalReceipt(parsed);
  const signatureVerified =
    verification.ok && parsed && typeof parsed === "object"
      ? verifyApprovalReceiptSignature(parsed as PortalApprovalReceipt)
      : null;

  return NextResponse.json(
    {
      verification,
      signatureVerified,
      signatureNote:
        signatureVerified === null
          ? "No signature was verified: the receipt is unsigned or this deployment has not configured FILING_SIGNING_CERT_PEM."
          : signatureVerified
            ? "The detached signature matches the configured certificate."
            : "The detached signature does NOT match the configured certificate.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
