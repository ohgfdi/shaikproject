import { NextRequest } from "next/server";

import { POST } from "@/app/api/ca/tds-credit-recon/route";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1" },
      workspace: { id: "w1" },
      settings: {},
      organization: { id: "o1" },
      organizationRole: "OWNER",
    })),
  };
});

const HEADER = "TAN,Deductor Name,Section,Financial Year,Quarter,Date,Amount Paid,TDS Deducted";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/ca/tds-credit-recon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/ca/tds-credit-recon", () => {
  it("parses both sides and returns the reconciliation", async () => {
    const res = await post({
      statementText: `${HEADER}\nABCD12345E,Alpha,194C,2026-27,Q1,15/07/2026,"1,00,000",1000`,
      booksText: `${HEADER}\nABCD12345E,Alpha,194C,2026-27,Q1,15/07/2026,"1,00,000",1000`,
      statementSource: "26AS",
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.reconciliation.counts.matched).toBe(1);
    expect(json.data.statement).toMatchObject({ count: 1, warnings: [] });
    expect(json.data.books.count).toBe(1);
  });

  it("uses the rupee tolerance supplied by the caller", async () => {
    const res = await post({
      statementText: `${HEADER}\nABCD12345E,Alpha,194C,2026-27,Q1,15/07/2026,100000,1000`,
      booksText: `${HEADER}\nABCD12345E,Alpha,194C,2026-27,Q1,15/07/2026,100000,1005`,
      tolerance: 10,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.reconciliation.counts.matched).toBe(1);
    expect(json.data.reconciliation.totals.netDifference).toBe(500);
  });

  it("rejects an empty statement at the schema boundary", async () => {
    const res = await post({ statementText: "", booksText: "" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
  });

  it("returns a readable error for an unmappable CSV", async () => {
    const res = await post({ statementText: "Deductor,Amount\nAlpha,1000", booksText: "" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.message).toMatch(/TAN column/);
  });
});
