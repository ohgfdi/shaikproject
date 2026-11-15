import { requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { runHypothesisTest, type HypothesisInput } from "@/lib/engine/hypothesis";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");
    const body = await readJsonBody<HypothesisInput>(request);
    const result = runHypothesisTest(body);
    return ok({ result, dataset: { id: dataset.id, name: dataset.name } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
