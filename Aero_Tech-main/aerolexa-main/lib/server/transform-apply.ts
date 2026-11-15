import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import type { Cell } from "@/lib/engine/dataset";
import { applySteps, describeStep, PQError, type PQStep } from "@/lib/engine/powerquery";
import { serverEnv } from "@/lib/env";
import { type StorableColumn } from "@/lib/file/store-rows";
import { storeRowsAsDataset } from "@/lib/file/store-rows";
import { stringifyJson } from "@/lib/json";
import type { ColType } from "@/lib/types";

/**
 * Auto-apply a dataset's saved Power Query steps (Gap ⑥).
 *
 * When a dataset carries persisted transform steps (saved in the studio) and
 * its rows are replaced — CSV/XLSX re-upload or a connector full-pull sync —
 * the saved pipeline re-runs deterministically over the fresh rows before
 * they are materialized. Everything downstream (profiler, analyses, exports)
 * then reads transformed data, and the raw file remains untouched on disk.
 *
 * Honesty rules:
 *  - The applied pipeline is recorded (activity meta + caller-provenance), so
 *    a transformed dataset is never mistaken for raw source data.
 *  - Column drift between the saved steps and the new file is FINE: the engine
 *    throws PQError with the exact step that no longer applies, and the caller
 *    chooses to keep raw rows (default) — never a silently broken dataset.
 */

export interface ApplyResult {
  applied: boolean;
  stepCount: number;
  rowCount: number;
  columnCount: number;
  /** Populated when application failed — the raw rows were kept. */
  skippedReason?: string;
}

/**
 * Run the saved steps over the dataset's current parsed rows and re-materialize
 * the result. Returns applied:false when there is nothing to do or the pipeline
 * no longer fits the data (reason reported, raw rows kept).
 */
export async function applySavedTransformSteps(datasetId: string): Promise<ApplyResult> {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    select: { transformSteps: true },
  });
  const raw = dataset?.transformSteps;
  if (!raw) return { applied: false, stepCount: 0, rowCount: 0, columnCount: 0 };

  let steps: PQStep[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { applied: false, stepCount: 0, rowCount: 0, columnCount: 0 };
    }
    steps = parsed as PQStep[];
  } catch {
    return { applied: false, stepCount: 0, rowCount: 0, columnCount: 0, skippedReason: "Corrupt saved steps JSON." };
  }

  const loaded = await loadParsedDataset(datasetId, serverEnv().DATASET_ANALYSIS_LIMIT);
  const datasetRow = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { columns: true } });
  const columns = JSON.parse(datasetRow?.columns ?? "[]") as { name: string; type: string }[];

  try {
    const table = applySteps(
      {
        columns: columns.map((c) => ({
          name: c.name,
          type: (c.type as ColType) ?? "string",
          origin: "source" as const,
        })),
        rows: loaded.rows.map((r) => r.map((v) => (v === undefined ? null : (v as string | number | boolean | null)))),
      },
      steps,
    );

    const cellRows = table.rows.map((row) => row.map((cell) => cell as Cell));
    const storableCols = table.columns.map((c) => ({ name: c.name, type: c.type as ColType }));
    const stored = await storeRowsAsDataset(datasetId, storableCols as StorableColumn[], cellRows);

    // Persist the TRANSFORMED state (profile/columns/preview) while keeping the
    // saved pipeline itself intact for the next re-upload.
    await prisma.dataset.update({
      where: { id: datasetId },
      data: {
        rowCount: stored.rowCount,
        columnCount: stored.columns.length,
        profile: stringifyJson(stored.profile),
        columns: stringifyJson(stored.columns),
        preview: stringifyJson(stored.preview),
        qualityWarnings: stringifyJson(stored.qualityWarnings),
      },
    });

    return {
      applied: true,
      stepCount: steps.length,
      rowCount: stored.rowCount,
      columnCount: stored.columns.length,
    };
  } catch (err) {
    if (err instanceof PQError) {
      return {
        applied: false,
        stepCount: steps.length,
        rowCount: loaded.rows.length,
        columnCount: columns.length,
        skippedReason: err.message,
      };
    }
    throw err;
  }
}

/** Human-readable pipeline description for activity/version provenance. */
export function describeSavedSteps(steps: PQStep[]): string[] {
  return steps.map((s) => describeStep(s)).slice(0, 20);
}
