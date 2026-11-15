import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity, logSecurityEvent, notify } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireProjectRole } from "@/lib/server/members";
import type { ProjectRole } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: ProjectRole[] = ["OWNER", "EDITOR", "VIEWER"];

async function loadProjectMember(projectId: string, userId: string) {
  return prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string; userId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    await requireProjectRole(ctx, project, "OWNER");

    const member = await loadProjectMember(project.id, params.userId);
    if (!member) throw new ApiError(404, "NOT_FOUND", "Team member not found.");
    const body = await readJsonBody<{ role?: string }>(request);
    const role = body.role as ProjectRole;
    if (!ROLES.includes(role) || role === "OWNER") {
      throw new ApiError(400, "VALIDATION", "Role must be EDITOR or VIEWER (OWNER is reserved for the project owner).");
    }
    const updated = await prisma.projectMember.update({
      where: { projectId_userId: { projectId: project.id, userId: member.userId } },
      data: { role },
    });
    await logActivity(
      ctx,
      "MEMBER_UPDATED",
      `${member.user.email}'s role changed to ${role.toLowerCase()} on “${project.name}”`,
      project.id,
      { memberId: updated.id },
    );
    await logSecurityEvent(
      project.workspaceId,
      ctx.user.id,
      "MEMBER_UPDATED",
      `${member.user.email} → ${role} on “${project.name}”`,
      project.id,
    );
    await notify(member.userId, {
      type: "system",
      title: "Project role changed",
      message: `Your role on “${project.name}” is now ${role.toLowerCase()}.`,
    });
    return ok({ role });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string; userId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    await requireProjectRole(ctx, project, "OWNER");
    const member = await loadProjectMember(project.id, params.userId);
    if (!member) throw new ApiError(404, "NOT_FOUND", "Team member not found.");
    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: project.id, userId: member.userId } },
    });
    await logActivity(ctx, "MEMBER_REMOVED", `${member.user.email} removed from “${project.name}”`, project.id, {
      memberId: member.id,
    });
    await logSecurityEvent(
      project.workspaceId,
      ctx.user.id,
      "MEMBER_REMOVED",
      `${member.user.email} removed from “${project.name}”`,
      project.id,
    );
    await notify(member.userId, {
      type: "system",
      title: "Removed from project",
      message: `You were removed from “${project.name}”.`,
    });
    return ok({ removed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
