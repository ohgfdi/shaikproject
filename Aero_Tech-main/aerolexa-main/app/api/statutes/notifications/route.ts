import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { prismaStatutesRepository } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

/** The ingestion inbox: what the authority feeds delivered, newest first. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const sp = new URL(request.url).searchParams;
    const status = sp.get("status");
    const limitRaw = Number(sp.get("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
    const repo = await prismaStatutesRepository();
    return ok({
      notifications: await repo.listNotifications(ctx.workspace.id, { status: status ?? undefined, limit }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
