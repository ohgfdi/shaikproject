import { NextRequest } from "next/server";

import { GET as calendarRoute } from "@/app/api/organization/compliance/route";
import { PUT as saveProfileRoute } from "@/app/api/organization/engagements/[id]/compliance/route";
import { POST as statusRoute } from "@/app/api/organization/engagements/[id]/compliance/status/route";
import { ApiError } from "@/lib/auth/guard";
import {
  getComplianceCalendar,
  setComplianceTaskStatus,
  upsertComplianceProfile,
} from "@/lib/server/compliance-calendar";

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

jest.mock("@/lib/server/compliance-calendar", () => ({
  getComplianceCalendar: jest.fn(),
  upsertComplianceProfile: jest.fn(),
  setComplianceTaskStatus: jest.fn(),
}));

const mocked = {
  calendar: jest.mocked(getComplianceCalendar),
  profile: jest.mocked(upsertComplianceProfile),
  status: jest.mocked(setComplianceTaskStatus),
};

const CALENDAR = {
  asOf: "2026-11-08",
  financialYear: "2026-27",
  clients: [{ id: "e1", name: "Acme", code: "ACME", configured: true, profile: {} }],
  tasks: [{ id: "e1:GSTR-1:Apr-2026:1", title: "GSTR-1", state: "due-soon" }],
  totals: { clients: 1, unconfigured: 0, overdue: 0, dueSoon: 1, upcoming: 0, filed: 0, waived: 0 },
};

describe("GET /api/organization/compliance", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes the as-of date and returns the calendar", async () => {
    mocked.calendar.mockResolvedValueOnce(CALENDAR as never);
    const res = await calendarRoute(new NextRequest("http://localhost/api/organization/compliance?today=2026-11-08"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.calendar.totals.dueSoon).toBe(1);
    expect(mocked.calendar).toHaveBeenCalledWith(expect.objectContaining({ user: { id: "u1" } }), {
      today: "2026-11-08",
    });
  });

  it("maps a missing organization to 404", async () => {
    mocked.calendar.mockRejectedValueOnce(new ApiError(404, "NO_ORGANIZATION", "Create an organization first."));
    const res = await calendarRoute(new NextRequest("http://localhost/api/organization/compliance"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NO_ORGANIZATION");
  });
});

describe("PUT /api/organization/engagements/[id]/compliance", () => {
  beforeEach(() => jest.clearAllMocks());

  const PROFILE = {
    entityKind: "company",
    financialYear: "2026-27",
    gstRegistered: true,
    gstFrequency: "monthly",
    tdsDeductor: true,
    taxAuditApplicable: true,
    transferPricingApplicable: false,
    listedCompany: false,
    state: "maharashtra",
    employsStaff: true,
  };

  function put(payload: unknown) {
    return saveProfileRoute(
      new NextRequest("http://localhost/api/organization/engagements/e1/compliance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: "e1" }) },
    );
  }

  it("validates and saves the registration profile", async () => {
    mocked.profile.mockResolvedValueOnce({ profile: PROFILE } as never);
    const res = await put(PROFILE);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.profile.financialYear).toBe("2026-27");
    expect(mocked.profile).toHaveBeenCalledWith(expect.anything(), "e1", PROFILE);
  });

  it("rejects a malformed financial year at the schema boundary", async () => {
    const res = await put({ ...PROFILE, financialYear: "26-27" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
    expect(mocked.profile).not.toHaveBeenCalled();
  });
});

describe("POST /api/organization/engagements/[id]/compliance/status", () => {
  beforeEach(() => jest.clearAllMocks());

  it("records a filed obligation with its reference", async () => {
    mocked.status.mockResolvedValueOnce({ taskId: "t1", status: "filed" } as never);
    const res = await statusRoute(
      new NextRequest("http://localhost/api/organization/engagements/e1/compliance/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "t1", status: "filed", filedOn: "2026-11-07", reference: "ARN-1" }),
      }),
      { params: Promise.resolve({ id: "e1" }) },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.status).toBe("filed");
    expect(mocked.status).toHaveBeenCalledWith(expect.anything(), "e1", {
      taskId: "t1",
      status: "filed",
      filedOn: "2026-11-07",
      reference: "ARN-1",
    });
  });

  it("rejects an unknown task id returned by the server", async () => {
    mocked.status.mockRejectedValueOnce(new ApiError(400, "VALIDATION", "That task does not belong to this client's current calendar."));
    const res = await statusRoute(
      new NextRequest("http://localhost/api/organization/engagements/e1/compliance/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "nope", status: "filed" }),
      }),
      { params: Promise.resolve({ id: "e1" }) },
    );

    expect(res.status).toBe(400);
  });
});
