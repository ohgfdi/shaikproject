import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { parseJson, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { withTenantDb } from "@/lib/server/tenant-db";
import { defaultDashboardWidgets } from "@/lib/templates";
import type { AnalysisResult, DashboardWidget, InsightCard } from "@/lib/types";

const schema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(2).max(200),
  description: z.string().max(500).optional(),
  seed: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const project = await withTenantDb(ctx, (db) => db.project.findUnique({ where: { id: body.projectId } }));
    await requireRowRole(ctx, project, "EDITOR");

    let widgets: DashboardWidget[] = [];
    if (body.seed) {
      const [dataset, analyses, insights] = await withTenantDb(ctx, (db) =>
        Promise.all([
          db.dataset.findFirst({
            where: { workspaceId: ctx.workspace.id, projectId: project!.id },
            orderBy: { createdAt: "desc" },
          }),
          db.analysis.findMany({
            where: { workspaceId: ctx.workspace.id, projectId: project!.id },
            orderBy: { createdAt: "desc" },
            take: 6,
          }),
          db.insight.findMany({
            where: { workspaceId: ctx.workspace.id, projectId: project!.id },
            orderBy: { createdAt: "desc" },
            take: 6,
          }),
        ]),
      );
      widgets = defaultDashboardWidgets({
        dataset,
        analyses: analyses.map((a) => ({
          id: a.id,
          title: a.title,
          kind: a.kind,
          result: parseJson<AnalysisResult | null>(a.result, null),
        })),
        insights: insights.map((i) => parseJson<InsightCard>(JSON.stringify(i), null as unknown as InsightCard)),
      });
    }

    const dashboard = await withTenantDb(ctx, (db) =>
      db.dashboard.create({
        data: {
          workspaceId: ctx.workspace.id,
          projectId: project!.id,
          title: body.title,
          description: body.description ?? null,
          widgets: stringifyJson(widgets),
          createdById: ctx.user.id,
        },
      }),
    );
    await logActivity(ctx, "DASHBOARD_CREATED", `Dashboard “${dashboard.title}” created`, project!.id, {
      dashboardId: dashboard.id,
    });
    return ok({ dashboard: { id: dashboard.id } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
