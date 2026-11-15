import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { applySteps, describeStep, PQError, type PQStep } from "@/lib/engine/powerquery";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";
import type { ColType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/[id]/transform/save
 *
 * Validates and persists a dataset's applied Power Query steps on the new
 * `Dataset.transformSteps` JSON column. Validation runs the real engine over
 * the live preview frame first: invalid steps are rejected with the exact
 * engine error, so a saved pipeline is always executable. The source file and
 * materialized store are never mutated — steps re-run deterministically
 * (re-upload hook is the next milestone; today the studio and API can
 * re-apply them on demand).
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const frame = await loadDatasetFrame(ctx, params.id);
    const body = await readJsonBody<{ steps?: PQStep[] }>(request);
    const steps = body.steps ?? [];
    if (!Array.isArray(steps)) throw badRequest("steps must be an array.");
    if (steps.length > 100) throw badRequest("Too many steps (max 100).");

    // Validate against the real engine — never persist a broken pipeline.
    try {
      applySteps(
        {
          columns: frame.columns.map((c) => ({
            name: c.name,
            type: (c.type as ColType) ?? "string",
            origin: "source" as const,
          })),
          rows: frame.rows.map((r) => r.map((v) => (v === undefined ? null : (v as string | number | boolean | null)))),
        },
        steps,
      );
    } catch (err) {
      if (err instanceof PQError) throw badRequest(err.message);
      throw err;
    }

    await prisma.dataset.update({
      where: { id: frame.datasetId },
      data: { transformSteps: JSON.stringify(steps) },
    });

    await logActivity(
      ctx,
      "TRANSFORM_SAVE",
      `Saved ${steps.length} transform step(s) on “${frame.datasetName}”`,
      frame.projectId,
      { datasetId: frame.datasetId, steps: steps.map((s) => describeStep(s)).slice(0, 20) },
    );
    return ok({ saved: steps.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
