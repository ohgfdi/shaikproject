// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - demo dataset creation is a deployment-wide aggregate operation
import { randomUUID } from "node:crypto";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { writeDemoCsv, DEMO_DATASET_NAME } from "@/lib/demo/demo-data";
import { parseAndProfileFile } from "@/lib/file/parse";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, project, "EDITOR");
    if (project!.status === "ARCHIVED")
      throw new ApiError(
        403,
        "ARCHIVED_PROJECT",
        "This project is archived and read-only. What happened: you're trying to create a dataset in an archived project. How to fix: create a new project or restore this one from the project settings.",
      );

    const id = randomUUID();
    const demo = await writeDemoCsv(id);
    const parsed = await parseAndProfileFile({
      id,
      filePath: demo.filePath,
      fileName: demo.fileName,
      mimeType: demo.mimeType,
      isDemo: true,
    });

    const dataset = await prisma.dataset.create({
      data: {
        id,
        workspaceId: ctx.workspace.id,
        projectId: project!.id,
        name: DEMO_DATASET_NAME,
        originalName: demo.fileName,
        mimeType: demo.mimeType,
        sizeBytes: parsed.rowCount * 120,
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        isDemo: true,
        filePath: demo.filePath,
        ndjsonPath: `${id}.ndjson`,
        profile: stringifyJson(parsed.profile),
        columns: stringifyJson(parsed.columns),
        preview: stringifyJson(parsed.preview),
        qualityWarnings: stringifyJson(parsed.qualityWarnings),
        createdById: ctx.user.id,
      },
    });

    await logActivity(ctx, "DATASET_UPLOADED", `Demo / synthetic dataset created in “${project!.name}”`, project!.id, {
      datasetId: dataset.id,
      demo: true,
    });
    return ok({ datasetId: dataset.id, rowCount: parsed.rowCount, isDemo: true, name: DEMO_DATASET_NAME });
  } catch (err) {
    return toErrorResponse(err);
  }
}
