/**
 * Per-client live-filing promotion.
 *
 * The gateway can be live deployment-wide while every client still deserves a
 * shadow period. This module owns that decision per engagement:
 *
 *   shadow — submit is refused with FILING_SHADOW_ONLY; the shadow preview still
 *            works, so the firm can see exactly what would be sent.
 *   live   — submission is allowed.
 *
 * The gate is enforced only when FILING_ROLLOUT_ENFORCED=true. That is
 * deliberate: adding the table must not silently change an existing
 * deployment's behaviour. Once enforced, shadow is the default for every
 * engagement, including ones with no row yet.
 *
 * Queries run through withTenantDb() so the filing tables can be protected by
 * PostgreSQL RLS once the rest of the query layer is wrapped.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { filingProviderKind } from "@/lib/engine/filing/gateway";
import type { ProviderKind } from "@/lib/engine/filing/types";
import { requireEngagementRole } from "@/lib/server/engagement";
import { withTenantDb } from "@/lib/server/tenant-db";

export type FilingRolloutMode = "shadow" | "live";

export interface FilingRolloutView {
  engagementId: string;
  mode: FilingRolloutMode;
  enforced: boolean;
  note: string | null;
  promotedAt: string | null;
  promotedBy: string | null;
}

export function rolloutEnforced(): boolean {
  return process.env.FILING_ROLLOUT_ENFORCED === "true";
}

export function normalizeMode(value: string | null | undefined): FilingRolloutMode {
  return value === "live" ? "live" : "shadow";
}

export interface SubmissionGate {
  allowed: boolean;
  mode: FilingRolloutMode;
  code: "FILING_SHADOW_ONLY" | null;
  reason: string | null;
}

/**
 * Pure submission gate. Simulation/reference providers are never blocked: they
 * transmit nothing, and blocking them would make the demo and tests unable to
 * exercise the pipeline. Only a live provider plus a shadow client blocks.
 */
export function evaluateFilingSubmission(input: {
  enforced: boolean;
  storedMode: string | null | undefined;
  provider: ProviderKind;
}): SubmissionGate {
  const mode = normalizeMode(input.storedMode);
  if (!input.enforced || input.provider !== "live" || mode === "live") {
    return { allowed: true, mode, code: null, reason: null };
  }
  return {
    allowed: false,
    mode,
    code: "FILING_SHADOW_ONLY",
    reason:
      "This client is in shadow mode, so nothing was transmitted. Review the shadow plan, then promote the client to live filing in its engagement settings before submitting.",
  };
}

export async function getFilingRollout(ctx: AuthContext, engagementId: string): Promise<FilingRolloutView> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
  }
  const row = await withTenantDb(ctx, (db) =>
    db.filingRollout.findUnique({
      where: { engagementId },
      select: {
        engagementId: true,
        organizationId: true,
        mode: true,
        note: true,
        promotedAt: true,
        promotedById: true,
      },
    }),
  );
  const owned = row && row.organizationId === organizationId ? row : null;
  return {
    engagementId,
    mode: normalizeMode(owned?.mode),
    enforced: rolloutEnforced(),
    note: owned?.note ?? null,
    promotedAt: owned?.promotedAt ? owned.promotedAt.toISOString() : null,
    promotedBy: owned?.promotedById ?? null,
  };
}

/** Promote or demote one client. The call is auditable: who, when, why. */
export async function setFilingRollout(
  ctx: AuthContext,
  engagementId: string,
  input: { mode: FilingRolloutMode; note?: string | null },
): Promise<FilingRolloutView> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!ctx.organization || ctx.organization.id !== engagement.organizationId) {
    throw new ApiError(403, "FORBIDDEN", "This client belongs to a different organization.");
  }

  const now = new Date();
  const row = await withTenantDb(ctx, (db) =>
    db.filingRollout.upsert({
      where: { engagementId: engagement.id },
      create: {
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        mode: input.mode,
        note: input.note ?? null,
        promotedAt: input.mode === "live" ? now : null,
        promotedById: input.mode === "live" ? ctx.user.id : null,
      },
      update: {
        mode: input.mode,
        note: input.note ?? null,
        promotedAt: input.mode === "live" ? now : null,
        promotedById: input.mode === "live" ? ctx.user.id : null,
      },
    }),
  );

  return {
    engagementId: row.engagementId,
    mode: normalizeMode(row.mode),
    enforced: rolloutEnforced(),
    note: row.note,
    promotedAt: row.promotedAt ? row.promotedAt.toISOString() : null,
    promotedBy: row.promotedById,
  };
}

/** All explicit rollout rows for the firm, newest first. */
export async function listFilingRollouts(ctx: AuthContext): Promise<{
  defaultMode: FilingRolloutMode;
  enforced: boolean;
  rollouts: FilingRolloutView[];
}> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
  }
  const rows = await withTenantDb(ctx, (db) =>
    db.filingRollout.findMany({
      where: { organizationId },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
  );
  return {
    defaultMode: "shadow",
    enforced: rolloutEnforced(),
    rollouts: rows.map((row) => ({
      engagementId: row.engagementId,
      mode: normalizeMode(row.mode),
      enforced: rolloutEnforced(),
      note: row.note,
      promotedAt: row.promotedAt ? row.promotedAt.toISOString() : null,
      promotedBy: row.promotedById,
    })),
  };
}

/** Enforced immediately before a live submission leaves the building. */
export async function assertFilingSubmissionAllowed(ctx: AuthContext, engagementId: string): Promise<void> {
  if (!rolloutEnforced() || filingProviderKind() !== "live") return;
  const row = await withTenantDb(ctx, (db) =>
    db.filingRollout.findUnique({
      where: { engagementId },
      select: { mode: true },
    }),
  );
  const gate = evaluateFilingSubmission({
    enforced: true,
    storedMode: row?.mode,
    provider: "live",
  });
  if (!gate.allowed && gate.code && gate.reason) {
    throw new ApiError(409, gate.code, gate.reason);
  }
}
