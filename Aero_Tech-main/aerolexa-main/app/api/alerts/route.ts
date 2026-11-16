import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

/**
 * tenancy-audit: global-operator — data alerts API lists workspace-wide
 * alerts for the firm. This is a deployment-wide aggregate rather than a
 * per-tenant query.
 */
import { isAlertRuleConfig } from "@/lib/engine/alerts";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/** List this workspace's data alerts. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const alerts = await prisma.dataAlert.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
      include: { dataset: { select: { name: true } } },
      take: 200,
    });
    return ok({
      alerts: alerts.map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        datasetId: a.datasetId,
        datasetName: a.dataset.name,
        ruleKind: a.ruleKind,
        ruleConfig: JSON.parse(a.ruleConfig || "{}") as unknown,
        columnName: a.columnName,
        severity: a.severity,
        cooldownMinutes: a.cooldownMinutes,
        lastOutcome: a.lastOutcome,
        lastFiredAt: a.lastFiredAt,
        lastValue: a.lastValue,
        lastMessage: a.lastMessage,
        notifyEmail: a.notifyEmail,
        notifyWhatsapp: a.notifyWhatsapp,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Create a data alert (rule config validated against the engine's shape). */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      name?: string;
      datasetId?: string;
      ruleKind?: string;
      ruleConfig?: unknown;
      columnName?: string;
      severity?: string;
      cooldownMinutes?: number;
      notifyEmail?: boolean;
      notifyWhatsapp?: boolean;
    }>(request);

    const name = (body.name ?? "").trim();
    if (!name || name.length > 140) {
      throw new ConnectorError("Give the alert a name (max 140 characters).");
    }
    if (!body.datasetId) throw new ConnectorError("Choose the dataset this alert watches.");
    const dataset = await prisma.dataset.findUnique({
      where: { id: body.datasetId },
      select: { id: true, workspaceId: true, columns: true },
    });
    if (!dataset || dataset.workspaceId !== ctx.workspace.id) {
      throw new ConnectorError("The dataset was not found in this workspace.", {
        status: 404,
        code: "CONNECTOR_NOT_FOUND",
      });
    }

    const ruleKind = body.ruleKind ?? "";
    if (!["threshold", "anomaly", "staleness"].includes(ruleKind)) {
      throw new ConnectorError("Unknown alert rule kind.");
    }
    const ruleConfig = body.ruleConfig ?? {};
    if (!isAlertRuleConfig(ruleConfig)) {
      throw new ConnectorError(
        "The alert rule is invalid. How to fix: for threshold rules provide aggregate/operator/value; for anomaly, aggregate/windowPoints (4–90); for staleness, maxAgeHours > 0.",
      );
    }
    const kind = ruleConfig.kind;

    // Column must exist on the dataset for non-staleness rules.
    let columnName: string | null = null;
    if (kind !== "staleness") {
      columnName = (body.columnName ?? "").trim() || null;
      if (!columnName) throw new ConnectorError("Choose the column this alert watches.");
      const columns = JSON.parse(dataset.columns || "[]") as { name: string }[];
      if (!columns.some((c) => c.name === columnName)) {
        throw new ConnectorError(`Column “${columnName}” does not exist on this dataset.`);
      }
    }

    const severity = ["info", "warning", "critical"].includes(body.severity ?? "")
      ? (body.severity as string)
      : kind === "anomaly"
        ? "warning"
        : "warning";

    const alert = await prisma.dataAlert.create({
      data: {
        workspaceId: ctx.workspace.id,
        datasetId: dataset.id,
        createdById: ctx.user.id,
        name,
        ruleKind: kind,
        ruleConfig: JSON.stringify(ruleConfig),
        columnName,
        severity,
        cooldownMinutes: Math.max(5, Math.min(10_080, Math.floor(body.cooldownMinutes ?? 240))),
        notifyEmail: body.notifyEmail ?? true,
        notifyWhatsapp: body.notifyWhatsapp ?? false,
      },
    });

    await logActivity(ctx, "CONNECTOR_CREATED", `Created data alert “${name}”`, null, {
      alertId: alert.id,
      datasetId: dataset.id,
    });

    return ok({ alert: { id: alert.id, name: alert.name } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
