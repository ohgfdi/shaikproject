/**
 * HTTP integration tests for engagement governance.
 *
 * Runs against the real Next.js server booted by __tests__/api/global-setup.cjs
 * (fresh scratch SQLite DB + migrations applied). Unlike the unit suite — which
 * calls the server modules directly — these drive the actual route handlers, so
 * a broken import, a mis-typed params contract or a wrong status code fails here.
 */
import request from "supertest";

const BASE = "http://127.0.0.1:3210";

let agentSeq = 0;
const agent = () => {
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.9.0.${++agentSeq}`);
  return a;
};

describe("engagement governance API", () => {
  const user = agent();
  let engagementId = "";

  it("signs up, creates the firm and a client engagement", async () => {
    const email = `gov-${Date.now()}@test.dev`;
    const signup = await user.post("/api/auth/signup").send({ name: "Gov Tester", email, password: "Testpass123" });
    expect(signup.status).toBe(200);

    const org = await user.post("/api/organization").send({ name: "HTTP Test Firm" });
    expect(org.status).toBe(201);
    expect(org.body.data.organization.role).toBe("OWNER");

    const engagement = await user.post("/api/organization/engagements").send({ name: "Acme FY26", code: "ACME-FY26" });
    expect(engagement.status).toBe(201);
    engagementId = engagement.body.data.engagement.id;
    expect(engagementId).toBeTruthy();
  });

  it("401s for anonymous callers before any data is read", async () => {
    const res = await request(BASE).get(`/api/organization/engagements/${engagementId}/data-posture`);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("reports the jurisdiction-aware retention posture (India default)", async () => {
    const res = await user.get(`/api/organization/engagements/${engagementId}/data-posture`);
    expect(res.status).toBe(200);
    expect(res.body.data.jurisdiction).toBe("IN");
    expect(res.body.data.retention.floorDays).toBeGreaterThan(0);
    expect(res.body.data.retention.legalHold).toBe(false);
  });

  it("lists caller access, resolving the owner as PARTNER", async () => {
    const res = await user.get(`/api/organization/engagements/${engagementId}/access`);
    expect(res.status).toBe(200);
    expect(res.body.data.callerRole).toBe("PARTNER");
    expect(res.body.data.assignments.length).toBeGreaterThan(0);
  });

  it("starts with an empty but verifiable ledger", async () => {
    const res = await user.get(`/api/organization/engagements/${engagementId}/ledger`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.valid).toBe(true);
  });

  it("requires a reason before a change request can be submitted", async () => {
    const created = await user
      .post(`/api/organization/engagements/${engagementId}/changes`)
      .send({ title: "Adjust opening balance", targetType: "book" });
    expect(created.status).toBe(201);
    const id = created.body.data.changeRequest.id;
    expect(created.body.data.changeRequest.state).toBe("DRAFT");

    const blocked = await user
      .patch(`/api/organization/engagements/${engagementId}/changes/${id}`)
      .send({ action: "submit" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("RATIONALE_REQUIRED");

    const withReason = await user.post(`/api/organization/engagements/${engagementId}/changes`).send({
      title: "Correct GSTIN",
      rationale: "Mismatch with the registration certificate.",
      targetType: "clientMaster",
    });
    const submitted = await user
      .patch(`/api/organization/engagements/${engagementId}/changes/${withReason.body.data.changeRequest.id}`)
      .send({ action: "submit" });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.changeRequest.state).toBe("REQUESTED");
  });

  it("blocks an export until client consent is on file", async () => {
    const blocked = await user
      .post(`/api/organization/engagements/${engagementId}/export`)
      .send({ reason: "Client asked for their file" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("EXPORT_BLOCKED");

    const consent = await user
      .post(`/api/organization/engagements/${engagementId}/consents`)
      .send({ purpose: "statutory-filing", subjectRef: "Client CFO" });
    expect(consent.status).toBe(201);

    const allowed = await user
      .post(`/api/organization/engagements/${engagementId}/export`)
      .send({ reason: "Client asked for their file" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.scope.redacted).toBe(true);
  });

  it("creates and escalates a working paper through review", async () => {
    const created = await user
      .post(`/api/organization/engagements/${engagementId}/working-papers`)
      .send({ indexRef: "B-200", title: "Substantive testing of receivables", saReference: "SA 500" });
    expect(created.status).toBe(201);
    const wpId = created.body.data.workingPaper.id;
    expect(created.body.data.workingPaper.version).toBe(1);

    const submitted = await user
      .patch(`/api/organization/engagements/${engagementId}/working-papers/${wpId}`)
      .send({ action: "submit" });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.workingPaper.status).toBe("IN_REVIEW");

    // The preparer cannot review their own paper.
    const selfReview = await user
      .patch(`/api/organization/engagements/${engagementId}/working-papers/${wpId}`)
      .send({ action: "review", approved: true });
    expect(selfReview.status).toBe(403);

    const index = await user.get(`/api/organization/engagements/${engagementId}/working-papers`);
    expect(index.status).toBe(200);
    expect(index.body.data.index.entries.find((e: { ref: string }) => e.ref === "B-200").status).toBe("prepared");
  });

  it("records the export and change activity in the ledger, chain intact", async () => {
    const res = await user.get(`/api/organization/engagements/${engagementId}/ledger`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.valid).toBe(true);
    const actions = res.body.data.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["CHANGE_REQUEST_CREATED", "CHANGE_REQUEST_SUBMITTED", "ENGAGEMENT_EXPORTED"]),
    );
  });

  it("refuses erasure while the retention floor is active", async () => {
    const plan = await user.get(`/api/organization/engagements/${engagementId}/erasure`);
    expect(plan.status).toBe(200);
    expect(plan.body.data.eligible).toBe(false);

    const executed = await user
      .put(`/api/organization/engagements/${engagementId}/erasure`)
      .send({ reason: "Client disengaged; remove the data.", confirm: "ACME-FY26" });
    expect(executed.status).toBe(409);
    expect(executed.body.error.code).toBe("RETENTION_ACTIVE");
  });
});
