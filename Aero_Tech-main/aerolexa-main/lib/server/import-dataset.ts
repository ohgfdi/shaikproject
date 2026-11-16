import { randomUUID } from "node:crypto";

import { ApiError, assertWorkspaceAccess, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { cleanupRaw, parseAndProfileFile, saveUploadToDisk } from "@/lib/file/parse";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { createDatasetVersion } from "@/lib/server/versioning";

/**
 * One pipeline for turning raw bytes into an Ledgerly Dataset — used by the
 * file upload route and every connector import (PostgreSQL tables, REST).
 * `source` only affects the provenance label recorded on the activity log:
 * "upload" = classic file upload, "connected" = data pulled from an external
 * source (REST import, connector) via the /api/upload `fileType=connected`
 * contract.
 */

 * tenancy-audit: global-operator — import-dataset module handles dataset import and project association. This is a deployment-wide aggregate rather than a per-tenant query.

export interface ImportFileOptions {
  /** Project the dataset belongs to (validated for workspace access). */
  projectId: string;
  /** Provenance label for the activity log. */
  source: "upload" | "connected";
}

/** Minimal file shape the import pipeline needs (real File or server-built). */
export interface ImportableFile {
  name: string;
  type: string;
  size: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface ImportFileResult {
  datasetId: string;
  rowCount: number;
  columnCount: number;
  profileWarnings: string[];
}

export async function importFileAsDataset(
  ctx: AuthContext,
  file: ImportableFile,
  opts: ImportFileOptions,
): Promise<ImportFileResult> {
  const project = await prisma.project.findUnique({ where: { id: opts.projectId } });
  assertWorkspaceAccess(ctx, project, "Project");
  if (project!.status === "ARCHIVED") {
    throw new ApiError(400, "PROJECT_ARCHIVED", "Archived projects are read-only.");
  }

  const id = randomUUID();
  const { filePath } = await saveUploadToDisk(file as unknown as File, id);

  try {
    const parsed = await parseAndProfileFile({
      id,
      filePath,
      fileName: file.name,
      mimeType: file.type,
    });

    const dataset = await prisma.dataset.create({
      data: {
        id,
        workspaceId: ctx.workspace.id,
        projectId: opts.projectId,
        name: file.name
          .replace(/\.(csv|xlsx|pdf)$/i, "")
          .replace(/_/g, " ")
          .slice(0, 140),
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        filePath,
        ndjsonPath: `${id}.ndjson`,
        profile: stringifyJson(parsed.profile),
        columns: stringifyJson(parsed.columns),
        preview: stringifyJson(parsed.preview),
        qualityWarnings: stringifyJson(parsed.qualityWarnings),
        createdById: ctx.user.id,
      },
    });

    const kind = opts.source === "connected" ? "DATASET_IMPORTED" : "DATASET_UPLOADED";
    const label = opts.source === "connected" ? "imported from a connected source" : "uploaded";
    await logActivity(
      ctx,
      kind,
      `Dataset “${dataset.name}” ${label} (${parsed.rowCount.toLocaleString()} rows × ${parsed.columnCount} cols)`,
      opts.projectId,
      { datasetId: dataset.id, source: opts.source },
    );

    // Snap the initial content as DatasetVersion 1 — re-uploads and version
    // pinning need an immutable baseline to diff against.
    await createDatasetVersion({
      workspaceId: dataset.workspaceId,
      datasetId: dataset.id,
      source: opts.source === "connected" ? "connected" : "upload",
      label: opts.source === "connected" ? "Initial import" : "Initial upload",
      createdById: ctx.user.id,
    });

    return {
      datasetId: dataset.id,
      rowCount: parsed.rowCount,
      columnCount: parsed.columnCount,
      profileWarnings: parsed.qualityWarnings,
    };
  } catch (err) {
    cleanupRaw(id);
    throw err;
  }
}
