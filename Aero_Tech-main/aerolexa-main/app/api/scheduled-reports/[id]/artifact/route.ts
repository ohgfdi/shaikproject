import { NextResponse } from "next/server";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { readExportHtml } from "@/lib/server/artifacts";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledReport.findUnique({ where: { id: params.id } });
    if (!schedule || schedule.workspaceId !== ctx.workspace.id) {
      throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    }
    if (!schedule.lastRunOutputUrl) {
      throw new ApiError(404, "NOT_FOUND", "No run output yet — run the schedule first.");
    }
    const html = await readExportHtml(schedule.lastRunOutputUrl);
    if (!html) throw new ApiError(404, "NOT_FOUND", "The run output is missing on disk.");
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="${schedule.lastRunOutputUrl}"`,
      },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ ok: false, error: { code: err.code, message: err.message } }, { status: err.status });
    }
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "An unexpected error occurred." } },
      { status: 500 },
    );
  }
}
