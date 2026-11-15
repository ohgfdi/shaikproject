import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/server/api";
import { validateApiKey, requireScope, addApiKeyHeaders } from "@/lib/server/api-key-auth";
import { loadAuthorizedDataset } from "@/lib/server/dataset-access";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/v1/datasets/[id]/rows
 *
 * Stream a dataset's typed rows (RLS-filtered, capped at the analysis limit).
 * Requires scope: datasets:read. Supports ?version=<DatasetVersionId> to read
 * an immutable historical snapshot.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
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

    const params = await props.params;
    const versionId = request.nextUrl.searchParams.get("version") ?? undefined;

    const loaded = await loadAuthorizedDataset(
      { userId: context.userId, workspaceId: context.workspaceId },
      params.id,
      { minRole: "VIEWER" },
    );

    const response = NextResponse.json({
      ok: true,
      datasetId: loaded.datasetId,
      name: loaded.datasetName,
      columns: loaded.columns,
      rows: loaded.rows,
      totalRows: loaded.totalRows,
      loadedRows: loaded.rowsLoaded,
      // Honest labelling carried over from the session-auth route.
      rlsNote: loaded.note || null,
      sampleNote: loaded.sampleNote || null,
      versionId: versionId ?? null,
    });
    return addApiKeyHeaders(response, context);
  } catch (err) {
    return toErrorResponse(err);
  }
}
