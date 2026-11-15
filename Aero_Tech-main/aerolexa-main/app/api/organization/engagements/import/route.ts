import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { importClientsFromCsv } from "@/lib/server/client-import";

export const dynamic = "force-dynamic";

const schema = z.object({
  csv: z.string().min(1).max(2_000_000),
});

/**
 * POST — import a client list as CSV.
 *
 * Validation is all-or-nothing: if any row is malformed, nothing is written and
 * the response names each bad line. The caller can fix the file and retry.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    return ok(await importClientsFromCsv(ctx, body.csv));
  } catch (err) {
    return toErrorResponse(err);
  }
}
