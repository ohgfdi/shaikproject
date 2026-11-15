/**
 * Assistant enablement.
 *
 * Two independent gates:
 *  1. `ASSISTANT_ENABLED` — the operator kill switch. False denies everyone.
 *  2. per-organization setting — default OFF (`ASSISTANT_ORGANIZATION_DEFAULT_ENABLED`).
 *     A personal book (no organization) is governed only by the kill switch.
 *
 * A missing organization setting is a deny, not an allow. This is the same
 * fail-closed posture as book tenancy.
 */

import type { AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

export interface AssistantEnablement {
  allowed: boolean;
  reason: "ok" | "global_disabled" | "organization_disabled";
  organizationId: string | null;
}

export async function assistantEnablement(ctx: AuthContext): Promise<AssistantEnablement> {
  const env = serverEnv();
  if (!env.ASSISTANT_ENABLED) {
    return { allowed: false, reason: "global_disabled", organizationId: ctx.organization?.id ?? null };
  }
  if (!ctx.organization) {
    // Personal books have no organization switch to consult.
    return { allowed: true, reason: "ok", organizationId: null };
  }
  const setting = await prisma.assistantOrganizationSetting.findUnique({
    where: { organizationId: ctx.organization.id },
    select: { enabled: true },
  });
  const enabled = setting ? setting.enabled : env.ASSISTANT_ORGANIZATION_DEFAULT_ENABLED;
  return {
    allowed: enabled,
    reason: enabled ? "ok" : "organization_disabled",
    organizationId: ctx.organization.id,
  };
}

export async function setAssistantOrganizationEnabled(input: {
  organizationId: string;
  enabled: boolean;
  updatedById: string;
}) {
  return prisma.assistantOrganizationSetting.upsert({
    where: { organizationId: input.organizationId },
    create: {
      organizationId: input.organizationId,
      enabled: input.enabled,
      updatedById: input.updatedById,
    },
    update: { enabled: input.enabled, updatedById: input.updatedById },
  });
}

export async function getAssistantOrganizationSetting(organizationId: string) {
  return prisma.assistantOrganizationSetting.findUnique({ where: { organizationId } });
}
