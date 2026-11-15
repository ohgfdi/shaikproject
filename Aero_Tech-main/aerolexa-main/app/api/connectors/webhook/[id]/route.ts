import { prisma } from "@/lib/db";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { verifyConnectorWebhookSignature } from "@/lib/server/alerts";
import { ok, toErrorResponse } from "@/lib/server/api";
import { runConnectorSync } from "@/lib/server/connector-sync";

export const dynamic = "force-dynamic";

/**
 * Inbound connector webhook (push-based refresh).
 *
 * A source system (or a bridge like Zapier/Make watching a Shopify topic)
 * calls this endpoint to say "data changed — pull now". Authentication is a
 * per-connector HMAC: the caller signs the RAW request body with its secret
 * and sends `X-Ledgerly-Signature: sha256=<hex>`. Wrong/missing signature
 * answers 401 without revealing whether the connector id exists.
 *
 * Response is the honest outcome of the sync it triggered.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const rawBody = await request.text();
    // Both header spellings accepted: `x-ledgerly-signature` is current, but a
    // partner endpoint configured before the rename still sends the old name,
    // and silently 401-ing those would break a live integration on upgrade.
    const signature = request.headers.get("x-ledgerly-signature") ?? request.headers.get("x-aerolexa-signature");
    const connector = await prisma.connector.findUnique({ where: { id } });

    // Uniform 401 for unknown connector AND bad signature (no oracle).
    if (!connector || !connector.webhookSecret) {
      throw new ConnectorError("Invalid webhook credentials.", { status: 401, code: "CONNECTOR_AUTH" });
    }
    if (!verifyConnectorWebhookSignature(rawBody, signature, connector.webhookSecret)) {
      throw new ConnectorError("Invalid webhook signature.", { status: 401, code: "CONNECTOR_AUTH" });
    }

    const datasets = await prisma.dataset.findMany({
      where: { connectorId: id },
      select: { id: true },
      take: 20,
    });
    if (datasets.length === 0) {
      return ok({ ok: true, synced: 0, message: "No connector-backed datasets to refresh." });
    }

    const results: { datasetId: string; status: string; rowCount?: number; error?: string }[] = [];
    for (const dataset of datasets) {
      const outcome = await runConnectorSync(id, dataset.id, "manual");
      results.push({
        datasetId: dataset.id,
        status: outcome.status,
        rowCount: outcome.rowCount,
        error: outcome.error,
      });
    }
    const okCount = results.filter((r) => r.status === "SUCCESS").length;
    return ok({ ok: true, synced: okCount, total: results.length, results });
  } catch (err) {
    return toErrorResponse(err);
  }
}
