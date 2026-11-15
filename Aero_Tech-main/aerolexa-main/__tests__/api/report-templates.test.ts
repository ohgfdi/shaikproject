/**
 * HTTP integration tests for firm-wide master report templates.
 *
 * Runs against the real Next.js server booted by __tests__/api/global-setup.cjs
 * (fresh scratch SQLite DB + migrations applied).
 */
import request from "supertest";

const BASE = "http://127.0.0.1:3210";
const TEMPLATE_BODY = JSON.stringify({
  parts: [{ kind: "body", heading: "Balance Sheet", body: "Assets: ^^CLIENT_NAME^^" }],
  precedents: [],
  cover: null,
});

let agentSeq = 0;
const agent = () => {
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.11.0.${++agentSeq}`);
  return a;
};

describe("report-templates API", () => {
  const user = agent();
  let masterId = "";

  it("signs up and creates the firm", async () => {
    const email = `rt-${Date.now()}@test.dev`;
    const signup = await user
      .post("/api/auth/signup")
      .send({ name: "Template Tester", email, password: "Testpass123" });
    expect(signup.status).toBe(200);

    const org = await user.post("/api/organization").send({ name: "Template Test Firm" });
    expect(org.status).toBe(201);
    expect(org.body.data.organization.role).toBe("OWNER");
  });

  it("401s for anonymous callers", async () => {
    const res = await request(BASE).get("/api/organization/settings/report-templates");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("starts with no master templates", async () => {
    const res = await user.get("/api/organization/settings/report-templates");
    expect(res.status).toBe(200);
    expect(res.body.data.masters).toEqual([]);
  });

  it("rejects an invalid formatCode on list", async () => {
    const res = await user.get("/api/organization/settings/report-templates?formatCode=NOPE");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("creates a master template", async () => {
    const res = await user.post("/api/organization/settings/report-templates").send({
      formatCode: "BALANCE_SHEET",
      label: "Firm Balance Sheet — Schedule III",
      body: TEMPLATE_BODY,
      firmName: "Acme & Co",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(201);
    masterId = res.body.data.master.id;
    expect(masterId).toBeTruthy();
    expect(res.body.data.master.firmName).toBe("Acme & Co");
    expect(res.body.data.master.status).toBe("ACTIVE");
  });

  it("rejects a duplicate label for the same format", async () => {
    const res = await user.post("/api/organization/settings/report-templates").send({
      formatCode: "BALANCE_SHEET",
      label: "Firm Balance Sheet — Schedule III",
      body: TEMPLATE_BODY,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE");
  });

  it("requires a non-empty body", async () => {
    const res = await user.post("/api/organization/settings/report-templates").send({
      formatCode: "NOTES",
      label: "Notes master",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("filters masters by formatCode", async () => {
    const matching = await user.get("/api/organization/settings/report-templates?formatCode=BALANCE_SHEET");
    expect(matching.status).toBe(200);
    expect(matching.body.data.masters.length).toBe(1);

    const empty = await user.get("/api/organization/settings/report-templates?formatCode=NOTES");
    expect(empty.status).toBe(200);
    expect(empty.body.data.masters).toEqual([]);
  });

  it("updates a master template", async () => {
    const res = await user.patch("/api/organization/settings/report-templates").send({
      id: masterId,
      firmName: "Acme & Associates",
      description: "Updated master",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.master.firmName).toBe("Acme & Associates");
    expect(res.body.data.master.description).toBe("Updated master");
  });

  it("rejects a patch with no id", async () => {
    const res = await user.patch("/api/organization/settings/report-templates").send({ firmName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("404s a patch for an unknown master", async () => {
    const res = await user
      .patch("/api/organization/settings/report-templates")
      .send({ id: "does-not-exist", firmName: "X" });
    expect(res.status).toBe(404);
  });

  it("rejects a patch that changes nothing", async () => {
    const res = await user.patch("/api/organization/settings/report-templates").send({ id: masterId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("deletes an unused master template", async () => {
    const missing = await user.delete("/api/organization/settings/report-templates");
    expect(missing.status).toBe(400);

    const unknown = await user.delete("/api/organization/settings/report-templates?id=does-not-exist");
    expect(unknown.status).toBe(404);

    const res = await user.delete(`/api/organization/settings/report-templates?id=${masterId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(masterId);

    const after = await user.get("/api/organization/settings/report-templates");
    expect(after.body.data.masters).toEqual([]);
  });
});
