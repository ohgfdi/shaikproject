import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity, logSecurityEvent, notify } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { listProjectMembers, requireProjectRole } from "@/lib/server/members";
import type { ProjectRole } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: ProjectRole[] = ["OWNER", "EDITOR", "VIEWER"];

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    const myRole = await requireProjectRole(ctx, project, "VIEWER");
    if (!project) return ok({ members: [], myRole: "VIEWER" });
    const members = await listProjectMembers(project);
    return ok({
      members: members.map((m) =>
        myRole === "OWNER" || m.userId === ctx.user.id
          ? m
          : { userId: m.userId, name: m.name, email: null, role: m.role, isOwner: m.isOwner, addedAt: m.addedAt },
      ),
      myRole,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    await requireProjectRole(ctx, project, "OWNER");

    const body = await readJsonBody<{ email?: string; role?: string }>(request);
    const email = (body.email ?? "").trim().toLowerCase();
    const role = (body.role ?? "EDITOR") as ProjectRole;
    if (!email) throw new ApiError(400, "VALIDATION", "Enter the member's email address.");
    if (!ROLES.includes(role) || role === "OWNER") {
      throw new ApiError(400, "VALIDATION", "Role must be EDITOR or VIEWER (OWNER is reserved for the project owner).");
    }
    const invited = await prisma.user.findUnique({ where: { email } });
    if (!invited) {
      throw new ApiError(
        400,
        "NOT_FOUND",
        `No Ledgerly account exists for “${email}”. The invited user needs an account first.`,
      );
    }
    if (invited.id === project.ownerId) {
      throw new ApiError(400, "VALIDATION", "The project owner is already a member with the OWNER role.");
    }
    const existing = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: invited.id } },
    });
    if (existing) {
      throw new ApiError(400, "VALIDATION", "That user is already on the project team.");
    }

    const member = await prisma.projectMember.create({
      data: { projectId: project.id, userId: invited.id, role },
    });
    await logActivity(
      ctx,
      "MEMBER_ADDED",
      `${invited.name} (${email}) added as ${role.toLowerCase()} to “${project.name}”`,
      project.id,
      {
        memberId: member.id,
      },
    );
    // Audit + notify both sides.
    await logSecurityEvent(
      project.workspaceId,
      ctx.user.id,
      "MEMBER_ADDED",
      `${invited.email} was added as ${role} to project “${project.name}” by ${ctx.user.email}`,
      project.id,
    );
    await notify(invited.id, {
      type: "system",
      title: "You were added to a project",
      message: `${ctx.user.name} added you to “${project.name}” as ${role.toLowerCase()}.`,
    });
    return ok({
      member: {
        userId: invited.id,
        name: invited.name,
        email: invited.email,
        role,
        isOwner: false,
        addedAt: member.createdAt.toISOString(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
