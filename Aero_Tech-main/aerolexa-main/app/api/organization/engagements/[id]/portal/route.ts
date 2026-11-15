import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createPortalLink, listPortalLinks, listPortalUploads } from "@/lib/server/client-portal";
import { listEngagementDocumentRequests } from "@/lib/server/document-requests";

export const dynamic = "force-dynamic";

/** Portal links + client uploads for one engagement. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const [links, uploads, requests] = await Promise.all([
      listPortalLinks(ctx, id),
      listPortalUploads(ctx, id),
      listEngagementDocumentRequests(ctx, id),
    ]);
    return ok({ links, uploads, requests });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Mint a new client link. The raw token appears in this response only. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ label?: string; expiresInDays?: number }>(request);
    const link = await createPortalLink(ctx, id, {
      label: body.label,
      expiresInDays: body.expiresInDays,
    });
    return ok({ link }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
