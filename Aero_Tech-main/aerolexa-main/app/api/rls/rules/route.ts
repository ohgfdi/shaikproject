// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - RLS rule management is a deployment-wide aggregate operation
import { z } from "zod";

import { forbiddenError, notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { loadRlsRules, saveRlsRules, type StoredRlsRule } from "@/lib/server/rls";

export const dynamic = "force-dynamic";

const ruleSchema = z.object({
  role: z.enum(["OWNER", "EDITOR", "VIEWER"]),
  datasetId: z.string().min(1),
  column: z.string().min(1).max(200),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(500),
});

const putSchema = z.object({ rules: z.array(ruleSchema).max(100) });

/** GET /api/rls/rules — list rules + the datasets/columns they can target. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const rules = await loadRlsRules(ctx.workspace.id);

    const datasets = await prisma.dataset.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, columns: true },
    });

    return ok({
      rules,
      datasets: datasets.map((d) => ({
        id: d.id,
        name: d.name,
        columns: d.columns
          ? (JSON.parse(d.columns as string) as { name: string; type: string }[]).map((c) => c.name)
          : [],
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PUT /api/rls/rules — replace the whole rule set (workspace OWNER only). */
export async function PUT(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = putSchema.parse(await readJsonBody(request));

    // OWNER-only: an EDITOR could otherwise grant themselves full access.
    // In this data model requireAuth already guarantees the workspace belongs
    // to the caller (1:1 workspace↔user), so the check is a redirect-free
    // assertion: workspace.user.id must be the session user.
    const ws = await prisma.workspace.findUnique({
      where: { id: ctx.workspace.id },
      select: { user: { select: { id: true } } },
    });
    if (!ws) throw notFoundError("Workspace not found.");
    if (ws.user?.id !== ctx.user.id) throw forbiddenError("Only the workspace owner can manage RLS rules.");

    // Validate every rule against a real dataset + real column (no silent typos).
    const datasets = await prisma.dataset.findMany({
      where: { workspaceId: ctx.workspace.id },
      select: { id: true, name: true, columns: true },
    });
    const byId = new Map(datasets.map((d) => [d.id, d]));
    const stored: StoredRlsRule[] = [];
    for (const r of body.rules) {
      const d = byId.get(r.datasetId);
      if (!d) throw notFoundError(`RLS rule references dataset ${r.datasetId} which does not exist in this workspace.`);
      const cols = d.columns
        ? (JSON.parse(d.columns as string) as { name: string; type: string }[]).map((c) => c.name)
        : [];
      if (!cols.includes(r.column)) {
        throw forbiddenError(`Column “${r.column}” does not exist on dataset “${d.name}”.`);
      }
      stored.push({
        id: `rls_${r.role}_${r.datasetId}_${r.column}`.replace(/[^a-zA-Z0-9_]/g, "_"),
        role: r.role,
        datasetId: r.datasetId,
        datasetName: d.name,
        column: r.column,
        values: r.values,
      });
    }

    await saveRlsRules(ctx.workspace.id, stored);
    await logActivity(ctx, "RLS_RULES_UPDATED", `Row-level security rules updated (${stored.length} rule(s))`, null, {
      count: stored.length,
    });
    return ok({ rules: stored });
  } catch (err) {
    return toErrorResponse(err);
  }
}
