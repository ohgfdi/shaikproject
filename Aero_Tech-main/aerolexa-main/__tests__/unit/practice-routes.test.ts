/**
 * Route-level tests for the practice dashboard endpoints.
 *
 * The aggregation module is mocked (its health maths is covered by
 * practice-overview.test.ts); these prove the HTTP layer is wired, passes the
 * engagement id through untouched, and maps failures to the right status.
 */

import { NextRequest } from "next/server";

import { GET as getOverviewRoute } from "@/app/api/organization/engagements/[id]/overview/route";
import { GET as getPracticeRoute } from "@/app/api/organization/practice/route";
import { ApiError } from "@/lib/auth/guard";
import { getEngagementOverview, getPracticeOverview } from "@/lib/server/practice-overview";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1", name: "Partner" },
      workspace: { id: "w1" },
      settings: {},
      organization: { id: "o1" },
      organizationRole: "OWNER",
    })),
  };
});

jest.mock("@/lib/server/practice-overview", () => ({
  getPracticeOverview: jest.fn(),
  getEngagementOverview: jest.fn(),
}));

const mockedPractice = jest.mocked(getPracticeOverview);
const mockedDetail = jest.mocked(getEngagementOverview);

const OVERVIEW = {
  totals: { clients: 1, papersAwaitingReview: 2 },
  engagements: [{ id: "e1", name: "Acme" }],
  generatedAt: "2026-11-08T09:00:00.000Z",
};

const DETAIL = { engagement: { id: "e1", name: "Acme" }, role: "PARTNER", team: [] };

describe("GET /api/organization/practice", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the firm overview in the standard envelope", async () => {
    mockedPractice.mockResolvedValueOnce(OVERVIEW as never);
    const res = await getPracticeRoute();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.overview).toEqual(OVERVIEW);
    expect(mockedPractice).toHaveBeenCalledTimes(1);
  });

  it("maps a missing organization to 404 NO_ORGANIZATION", async () => {
    mockedPractice.mockRejectedValueOnce(new ApiError(404, "NO_ORGANIZATION", "Create an organization first."));
    const res = await getPracticeRoute();
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("NO_ORGANIZATION");
  });
});

describe("GET /api/organization/engagements/[id]/overview", () => {
  beforeEach(() => jest.clearAllMocks());

  function call(id: string) {
    return getOverviewRoute(new NextRequest(`http://localhost/api/organization/engagements/${id}/overview`), {
      params: Promise.resolve({ id }),
    });
  }

  it("passes the engagement id through and returns the detail bundle", async () => {
    mockedDetail.mockResolvedValueOnce(DETAIL as never);
    const res = await call("e1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.overview).toEqual(DETAIL);
    expect(mockedDetail).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: "u1" }) }),
      "e1",
    );
  });

  it("does not leak another firm's engagement: 404 from the access layer is preserved", async () => {
    mockedDetail.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "Engagement not found."));
    const res = await call("someone-elses");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.message).toBe("Engagement not found.");
  });
});
