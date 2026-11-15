import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { modelArtifactPath } from "@/lib/server/artifacts";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Model not found." } },
        { status: 404 },
      );
    }
    await requireRowRole(ctx, model, "VIEWER");
    const file = modelArtifactPath(model.id);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "The model artifact is missing on disk." } },
        { status: 404 },
      );
    }
    await logActivity(
      ctx,
      "MODEL_TRAINED",
      `Model “${model.name}” v${model.version} artifact downloaded`,
      model.projectId,
      { modelId: model.id },
    );
    return new NextResponse(raw, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="model-${model.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${model.version}-prototype.json"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
