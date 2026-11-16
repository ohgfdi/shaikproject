import { NextResponse } from "next/server";
import { z } from "zod";

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - dataset versions listing/comparison is a deployment-wide aggregate operation
import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import type { VersionChangeLog } from "@/lib/engine/versioning";
import { parseJson } from "@/lib/json";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/** GET /api/datasets/:id/versions — list snapshot versions (newest first). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, dataset, "VIEWER");
    const [versions, versionCount] = await Promise.all([
      prisma.datasetVersion.findMany({
        where: { datasetId: dataset!.id },
        orderBy: { version: "desc" },
        take: 50,
        select: {
          id: true,
          version: true,
          label: true,
          source: true,
          rowCount: true,
          columnCount: true,
          changeLog: true,
          previousVersionId: true,
          createdAt: true,
        },
      }),
      prisma.datasetVersion.count({ where: { datasetId: dataset!.id } }),
    ]);
    const rows = versions.map((v) => ({
      id: v.id,
      version: v.version,
      label: v.label,
      source: v.source,
      rowCount: v.rowCount,
      columnCount: v.columnCount,
      changeLog: parseJson<VersionChangeLog | null>(v.changeLog, null),
      previousVersionId: v.previousVersionId,
      createdAt: v.createdAt.toISOString(),
    }));
    return ok({
      versions: rows,
      currentVersion: rows[0] ?? null,
      live: { versionCount },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const diffSchema = z.object({
  fromVersionId: z.string().min(1),
  toVersionId: z.string().min(1),
});

function storedChangeLog(raw: string | null): VersionChangeLog | null {
  return parseJson<VersionChangeLog | null>(raw, null);
}

/** POST /api/datasets/:id/versions — compare two dataset snapshots. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = diffSchema.parse(await readJsonBody(request));
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, dataset, "VIEWER");
    const [from, to] = await Promise.all([
      prisma.datasetVersion.findFirst({ where: { id: body.fromVersionId, datasetId: dataset!.id } }),
      prisma.datasetVersion.findFirst({ where: { id: body.toVersionId, datasetId: dataset!.id } }),
    ]);
    if (!from || !to) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "One of the versions does not belong to this dataset." } },
        { status: 404 },
      );
    }
    const fromLog = storedChangeLog(from.changeLog);
    return ok({
      diff: {
        from: { id: from.id, version: from.version, rowCount: from.rowCount },
        to: { id: to.id, version: to.version, rowCount: to.rowCount },
        rowsAdded: fromLog?.rowsAdded ?? 0,
        rowsRemoved: fromLog?.rowsRemoved ?? 0,
        note: fromLog?.note ?? null,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
