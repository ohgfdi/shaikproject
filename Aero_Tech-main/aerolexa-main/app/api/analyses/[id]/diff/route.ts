import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { diffAnalysisMetrics, type VersionMetric } from "@/lib/engine/versioning";
import { parseJsonArray } from "@/lib/json";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * Diff two analysis versions. `?from=<versionId>&to=<versionId>` — returns the
 * metrics that changed, with the numeric before/after values and the delta
 * (absolute + percentage), largest relative change first.
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const analysis = await prisma.analysis.findUnique({ where: { id: params.id } });
    if (!analysis) throw notFoundError("Analysis not found.");
    await requireRowRole(ctx, analysis, "VIEWER");

    const url = new URL(request.url);
    const fromId = url.searchParams.get("from");
    const toId = url.searchParams.get("to");
    if (!fromId || !toId) {
      return ok({ changed: [], error: "Pick two versions to compare (?from=…&to=…)." });
    }

    const [fromVersion, toVersion] = await Promise.all([
      prisma.analysisVersion.findUnique({ where: { id: fromId } }),
      prisma.analysisVersion.findUnique({ where: { id: toId } }),
    ]);
    if (!fromVersion || fromVersion.analysisId !== analysis.id) throw notFoundError("From-version not found.");
    if (!toVersion || toVersion.analysisId !== analysis.id) throw notFoundError("To-version not found.");

    const fromMetrics = parseJsonArray<VersionMetric>(fromVersion.metrics, []);
    const toMetrics = parseJsonArray<VersionMetric>(toVersion.metrics, []);
    const diff = diffAnalysisMetrics(fromMetrics, toMetrics);

    return ok({
      from: { version: fromVersion.version, id: fromVersion.id, createdAt: fromVersion.createdAt.toISOString() },
      to: { version: toVersion.version, id: toVersion.id, createdAt: toVersion.createdAt.toISOString() },
      changed: diff.changed.map((m) => ({
        metric: m.label,
        from: m.before,
        to: m.after,
        delta: m.delta,
        deltaPct: m.deltaPct,
      })),
      added: diff.added,
      removed: diff.removed,
      unchangedCount: diff.unchangedCount,
      changedCount: diff.changed.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
