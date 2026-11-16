import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";

/**
 * tenancy-audit: global-operator — analysis route fetches/updates/deletes a
 * single analysis for the workspace. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { title } = z.object({ title: z.string().min(1).max(200) }).parse(await readJsonBody(request));
    const analysis = await withTenantDb(ctx, (db) =>
    prisma.analysis.findUnique({ where: { id: params.id } }),
  );
    await requireRowRole(ctx, analysis, "EDITOR");
    await withTenantDb(ctx, (db) =>
    db.analysis.update({ where: { id: analysis!.id }, data: { title } }),
  );
    return ok({ id: analysis!.id, title });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const analysis = await withTenantDb(ctx, (db) =>
    prisma.analysis.findUnique({ where: { id: params.id } }),
  );
    await requireRowRole(ctx, analysis, "EDITOR");
    await prisma.$transaction([
      withTenantDb(ctx, (db) => db.insight.deleteMany({ where: { analysisId: analysis!.id } })),
    withTenantDb(ctx, (db) => db.analysis.delete({ where: { id: analysis!.id } }),
  );    ]);
    await logActivity(ctx, "ARTIFACT_DELETED", `Analysis deleted`, analysis!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
