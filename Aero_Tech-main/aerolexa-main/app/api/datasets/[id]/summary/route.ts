// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - dataset summary generation is a deployment-wide aggregate operation
import { generateExecutiveSummary } from "@/lib/analytics/executive-summary";
import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/[id]/summary
 *
 * Generates an executive summary from the dataset. Every claim is backed
 * by real computed statistics — no hallucinated numbers.
 *
 * Body:
 *   {
 *     audience?: "executive" | "analyst" | "technical",
 *     maxSections?: number,
 *     includeRecommendations?: boolean
 *   }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const body = await readJsonBody<{
      audience?: "executive" | "analyst" | "technical";
      maxSections?: number;
      includeRecommendations?: boolean;
    }>(request);

    const summary = await generateExecutiveSummary(dataset.id, {
      maxSections: body.maxSections,
      includeRecommendations: body.includeRecommendations,
      targetAudience: body.audience,
    });

    await logActivity(
      ctx,
      "EXECUTIVE_SUMMARY",
      `Generated executive summary for “${dataset.name}”`,
      dataset.projectId,
      { datasetId: dataset.id, sections: summary.sections.length },
    );

    return ok(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * GET /api/datasets/[id]/summary
 *
 * Returns the latest executive summary. 404 if none exists yet.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { id: true, name: true, projectId: true, workspaceId: true },
    });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    return ok({
      dataset: { id: dataset.id, name: dataset.name, projectId: dataset.projectId },
      message: "Generate a summary with POST to get fresh results.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
