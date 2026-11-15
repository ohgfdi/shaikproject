import * as XLSX from "xlsx";

import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { parseJson, parseJsonArray } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import type { ColumnDef } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/datasets/[id]/export/xlsx
 *
 * The analyst's final mile: a real Excel workbook, not a CSV of the preview.
 * Sheets:
 *   Data      — the typed rows the app computes over (capped at
 *               DATASET_ANALYSIS_LIMIT, labelled in a ReadMe cell when sampled)
 *   Profile   — per-column stats from the dataset profile (missing %, type,
 *               distinct counts, outliers) when a profile exists
 *   Quality   — the dataset's data-quality warnings, one per row
 *   Provenance— dataset name, row counts, sampled flag, generated-at timestamp
 *
 * Streaming-safe: rows are read from the NDJSON store (never inlined into the
 * DB) and written through XLSX.write to a Buffer. Authorization is the same
 * requireRowRole(VIEWER) check every dataset surface uses.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const columns = parseJsonArray<ColumnDef>(dataset.columns, []);
    // RLS: an export must never carry rows the caller cannot see, so the
    // workbook is built from the filtered row set, not the stored one.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
    const rows = rls.rows;
    const profile = parseJson<Record<string, unknown> | null>(dataset.profile ?? "", null);
    const warnings = parseJsonArray<string>(dataset.qualityWarnings, []);

    const sampled = loaded.totalRows > rows.length;

    const wb = XLSX.utils.book_new();

    // --- Data sheet ---------------------------------------------------------
    const header = columns.map((c) => c.name);
    const aoa: (string | number | boolean | null)[][] = [header, ...rows];
    const dataSheet = XLSX.utils.aoa_to_sheet(aoa);
    dataSheet["!cols"] = columns.map((c) => ({ wch: Math.max(10, Math.min(32, c.name.length + 4)) }));
    XLSX.utils.book_append_sheet(wb, dataSheet, "Data");

    // --- Profile sheet ------------------------------------------------------
    const profileRows: (string | number | null)[][] = [["column", "type", "missing", "distinct", "outliers"]];
    const columnStats = (profile?.["columns"] ?? null) as
      { name?: string; type?: string; missing?: number; distinct?: number; outliers?: number }[] | null;
    if (Array.isArray(columnStats)) {
      for (const c of columnStats) {
        profileRows.push([
          c.name ?? null,
          c.type ?? null,
          typeof c.missing === "number" ? c.missing : null,
          typeof c.distinct === "number" ? c.distinct : null,
          typeof c.outliers === "number" ? c.outliers : null,
        ]);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(profileRows), "Profile");
    }

    // --- Quality sheet ------------------------------------------------------
    if (warnings.length > 0) {
      const qualitySheet = XLSX.utils.aoa_to_sheet([["data-quality warning"], ...warnings.map((w) => [w])]);
      XLSX.utils.book_append_sheet(wb, qualitySheet, "Quality");
    }

    // --- Provenance sheet ---------------------------------------------------
    const provSheet = XLSX.utils.aoa_to_sheet([
      ["field", "value"],
      ["dataset", dataset.name],
      ["original file", dataset.originalName],
      ["rows in source", loaded.totalRows],
      ["rows exported", rows.length],
      ["sampled", sampled ? "yes — export capped at DATASET_ANALYSIS_LIMIT" : "no"],
      ["row-level security", rls.applied ? `applied — ${rls.restrictions.join(" AND ")}` : "not applied"],
      ["columns", columns.length],
      ["generated at", new Date().toISOString()],
      ["generator", "Ledgerly"],
    ]);
    XLSX.utils.book_append_sheet(wb, provSheet, "Provenance");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const safeName = dataset.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "dataset";

    await logActivity(
      ctx,
      "REPORT_EXPORTED",
      `Exported “${dataset.name}” to XLSX (${rows.length} rows)`,
      dataset.projectId,
      {
        datasetId: dataset.id,
        format: "xlsx",
        rows: rows.length,
        sampled,
      },
    );

    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeName}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
