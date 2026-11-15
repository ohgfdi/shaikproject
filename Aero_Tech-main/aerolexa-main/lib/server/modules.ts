import { ApiError, getAuth } from "@/lib/auth/guard";
import { resolveBrandEnv, serverEnv } from "@/lib/env";

/**
 * Deployment profiles — who this instance is for, decided by ONE env var.
 *
 * The analyst toolkit (SQL Lab, notebook, what-if, training, advisor,
 * connectors, scheduler, prompts, LLM features) ships unfrozen by default so
 * the app presents its full capability on a cold install (Phase 3.1). A
 * deployment profile still lets an operator narrow it in one switch:
 *
 *   pro       (default) — everything a working analyst needs unfrozen
 *                         (SQL Lab, notebook, what-if, connectors, scheduler,
 *                         training, advisor, prompts, LLM). SSO and chat-room
 *                         collaboration stay frozen (org/IT decisions).
 *   core                — opt-out: core flow only, every extended module frozen.
 *   all                 — every module unfrozen (= legacy "all" master switch).
 *
 * Precedence (first match wins):
 *   1. LEDGERLY_ENABLED_MODULES explicitly set (a single module list or "all")
 *      — per-module flags and lists keep winning, so nothing existing changes.
 *   2. LEDGERLY_PROFILE=<pro|all|core>.
 *   3. Per-module flags as-is; with nothing set the profile is "pro".
 */

export type ModuleFlag =
  | "NOTEBOOK_ENABLED"
  | "SQL_LAB_ENABLED"
  | "TRAINING_ENABLED"
  | "WHATIF_ENABLED"
  | "CONNECTORS_ENABLED"
  | "SCHEDULER_ENABLED"
  | "COLLABORATION_ENABLED"
  | "SSO_ENABLED"
  | "PROMPTS_ENABLED"
  | "ADVISOR_ENABLED"
  | "RENDERING_ENABLED"
  | "LLM_ENABLED"
  | "DISTRIBUTED_ENABLED"
  | "STREAMING_ENABLED"
  | "DEEP_LEARNING_ENABLED"
  | "NLP_ENABLED"
  | "FEATURE_STORE_ENABLED"
  | "REAL_TIME_SERVING_ENABLED"
  | "HTE_ENABLED"
  | "IV_CALCULUS_ENABLED"
  | "GEOSPATIAL_ENABLED";

/** Modules a working analyst needs day-to-day (the "pro" profile). */
export const PRO_MODULES: ModuleFlag[] = [
  "SQL_LAB_ENABLED",
  "NOTEBOOK_ENABLED",
  "WHATIF_ENABLED",
  "CONNECTORS_ENABLED",
  "SCHEDULER_ENABLED",
  "TRAINING_ENABLED",
  "ADVISOR_ENABLED",
  "PROMPTS_ENABLED",
  "LLM_ENABLED",
];

export const ALL_MODULES: ModuleFlag[] = [
  ...PRO_MODULES,
  "COLLABORATION_ENABLED",
  "SSO_ENABLED",
  "RENDERING_ENABLED",
  "DISTRIBUTED_ENABLED",
  "STREAMING_ENABLED",
  "DEEP_LEARNING_ENABLED",
  "NLP_ENABLED",
  "FEATURE_STORE_ENABLED",
  "REAL_TIME_SERVING_ENABLED",
  "HTE_ENABLED",
  "IV_CALCULUS_ENABLED",
  "GEOSPATIAL_ENABLED",
];

export type DeploymentProfile = "core" | "pro" | "all";

export const MODULE_HINTS: Record<ModuleFlag, string> = {
  NOTEBOOK_ENABLED: "NOTEBOOK_ENABLED=true",
  SQL_LAB_ENABLED: "SQL_LAB_ENABLED=true",
  TRAINING_ENABLED: "TRAINING_ENABLED=true",
  WHATIF_ENABLED: "WHATIF_ENABLED=true",
  CONNECTORS_ENABLED: "CONNECTORS_ENABLED=true",
  SCHEDULER_ENABLED: "SCHEDULER_ENABLED=true",
  COLLABORATION_ENABLED: "COLLABORATION_ENABLED=true",
  SSO_ENABLED: "SSO_ENABLED=true",
  PROMPTS_ENABLED: "PROMPTS_ENABLED=true",
  ADVISOR_ENABLED: "ADVISOR_ENABLED=true",
  RENDERING_ENABLED: "RENDERING_ENABLED=true",
  LLM_ENABLED: "LLM_ENABLED=true",
  DISTRIBUTED_ENABLED: "DISTRIBUTED_ENABLED=true",
  STREAMING_ENABLED: "STREAMING_ENABLED=true",
  DEEP_LEARNING_ENABLED: "DEEP_LEARNING_ENABLED=true",
  NLP_ENABLED: "NLP_ENABLED=true",
  FEATURE_STORE_ENABLED: "FEATURE_STORE_ENABLED=true",
  REAL_TIME_SERVING_ENABLED: "REAL_TIME_SERVING_ENABLED=true",
  HTE_ENABLED: "HTE_ENABLED=true",
  IV_CALCULUS_ENABLED: "IV_CALCULUS_ENABLED=true",
  GEOSPATIAL_ENABLED: "GEOSPATIAL_ENABLED=true",
};

/**
 * The active profile. Defaults to "pro" (Phase 3.1: the analyst toolkit is
 * on out of the box); set LEDGERLY_PROFILE=core to freeze it again. An
 * explicit LEDGERLY_ENABLED_MODULES value (any non-empty string other than an
 * unknown profile-like token) means the operator has already spoken — honor
 * it exactly as before and report the profile as "core" (per-module control).
 */
export function deploymentProfile(): DeploymentProfile {
  // Both spellings accepted; the current LEDGERLY_* name wins (see lib/env.ts).
  const { value: modules } = resolveBrandEnv("LEDGERLY_ENABLED_MODULES", "AEROLEXA_ENABLED_MODULES");
  const { value: profile } = resolveBrandEnv("LEDGERLY_PROFILE", "AEROLEXA_PROFILE");
  const mods = modules.trim().toLowerCase();
  const prof = profile.trim().toLowerCase();
  if (mods === "all") return "all";
  if (mods !== "") return "core";
  if (prof === "all") return "all";
  if (prof === "pro") return "pro";
  if (prof === "core") return "core";
  // Nothing set (or an empty profile) — ship the full analyst toolkit.
  return "pro";
}

/** Is this module currently unfrozen? (Profile-aware; per-module flags still win.) */
export function moduleEnabled(flag: ModuleFlag): boolean {
  const env = serverEnv();
  if (env[flag]) return true; // explicit per-module opt-in always wins
  const profile = deploymentProfile();
  if (profile === "all") return true;
  if (profile === "pro") return PRO_MODULES.includes(flag);
  return false;
}

/**
 * API gate: throw a 503 with the remedy when the module is frozen. Call right
 * after (or before) requireAuth — the module check must not leak resource
 * existence, so it comes first.
 */
export function requireModule(flag: ModuleFlag): void {
  if (moduleEnabled(flag)) return;
  const profile = deploymentProfile();
  const profileHint =
    profile === "core"
      ? ` For the full analyst toolkit in one switch, set LEDGERLY_PROFILE=pro (or LEDGERLY_ENABLED_MODULES=all for absolutely everything).`
      : "";
  throw new ApiError(
    503,
    "MODULE_DISABLED",
    `This module is frozen (product focus is the core flow). An operator can unfreeze it with ${MODULE_HINTS[flag]}.${profileHint}`,
  );
}

/**
 * Request-aware module gate.
 *
 * `moduleEnabled()` answers "is this module unfrozen for this deployment?".
 * Admin mode is a per-user override on top of that: an admin gets every
 * module regardless of the deployment profile, and this is the gate the API
 * routes use so a premium endpoint can never 503 an admin while the sidebar
 * offers the same feature. Unauthenticated callers keep the plain
 * deployment answer (no admin), so public routes are unaffected.
 */
export async function moduleEnabledForRequest(flag: ModuleFlag): Promise<boolean> {
  if (moduleEnabled(flag)) return true;
  const ctx = await getAuth();
  return ctx?.isAdmin === true;
}
