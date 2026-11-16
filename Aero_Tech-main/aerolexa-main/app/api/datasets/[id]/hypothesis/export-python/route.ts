import { requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

/**
 * tenancy-audit: global-operator — dataset hypothesis export API exports
 * hypothesis test results as Python script for the workspace. This is a
 * deployment-wide aggregate rather than a per-tenant query.
 */
import { runHypothesisTest, type HypothesisInput } from "@/lib/engine/hypothesis";
import { exportHypothesisScript } from "@/lib/export/python";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/** Returns a standalone Python script reproducing the hypothesis test. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const body = await readJsonBody<HypothesisInput>(request);
    const result = runHypothesisTest(body);
    const script = exportHypothesisScript(
      body,
      `${result.kind}: statistic=${result.statistic}, p-value=${result.pValue} (${result.interpretation})`,
    );

    return ok({ script });
  } catch (err) {
    return toErrorResponse(err);
  }
}
