import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { listClientConsents, recordClientConsent } from "@/lib/server/data-controls";
import type { ClientConsentPurpose } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Client consent history for an engagement (newest first). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok({ consents: await listClientConsents(ctx, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Record (or withdraw) a client consent decision — append-only proof. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      purpose?: ClientConsentPurpose;
      subjectRef?: string;
      granted?: boolean;
      evidenceNote?: string | null;
      expiresAt?: string | null;
    }>(request);
    if (!body.purpose) throw new ApiError(400, "VALIDATION", "purpose is required.");
    if (!body.subjectRef) throw new ApiError(400, "VALIDATION", "subjectRef is required.");
    const consent = await recordClientConsent(ctx, id, {
      purpose: body.purpose,
      subjectRef: body.subjectRef,
      granted: body.granted,
      evidenceNote: body.evidenceNote,
      expiresAt: body.expiresAt,
    });
    return ok({ consent }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
