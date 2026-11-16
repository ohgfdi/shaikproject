// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - model version management is a deployment-wide aggregate operation
import { promises as fs } from "node:fs";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { modelArtifactPath } from "@/lib/server/artifacts";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) return ok({ deleted: false });
    await requireRowRole(ctx, model, "EDITOR");

    await prisma.modelVersion.delete({ where: { id: model.id } });
    fs.rm(modelArtifactPath(model.id)).catch(() => undefined);
    await logActivity(ctx, "ARTIFACT_DELETED", `Model “${model.name}” v${model.version} deleted`, model.projectId, {
      modelId: model.id,
    });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
