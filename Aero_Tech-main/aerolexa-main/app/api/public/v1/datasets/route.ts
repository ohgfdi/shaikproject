import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { validateApiKey, requireScope, addApiKeyHeaders } from "@/lib/server/api-key-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/v1/datasets
 *
 * List datasets accessible via API key.
 * Requires scope: datasets:read
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await validateApiKey(request);
    if (auth instanceof NextResponse) return auth;

    const { context } = auth;

    if (!requireScope(context, "datasets:read")) {
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "Scope 'datasets:read' required" } },
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

    const datasets = await prisma.dataset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        rowCount: true,
        columnCount: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
    });

    let nextCursor: string | null = null;
    if (datasets.length > limit) {
      const next = datasets.pop()!;
      nextCursor = next.id;
    }

    const response = ok({
      datasets,
      nextCursor,
      limit,
    });

    return addApiKeyHeaders(response, context);
  } catch (err) {
    return toErrorResponse(err);
  }
}
