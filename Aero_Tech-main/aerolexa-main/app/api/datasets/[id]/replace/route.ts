import { notFoundError, requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { computeChangeLog } from "@/lib/engine/connectors/changelog";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { cleanupRaw, parseAndProfileFile, saveUploadToDisk } from "@/lib/file/parse";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readFormData, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { applySavedTransformSteps } from "@/lib/server/transform-apply";
import { createDatasetVersion } from "@/lib/server/versioning";
import type { SqlValue } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * tenancy-audit: global-operator — dataset replace API re-uploads a dataset
 * data file for the workspace. This is a deployment-wide aggregate rather
 * than a per-tenant query.
 */

* Re-upload (replace) a dataset's data with a new file. The previous
 * contents are never deleted — a new DatasetVersion is appended, linked to
 * the prior one, and the change log records exactly what changed. Analyses
 * pinned to the old version keep reading its immutable snapshot.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "EDITOR");
    if (dataset.status === "PROCESSING") {
      throw new ApiError(
        400,
        "DATASET_PROCESSING",
        "This dataset is still processing. What happened: the dataset is currently being parsed and is not ready for replacement. How to fix: wait for the processing to complete, then try again.",
      );
    }

    const form = await readFormData(request);
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(
        400,
        "FILE_REQUIRED",
        "Attach a CSV, XLSX or text-layer PDF file to replace the dataset contents. What happened: no file was provided in the request. How to fix: select a .csv, .xlsx or text-layer .pdf file to upload.",
      );
    }
    if (
      !file.name ||
      (!/\.(csv|xlsx|pdf)$/i.test(file.name) &&
        !file.type.includes("csv") &&
        !file.type.includes("spreadsheet") &&
        !file.type.includes("pdf"))
    ) {
      throw new ApiError(
        400,
        "FILE_UNSUPPORTED",
        `Unsupported file ${file.name}. What happened: the file type is not supported. How to fix: upload a .csv, .xlsx or text-layer .pdf file.`,
      );
    }
    const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
    if (file.size > maxBytes) {
      throw new ApiError(
        400,
        "FILE_TOO_LARGE",
        `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit. What happened: the file is too large to import. How to fix: split the file or upload a subset within the size limit.`,
      );
    }

    // Keep the raw file under a fresh name so a failed parse never clobbers
    // the dataset's current raw upload.
    const rawId = `replace-${crypto.randomUUID()}`;
    const { filePath } = await saveUploadToDisk(file, rawId);

    // Capture the CURRENT rows before anything is overwritten so the change
    // log can diff like-for-like.
    const before = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);

    try {
      // parseAndProfileFile writes NDJSON to dataDir/parsed/<id>.ndjson via a
      // tmp file + rename, so parsing under the dataset's own id is atomic:
      // if it fails, the live file is untouched.
      const parsed = await parseAndProfileFile({
        id: dataset.id,
        filePath,
        fileName: file.name,
        mimeType: file.type,
      });
      // The parser only returns a preview; reload the full row set it just
      // wrote for the change-log diff.
      const after = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);

      const changeLog = computeChangeLog(before.rows as SqlValue[][], after.rows as SqlValue[][]);

      await prisma.dataset.update({
        where: { id: dataset.id },
        data: {
          originalName: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          rowCount: parsed.rowCount,
          columnCount: parsed.columnCount,
          filePath,
          profile: stringifyJson(parsed.profile),
          columns: stringifyJson(parsed.columns),
          preview: stringifyJson(parsed.preview),
          qualityWarnings: stringifyJson(parsed.qualityWarnings),
          updatedAt: new Date(),
        },
      });

      // createDatasetVersion snapshots the dataset's rows itself and computes
      // its own change log against the previous version; it only needs the
      // provenance fields here. The changeLog above is still reported to the
      // client and the activity trail.
      const created = await createDatasetVersion({
        workspaceId: dataset.workspaceId,
        datasetId: dataset.id,
        label: `Re-upload · ${file.name}`,
        source: "re-upload",
        createdById: ctx.user.id,
      });
      const version = created?.version ?? 0;

      // Auto-apply the saved Power Query pipeline (Gap ⑥): when the dataset has
      // saved transform steps, they re-run over the fresh rows immediately, so
      // the dataset's live state is TRANSFORMED data, not raw re-upload data.
      // Failure (e.g. a renamed column) keeps the raw rows and reports why.
      const applied = await applySavedTransformSteps(dataset.id);

      await logActivity(
        ctx,
        "DATASET_UPLOADED",
        `Dataset “${dataset.name}” re-uploaded (${parsed.rowCount.toLocaleString()} rows × ${parsed.columnCount} cols) — v${version}${applied.applied ? ` · pipeline re-applied (${applied.stepCount} steps → ${applied.rowCount.toLocaleString()} rows)` : ""}`,
        dataset.projectId,
        {
          datasetId: dataset.id,
          version,
          rowsAdded: changeLog.rowsAdded,
          rowsRemoved: changeLog.rowsRemoved,
          transformApplied: applied.applied,
          transformSteps: applied.stepCount,
          transformSkippedReason: applied.skippedReason ?? null,
        },
      );

      return ok({
        datasetId: dataset.id,
        version,
        rowCount: applied.applied ? applied.rowCount : parsed.rowCount,
        columnCount: applied.applied ? applied.columnCount : parsed.columnCount,
        transformApplied: applied.applied,
        transformSteps: applied.stepCount,
        transformSkippedReason: applied.skippedReason ?? null,
        changeLog,
        warnings: parsed.qualityWarnings,
      });
    } catch (err) {
      cleanupRaw(rawId);
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

export function GET() {
  return new Response(JSON.stringify({ ok: false, error: "Replace requires POST." }), { status: 405 });
}
