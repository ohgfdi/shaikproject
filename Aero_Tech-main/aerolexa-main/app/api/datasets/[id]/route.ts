import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { prisma } from "@/lib/db";
import { dataDir } from "@/lib/engine/dataset";
import { applyColumnOps } from "@/lib/file/parse";
import { parseJsonArray } from "@/lib/json";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { createDatasetVersion } from "@/lib/server/versioning";
import type { ColumnDef } from "@/lib/types";

const columnOpSchema = z.object({
  kind: z.enum(["cast", "drop", "rename"]),
  name: z.string().min(1),
  type: z.enum(["string", "number", "date", "boolean"]).optional(),
  newName: z.string().min(1).max(120).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  ops: z.array(columnOpSchema).max(20).optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = patchSchema.parse(await readJsonBody(request));
    const dataset = await withTenantDb(ctx, (db) =>
    db.dataset.findUnique({ where: { id: params.id } }),
  );
    await requireRowRole(ctx, dataset, "EDITOR");
    if (dataset!.status === "PROCESSING") throw new ApiError(409, "PROCESSING", "Dataset is still processing.");

    let columns = parseJsonArray<ColumnDef>(dataset!.columns, []);

    if (body.ops?.length) {
      const result = await applyColumnOps(dataset!.id, columns, body.ops);
      columns = result.columns;
      await withTenantDb(ctx, (db) =>
        db.dataset.update({
          where: { id: dataset!.id },
          data: {
            columns: stringifyJson(result.columns),
            profile: stringifyJson(result.profile),
            preview: stringifyJson(result.preview),
            qualityWarnings: stringifyJson(result.profile.qualityWarnings),
            columnCount: result.columns.length,
            updatedAt: new Date(),
          },
        }),
      );
      // Phase 1.5: an immutable snapshot of the re-cast rows, so analyses can
      // pin to the pre-op state and the change is never silent.
      await createDatasetVersion({
        datasetId: dataset!.id,
        workspaceId: ctx.workspace.id,
        source: "column-ops",
        label: `column ops (${body.ops.map((op) => op.kind).join(", ")})`,
        createdById: ctx.user.id,
      });
    }

    const name = body.name?.trim();
    if (name && name !== dataset!.name) {
      await withTenantDb(ctx, (db) =>
        db.dataset.update({ where: { id: dataset!.id }, data: { name, updatedAt: new Date() } }),
    );

    await logActivity(ctx, "DATASET_UPDATED", `Dataset “${name ?? dataset!.name}” updated`, dataset!.projectId, {
      datasetId: dataset!.id,
    });
    return ok({ id: dataset!.id, columns, name: name ?? dataset!.name });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await withTenantDb(ctx, (db) =>
    db.dataset.findUnique({
      where: { id: params.id },
      include: { _count: { select: { analyses: true } } },
    }),
  );
    await requireRowRole(ctx, dataset, "EDITOR");
    // Cascade in the schema removes analyses/insights; remove files too.
    await withTenantDb(ctx, (db) =>
      db.$transaction([
        db.analysis.deleteMany({ where: { datasetId: dataset!.id } }),
        db.insight.deleteMany({ where: { datasetId: dataset!.id } }),
        db.dataset.delete({ where: { id: dataset!.id } }),
      ]),
    );
    const parsedFile = path.join(dataDir(), "parsed", `${dataset!.id}.ndjson`);
    const rawFile = dataset!.filePath;
    await Promise.allSettled([
      fs.rm(parsedFile, { force: true }),
      rawFile ? fs.rm(rawFile, { force: true }) : Promise.resolve(),
    ]);
    await logActivity(ctx, "ARTIFACT_DELETED", `Dataset “${dataset!.name}” deleted`, dataset!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
