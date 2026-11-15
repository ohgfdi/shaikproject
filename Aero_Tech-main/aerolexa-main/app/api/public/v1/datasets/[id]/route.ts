import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { validateApiKey, requireScope, addApiKeyHeaders } from "@/lib/server/api-key-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/v1/datasets/[id]
 *
 * Get a single dataset by ID.
 * Requires scope: datasets:read
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        rowCount: true,
        columnCount: true,
        status: true,
        columns: true,
        preview: true,
        profile: true,
        qualityWarnings: true,
        workspaceId: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
    });

    if (!dataset || dataset.workspaceId !== context.workspaceId) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Dataset not found" } },
        { status: 404 },
      );
    }

    const response = ok({
      dataset: {
        ...dataset,
        columns: JSON.parse(dataset.columns || "[]"),
        preview: dataset.preview ? JSON.parse(dataset.preview) : null,
        profile: dataset.profile ? JSON.parse(dataset.profile) : null,
        qualityWarnings: dataset.qualityWarnings ? JSON.parse(dataset.qualityWarnings) : [],
      },
    });

    return addApiKeyHeaders(response, context);
  } catch (err) {
    return toErrorResponse(err);
  }
}
