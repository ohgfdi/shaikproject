/**
 * Statute & rule registry API integration tests — the full request pipeline
 * (auth → route → real SQLite scratch DB → Prisma repository), no mocks.
 *
 * These are the tests that prove the persistence layer the unit suite cannot:
 * the migration creates the four tables, a published version is READ BACK by
 * the as-on resolver, publishing CLOSES the window it replaces (so a past date
 * still resolves the old rule), and rows are workspace-scoped.
 */
import request from "supertest";

import { RULE_CATALOG } from "@/lib/engine/statutes";

const BASE = "http://127.0.0.1:3210";
const agent = () => {
  // Unique X-Forwarded-For per agent — see app.test.ts for the rationale.
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.7.9.${++agentSeq}`);
  return a;
};
let agentSeq = 0;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

let userA: ReturnType<typeof agent>;
let userB: ReturnType<typeof agent>;
let cessV1Id = "";

function cessInput(effectiveFrom: string, rate: number, summary: string) {
  return {
    ruleKey: "cess",
    applicability: { ay: "2025-26", entityTypes: [], states: [], scope: "central" },
    unit: "bps",
    rows: [{ upTo: null, rate }],
    valueSummary: summary,
    citation: effectiveFrom >= "2026-04-01" ? "Finance Act 2026" : "Finance Act 2025",
    effectiveFrom,
    effectiveTo: null,
  };
}

beforeAll(async () => {
  userA = agent();
  userB = agent();
  await userA
    .post("/api/auth/signup")
    .send({ name: "Registry A", email: `st-${Date.now()}@test.dev`, password: "Testpass123" });
  await userA.post("/api/onboarding").send({ profileRole: "Chartered Accountant", goals: ["compliance"] });
  await userB
    .post("/api/auth/signup")
    .send({ name: "Registry B", email: `st-b-${Date.now()}@test.dev`, password: "Testpass123" });
  await userB.post("/api/onboarding").send({ profileRole: "Chartered Accountant", goals: ["compliance"] });
});

describe("statute registry API", () => {
  it("requires authentication", async () => {
    const res = await request(BASE).get("/api/statutes");
    expect(res.status).toBe(401);
  });

  it("reports every catalogue slot, and every one as unresolved before seeding", async () => {
    const res = await userA.get("/api/statutes?asOn=2025-06-15&ay=2025-26");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const registry = res.body.data.registry;
    expect(registry.entries).toHaveLength(RULE_CATALOG.length);
    expect(registry.summary.rulesUnresolved).toBe(RULE_CATALOG.length);
    expect(registry.summary.rulesInForce).toBe(0);
    expect(registry.asOn).toBe("2025-06-15");
    // A solo workspace owns itself, so it may author the registry.
    expect(res.body.data.canAuthor).toBe(true);
    // Nothing is registered — the API must not invent a statutory value.
    const cess = registry.entries.find((e: { key: string }) => e.key === "cess");
    expect(cess.inForce).toBeNull();
    expect(cess.unresolved).toBe(true);
  });

  it("seeds the built-in AY 2025-26 defaults, idempotently", async () => {
    const first = await userA.post("/api/statutes/seed");
    expect(first.status).toBe(200);
    expect(first.body.data.result.published).toBeGreaterThan(0);
    expect(first.body.data.result.skipped).toBe(0);

    const second = await userA.post("/api/statutes/seed");
    expect(second.body.data.result.published).toBe(0);
    expect(second.body.data.result.skipped).toBe(first.body.data.result.published);
  });

  it("resolves the in-force version for the seeded rules", async () => {
    const res = await userA.get("/api/statutes/rules?ruleKey=cess");
    expect(res.status).toBe(200);
    const versions = res.body.data.versions;
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe("published");
    expect(versions[0].unit).toBe("bps");
    expect(versions[0].rows).toEqual([{ upTo: null, rate: 400 }]);
    expect(versions[0].effectiveFrom).toMatch(ISO);
    cessV1Id = versions[0].id;

    const resolved = await userA.get("/api/statutes/rules/resolve?ruleKey=cess&asOn=2025-06-15&ay=2025-26");
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.resolution.version.id).toBe(cessV1Id);
    expect(resolved.body.data.resolution.version.version).toBe(1);
  });

  it("returns no resolution — never a guessed value — for an unregistered slot or date", async () => {
    // A due-date window has no built-in default: nothing is in force.
    const roc = await userA.get("/api/statutes/rules/resolve?ruleKey=roc-aoc4-due-days&asOn=2025-06-15&ay=2025-26");
    expect(roc.status).toBe(200);
    expect(roc.body.data.resolution).toBeNull();

    // A date before the rule existed.
    const early = await userA.get("/api/statutes/rules/resolve?ruleKey=cess&asOn=2024-01-01&ay=2024-25");
    expect(early.body.data.resolution).toBeNull();
  });

  it("validates the resolution query", async () => {
    expect((await userA.get("/api/statutes/rules/resolve?asOn=2025-06-15")).status).toBe(400);
    expect((await userA.get("/api/statutes/rules/resolve?ruleKey=cess")).status).toBe(400);
  });

  it("publishes a later version and CLOSES the window it replaces", async () => {
    const res = await userA.post("/api/statutes/rules").send(cessInput("2026-04-01", 500, "Cess 5%"));
    expect(res.status).toBe(200);
    expect(res.body.data.version.version).toBe(2);
    expect(res.body.data.version.effectiveTo).toBeNull();
    expect(res.body.data.closed).toHaveLength(1);
    expect(res.body.data.closed[0].id).toBe(cessV1Id);
    expect(res.body.data.closed[0].effectiveTo).toBe("2026-04-01");
    // History is closed, not deleted: v1 remains published.
    expect(res.body.data.closed[0].status).toBe("published");

    // A 2025 filing still resolves what was in force in 2025.
    const past = await userA.get("/api/statutes/rules/resolve?ruleKey=cess&asOn=2025-06-15&ay=2025-26");
    expect(past.body.data.resolution.version.id).toBe(cessV1Id);
    expect(past.body.data.resolution.version.rows).toEqual([{ upTo: null, rate: 400 }]);

    const now = await userA.get("/api/statutes/rules/resolve?ruleKey=cess&asOn=2026-05-01&ay=2025-26");
    expect(now.body.data.resolution.version.version).toBe(2);
    expect(now.body.data.resolution.version.rows).toEqual([{ upTo: null, rate: 500 }]);
  });

  it("refuses a same-date and a back-dated version", async () => {
    const sameDate = await userA.post("/api/statutes/rules").send(cessInput("2026-04-01", 600, "Cess 6%"));
    expect(sameDate.status).toBe(409);
    expect(sameDate.body.error.code).toBe("STATUTES_CONFLICT");

    const backDated = await userA.post("/api/statutes/rules").send(cessInput("2025-01-01", 300, "Cess 3%"));
    expect(backDated.status).toBe(409);
  });

  it("rejects an unknown catalogue slot and a malformed effective date", async () => {
    const unknown = await userA
      .post("/api/statutes/rules")
      .send({ ...cessInput("2026-04-01", 400, "x"), ruleKey: "not-a-rule" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("STATUTES_INPUT");

    const badDate = await userA.post("/api/statutes/rules").send(cessInput("2026/04/01", 400, "x"));
    expect(badDate.status).toBeGreaterThanOrEqual(400);
  });

  it("registers a source, validates it, and refuses ingestion while it is disabled", async () => {
    const bad = await userA.post("/api/statutes/sources").send({
      key: "bad-source",
      name: "Bad",
      authority: "cbdt",
      url: "not-a-url",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("STATUTES_INPUT");

    const badAuthority = await userA.post("/api/statutes/sources").send({
      key: "bad-authority",
      name: "Bad",
      authority: "hmrc",
      url: "https://example.test/feed.json",
    });
    expect(badAuthority.status).toBe(400);

    const created = await userA.post("/api/statutes/sources").send({
      key: "test-feed",
      name: "Test authority feed",
      authority: "cbdt",
      url: "https://example.test/notifications.json",
      active: false,
    });
    expect(created.status).toBe(200);
    expect(created.body.data.source.key).toBe("test-feed");
    expect(created.body.data.source.active).toBe(false);

    const list = await userA.get("/api/statutes/sources");
    expect(list.body.data.sources.map((s: { key: string }) => s.key)).toContain("test-feed");

    // Disabled sources are refused BEFORE any outbound fetch happens.
    const disabled = await userA.post("/api/statutes/ingest").send({ sourceId: created.body.data.source.id });
    expect(disabled.status).toBe(400);
    expect(disabled.body.error.message).toMatch(/disabled/i);

    const missing = await userA.post("/api/statutes/ingest").send({ sourceId: "does-not-exist" });
    expect(missing.status).toBe(404);
  });

  it("404s a draft request for an unknown notification", async () => {
    const res = await userA.post("/api/statutes/notifications/nope/draft").send({ ay: "2025-26" });
    expect(res.status).toBe(404);
  });

  it("reports the seeded registry and the inbox in the overview", async () => {
    const res = await userA.get("/api/statutes?asOn=2025-06-15&ay=2025-26");
    const registry = res.body.data.registry;
    const cess = registry.entries.find((e: { key: string }) => e.key === "cess");
    expect(cess.unresolved).toBe(false);
    expect(cess.inForce.valueSummary).toBeTruthy();
    expect(cess.inForce.citation).toBeTruthy();
    expect(cess.versions).toBe(2);
    expect(registry.summary.rulesInForce).toBeGreaterThan(0);
    expect(registry.summary.sourcesActive).toBe(0); // the only source is disabled
    expect(registry.notifications).toEqual([]);
  });

  it("keeps one workspace's registry out of another's", async () => {
    const res = await userB.get("/api/statutes?asOn=2025-06-15&ay=2025-26");
    expect(res.status).toBe(200);
    const registry = res.body.data.registry;
    expect(registry.summary.rulesInForce).toBe(0);
    expect(registry.summary.rulesUnresolved).toBe(RULE_CATALOG.length);
    expect(registry.sources).toEqual([]);
    expect((await userB.get("/api/statutes/rules?ruleKey=cess")).body.data.versions).toEqual([]);
    expect(
      (await userB.get("/api/statutes/rules/resolve?ruleKey=cess&asOn=2025-06-15&ay=2025-26")).body.data.resolution,
    ).toBeNull();
  });
});
