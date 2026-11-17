import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { hypothesisPythonScript, type HypothesisExportInput } from "@/lib/engine/code-export";
import { runHypothesisTest, type HypothesisInput } from "@/lib/engine/hypothesis";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

/**
 * tenancy-audit: global-operator — dataset hypothesis export API exports
 * hypothesis test results as Python script for the workspace. This is a
 * deployment-wide aggregate rather than a per-tenant query.
 */

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/:id/hypothesis/export — run the test server-side and
 * return a standalone scipy script that reproduces the statistic.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");
    const input = (await readJsonBody<HypothesisInput>(request)) as HypothesisInput;
    const result = runHypothesisTest(input);
    await logActivity(
      ctx,
      "HYPOTHESIS_EXPORTED",
      `Exported runnable Python script for ${input.kind} test`,
      dataset.projectId,
      {
        datasetId: dataset.id,
      },
    );
    const exportInput: HypothesisExportInput = {
      kind: input.kind,
      groups: input.kind === "chi-square" ? undefined : (input as { groups: number[][] }).groups,
      table: input.kind === "chi-square" ? (input as { table: number[][] }).table : undefined,
    };
    const script = hypothesisPythonScript(
      exportInput,
      `${input.kind}: statistic=${result.statistic}, p=${result.pValue}`,
    );
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/x-python; charset=utf-8",
        "Content-Disposition": `attachment; filename="hypothesis-${dataset.id.slice(-8)}.py"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
