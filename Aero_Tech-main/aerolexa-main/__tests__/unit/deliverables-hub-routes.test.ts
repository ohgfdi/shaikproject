import { NextRequest } from "next/server";

import { GET } from "@/app/api/organization/deliverables/route";
import { ApiError } from "@/lib/auth/guard";
import { listFirmDeliverables } from "@/lib/server/deliverables-hub";

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

jest.mock("@/lib/server/deliverables-hub", () => ({
  listFirmDeliverables: jest.fn(),
}));

const mockedList = jest.mocked(listFirmDeliverables);

const RESULT = {
  deliverables: [{ id: "d1", formatLabel: "Financial statements", status: "SIGNED_OFF" }],
  engagements: [{ id: "e1", name: "Acme", code: "ACME", role: "PARTNER" }],
  formats: [{ code: "FINANCIALS", label: "Financial statements" }],
  totals: { total: 1, byStatus: { SIGNED_OFF: 1 }, outstanding: 1, issued: 0 },
  truncated: false,
};

describe("GET /api/organization/deliverables", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes the register filters through and returns the hub envelope", async () => {
    mockedList.mockResolvedValueOnce(RESULT as never);
    const res = await GET(
      new NextRequest(
        "http://localhost/api/organization/deliverables?engagementId=e1&status=SIGNED_OFF&formatCode=FINANCIALS&limit=50",
      ),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.totals.outstanding).toBe(1);
    expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ user: { id: "u1" } }), {
      engagementId: "e1",
      status: "SIGNED_OFF",
      formatCode: "FINANCIALS",
      limit: 50,
    });
  });

  it("preserves the access layer's 404 for another firm's engagement", async () => {
    mockedList.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "Engagement not found."));
    const res = await GET(new NextRequest("http://localhost/api/organization/deliverables?engagementId=x"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.message).toBe("Engagement not found.");
  });
});
