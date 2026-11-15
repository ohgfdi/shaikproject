/**
 * Frozen-module enforcement — the Phase 3.1 gap this file exists for.
 *
 * `requireModule()` used to be exported, documented and unit-tested while NO
 * route imported it, so a `LEDGERLY_PROFILE=core` deployment hid the nav entry
 * and still served the endpoint. The flag was cosmetic.
 *
 * These tests call the real route handlers. That works without a database
 * because requireModule() runs BEFORE requireAuth()/prisma: on a frozen profile
 * the handler throws MODULE_DISABLED on its first statement, and the
 * `catch → toErrorResponse` turn becomes the 503 we assert on. An un-gated
 * route instead reaches requireAuth() and returns 401 — which is exactly the
 * regression this file is designed to catch.
 *
 * The mirror case matters just as much: under the default pro profile the same
 * handlers must get PAST the gate (and fail later, on auth), proving the gates
 * are not simply always-on.
 */

export {};

function baseEnv(profile: "core" | "pro") {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
  process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
  process.env.LEDGERLY_PROFILE = profile;
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
    "RENDERING_ENABLED",
    "LLM_ENABLED",
  ]) {
    process.env[flag] = "";
  }
}

const props = { params: Promise.resolve({ id: "does-not-matter" }) };

/**
 * Call a route handler and read back its JSON envelope. Request bodies are
 * irrelevant: the gate fires before any body is parsed.
 */
async function call(
  mod: string,
  method: "GET" | "POST" = "POST",
): Promise<{ status: number; code?: string; message?: string }> {
  const route = (await import(mod)) as Record<string, unknown>;
  const handler = route[method] as (r: Request, p: unknown) => Promise<Response>;
  const res = await handler(new Request("http://localhost/api", { method }), props);
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return { status: res.status, code: body.error?.code, message: body.error?.message };
}

describe("frozen modules refuse their API (LEDGERLY_PROFILE=core)", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv("core");
  });

  it("SQL Lab: query and materialize are 503, not a live back door", async () => {
    const query = await call("@/app/api/datasets/[id]/query/route");
    expect(query.status).toBe(503);
    expect(query.code).toBe("MODULE_DISABLED");
    expect(query.message).toContain("SQL_LAB_ENABLED=true");

    const materialize = await call("@/app/api/datasets/[id]/materialize/route");
    expect(materialize.status).toBe(503);
    expect(materialize.code).toBe("MODULE_DISABLED");
  });

  it("What-if: the simulation and both Python exports are 503", async () => {
    for (const mod of [
      "@/app/api/datasets/[id]/whatif/route",
      "@/app/api/datasets/[id]/whatif/export/route",
      "@/app/api/datasets/[id]/whatif/export-python/route",
    ]) {
      const res = await call(mod);
      expect([mod, res.status]).toEqual([mod, 503]);
      expect(res.code).toBe("MODULE_DISABLED");
    }
  });

  it("Advisor: asking a question is 503", async () => {
    const res = await call("@/app/api/advisor/route");
    expect(res.status).toBe(503);
    expect(res.code).toBe("MODULE_DISABLED");
    expect(res.message).toContain("ADVISOR_ENABLED=true");
  });

  it("Prompts: creating a template is 503", async () => {
    const res = await call("@/app/api/prompts/route");
    expect(res.status).toBe(503);
    expect(res.code).toBe("MODULE_DISABLED");
    expect(res.message).toContain("PROMPTS_ENABLED=true");
  });

  it("Notebook: running a cell, versioning and exporting are 503", async () => {
    for (const [mod, method] of [
      ["@/app/api/notebooks/[id]/run/route", "POST"],
      ["@/app/api/notebooks/[id]/versions/route", "POST"],
      ["@/app/api/notebooks/[id]/export/route", "GET"],
      ["@/app/api/notebooks/[id]/ai/route", "POST"],
      ["@/app/api/scheduled-notebooks/route", "POST"],
    ] as const) {
      const res = await call(mod, method);
      expect([mod, res.status]).toEqual([mod, 503]);
      expect(res.code).toBe("MODULE_DISABLED");
    }
  });

  it("the 503 advertises the one-switch remedy", async () => {
    const res = await call("@/app/api/advisor/route");
    expect(res.message).toContain("LEDGERLY_PROFILE=pro");
  });
});

describe("the default pro profile does not block the same routes", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv("pro");
  });

  it("no gated handler returns MODULE_DISABLED", async () => {
    // These requests have no session, so they fail downstream (auth/db) —
    // that is the point. What must NOT happen is a 503: the gate is open, and
    // a gate that was accidentally always-on would fail here.
    for (const mod of [
      "@/app/api/datasets/[id]/query/route",
      "@/app/api/datasets/[id]/whatif/route",
      "@/app/api/advisor/route",
      "@/app/api/prompts/route",
      "@/app/api/notebooks/[id]/run/route",
    ]) {
      const res = await call(mod);
      expect([mod, res.status]).not.toEqual([mod, 503]);
      expect(res.code).not.toBe("MODULE_DISABLED");
    }
  });
});

describe("per-module flags still win over a frozen profile", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv("core");
  });

  it("SQL_LAB_ENABLED=true re-opens SQL Lab under the core profile", async () => {
    process.env.SQL_LAB_ENABLED = "true";
    const res = await call("@/app/api/datasets/[id]/query/route");
    expect(res.status).not.toBe(503);
    expect(res.code).not.toBe("MODULE_DISABLED");
  });

  it("…while What-if stays frozen", async () => {
    process.env.SQL_LAB_ENABLED = "true";
    const res = await call("@/app/api/datasets/[id]/whatif/route");
    expect(res.status).toBe(503);
    expect(res.code).toBe("MODULE_DISABLED");
  });
});
