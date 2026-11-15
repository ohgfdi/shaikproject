/**
 * HTTP integration tests for the engagement deliverable-assembly layer:
 * formats, templates, assembly, client/reviewer rendering, redaction,
 * working-paper traceability and the review→approve→sign-off→issue lifecycle.
 *
 * Runs against the real Next.js server booted by __tests__/api/global-setup.cjs
 * (fresh scratch SQLite DB + migrations applied).
 */
import request from "supertest";

// The first request to each route triggers a Next dev-server compile; give the
// setup test room so a cold compile cannot flake the whole suite.
jest.setTimeout(60000);

const BASE = "http://127.0.0.1:3210";
const TEMPLATE_BODY = JSON.stringify({
  cover: { title: "Balance Sheet of ^^CLIENT_NAME^^", subtitle: "FY 2025-26", docRef: "^^FIRM_NAME^^" },
  parts: [
    { kind: "body", heading: "Balance Sheet", body: "GSTIN of the entity is ^^GSTIN^^." },
    { kind: "note", heading: "Note 1 — Accounting policies", body: "Basis of preparation." },
  ],
  precedents: [],
});

let agentSeq = 0;
const agent = () => {
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.12.0.${++agentSeq}`);
  return a;
};

describe("engagement deliverables API", () => {
  const user = agent();
  let engagementId = "";
  let masterId = "";
  let versionId = "";
  // The revision assembled later in the suite stays in DRAFT, so the
  // traceability contract can be exercised without disturbing the lifecycle.
  let secondVersionId = "";

  it("signs up, creates the firm and an engagement", async () => {
    const email = `del-${Date.now()}@test.dev`;
    const signup = await user
      .post("/api/auth/signup")
      .send({ name: "Deliverable Tester", email, password: "Testpass123" });
    expect(signup.status).toBe(200);

    const org = await user.post("/api/organization").send({ name: "Deliverable Test Firm" });
    expect(org.status).toBe(201);

    const engagement = await user.post("/api/organization/engagements").send({ name: "Acme FY26", code: "ACME-DEL" });
    expect(engagement.status).toBe(201);
    engagementId = engagement.body.data.engagement.id;
    expect(engagementId).toBeTruthy();

    const master = await user.post("/api/organization/settings/report-templates").send({
      formatCode: "BALANCE_SHEET",
      label: "Firm Balance Sheet master",
      body: TEMPLATE_BODY,
      firmName: "Acme & Co",
    });
    expect(master.status).toBe(200);
    masterId = master.body.data.master.id;
  });

  it("401s for anonymous callers", async () => {
    const res = await request(BASE).get(`/api/organization/engagements/${engagementId}/deliverables`);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("starts with no formats or templates", async () => {
    const res = await user.get(`/api/organization/engagements/${engagementId}/deliverables`);
    expect(res.status).toBe(200);
    expect(res.body.data.formats).toEqual([]);
    expect(res.body.data.templates).toEqual([]);
  });

  it("creates an engagement report format", async () => {
    const res = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "create-format",
      code: "BALANCE_SHEET",
      label: "Balance Sheet",
      clauses: { "SA 700": "Opinion" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(201);
    expect(res.body.data.format.code).toBe("BALANCE_SHEET");
  });

  it("rejects a duplicate format", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "create-format", code: "BALANCE_SHEET", label: "Balance Sheet again" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE");
  });

  it("rejects an unknown action", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "teleport" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("creates an engagement template derived from the master", async () => {
    const res = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "create-template",
      formatCode: "BALANCE_SHEET",
      label: "Acme BS FY26",
      body: TEMPLATE_BODY,
      masterRef: masterId,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(201);
    expect(res.body.data.template.masterRef).toBe(masterId);
  });

  it("assembles a deliverable version", async () => {
    const res = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "assemble",
      formatCode: "BALANCE_SHEET",
      placeholders: { CLIENT_NAME: "Acme Industries", GSTIN: "27AAABC1234A1Z5", FIRM_NAME: "Acme & Co" },
      computedBody: "Total assets 1,00,000",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(201);
    expect(res.body.data.contentHash).toMatch(/^d-/);
    const partKinds = res.body.data.parts.map((p: { kind: string }) => p.kind);
    expect(partKinds).toContain("clauses");
    expect(partKinds).toContain("cover");
    versionId = res.body.data.version.id;
    expect(versionId).toBeTruthy();
  });

  it("falls back to an error when no template exists for a format", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "assemble", formatCode: "MGMT_LETTER" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("lists formats, templates and versions", async () => {
    const formats = await user.get(`/api/organization/engagements/${engagementId}/deliverables?kind=formats`);
    expect(formats.status).toBe(200);
    expect(formats.body.data.formats.length).toBe(1);

    const templates = await user.get(`/api/organization/engagements/${engagementId}/deliverables?kind=templates`);
    expect(templates.status).toBe(200);
    expect(templates.body.data.templates.length).toBe(1);

    const versions = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables?kind=versions&formatCode=BALANCE_SHEET`,
    );
    expect(versions.status).toBe(200);
    expect(versions.body.data.versions.length).toBe(1);
    expect(versions.body.data.versions[0].id).toBe(versionId);
  });

  it("rejects an invalid formatCode on versions", async () => {
    const res = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables?kind=versions&formatCode=NOPE`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("renders the client copy with masked identifiers and the reviewer copy in full", async () => {
    const client = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables/${versionId}/render?variant=CLIENT`,
    );
    expect(client.status).toBe(200);
    expect(client.body.data.variant).toBe("CLIENT");
    expect(client.body.data.assembledBody).toContain("Acme Industries");
    expect(client.body.data.assembledBody).not.toContain("27AAABC1234A1Z5");

    const reviewer = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables/${versionId}/render?variant=REVIEWER`,
    );
    expect(reviewer.status).toBe(200);
    expect(reviewer.body.data.assembledBody).toContain("27AAABC1234A1Z5");
  });

  it("adds a redaction rule to the version", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "add-redaction", versionId, policy: "MASKED", appliesTo: "PAN", note: "Firm policy" });
    expect(res.status).toBe(200);
    expect(res.body.data.redaction.policy).toBe("MASKED");
    expect(res.body.data.redaction.effectiveForVariant).toBe("CLIENT");
  });

  it("rejects an invalid redaction policy", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "add-redaction", versionId, policy: "BANANA", appliesTo: "PAN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("routes the version through review, approval, sign-off and issue", async () => {
    const created = await user
      .post(`/api/organization/engagements/${engagementId}/working-papers`)
      .send({ indexRef: "B-200", title: "Substantive testing of receivables", saReference: "SA 500" });
    expect(created.status).toBe(201);

    const trace = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables/${versionId}/working-paper-trace`)
      .send({ workingPaperRefs: ["B-200"] });
    expect(trace.status).toBe(200);
    expect(trace.body.data.traceUpdated).toBe(1);
    expect(trace.body.data.parts[0].indexRef).toBe("B-200");

    const traceRead = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables/${versionId}/working-paper-trace`,
    );
    expect(traceRead.status).toBe(200);
    expect(traceRead.body.data.alreadyTraced.map((t: { indexRef: string }) => t.indexRef)).toContain("B-200");

    const submitted = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "submit-for-review", versionId, reviewNote: "Prepared for partner review." });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.version.status).toBe("IN_REVIEW");

    const approved = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "approve", versionId, note: "Looks good." });
    expect(approved.status).toBe(200);
    expect(approved.body.data.version.status).toBe("REVIEWED");

    const signed = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "sign-off", versionId, signOffRole: "PARTNER" });
    expect(signed.status).toBe(200);
    expect(signed.body.data.version.status).toBe("SIGNED_OFF");
    expect(signed.body.data.version.signOffRole).toBe("PARTNER");

    const issued = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "issue", versionId, issuedFor: "Acme Industries", issuedAtLabel: "1 June 2026" });
    expect(issued.status).toBe(200);
    expect(issued.body.data.version.status).toBe("ISSUED");
    expect(issued.body.data.version.issuedAt).toBeTruthy();
    expect(issued.body.data.version.issuedFor).toBe("Acme Industries");
    expect(issued.body.data.version.udin).toMatch(/^[0-9A-Z]{21}$/);
    expect(issued.body.data.version.udinVerifyCount).toBe(0);
  });

  it("refuses to sign off an already-issued version", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "sign-off", versionId, signOffRole: "PARTNER" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("records the deliverable lifecycle in the ledger, chain intact", async () => {
    const res = await user.get(`/api/organization/engagements/${engagementId}/ledger`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.valid).toBe(true);
    const actions = res.body.data.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "DELIVERABLE_FORMAT_CREATED",
        "DELIVERABLE_TEMPLATE_CREATED",
        "DELIVERABLE_ASSEMBLED",
        "DELIVERABLE_SIGNED_OFF",
      ]),
    );
  });

  it("withdraws a version", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "withdraw", versionId, reason: "Client corrections pending." });
    expect(res.status).toBe(200);
    expect(res.body.data.version.status).toBe("WITHDRAWN");
  });

  it("verifies the issued UDIN and records the verification", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "verify-udin", versionId });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.verifyCount).toBe(1);
    expect(res.body.data.udin).toMatch(/^[0-9A-Z]{21}$/);
  });

  it("assembles a second revision and diffs it against the first", async () => {
    const assembled = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "assemble",
      formatCode: "BALANCE_SHEET",
      placeholders: { CLIENT_NAME: "Acme Industries", FIRM_NAME: "Acme & Co" },
      computedBody: "Total assets 2,00,000",
    });
    expect(assembled.status).toBe(200);
    const rev2 = assembled.body.data.version.id;
    secondVersionId = rev2;

    const diff = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables?kind=diff&fromId=${versionId}&toId=${rev2}`,
    );
    expect(diff.status).toBe(200);
    expect(diff.body.data.diff.fromRevision).toBe(1);
    expect(diff.body.data.diff.toRevision).toBe(2);
    expect(diff.body.data.diff.identical).toBe(false);
    expect(diff.body.data.diff.changed.length).toBeGreaterThan(0);
  });

  it("weaves a structured 44AB certificate into an assembled version", async () => {
    const format = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables`)
      .send({ action: "create-format", code: "CERTIFICATE_44AB", label: "Tax audit u/s 44AB" });
    expect(format.status).toBe(200);

    const template = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "create-template",
      formatCode: "CERTIFICATE_44AB",
      label: "Acme 44AB FY26",
      body: JSON.stringify({ parts: [], precedents: [], cover: null }),
    });
    expect(template.status).toBe(200);

    const res = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "assemble",
      formatCode: "CERTIFICATE_44AB",
      placeholders: {
        FIRM_NAME: "Acme & Co",
        CLIENT_NAME: "Acme Industries",
        ASSESSMENT_YEAR: "2026-27",
        PERIOD_ENDING: "31 March 2026",
      },
      certificate: {
        format: "CERTIFICATE_44AB",
        params: {
          turnoverGross: "2,00,00,000",
          turnoverExempt: "0",
          cashReceipts: "38,00,000",
          bookkeeping: "Electronic",
          auditPerformedBy: "CA A. Partner",
          auditPerformedFrom: "1 April 2025",
          auditPerformedTo: "31 March 2026",
          notes: ["Books of account examined."],
        },
      },
    });
    expect(res.status).toBe(200);
    const kinds = res.body.data.parts.map((p: { kind: string }) => p.kind);
    expect(kinds).toContain("certificate");
  });

  it("traces working papers idempotently and fails closed on unknown references", async () => {
    const created = await user
      .post(`/api/organization/engagements/${engagementId}/working-papers`)
      .send({ indexRef: "B-100", title: "Revenue cut-off testing", saReference: "SA 500" });
    expect(created.status).toBe(201);

    const first = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables/${secondVersionId}/working-paper-trace`)
      .send({ workingPaperRefs: ["B-100"] });
    expect(first.status).toBe(200);
    expect(first.body.data.traceUpdated).toBe(1);
    const refs = (parts: Array<{ indexRef: string }>) => parts.map((p) => p.indexRef);
    expect(refs(first.body.data.parts)).toContain("B-100");

    // A retry is a no-op, not a duplicate part.
    const repeat = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables/${secondVersionId}/working-paper-trace`)
      .send({ workingPaperRefs: ["B-100"] });
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.traceUpdated).toBe(0);
    expect(repeat.body.data.parts).toHaveLength(first.body.data.parts.length);
    expect(refs(repeat.body.data.parts).filter((r) => r === "B-100")).toHaveLength(1);

    // Unknown refs never become pointers to nothing.
    const unknown = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables/${secondVersionId}/working-paper-trace`)
      .send({ workingPaperRefs: ["Z-999"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("VALIDATION");
    expect(unknown.body.error.details.unknownRefs).toEqual(["Z-999"]);

    const read = await user.get(
      `/api/organization/engagements/${engagementId}/deliverables/${secondVersionId}/working-paper-trace`,
    );
    expect(read.status).toBe(200);
    const traced = read.body.data.alreadyTraced.map((t: { indexRef: string }) => t.indexRef);
    expect(traced).toContain("B-100");
    expect(traced.filter((r: string) => r === "B-100")).toHaveLength(1);
  });

  it("refuses to change traceability once the deliverable has left draft", async () => {
    const res = await user
      .post(`/api/organization/engagements/${engagementId}/deliverables/${versionId}/working-paper-trace`)
      .send({ workingPaperRefs: ["B-200"] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_DRAFT");
  });

  it("rejects an unknown certificate format", async () => {
    const res = await user.post(`/api/organization/engagements/${engagementId}/deliverables`).send({
      action: "assemble",
      formatCode: "CERTIFICATE_44AB",
      certificate: { format: "NOPE", params: {} },
    });
    expect(res.status).toBe(400);
  });
});
