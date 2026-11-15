import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { renderDeliverableVersion } from "@/lib/server/deliverable-render";
import { requireEngagementRole } from "@/lib/server/engagement";

export const dynamic = "force-dynamic";

const VALID_VARIANTS = ["CLIENT", "REVIEWER"] as const;

export async function GET(request: Request, props: { params: Promise<{ id: string; versionId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await requireEngagementRole(ctx, params.id, "ASSISTANT");

    const searchParams = new URL(request.url).searchParams;
    const variant = z
      .enum(VALID_VARIANTS)
      .default("CLIENT")
      .parse(searchParams.get("variant") ?? "CLIENT");

    const rendered = await renderDeliverableVersion({
      engagementId: params.id,
      versionId: params.versionId,
      variant,
    });
    if (!rendered) throw new ApiError(404, "NOT_FOUND", "Version not found.");

    // Keep the firm API surface exactly as it was before the renderer was
    // shared with the client portal.
    return ok({
      versionId: rendered.versionId,
      variant: rendered.variant,
      formatCode: rendered.formatCode,
      revision: rendered.revision,
      status: rendered.status,
      contentHash: rendered.contentHash,
      assembledBody: rendered.assembledBody,
      parts: rendered.parts,
      redactions: rendered.redactions,
      traceability: rendered.traceability,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
