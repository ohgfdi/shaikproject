/**
 * Phase 10: Feature Flags Framework
 *
 * Provides a gradual rollout mechanism for new features.
 * Flags are stored in the database (FeatureFlag model) and checked
 * at runtime to enable/disable features per user/workspace/org.
 *
 * Usage:
 *   import { isEnabled } from "@/lib/feature-flags";
 *
 *   if (isEnabled("new_dashboard_ui", workspaceId, userId)) {
 *     // show new UI
 *   }
 */
import { prisma } from "./db";

export type FlagScope = "user" | "workspace" | "organization" | "global";

/** Check if a feature flag is enabled for the given scope. */
export async function isEnabled(
  key: string,
  scopeId?: string,
  scope?: FlagScope,
): Promise<boolean> {
  const flag = await prisma.featureFlag.findFirst({
    where: {
      key,
      ...(scopeId && scope && {
        [`${scope}Id`]: scopeId,
      }),
    },
  });

  if (!flag) {
    // Default: feature disabled if no flag exists
    return false;
  }

  if (!flag.enabled) {
    return false;
  }

  // Check rollout percentage
  if (flag.rollout < 100) {
    // Simple hash-based rollout for deterministic per-user enabling
    if (scopeId) {
      const hash = hashString(`${scopeId}:${key}`);
      const percentage = (hash % 100) + 1;
      if (percentage > flag.rollout) {
        return false;
      }
    }
  }

  return true;
}

/** Hash a string to a deterministic integer 0-99. */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100;
}

/** Get the current rollout percentage for a flag. */
export async function getRollout(key: string): Promise<number> {
  const flag = await prisma.featureFlag.findFirst({
    where: { key },
    select: { rollout: true },
  });

  if (!flag) return 0;
  return flag.rollout;
}

/** Set the rollout percentage for a flag (admin only). */
export async function setRollout(key: string, rollout: number): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key },
    update: { rollout },
    create: { key, rollout, enabled: false },
  });
}

/** Enable a feature flag. */
export async function enable(key: string, opts: { scopeId?: string; scope?: FlagScope; rollout?: number } = {}): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key },
    update: { enabled: true, rollout: opts.rollout },
    create: { key, enabled: true, rollout: opts.rollout ?? 100 },
  });
}

/** Disable a feature flag. */
export async function disable(key: string): Promise<void> {
  await prisma.featureFlag.update({
    where: { key },
    data: { enabled: false },
  });
}

/** Get all flags and their status. */
export async function getAllFlags(): Promise<Array<{ key: string; enabled: boolean; rollout: number }>> {
  const flags = await prisma.featureFlag.findMany();
  return flags.map((f) => ({
    key: f.key,
    enabled: f.enabled,
    rollout: f.rollout,
  }));
}