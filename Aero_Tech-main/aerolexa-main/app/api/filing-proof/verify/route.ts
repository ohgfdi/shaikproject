import { verifyFilingProofBundle } from "@/lib/server/filing-proof-verify";

export const dynamic = "force-dynamic";

/** Cap the request before parsing: a proof bundle is small JSON. */
const MAX_BODY_CHARS = 200_000;

/**
 * Verify a filing proof bundle without authentication.
 *
 * The point of the endpoint is that an auditor or client can check the evidence
 * without a Ledgerly account: it is pure computation over the document they
 * already hold, and it never reads a database row. It therefore cannot leak
 * another firm's data — the caller must supply the bundle.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length === 0) {
    return Response.json({ error: "Send the proof bundle as JSON." }, { status: 400 });
  }
  if (raw.length > MAX_BODY_CHARS) {
    return Response.json(
      { error: `Proof bundles must be ${Math.round(MAX_BODY_CHARS / 1000)} KB or smaller.` },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "The request body is not valid JSON." }, { status: 400 });
  }

  const result = verifyFilingProofBundle(body);
  return Response.json(result, {
    status: result.ok ? 200 : 422,
    headers: { "cache-control": "no-store" },
  });
}
