import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

/**
 * tenancy-audit: global-operator — analysis versions API lists analysis
 * versions for the workspace. This is a deployment-wide aggregate rather than
 * a per-tenant query.
 */
import { analysisPythonScript } from "@/lib/engine/code-export";
import { diffAnalysisMetrics, analysisVersionIpynb, type VersionMetric } from "@/lib/engine/versioning";
import { parseJson, parseJsonArray } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse, ok, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { AnalysisResult } from "@/lib/types";

export const dynamic = "force-dynamic";

interface VersionRowLike {
  id: string;
  version: number;
  result: string;
  config: string;
  metrics: string;
  datasetVersionId: string | null;
  datasetVersion: { id: string; version: number } | null;
  createdAt: Date;
}

function versionView(v: VersionRowLike) {
  return {
    id: v.id,
    version: v.version,
    datasetVersionId: v.datasetVersionId,
    datasetVersion: v.datasetVersion ? { id: v.datasetVersion.id, version: v.datasetVersion.version } : null,
    createdAt: v.createdAt.toISOString(),
    title: parseJson<AnalysisResult | null>(v.result, null)?.title ?? `Version ${v.version}`,
    metricCount: parseJsonArray<VersionMetric>(v.metrics, []).length,
  };
}

/**
 * GET /api/analyses/:id/versions — list versions of an analysis.
 * With ?format=python|ipynb (optionally &versionId=…): download the
 * "Export runnable code" artifact directly (browser navigation download).
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const url = new URL(request.url);
    const format = url.searchParams.get("format");
    if (format === "python" || format === "ipynb") {
      return exportArtifact(request, params, format, url.searchParams.get("versionId"));
    }
    const ctx = await requireAuth();
    const analysis = await prisma.analysis.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, analysis, "VIEWER");
    const versions = await prisma.analysisVersion.findMany({
      where: { analysisId: analysis!.id },
      orderBy: { version: "desc" },
      take: 50,
      include: { datasetVersion: { select: { id: true, version: true } } },
    });
    return ok({ versions: versions.map(versionView) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function exportArtifact(
  _request: Request,
  params: { id: string },
  format: "python" | "ipynb",
  versionId: string | null,
): Promise<NextResponse> {
  const ctx = await requireAuth();
  const analysis = await prisma.analysis.findUnique({
    where: { id: params.id },
    include: { dataset: { select: { id: true, name: true } } },
  });
  await requireRowRole(ctx, analysis, "VIEWER");
  const version = versionId
    ? await prisma.analysisVersion.findFirst({ where: { id: versionId, analysisId: analysis!.id } })
    : await prisma.analysisVersion.findFirst({ where: { analysisId: analysis!.id }, orderBy: { version: "desc" } });
  if (!version) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "No recorded version exists for this analysis yet." } },
      { status: 404 },
    );
  }
  const result = parseJson<AnalysisResult | null>(version.result, null);
  if (!result) {
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "The stored version result could not be read." } },
      { status: 500 },
    );
  }
  const cfg = parseJson<Record<string, unknown>>(version.config, {});
  await logActivity(
    ctx,
    "ANALYSIS_EXPORTED",
    `Exported runnable ${format === "ipynb" ? "notebook" : "Python script"} for “${result.title}” v${version.version}`,
    analysis!.projectId,
    { analysisId: analysis!.id, versionId: version.id },
  );
  if (format === "ipynb") {
    const nb = analysisVersionIpynb(result, cfg);
    return new NextResponse(JSON.stringify(nb, null, 2), {
      headers: {
        "Content-Type": "application/x-ipynb+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="analysis-${analysis!.id}-v${version.version}.ipynb"`,
      },
    });
  }
  const script = analysisPythonScript(result, cfg);
  return new NextResponse(script, {
    headers: {
      "Content-Type": "text/x-python; charset=utf-8",
      "Content-Disposition": `attachment; filename="analysis-${analysis!.id}-v${version.version}.py"`,
    },
  });
}

const diffSchema = z.object({
  fromVersionId: z.string().min(1),
  toVersionId: z.string().min(1),
});

/** POST /api/analyses/:id/versions — diff two versions of this analysis. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = diffSchema.parse(await readJsonBody(request));
    const analysis = await prisma.analysis.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, analysis, "VIEWER");

    const [from, to] = await Promise.all([
      prisma.analysisVersion.findFirst({ where: { id: body.fromVersionId, analysisId: analysis!.id } }),
      prisma.analysisVersion.findFirst({ where: { id: body.toVersionId, analysisId: analysis!.id } }),
    ]);
    if (!from || !to) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "One of the versions does not belong to this analysis." } },
        { status: 404 },
      );
    }

    const fromMetrics = parseJsonArray<VersionMetric>(from.metrics, []);
    const toMetrics = parseJsonArray<VersionMetric>(to.metrics, []);
    const diff = diffAnalysisMetrics(fromMetrics, toMetrics);
    return ok({
      diff: {
        from: { id: from.id, version: from.version, createdAt: from.createdAt.toISOString() },
        to: { id: to.id, version: to.version, createdAt: to.createdAt.toISOString() },
        changed: diff.changed,
        added: diff.added,
        removed: diff.removed,
        unchangedCount: diff.unchangedCount,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
