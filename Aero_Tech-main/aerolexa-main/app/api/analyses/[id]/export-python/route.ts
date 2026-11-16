import { NextResponse } from "next/server";

import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";

/**
 * tenancy-audit: global-operator — analysis export API.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */

import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { exportAnalysisScript } from "@/lib/export/python";
import { parseJson, parseJsonArray } from "@/lib/json";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { AnalysisConfig, AnalysisResult, ColumnDef } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Download a standalone Python script reproducing this analysis version. */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const analysis = await withTenantDb(ctx, (db) =>
    prisma.analysis.findUnique({ where: { id: params.id } }),
  );
    if (!analysis) throw notFoundError("Analysis not found.");
    await requireRowRole(ctx, analysis, "VIEWER");

    const url = new URL(request.url);
    const versionId = url.searchParams.get("versionId");

    const version = versionId
      ? await withTenantDb(ctx, (db) =>
          prisma.analysisVersion.findUnique({ where: { id: versionId } })
        : await withTenantDb(ctx, (db) =>
          prisma.analysisVersion.findFirst({
            where: { analysisId: analysis.id },
            orderBy: { version: "desc" },
          }),
      );
    if (!version || version.analysisId !== analysis.id) throw notFoundError("Analysis version not found.");

    const dataset = await withTenantDb(ctx, (db) =>
    prisma.dataset.findUnique({ where: { id: analysis.datasetId } }),
  );
    if (!dataset) throw notFoundError("The source dataset is missing.");

    const columns: ColumnDef[] = datasetColumns(dataset);
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const result = parseJson<AnalysisResult | null>(version.result, null);
    if (!result) throw notFoundError("The stored analysis result is missing.");

    const cfg = parseJson<AnalysisConfig | null>(version.config, null) ?? ({ kind: version.kind } as AnalysisConfig);
    const script = exportAnalysisScript(result, cfg as unknown as Record<string, unknown>, columns, loaded.rows);

    await logActivity(
      ctx,
      "ANALYSIS_RUN",
      `Exported runnable Python for analysis “${version.title}” v${version.version}`,
      analysis.projectId,
      { analysisId: analysis.id, version: version.version },
    );

    const safeName = version.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "-")
      .slice(0, 60);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/x-python; charset=utf-8",
        "Content-Disposition": `attachment; filename="analysis-${safeName}-v${version.version}.py"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

void parseJsonArray;
