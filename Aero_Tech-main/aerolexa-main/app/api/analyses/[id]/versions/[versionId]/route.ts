import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { AnalysisResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Fetch one immutable analysis version's stored result. */
export async function GET(_request: Request, props: { params: Promise<{ id: string; versionId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const analysis = await prisma.analysis.findUnique({ where: { id: params.id } });
    if (!analysis) throw notFoundError("Analysis not found.");
    await requireRowRole(ctx, analysis, "VIEWER");

    const version = await prisma.analysisVersion.findUnique({
      where: { id: params.versionId },
      include: {
        datasetVersion: { select: { version: true, label: true, source: true } },
        createdBy: { select: { name: true } },
      },
    });
    if (!version || version.analysisId !== analysis.id) throw notFoundError("Analysis version not found.");

    return ok({
      version: {
        id: version.id,
        version: version.version,
        kind: version.kind,
        title: version.title,
        createdAt: version.createdAt.toISOString(),
        createdByName: version.createdBy?.name ?? null,
        result: parseJson<AnalysisResult | null>(version.result, null),
        metrics: parseJson<Record<string, number>>(version.metrics, {}),
        datasetVersion: version.datasetVersion
          ? {
              version: version.datasetVersion.version,
              label: version.datasetVersion.label,
              source: version.datasetVersion.source,
            }
          : null,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
