import { requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/server/api";
import { readPortalUpload } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

/** Open or download a document a client uploaded through their portal. */
export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string; uploadId: string }> },
) {
  const { id, uploadId } = await props.params;
  try {
    const ctx = await requireAuth();
    const file = await readPortalUpload(ctx, id, uploadId);

    // The filename is client-supplied: quote-escape the ASCII fallback and use
    // RFC 5987 for the exact name, so a newline or quote cannot inject a header.
    const fallback = file.filename.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "upload";
    const disposition = `${INLINE_TYPES.has(file.mimeType) ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;

    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Client files are never same-origin documents: even if something slips
        // past the magic-byte check, a sandboxed response cannot run script.
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
