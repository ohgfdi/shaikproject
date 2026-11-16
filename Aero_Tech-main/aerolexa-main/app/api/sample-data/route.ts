import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SAMPLE_DATASETS, toNdjson, type SampleDatasetDef } from "@/lib/analytics/sample-data";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - sample dataset import is a deployment-wide aggregate operation
import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { dataDir } from "@/lib/engine/dataset";
import { inferType } from "@/lib/engine/dataset";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";
import { createDatasetVersion } from "@/lib/server/versioning";

export const dynamic = "force-dynamic";

/**
 * POST /api/sample-data
 *
 * One-click onboarding: imports a built-in sample dataset into the user's
 * workspace (optionally linked to a project). All data is deterministic
 * (seeded) so every instance of a sample is identical.
 *
 * The sample rows are persisted as a positional-array NDJSON row-stream — the
 * exact format `loadParsedDataset` and every engine read — so samples flow
 * through the same analytics as uploaded files. Profile is computed from the
 * real rows (same ColumnStat shape as parseAndProfileFile), and the import is
 * snapshotted as DatasetVersion 1 like every other dataset.
 *
 * Body: { kind: "sales" | "marketing" | "web_analytics" | "hr", projectId?: string }
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    // Authenticated principal rate limit: imports write rows to disk and the DB,
    // so they belong in the same budget as uploads (60/hour per user).
    enforceUserRateLimit(ctx.user.id, "upload", RATE_LIMITS.upload);

    const body = await readJsonBody<{ kind?: string; projectId?: string }>(request);
    const kind = (body.kind ?? "sales").trim();

    const generator = SAMPLE_DATASETS[kind];
    if (!generator) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Unknown sample dataset "${kind}". Available: ${Object.keys(SAMPLE_DATASETS).join(", ")}`,
      );
    }

    const sample: SampleDatasetDef = generator();
    if (sample.rows.length === 0) {
      throw new ApiError(500, "INTERNAL", "Sample generator produced no rows.");
    }

    // Validate project exists if supplied
    let projectId: string | null = null;
    if (body.projectId) {
      const project = await prisma.project.findUnique({ where: { id: body.projectId } });
      if (!project || project.workspaceId !== ctx.workspace.id) {
        throw new ApiError(404, "NOT_FOUND", "Project not found in your workspace.");
      }
      if (project.status === "ARCHIVED") {
        throw new ApiError(400, "PROJECT_ARCHIVED", "Archived projects are read-only.");
      }
      projectId = project.id;
    }

    // Positional array rows — the normalized row-stream every engine reads.
    const positionalRows: (string | number | boolean | null)[][] = sample.rows.map((row) =>
      sample.columns.map((c) => {
        const v = row[c.name];
        return v === undefined ? null : (v as string | number | boolean | null);
      }),
    );
    const ndjsonContent = toNdjson(positionalRows as unknown as Record<string, unknown>[]);

    // Persist under data/parsed/<id>.ndjson where loadParsedDataset looks.
    const id = crypto.randomUUID();
    const parsedDir = join(dataDir(), "parsed");
    mkdirSync(parsedDir, { recursive: true });
    const ndjsonPath = join(parsedDir, `${id}.ndjson`);
    if (!existsSync(ndjsonPath)) writeFileSync(ndjsonPath, ndjsonContent, "utf8");

    // Column defs re-inferred from the real cells (same inferType as upload).
    const columns = sample.columns.map((c, i) => ({
      name: c.name,
      type: inferType(positionalRows.slice(0, 2000).map((r) => r[i] ?? null)) as string,
    }));

    // Real per-column profile — same shape parseAndProfileFile persists.
    const profile = buildProfile(sample, positionalRows);
    const qualityWarnings = buildQualityWarnings(profile.stats, positionalRows.length);

    const dataset = await prisma.dataset.create({
      data: {
        id,
        workspaceId: ctx.workspace.id,
        projectId,
        name: sample.name.replace(/\.csv$/, "").replace(/_/g, " "),
        originalName: sample.name,
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(ndjsonContent, "utf8"),
        rowCount: positionalRows.length,
        columnCount: sample.columns.length,
        isDemo: true,
        status: "READY",
        ndjsonPath: `${id}.ndjson`,
        columns: stringifyJson(columns),
        profile: stringifyJson(profile),
        preview: stringifyJson(positionalRows.slice(0, 20)),
        qualityWarnings: stringifyJson(qualityWarnings),
        createdById: ctx.user.id,
      },
    });

    // Snapshot as DatasetVersion 1 — same baseline every uploaded dataset gets.
    await createDatasetVersion({
      workspaceId: dataset.workspaceId,
      datasetId: dataset.id,
      source: "upload",
      label: "Initial sample import",
      createdById: ctx.user.id,
    });

    await logActivity(
      ctx,
      "DATASET_CREATED",
      `Imported sample dataset “${sample.name}” (${positionalRows.length.toLocaleString()} rows)`,
      projectId,
      { datasetId: dataset.id },
    );

    return ok({
      dataset: {
        id: dataset.id,
        name: dataset.name,
        rowCount: dataset.rowCount,
        columnCount: dataset.columnCount,
      },
      description: sample.description,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Build a real DatasetProfile from the sample rows (parse.ts shape). */
function buildProfile(sample: SampleDatasetDef, rows: (string | number | boolean | null)[][]) {
  const stats: Record<string, Record<string, unknown>> = {};
  let duplicateRows = 0;
  const seen = new Set<string>();

  sample.columns.forEach((col, i) => {
    const cells = rows.map((r) => r[i]);
    const missing = cells.filter((v) => v == null || v === "").length;

    const stat: Record<string, unknown> = {
      name: col.name,
      type: col.type,
      missing,
      distinct: new Set(cells.filter((v) => v != null && v !== "").map((v) => String(v))).size,
      nearConstant: false,
    };

    if (col.type === "number") {
      const nums = cells.filter((v) => v != null && v !== "" && Number.isFinite(Number(v))).map(Number);
      if (nums.length > 0) {
        const sum = nums.reduce((a, b) => a + b, 0);
        const mean = sum / nums.length;
        stat.min = Math.min(...nums);
        stat.max = Math.max(...nums);
        stat.sum = sum;
        stat.mean = mean;
        stat.stddev = Math.sqrt(nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length);
        const sorted = [...nums].sort((a, b) => a - b);
        stat.median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        stat.q1 = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
        stat.q3 = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
      }
    }

    if (col.type === "date") {
      const dates = cells
        .filter((v) => v != null && v !== "")
        .map((v) => new Date(String(v)))
        .filter((d) => !Number.isNaN(d.getTime()));
      if (dates.length > 0) {
        const times = dates.map((d) => d.getTime());
        stat.minDate = new Date(Math.min(...times)).toISOString();
        stat.maxDate = new Date(Math.max(...times)).toISOString();
      }
    }

    if (col.type === "string") {
      const counts = new Map<string, number>();
      for (const v of cells) {
        if (v == null || v === "") continue;
        const s = String(v);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      stat.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
    }

    stats[col.name] = stat;
  });

  // Exact duplicate rows (same key the upload profiler uses).
  for (const row of rows) {
    const sig = JSON.stringify(row);
    if (seen.has(sig)) duplicateRows++;
    else seen.add(sig);
  }

  return {
    analyzedRows: rows.length,
    sampled: false,
    rowCount: rows.length,
    columnCount: sample.columns.length,
    columns: sample.columns.map((c) => ({ name: c.name, type: c.type as string })),
    stats,
    duplicateRows,
    qualityWarnings: [] as string[],
  };
}

/** Honest quality warnings computed from the real rows. */
function buildQualityWarnings(stats: Record<string, Record<string, unknown>>, rowCount: number): string[] {
  const warnings: string[] = [];
  for (const [name, stat] of Object.entries(stats)) {
    const missing = Number(stat.missing ?? 0);
    if (rowCount > 0 && missing / rowCount > 0.2) {
      warnings.push(`Column “${name}” is ${((missing / rowCount) * 100).toFixed(1)}% missing.`);
    }
  }
  return warnings;
}
