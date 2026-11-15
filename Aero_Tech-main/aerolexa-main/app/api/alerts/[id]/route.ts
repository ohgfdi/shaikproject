import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { evaluateDataAlert } from "@/lib/server/alerts";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Update an alert (enable/disable, channels, cooldown). Rule edits recreate the alert. */
export async function PATCH(request: Request, props: Params) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    const alert = await prisma.dataAlert.findUnique({ where: { id } });
    if (!alert || alert.workspaceId !== ctx.workspace.id) {
      throw new ConnectorError("Alert not found.", { status: 404, code: "CONNECTOR_NOT_FOUND" });
    }
    const body = await readJsonBody<{
      enabled?: boolean;
      notifyEmail?: boolean;
      notifyWhatsapp?: boolean;
      cooldownMinutes?: number;
      name?: string;
    }>(request);

    const updated = await prisma.dataAlert.update({
      where: { id },
      data: {
        enabled: body.enabled ?? alert.enabled,
        notifyEmail: body.notifyEmail ?? alert.notifyEmail,
        notifyWhatsapp: body.notifyWhatsapp ?? alert.notifyWhatsapp,
        cooldownMinutes:
          body.cooldownMinutes !== undefined
            ? Math.max(5, Math.min(10_080, Math.floor(body.cooldownMinutes)))
            : alert.cooldownMinutes,
        name: body.name?.trim() ? body.name.trim().slice(0, 140) : alert.name,
      },
    });
    return ok({ alert: { id: updated.id, enabled: updated.enabled } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: Params) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    const alert = await prisma.dataAlert.findUnique({ where: { id } });
    if (!alert || alert.workspaceId !== ctx.workspace.id) {
      throw new ConnectorError("Alert not found.", { status: 404, code: "CONNECTOR_NOT_FOUND" });
    }
    await prisma.dataAlert.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Manual "run now": evaluates the rule immediately (real engine, real rows). */
export async function POST(_request: Request, props: Params) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    const alert = await prisma.dataAlert.findUnique({ where: { id } });
    if (!alert || alert.workspaceId !== ctx.workspace.id) {
      throw new ConnectorError("Alert not found.", { status: 404, code: "CONNECTOR_NOT_FOUND" });
    }
    const result = await evaluateDataAlert(id);
    return ok({
      outcome: result.outcome,
      notified: result.notified,
      message: result.verdict?.message ?? null,
      value: result.verdict?.value ?? null,
      evidence: result.verdict?.evidence ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
