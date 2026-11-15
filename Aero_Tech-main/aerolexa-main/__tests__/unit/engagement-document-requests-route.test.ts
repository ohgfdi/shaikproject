import { NextRequest } from "next/server";

import {
  GET as listRoute,
  POST as createRoute,
} from "@/app/api/organization/engagements/[id]/document-requests/route";
import { ApiError } from "@/lib/auth/guard";
import {
  createEngagementDocumentRequest,
  listEngagementDocumentRequests,
} from "@/lib/server/document-requests";

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

jest.mock("@/lib/server/document-requests", () => ({
  createEngagementDocumentRequest: jest.fn(),
  listEngagementDocumentRequests: jest.fn(),
}));

const mocked = {
  create: jest.mocked(createEngagementDocumentRequest),
  list: jest.mocked(listEngagementDocumentRequests),
};

function post(body: unknown) {
  return createRoute(
    new NextRequest("http://localhost/api/organization/engagements/e1/document-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "e1" }) },
  );
}

describe("engagement document requests", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists requests for the engagement", async () => {
    mocked.list.mockResolvedValueOnce([{ id: "r1", title: "Bank statement", status: "requested" }] as never);
    const res = await listRoute(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "e1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.requests[0].title).toBe("Bank statement");
    expect(mocked.list).toHaveBeenCalledWith(expect.objectContaining({ user: { id: "u1" } }), "e1");
  });

  it("creates a request the client will see in the portal", async () => {
    mocked.create.mockResolvedValueOnce({ id: "r1", title: "Bank statement" } as never);
    const res = await post({
      title: "Bank statement",
      category: "financial-statement",
      dueDate: "2026-11-30",
      period: "FY 2026-27",
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.request.id).toBe("r1");
    expect(mocked.create).toHaveBeenCalledWith(expect.anything(), "e1", {
      title: "Bank statement",
      category: "financial-statement",
      dueDate: "2026-11-30",
      period: "FY 2026-27",
    });
  });

  it("rejects an unknown category at the schema boundary", async () => {
    const res = await post({ title: "Bank statement", category: "nonsense", dueDate: "2026-11-30" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
    expect(mocked.create).not.toHaveBeenCalled();
  });

  it("maps a missing engagement to 404", async () => {
    mocked.create.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "Engagement not found."));
    const res = await post({ title: "Bank statement", category: "other", dueDate: "2026-11-30" });

    expect(res.status).toBe(404);
  });
});
