/**
 * Deployment profiles — LEDGERLY_PROFILE resolves who the instance is
 * for without touching any per-module flag, and per-module flags keep winning.
 * Env is cached at module level, so each scenario re-imports with
 * jest.resetModules().
 *
 * Both the current LEDGERLY_* spelling and the deprecated AEROLEXA_* alias are
 * exercised here — the alias must keep working so an existing .env does not
 * have to change on upgrade (see resolveBrandEnv in lib/env.ts).
 */

export {};

function baseEnv() {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
  process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
  process.env.LEDGERLY_PROFILE = "";
  process.env.LEDGERLY_ENABLED_MODULES = "";
  process.env.AEROLEXA_PROFILE = "";
  process.env.AEROLEXA_ENABLED_MODULES = "";
  for (const flag of [
    "NOTEBOOK_ENABLED",
    "SQL_LAB_ENABLED",
    "TRAINING_ENABLED",
    "WHATIF_ENABLED",
    "CONNECTORS_ENABLED",
    "SCHEDULER_ENABLED",
    "COLLABORATION_ENABLED",
    "SSO_ENABLED",
    "PROMPTS_ENABLED",
    "ADVISOR_ENABLED",
    "LLM_ENABLED",
    "RENDERING_ENABLED",
  ]) {
    process.env[flag] = "";
  }
}

describe("deployment profiles", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv();
  });

  it("default (nothing set) = pro: the analyst toolkit ships unfrozen", async () => {
    const { moduleEnabled, deploymentProfile } = await import("@/lib/server/modules");
    expect(deploymentProfile()).toBe("pro");
    for (const flag of [
      "SQL_LAB_ENABLED",
      "NOTEBOOK_ENABLED",
      "WHATIF_ENABLED",
      "TRAINING_ENABLED",
      "ADVISOR_ENABLED",
      "PROMPTS_ENABLED",
      "LLM_ENABLED",
      "CONNECTORS_ENABLED",
      "SCHEDULER_ENABLED",
    ] as const) {
      expect(moduleEnabled(flag)).toBe(true);
    }
    // Org/IT decisions stay opt-in even under the default profile.
    expect(moduleEnabled("SSO_ENABLED")).toBe(false);
    expect(moduleEnabled("COLLABORATION_ENABLED")).toBe(false);
  });

  it("LEDGERLY_PROFILE=core opts out and freezes the toolkit", async () => {
    process.env.LEDGERLY_PROFILE = "core";
    const { moduleEnabled, deploymentProfile } = await import("@/lib/server/modules");
    expect(deploymentProfile()).toBe("core");
    expect(moduleEnabled("SQL_LAB_ENABLED")).toBe(false);
    expect(moduleEnabled("ADVISOR_ENABLED")).toBe(false);
    expect(moduleEnabled("PROMPTS_ENABLED")).toBe(false);
  });

  it("LEDGERLY_PROFILE=pro unfreezes the analyst toolkit", async () => {
    process.env.LEDGERLY_PROFILE = "pro";
    const mod = (await import("@/lib/server/modules")) as typeof import("@/lib/server/modules");
    expect(mod.deploymentProfile()).toBe("pro");
    for (const flag of [
      "SQL_LAB_ENABLED",
      "NOTEBOOK_ENABLED",
      "WHATIF_ENABLED",
      "CONNECTORS_ENABLED",
      "SCHEDULER_ENABLED",
      "TRAINING_ENABLED",
      "ADVISOR_ENABLED",
      "PROMPTS_ENABLED",
    ] as const) {
      expect(mod.moduleEnabled(flag)).toBe(true);
    }
  });

  it("pro still freezes org/IT decisions: SSO and collaboration", async () => {
    process.env.LEDGERLY_PROFILE = "pro";
    const { moduleEnabled } = await import("@/lib/server/modules");
    expect(moduleEnabled("SSO_ENABLED")).toBe(false);
    expect(moduleEnabled("COLLABORATION_ENABLED")).toBe(false);
  });

  it("LEDGERLY_PROFILE=all unfreezes everything", async () => {
    process.env.LEDGERLY_PROFILE = "all";
    const { moduleEnabled, deploymentProfile } = await import("@/lib/server/modules");
    expect(deploymentProfile()).toBe("all");
    expect(moduleEnabled("SSO_ENABLED")).toBe(true);
    expect(moduleEnabled("COLLABORATION_ENABLED")).toBe(true);
    expect(moduleEnabled("SQL_LAB_ENABLED")).toBe(true);
  });

  it("per-module flags win over the profile (surgical control)", async () => {
    process.env.LEDGERLY_PROFILE = "pro";
    const mod = (await import("@/lib/server/modules")) as typeof import("@/lib/server/modules");
    expect(mod.moduleEnabled("SQL_LAB_ENABLED")).toBe(true);
    // A truthy per-module flag turns a module ON even under the core profile.
    process.env.LEDGERLY_PROFILE = "core";
    process.env.SQL_LAB_ENABLED = "true";
    expect(mod.moduleEnabled("SQL_LAB_ENABLED")).toBe(true);
  });

  it("explicit LEDGERLY_ENABLED_MODULES=all keeps precedence over the profile", async () => {
    process.env.LEDGERLY_ENABLED_MODULES = "all";
    process.env.LEDGERLY_PROFILE = "core";
    const { deploymentProfile, moduleEnabled } = await import("@/lib/server/modules");
    expect(deploymentProfile()).toBe("all");
    expect(moduleEnabled("SSO_ENABLED")).toBe(true);
  });

  it("an explicit module list (not 'all') keeps per-module control = core profile", async () => {
    process.env.LEDGERLY_ENABLED_MODULES = "SQL_LAB_ENABLED";
    const { deploymentProfile } = await import("@/lib/server/modules");
    expect(deploymentProfile()).toBe("core");
  });

  it("requireModule's 503 message advertises the pro profile on core deployments", async () => {
    process.env.LEDGERLY_PROFILE = "core";
    const { requireModule } = await import("@/lib/server/modules");
    try {
      requireModule("SQL_LAB_ENABLED");
      throw new Error("expected MODULE_DISABLED");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("LEDGERLY_PROFILE=pro");
      expect(message).toContain("SQL_LAB_ENABLED=true");
    }
  });

  // --- Rename back-compat: the pre-rename variable names must keep working ---
  // A deployment that never touches its .env after the upgrade must resolve the
  // same profile. Guarded here because deploymentProfile() is the single
  // consumer of these variables.

  it("deprecated AEROLEXA_PROFILE=pro still unfreezes the toolkit", async () => {
    process.env.AEROLEXA_PROFILE = "pro";
    const mod = (await import("@/lib/server/modules")) as typeof import("@/lib/server/modules");
    expect(mod.deploymentProfile()).toBe("pro");
    expect(mod.moduleEnabled("SQL_LAB_ENABLED")).toBe(true);
    expect(mod.moduleEnabled("CONNECTORS_ENABLED")).toBe(true);
  });

  it("deprecated AEROLEXA_ENABLED_MODULES=all still unfreezes everything", async () => {
    process.env.AEROLEXA_ENABLED_MODULES = "all";
    const mod = (await import("@/lib/server/modules")) as typeof import("@/lib/server/modules");
    expect(mod.deploymentProfile()).toBe("all");
    expect(mod.moduleEnabled("SSO_ENABLED")).toBe(true);
  });

  it("the current name wins when both spellings are set", async () => {
    process.env.LEDGERLY_PROFILE = "core";
    process.env.AEROLEXA_PROFILE = "all";
    const { deploymentProfile } = await import("@/lib/server/modules");
    expect(deploymentProfile()).toBe("core");
  });
});
