import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";

export async function POST(request: Request) {
  try {
    const _ctx = await requireAuth();

    // engagementId comes from query params (set by client portal)
    const { engagementId } = Object.fromEntries(await new URL(request.url).searchParams.entries());

    const formData = await request.formData();
    const title = formData.get("title") as string;
    const file = formData.get("file") as File;

    if (!title || title.trim().length < 3) {
      return toErrorResponse(new Error("Title must be at least 3 characters."));
    }

    if (!file) {
      return toErrorResponse(new Error("No file uploaded."));
    }

    // Validate file type
    const allowedTypes = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"];
    if (!allowedTypes.includes(file.type) && !file.name.match(/\.(pdf|doc|docx|txt)$/i)) {
      return toErrorResponse(new Error("Invalid file type. Allowed: PDF, DOC, DOCX, TXT."));
    }

    // Validate file size (limit to 25MB)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (file.size > maxSize) {
      return toErrorResponse(new Error(`File too large. Maximum size: 25MB. Your file: ${(file.size / 1024 / 1024).toFixed(2)}MB`));
    }

    // Record document reference
    const documentRef = {
      engagementId: engagementId ?? "",
      title: title.trim(),
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type,
      contentHash: "", // Will be computed after AI analysis
      status: "UPLOADED",
      uploadedAt: new Date(),
    };

    return ok({
      success: true,
      title: title.trim(),
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      uploadedAt: documentRef.uploadedAt,
      message: "Document uploaded successfully. AI analysis will be triggered shortly.",
    });
  } catch (err: any) {
    return toErrorResponse(err);
  }
}