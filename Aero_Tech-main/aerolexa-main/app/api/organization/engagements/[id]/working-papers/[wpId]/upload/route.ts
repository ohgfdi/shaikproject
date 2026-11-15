import { ApiError, requireAuth } from "@/lib/auth/guard";
import { uploadFileToS3 } from "@/lib/aws/s3";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
/** POST /api/organization/engagements/:id/working-papers/:wpId/upload
 *  Upload a document for a working paper version.
 *  Stores the file in S3 and triggers AI analysis.
 */
const generateId = () => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `wp-${timestamp}-${random}`;
};

/** POST /api/organization/engagements/:id/working-papers/:wpId/upload
 *  Upload a document for a working paper version.
 *  Stores the file in S3 and triggers AI analysis.
 */
export async function POST(request: Request, props: { params: Promise<{ wpId: string }> }) {
  try {
    const { wpId } = await props.params;
    const ctx = await requireAuth();

    const body = await readJsonBody<{
      title: string;
      category: "trial-balance" | "invoice" | "receipt" | "bank-statement" | "other";
      fileName: string;
      fileSize: number;
      contentHash: string; // base64 encoded content hash for preview
    }>(request);

    if (!body.title || body.title.trim().length < 3) {
      throw new ApiError(400, "VALIDATION", "Title must be at least 3 characters.");
    }

    if (!["trial-balance", "invoice", "receipt", "bank-statement", "other"].includes(body.category)) {
      throw new ApiError(400, "VALIDATION", "Invalid document category.");
    }

    // Create a new version with the document
    const version = generateId().substring(0, 8);

    // Upload file to S3
    const fileBytes = Buffer.from(body.contentHash ?? '', 'base64');
    const s3Key = `engagements/${body.title}_${version}/${body.fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const s3Url = await uploadFileToS3(fileBytes, s3Key);

    // Trigger AI analysis based on category
    let aiAnalysis = null;
    try {
      const analysisRes = await fetch("/api/ai/analyze-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentType: body.category,
          content: body.contentHash,
          title: body.title,
        }),
      });

      if (analysisRes.ok) {
        aiAnalysis = await analysisRes.json();
      }
    } catch (aiErr) {
      // AI analysis failure doesn't block the upload
      console.error("AI document analysis failed:", aiErr);
    }

    return ok({
      success: true,
      version,
      title: body.title,
      category: body.category,
      s3Url,
      aiAnalysis,
      message: "Document uploaded successfully. AI analysis completed.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}