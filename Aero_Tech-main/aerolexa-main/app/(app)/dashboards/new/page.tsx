import { redirect } from "next/navigation";

import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";

export const metadata = { title: "New dashboard" };

export default async function NewDashboardPage(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const projectId = searchParams.project;
  const project = projectId
    ? await prisma.project.findUnique({ where: { id: projectId } })
    : await prisma.project.findFirst({ where: { workspaceId: ctx.workspace.id }, orderBy: { updatedAt: "desc" } });
  if (!project || project.workspaceId !== ctx.workspace.id) redirect("/projects");

  const dashboard = await prisma.dashboard.create({
    data: {
      workspaceId: ctx.workspace.id,
      projectId: project.id,
      title: `${project.name} · Dashboard`,
      widgets: stringifyJson([]),
      createdById: ctx.user.id,
    },
  });
  await logActivity(ctx, "DASHBOARD_CREATED", `Dashboard “${dashboard.title}” created`, project.id, {
    dashboardId: dashboard.id,
  });
  redirect(`/dashboards/${dashboard.id}?edit=1`);
}
