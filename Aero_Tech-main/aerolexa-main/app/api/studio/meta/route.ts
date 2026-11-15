import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset, cellString, cellDate, cellNumber, columnIndex, valueCounts } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { parseJsonArray } from "@/lib/json";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import type { ColumnDef } from "@/lib/types";

const schema = z.object({ datasetId: z.string(), columns: z.array(z.string()).max(10) });

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const dataset = await prisma.dataset.findUnique({ where: { id: body.datasetId } });
    await requireRowRole(ctx, dataset, "VIEWER");
    const defs = parseJsonArray<ColumnDef>(dataset!.columns, []);
    const wanted = defs.filter((c) => body.columns.includes(c.name));

    // RLS: value lists, min/max and date ranges are derived from visible rows.
    const loaded = await loadParsedDataset(dataset!.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const { rows } = await applyRowSecurity(ctx, dataset!, { rows: loaded.rows, columns: defs });
    const out: Record<
      string,
      {
        type: string;
        values: { value: string; count: number }[];
        min?: number;
        max?: number;
        minDate?: string;
        maxDate?: string;
      }
    > = {};
    for (const col of wanted) {
      const idx = columnIndex(defs, col.name);
      if (idx < 0) continue;
      if (col.type === "date") {
        let minD: string | null = null;
        let maxD: string | null = null;
        for (const row of rows) {
          const d = cellDate(row[idx]);
          if (!d) continue;
          const iso = d.toISOString().slice(0, 10);
          if (!minD || iso < minD) minD = iso;
          if (!maxD || iso > maxD) maxD = iso;
        }
        out[col.name] = { type: col.type, values: [], minDate: minD ?? undefined, maxDate: maxD ?? undefined };
      } else if (col.type === "number") {
        let mn = Number.POSITIVE_INFINITY;
        let mx = Number.NEGATIVE_INFINITY;
        for (const row of rows) {
          const n = cellNumber(row[idx]);
          if (!Number.isFinite(n)) continue;
          if (n < mn) mn = n;
          if (n > mx) mx = n;
        }
        out[col.name] = {
          type: col.type,
          values: [],
          min: Number.isFinite(mn) ? mn : undefined,
          max: Number.isFinite(mx) ? mx : undefined,
        };
      } else {
        const counts = valueCounts(
          rows.map((r) => cellString(r[idx])),
          200,
        );
        out[col.name] = { type: col.type, values: counts };
      }
    }
    return ok({ meta: out });
  } catch (err) {
    return toErrorResponse(err);
  }
}
