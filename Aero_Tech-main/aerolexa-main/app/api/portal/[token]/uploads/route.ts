import { ApiError } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { MAX_PORTAL_UPLOAD_BYTES, savePortalUpload } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

/** A client uploads a document against their engagement. */
export async function POST(request: Request, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "VALIDATION", "Attach a PDF, PNG, JPEG, CSV, XLSX or DOCX file.");
    }
    if (file.size > MAX_PORTAL_UPLOAD_BYTES) {
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Files must be ${Math.round(MAX_PORTAL_UPLOAD_BYTES / 1024 / 1024)} MB or smaller.`,
      );
    }

    const noteValue = form.get("note");
    const requestValue = form.get("requestId");
    const bytes = Buffer.from(await file.arrayBuffer());
    const upload = await savePortalUpload(token, {
      bytes,
      filename: file.name,
      mimeType: file.type,
      note: typeof noteValue === "string" ? noteValue : null,
      requestId: typeof requestValue === "string" ? requestValue : null,
    });
    return ok({ upload }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
