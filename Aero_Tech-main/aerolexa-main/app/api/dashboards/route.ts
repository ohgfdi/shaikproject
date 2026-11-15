import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
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
    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    await requireRowRole(ctx, project, "EDITOR");

    let widgets: DashboardWidget[] = [];
    if (body.seed) {
      const dataset = await prisma.dataset.findFirst({
        where: { workspaceId: ctx.workspace.id, projectId: project!.id },
        orderBy: { createdAt: "desc" },
      });
      const analyses = await prisma.analysis.findMany({
        where: { workspaceId: ctx.workspace.id, projectId: project!.id },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      const insights = await prisma.insight.findMany({
        where: { workspaceId: ctx.workspace.id, projectId: project!.id },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
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

    const dashboard = await prisma.dashboard.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: project!.id,
        title: body.title,
        description: body.description ?? null,
        widgets: stringifyJson(widgets),
        createdById: ctx.user.id,
      },
    });
    await logActivity(ctx, "DASHBOARD_CREATED", `Dashboard “${dashboard.title}” created`, project!.id, {
      dashboardId: dashboard.id,
    });
    return ok({ dashboard: { id: dashboard.id } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
