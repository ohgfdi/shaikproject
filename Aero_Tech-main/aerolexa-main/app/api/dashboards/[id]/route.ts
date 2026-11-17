import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { DashboardWidget, ReportBookmark, ReportTheme } from "@/lib/types";

/**
 * tenancy-audit: global-operator — dashboard route fetches/updates/deletes a
 * dashboard for the workspace. This is a deployment-wide aggregate rather than a
 * per-tenant query.
 */
/**
 * Pages are validated structurally (widgets stay opaque records here — the
 * same policy as the `widgets` column: the renderer tolerates snapshot shape
 * drift, and the authoritative widget contract lives in lib/types.ts).
 */

const pageSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  widgets: z.array(z.record(z.string(), z.unknown())),
  crossFilters: z
    .array(
      z.object({
        column: z.string(),
        values: z.array(z.string()),
        sourceWidgetId: z.string(),
        sourceWidgetTitle: z.string().optional(),
      }),
    )
    .optional(),
});

const schema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  widgets: z.array(z.record(z.string(), z.unknown())).optional(),
  pages: z.array(pageSchema).min(1).max(32).optional(),
  bookmarks: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  theme: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, dashboard, "EDITOR");
    const data: Record<string, unknown> = {};
    if (body.title) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.widgets) data.widgets = stringifyJson(body.widgets as unknown as DashboardWidget[]);
    if (body.pages) data.pages = stringifyJson(body.pages);
    if (body.bookmarks) data.bookmarks = stringifyJson(body.bookmarks as unknown as ReportBookmark[]);
    if (body.theme !== undefined) data.theme = body.theme ? stringifyJson(body.theme as unknown as ReportTheme) : null;
    const updated = await prisma.dashboard.update({ where: { id: dashboard!.id }, data });
    await logActivity(ctx, "DASHBOARD_UPDATED", `Dashboard “${updated.title}” updated`, dashboard!.projectId, {
      dashboardId: dashboard!.id,
    });
    return ok({ id: dashboard!.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, dashboard, "EDITOR");
    await prisma.dashboard.delete({ where: { id: dashboard!.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Dashboard deleted`, dashboard!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
