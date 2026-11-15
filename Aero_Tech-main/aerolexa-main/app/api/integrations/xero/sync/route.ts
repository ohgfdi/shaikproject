import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { syncXeroConnector } from "@/lib/server/xero-oauth";

export const dynamic = "force-dynamic";

const schema = z.object({ connectorId: z.string().min(1) });

/**
 * Exercise a stored Xero connection and persist the rotated refresh token.
 * Wired into the connectors screen and usable by a scheduled caller; without
 * the persistence step the second sync would authenticate with a dead token.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    return ok({ sync: await syncXeroConnector(ctx, body.connectorId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
