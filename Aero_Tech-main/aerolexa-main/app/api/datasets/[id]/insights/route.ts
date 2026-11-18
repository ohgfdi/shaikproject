// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - insights generation is a deployment-wide aggregate operation, no per-tenant context needed
import { requireAuth } from "@/lib/auth/guard";
import { narrateInsights } from "@/lib/copilot/narrative";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { scanDatasetForInsights } from "@/lib/engine/insights";
import { serverEnv } from "@/lib/env";
import { parseJsonArray, stringifyJson } from "@/lib/json";
import { getAvailableLLMProvider } from "@/lib/llm/providers";
import { logActivity, notify } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { ColumnDef, InsightInput } from "@/lib/types";

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await withTenantDb(ctx, (_db) =>
    prisma.dataset.findUnique({ where: { id: params.id } }),
  );
    await requireRowRole(ctx, dataset, "EDITOR");

    const columns = parseJsonArray<ColumnDef>(dataset!.columns, []);
    // RLS: insight cards must be derived only from rows this caller may see,
    // otherwise a restricted user's scan leaks aggregate signals about rows
    // they cannot read.
    const raw = await loadParsedDataset(dataset!.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const rls = await applyRowSecurity(ctx, dataset!, { rows: raw.rows, columns });
    const rows = rls.rows;
    const totalRows = raw.totalRows;
    const warnings = parseJsonArray<string>(dataset!.qualityWarnings, []);

    const candidates = scanDatasetForInsights({
      columns,
      rows,
      totalRows,
      datasetId: dataset!.id,
      datasetName: dataset!.name,
      datasetWarnings: warnings,
      sampled: totalRows > rows.length,
    });

    // Skip cards already generated for this dataset (title match) — avoid noise.
    const existing = await withTenantDb(ctx, (_db) =>
      prisma.insight.findMany({
        where: { datasetId: dataset!.id },
        select: { title: true },
      }),
  );
    const seen = new Set(existing.map((i) => i.title));
    const fresh = candidates.filter((c) => !seen.has(c.title));

    const created: InsightInput[] = [];
    const severity = (s: string): InsightInput["severity"] => (s === "critical" || s === "warning" ? s : "info");
    const confidence = (c: string): InsightInput["confidence"] =>
      c === "calculated" || c === "inferred" || c === "recommendation" ? c : "calculated";

    // Roadmap A2 — optional LLM narration. Narration is ENHANCEMENT only:
    // every candidate is narrated against its own computed evidence and the
    // numeric guard withholds any narrative that introduces a number. When no
    // model is configured the deterministic cards ship unchanged.
    let provider: Awaited<ReturnType<typeof getAvailableLLMProvider>> = null;
    try {
      provider = await getAvailableLLMProvider();
    } catch {
      provider = null;
    }
    const narrations = await narrateInsights(provider, fresh.slice(0, 10));

    for (const [index, insight] of fresh.slice(0, 10).entries()) {
      const narration = narrations.get(index);
      const extra: Record<string, unknown> = { ...(insight.extra ?? {}) };
      if (narration) extra.narrative = narration;

      const row = await withTenantDb(ctx, (_db) =>
      prisma.insight.create({
        data: {
          workspaceId: ctx.workspace.id,
          projectId: dataset!.projectId,
          datasetId: dataset!.id,
          title: insight.title,
          severity: severity(insight.severity),
          metric: insight.metric,
          observedChange: insight.observedChange,
          evidence: stringifyJson(insight.evidence),
          possibleCause: insight.possibleCause,
          businessImplication: insight.businessImplication,
          recommendedNextStep: insight.recommendedNextStep,
          confidence: confidence(insight.confidence),
          extra: Object.keys(extra).length > 0 ? stringifyJson(extra) : null,
        },
      }),
  );
      created.push({
        title: row.title,
        severity: severity(row.severity),
        metric: row.metric ?? undefined,
        observedChange: row.observedChange ?? undefined,
        evidence: parseJsonArray<string>(row.evidence, []),
        possibleCause: row.possibleCause ?? undefined,
        businessImplication: row.businessImplication ?? undefined,
        recommendedNextStep: row.recommendedNextStep ?? undefined,
        confidence: confidence(row.confidence),
      });
    }

    await logActivity(
      ctx,
      "INSIGHTS_GENERATED",
      `Generated ${created.length} insight card${created.length === 1 ? "" : "s"} for “${dataset!.name}”`,
      dataset!.projectId,
      { datasetId: dataset!.id },
    );
    if (created.length > 0) {
      // A2 — the digest notification says WHAT MOVED, citing the computed
      // evidence lines (real numbers, engine-authored — narration is extra).
      const first = created[0]!;
      await notify(ctx.user.id, {
        type: created.some((i) => i.severity === "critical" || i.severity === "warning") ? "anomaly" : "analysis",
        title: created.some((i) => i.severity === "critical")
          ? "Possible issue detected in your data"
          : "Insights generated",
        message: `${first.title} — ${first.evidence[0] ?? first.observedChange ?? "evidence attached"}${
          created.length > 1 ? ` (+${created.length - 1} more card${created.length === 2 ? "" : "s"})` : ""
        }`,
      });
    }
    return ok({ created: created.length, duplicate: candidates.length - created.length, insights: created });
  } catch (err) {
    return toErrorResponse(err);
  }
}
