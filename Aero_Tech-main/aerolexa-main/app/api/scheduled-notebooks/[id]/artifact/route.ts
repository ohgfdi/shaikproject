import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { toErrorResponse } from "@/lib/server/api";
import { readExportHtml } from "@/lib/server/artifacts";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledNotebook.findUnique({ where: { id: params.id } });
    if (!schedule) throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    await requireRowRole(ctx, schedule, "VIEWER");

    if (!schedule.lastRunOutputUrl) {
      return new Response("No artifact available for this run.", { status: 404 });
    }

    const html = await readExportHtml(schedule.lastRunOutputUrl);
    if (!html) return new Response("Artifact not found.", { status: 404 });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
