import { requireAuth, ApiError } from "@/lib/auth/guard";
import { serverEnv } from "@/lib/env";
import { ok, toErrorResponse, readFormData } from "@/lib/server/api";
import { importFileAsDataset } from "@/lib/server/import-dataset";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

const ALLOWED_MIME = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "text/plain",
  "application/pdf",
];

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    // Each upload parses a file, writes it to disk and materializes a
    // dataset. Unmetered, one account could fill the disk — the bucket existed
    // but was only ever charged by /api/sample-data.
    enforceUserRateLimit(ctx.user.id, "upload", RATE_LIMITS.upload);
    const form = await readFormData(request);
    const projectIdRaw = form.get("projectId");
    const projectId = typeof projectIdRaw === "string" ? projectIdRaw : null;
    if (!projectId) throw new ApiError(400, "VALIDATION", "A project is required to store the dataset.");

    const fileTypeRaw = form.get("fileType");
    const source: "upload" | "connected" = fileTypeRaw === "connected" ? "connected" : "upload";

    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "VALIDATION", "Attach a CSV, XLSX or text-layer PDF file.");
    if (!file.name || (!ALLOWED_MIME.includes(file.type) && !/\.(csv|xlsx|pdf)$/i.test(file.name))) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Unsupported file “${file.name}”. Upload a .csv, .xlsx or text-layer .pdf file.`,
      );
    }
    const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
    if (file.size > maxBytes) {
      throw new ApiError(400, "VALIDATION", `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`);
    }

    const result = await importFileAsDataset(ctx, file, { projectId, source });
    return ok({ ...result, projectId });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export function GET() {
  return new Response(
    JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Upload requires POST." } }),
    {
      status: 405,
      headers: { "Content-Type": "application/json" },
    },
  );
}
