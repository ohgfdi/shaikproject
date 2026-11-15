import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getScopedConnector, syncRunView } from "@/lib/server/connectors";

export const dynamic = "force-dynamic";

/** Sync-run history for this connector (versioned pulls, newest first). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    const runs = await prisma.connectorSyncRun.findMany({
      where: { connectorId: connector.id },
      include: { dataset: { select: { name: true } } },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return ok({ runs: runs.map(syncRunView) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
