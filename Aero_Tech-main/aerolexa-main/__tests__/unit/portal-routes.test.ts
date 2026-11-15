/**
 * Route-level tests for the client portal.
 *
 * The server module is mocked: its visibility and upload rules are oracle-tested
 * in client-portal.test.ts. These assert the HTTP contract — public routes need
 * no session, firm routes authenticate, ids pass through, and failures keep the
 * standard envelope.
 */

import { NextRequest } from "next/server";

import { DELETE as revokeRoute } from "@/app/api/organization/engagements/[id]/portal/[tokenId]/route";
import { GET as firmPortalRoute, POST as createLinkRoute } from "@/app/api/organization/engagements/[id]/portal/route";
import { GET as uploadDownloadRoute } from "@/app/api/organization/engagements/[id]/portal/uploads/[uploadId]/route";
import { GET as deliverableRoute } from "@/app/api/portal/[token]/deliverables/[versionId]/route";
import { GET as snapshotRoute } from "@/app/api/portal/[token]/route";
import { POST as uploadRoute } from "@/app/api/portal/[token]/uploads/route";
import { ApiError } from "@/lib/auth/guard";
import {
  createPortalLink,
  getPortalDeliverable,
  getPortalSnapshot,
  listPortalLinks,
  listPortalUploads,
  readPortalUpload,
  revokePortalLink,
  savePortalUpload,
} from "@/lib/server/client-portal";

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

jest.mock("@/lib/server/client-portal", () => ({
  MAX_PORTAL_UPLOAD_BYTES: 10 * 1024 * 1024,
  getPortalSnapshot: jest.fn(),
  getPortalDeliverable: jest.fn(),
  savePortalUpload: jest.fn(),
  createPortalLink: jest.fn(),
  revokePortalLink: jest.fn(),
  listPortalLinks: jest.fn(),
  listPortalUploads: jest.fn(),
  readPortalUpload: jest.fn(),
}));

jest.mock("@/lib/server/document-requests", () => ({
  listEngagementDocumentRequests: jest.fn(async () => []),
}));

const mocked = {
  snapshot: jest.mocked(getPortalSnapshot),
  deliverable: jest.mocked(getPortalDeliverable),
  create: jest.mocked(createPortalLink),
  revoke: jest.mocked(revokePortalLink),
  links: jest.mocked(listPortalLinks),
  uploads: jest.mocked(listPortalUploads),
  readUpload: jest.mocked(readPortalUpload),
  saveUpload: jest.mocked(savePortalUpload),
};

const TOKEN = "lpl_abcdefghijklmnopqrstuvwxyz0123456789";
const SNAPSHOT = {
  engagement: { name: "Acme", code: "ACME" },
  firmName: "Sharma & Co",
  linkExpiresAt: "2026-12-08T09:00:00.000Z",
  deliverables: [{ id: "d1", formatCode: "FINANCIALS", label: "Financials", revision: 2, issuedAt: null, udin: null }],
  uploads: [],
  requests: [],
};

function tokenRequest(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost${path}`, init);
}

describe("public portal snapshot", () => {
  beforeEach(() => jest.clearAllMocks());

  it("serves a token snapshot without a session", async () => {
    mocked.snapshot.mockResolvedValueOnce(SNAPSHOT as never);
    const res = await snapshotRoute(tokenRequest(`/api/portal/${TOKEN}`), { params: Promise.resolve({ token: TOKEN }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.portal.engagement.name).toBe("Acme");
    expect(mocked.snapshot).toHaveBeenCalledWith(TOKEN);
  });

  it("returns the same 404 for an invalid link", async () => {
    mocked.snapshot.mockRejectedValueOnce(new ApiError(404, "PORTAL_LINK_INVALID", "This client link is invalid or has expired."));
    const res = await snapshotRoute(tokenRequest("/api/portal/bad"), { params: Promise.resolve({ token: "bad" }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("PORTAL_LINK_INVALID");
  });
});

describe("public portal deliverable", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes the token and version through", async () => {
    mocked.deliverable.mockResolvedValueOnce({ versionId: "d1", formatLabel: "Financials" } as never);
    const res = await deliverableRoute(tokenRequest(`/api/portal/${TOKEN}/deliverables/d1`), {
      params: Promise.resolve({ token: TOKEN, versionId: "d1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.deliverable.versionId).toBe("d1");
    expect(mocked.deliverable).toHaveBeenCalledWith(TOKEN, "d1");
  });
});

describe("public portal upload", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes a selected document request through to the server", async () => {
    mocked.saveUpload.mockResolvedValueOnce({ id: "u1", filename: "bank.pdf", fulfilledRequestId: "req1" } as never);
    const form = new FormData();
    form.set("file", new File([Buffer.from("%PDF-1.7")], "bank.pdf", { type: "application/pdf" }));
    form.set("requestId", "req1");
    const res = await uploadRoute(
      new NextRequest(`http://localhost/api/portal/${TOKEN}/uploads`, { method: "POST", body: form }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.upload.fulfilledRequestId).toBe("req1");
    expect(mocked.saveUpload).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ requestId: "req1" }));
  });

  it("rejects a request with no file at the route boundary", async () => {
    const form = new FormData();
    form.set("note", "missing file");
    const res = await uploadRoute(
      new NextRequest(`http://localhost/api/portal/${TOKEN}/uploads`, { method: "POST", body: form }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
  });
});

describe("firm-side portal controls", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists links and uploads for an engagement", async () => {
    mocked.links.mockResolvedValueOnce([{ id: "l1", prefix: "lpl_abcdefgh", state: "active" }] as never);
    mocked.uploads.mockResolvedValueOnce([{ id: "u1", filename: "bank.pdf" }] as never);
    const res = await firmPortalRoute(tokenRequest("/api/organization/engagements/e1/portal"), {
      params: Promise.resolve({ id: "e1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.links).toHaveLength(1);
    expect(json.data.uploads[0].filename).toBe("bank.pdf");
  });

  it("mints a link and returns the raw token exactly once in the response", async () => {
    mocked.create.mockResolvedValueOnce({ id: "l1", prefix: "lpl_abcdefgh", raw: TOKEN } as never);
    const res = await createLinkRoute(
      new NextRequest("http://localhost/api/organization/engagements/e1/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "CFO", expiresInDays: 14 }),
      }),
      { params: Promise.resolve({ id: "e1" }) },
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.link.raw).toBe(TOKEN);
    expect(mocked.create).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ id: "u1" }) }), "e1", {
      label: "CFO",
      expiresInDays: 14,
    });
  });

  it("serves an upload inline with no-sniff and sandbox headers", async () => {
    mocked.readUpload.mockResolvedValueOnce({
      filename: 'bank "statement".pdf',
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7"),
    } as never);
    const res = await uploadDownloadRoute(
      tokenRequest("/api/organization/engagements/e1/portal/uploads/u1"),
      { params: Promise.resolve({ id: "e1", uploadId: "u1" }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("content-disposition")).not.toContain("\n");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(mocked.readUpload).toHaveBeenCalledWith(expect.anything(), "e1", "u1");
  });

  it("revokes by token id under the engagement", async () => {
    mocked.revoke.mockResolvedValueOnce({ id: "l1", state: "revoked" } as never);
    const res = await revokeRoute(tokenRequest("/api/organization/engagements/e1/portal/l1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "e1", tokenId: "l1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.link.state).toBe("revoked");
    expect(mocked.revoke).toHaveBeenCalledWith(expect.anything(), "e1", "l1");
  });
});
