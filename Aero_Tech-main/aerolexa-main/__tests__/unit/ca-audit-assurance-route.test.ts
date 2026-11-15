/**
 * Route-level integration for `POST /api/ca/compute` with
 * `kind: "audit-assurance"`.
 *
 * The adapter unit suite proves the dispatch + rupee→paise maths; this suite
 * proves the *route* actually reaches it — the outer `kind` union accepts the
 * payload, the op is validated, and the engine's refusal maps to a 400 rather
 * than a 500. Auth is mocked so the handler can be called directly (no server
 * boot, no database).
 */

import { POST } from "@/app/api/ca/compute/route";
import { addReviewNote, createWorkpaper, type Workpaper } from "@/lib/engine/ca-audit-assurance";

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

describe("POST /api/ca/compute · audit-assurance", () => {
  it("routes an audit-assurance op through the workflow engine", async () => {
    const res = await post({ kind: "audit-assurance", op: "tcwg", fraudOrSuspectedFraud: ["suspected"] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.auditAssurance.required).toBe(true);
    expect(json.data.auditAssurance.items.join(" ")).toContain("SA 240");
  });

  it("converts rupees to paise through the route", async () => {
    const res = await post({
      kind: "audit-assurance",
      op: "mus-plan",
      bookValue: 9_000,
      tolerableMisstatement: 900,
      expectedMisstatement: 0,
      confidence: 0.95,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.auditAssurance.samplingInterval).toBe(30_000);
    expect(json.data.auditAssurance.sampleSize).toBe(30);
  });

  it("rejects an invalid op payload with a 400, not a 500", async () => {
    const res = await post({
      kind: "audit-assurance",
      op: "report",
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      framework: "Ind AS",
      uncorrectedMisstatements: 0,
      materiality: 0, // must be positive
      evidenceSufficient: true,
      cause: "none",
      pervasiveness: "not-pervasive",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("maps an engine refusal (open review note blocks sign-off) to a 400", async () => {
    const withOpenNote: Workpaper = addReviewNote(
      createWorkpaper({ ref: "B-100", title: "WP", sa: "SA 330", preparedBy: "P", preparedAt: "2026-04-01" }),
      { id: "n1", raisedBy: "R", raisedAt: "2026-04-02", text: "Tie up" },
    );
    const res = await post({
      kind: "audit-assurance",
      op: "workpaper-review",
      workpaper: withOpenNote,
      reviewer: "R",
      at: "2026-04-03",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("AUDIT_ASSURANCE_INPUT");
  });
});
