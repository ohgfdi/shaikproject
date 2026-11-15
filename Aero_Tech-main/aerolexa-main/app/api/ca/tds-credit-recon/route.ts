import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import {
  parseTdsStatement,
  reconcileTdsCredits,
  TdsReconError,
  type TdsSource,
} from "@/lib/engine/tds-credit-recon";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

const MAX_TEXT = 2_000_000;

/**
 * POST /api/ca/tds-credit-recon — reconcile a 26AS/AIS export against the books.
 *
 * Both sides are supplied as text: the statement export (CSV or JSON, pasted or
 * read client-side) and the books extract in the same header-compatible format.
 * Nothing is persisted — this is client tax data, and the reconciliation is
 * reproducible from the two exports.
 */
export async function POST(request: Request) {
  try {
    await requireAuth();

    const body = z
      .object({
        statementText: z.string().min(1).max(MAX_TEXT),
        statementSource: z.enum(["26AS", "AIS", "TRACES"]).optional().default("26AS"),
        booksText: z.string().max(MAX_TEXT),
        /** Rupee tolerance for an exact TDS match (default ₹1). */
        tolerance: z.number().finite().min(0).max(100_000).optional(),
      })
      .parse(await readJsonBody(request));

    const statement = parseTdsStatement(body.statementText, body.statementSource as TdsSource);
    const books = parseTdsStatement(body.booksText, "books");
    const reconciliation = reconcileTdsCredits({
      statement: statement.rows,
      books: books.rows,
      tolerance: body.tolerance !== undefined ? Math.round(body.tolerance * 100) : undefined,
    });

    return ok({
      reconciliation,
      statement: { count: statement.rows.length, warnings: statement.warnings },
      books: { count: books.rows.length, warnings: books.warnings },
    });
  } catch (err) {
    if (err instanceof TdsReconError) {
      return toErrorResponse(new ApiError(400, "VALIDATION", err.message));
    }
    return toErrorResponse(err);
  }
}
