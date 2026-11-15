import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { validateApiKey, requireScope, addApiKeyHeaders } from "@/lib/server/api-key-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/v1/reports
 *
 * List reports accessible via API key.
 * Requires scope: reports:read
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await validateApiKey(request);
    if (auth instanceof NextResponse) return auth;

    const { context } = auth;

    if (!requireScope(context, "reports:read")) {
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "Scope 'reports:read' required" } },
        { status: 403 },
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get("projectId");
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);
    const cursor = searchParams.get("cursor");

    const where: Record<string, unknown> = {
      workspaceId: context.workspaceId,
    };
    if (projectId) where.projectId = projectId;

    const reports = await prisma.report.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        version: true,
        accessMode: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    let nextCursor: string | null = null;
    if (reports.length > limit) {
      const next = reports.pop()!;
      nextCursor = next.id;
    }

    const response = ok({
      reports,
      nextCursor,
      limit,
    });

    return addApiKeyHeaders(response, context);
  } catch (err) {
    return toErrorResponse(err);
  }
}
