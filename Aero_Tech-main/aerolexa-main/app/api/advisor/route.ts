import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { answerAdvisorQuestion } from "@/lib/engine/advisor";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { parseJsonArray } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { ColumnDef } from "@/lib/types";

/**
 * tenancy-audit: global-operator — advisor API aggregates
 * dataset insights for the firm.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */

const schema = z.object({
  question: z.string().min(4).max(1000),
  projectId: z.string().optional(),
  datasetId: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    // The advisor nav entry and this endpoint read the same predicate, so a
    // frozen profile hides the panel AND refuses the compute.
    requireModule("ADVISOR_ENABLED");
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));

    // Resolve the dataset the question should be answered against.
    let dataset;
    if (body.datasetId) {
      dataset = await withTenantDb(ctx, (_db) =>
    prisma.dataset.findUnique({ where: { id: body.datasetId } }),
  );
      await requireRowRole(ctx, dataset, "VIEWER");
    } else if (body.projectId) {
      const project = await withTenantDb(ctx, (_db) =>
    prisma.project.findUnique({ where: { id: body.projectId } }),
  );
      await requireRowRole(ctx, project, "VIEWER");
      dataset = await withTenantDb(ctx, (_db) =>
        prisma.dataset.findFirst({
          where: { workspaceId: ctx.workspace.id, projectId: project!.id },
          orderBy: { createdAt: "desc" },
        }),
      );
    } else {
      dataset = await withTenantDb(ctx, (_db) =>
        prisma.dataset.findFirst({
          where: { workspaceId: ctx.workspace.id },
          orderBy: { createdAt: "desc" },
        }),
      );
    }
    if (!dataset) {
      throw new ApiError(
        409,
        "NO_DATASET",
        "Ask the advisor after uploading a dataset — every answer is computed from your file. Upload one in a project first.",
      );
    }

    const columns = parseJsonArray<ColumnDef>(dataset.columns, []);
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    // RLS: the advisor's numbers must come only from rows this user may see.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
    const rows = rls.rows;
    const totalRows = loaded.totalRows;
    if (rows.length === 0) {
      throw new ApiError(409, "NO_DATA_ROWS", "The dataset file is missing on disk — re-upload it.");
    }

    const result = answerAdvisorQuestion({
      question: body.question,
      columns,
      rows,
      totalRows,
      sampled: totalRows > rows.length,
      datasetName: dataset.name,
      datasetId: dataset.id,
    });

    await logActivity(ctx, "ADVISOR_ASKED", `Advisor question asked in “${dataset.name}”`, dataset.projectId, {
      datasetId: dataset.id,
    });

    return ok(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
