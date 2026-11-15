import { requireAuth } from "@/lib/auth/guard";
import { applySteps, PQError, describeStep, type PQStep } from "@/lib/engine/powerquery";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { badRequest, loadDatasetFrame, type DatasetFrame } from "@/lib/server/pbi-frame";
import type { ColType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/[id]/transform
 *
 * Power Query–style applied-steps preview. Runs the step pipeline over the
 * first N rows and returns a before/after preview plus per-step row counts
 * (fold semantics like Power Query's preview, without mutating the source).
 *
 * Body: { steps: PQStep[], limit?: number }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const frame = await loadDatasetFrame(ctx, params.id);
    const body = await readJsonBody<{ steps?: PQStep[]; limit?: number }>(request);
    const steps = body.steps ?? [];
    if (!Array.isArray(steps)) throw badRequest("steps must be an array.");
    if (steps.length > 100) throw badRequest("Too many steps (max 100).");
    const limit = Math.min(Math.max(body.limit ?? 100, 1), 1_000);

    try {
      const source = toPQTable(frame);
      const applied = applySteps(source, steps);
      const stepLog = steps.map((s) => ({ id: s.id, kind: s.kind, label: describeStep(s) }));

      const preview = {
        columns: applied.columns.map((c) => ({ name: c.name, type: c.type })),
        rows: applied.rows.slice(0, limit),
        totalRows: applied.rows.length,
      };
      const before = {
        columns: source.columns.map((c) => ({ name: c.name, type: c.type })),
        rows: source.rows.slice(0, limit),
        totalRows: source.rows.length,
      };

      await logActivity(
        ctx,
        "TRANSFORM_PREVIEW",
        `Previewed ${steps.length} transformation steps on “${frame.datasetName}” (${before.totalRows} → ${preview.totalRows} rows)`,
        frame.projectId,
        { datasetId: frame.datasetId },
      );
      return ok({
        before,
        after: preview,
        steps: stepLog,
        note: "Preview only — steps are deterministic and re-runnable; no source data is modified.",
      });
    } catch (err) {
      if (err instanceof PQError) throw badRequest(err.message);
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

function toPQTable(frame: DatasetFrame) {
  return {
    columns: frame.columns.map((c) => ({
      name: c.name,
      type: (c.type as ColType) ?? "string",
      origin: "source" as const,
    })),
    rows: frame.rows.map((r) => r.map((v) => (v === undefined ? null : (v as string | number | boolean | null)))) as (
      string | number | boolean | null
    )[][],
  };
}
