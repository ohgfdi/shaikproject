import { requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/server/api";
import { buildPortabilityBundle } from "@/lib/server/portability";

/**
 * GET /api/me/export — the DPDP right to access & portability.
 *
 * Returns a machine-readable JSON bundle of every row tied to the
 * authenticated data principal, as a downloadable attachment.
 *
 * This serves `buildPortabilityBundle` rather than `exportUserData` from
 * `lib/server/dpdp.ts`. That older helper returned metadata stubs (id, title,
 * rowCount) where the subject had actually authored content — notebook cells,
 * chat transcripts, report sections, analysis configs — so it was an index of
 * the data, not a copy of it. The bundle also carries a manifest recording
 * what was included and, transparently, which credential fields were withheld
 * and why (see lib/server/portability.ts).
 */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const bundle = await buildPortabilityBundle(ctx);

    // Date-stamped filename: a subject requesting access twice should not have
    // to guess which download is the current one.
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ledgerly-data-export-${stamp}.json"`,
        // A data export is the most sensitive response in the product: it must
        // never sit in a shared proxy or browser cache.
        "Cache-Control": "no-store, private",
        Pragma: "no-cache",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
