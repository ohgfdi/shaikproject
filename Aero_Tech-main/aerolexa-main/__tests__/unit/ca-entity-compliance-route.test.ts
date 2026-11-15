/**
 * Route-level integration for `POST /api/ca/compute` with
 * `kind: "entity-compliance"`. Proves the route reaches the entity-compliance
 * adapter, validates the op, and maps an engine refusal to a 400 (not a 500).
 * Auth is mocked so the handler is called directly (no server, no database).
 */

import { POST } from "@/app/api/ca/compute/route";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1" },
      workspace: { id: "w1" },
      settings: {},
      organization: null,
      organizationRole: null,
    })),
  };
});

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/ca/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

const entity = {
  entityId: "e1",
  legalName: "Acme Ltd",
  cin: "U74999MH2015PTC123456",
  entityType: "private-limited",
  incorporationDate: "2015-06-01",
  registeredOffice: { line1: "1 Main St", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
  objects: ["Trading"],
  capital: { authorised: 10_000, paidUp: 5_000 },
  directors: [
    { name: "A Director", din: "01234567", designation: "director", appointedOn: "2015-06-01" },
    { name: "B Director", din: "07654321", designation: "director", appointedOn: "2016-04-01" },
  ],
  shareholders: [{ name: "A Director", pan: "ABCDE1234F", shareClass: "equity", shares: 5_000 }],
  charges: [],
  auditor: { name: "Audit LLP", appointedOn: "2025-09-30", termEndsOn: "2030-09-30" },
  financialYearEnd: "2026-03-31",
  lastAgmDate: "2026-06-30",
};

describe("POST /api/ca/compute · entity-compliance", () => {
  it("routes an entity-compliance op through the workflow engine", async () => {
    const res = await post({ kind: "entity-compliance", op: "roc-forms", event: "related-party-transaction" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.entityCompliance.map((s: { form: string }) => s.form)).toContain("AOC-2");
  });

  it("validates an entity master through the route", async () => {
    const res = await post({ kind: "entity-compliance", op: "validate-master", entity });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.entityCompliance.valid).toBe(true);
  });

  it("builds a filing calendar with dependencies through the route", async () => {
    const res = await post({
      kind: "entity-compliance",
      op: "filing-calendar",
      entity,
      events: [{ event: "annual-financial-statements", eventDate: "2026-06-30" }],
      asOf: "2026-07-01",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const aoc4 = json.data.entityCompliance.tasks.find((t: { form: string }) => t.form === "AOC-4");
    expect(aoc4.dueDate).toBe("2026-07-30");
    expect(aoc4.blockedBy).toEqual(["ADT-1"]);
  });

  it("maps an engine refusal (unknown form) to a 400", async () => {
    const res = await post({ kind: "entity-compliance", op: "due-date", form: "NOPE-1", context: {} });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("ENTITY_COMPLIANCE_INPUT");
  });

  it("rejects an invalid payload with a 400, not a 500", async () => {
    const res = await post({ kind: "entity-compliance", op: "due-date" }); // missing form
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
