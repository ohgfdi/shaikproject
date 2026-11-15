import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";

export async function GET() {
  try {
    const ctx = await requireAuth();
    const reports = await prisma.report.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { updatedAt: "desc" },
      include: { project: { select: { name: true } } },
      take: 50,
    });
    return ok({
      reports: reports.map((r) => ({
        id: r.id,
        title: r.title,
        projectName: r.project?.name,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
