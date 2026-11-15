/**
 * Route-level tests for the CA source API surface (app/api/ca/sources/*,
 * app/api/ca/mapping-profiles/*).
 *
 * These prove the HTTP layer is actually wired: each handler reaches the right
 * server function with a validated payload, and maps failures to the right
 * status. The server layer itself is mocked — its behaviour is covered by
 * ca-source-dispatcher.test.ts.
 */

import { NextRequest } from "next/server";

import {
  DELETE as deleteMappingProfileRoute,
  GET as getMappingProfileRoute,
} from "@/app/api/ca/mapping-profiles/[id]/route";
import { GET as listProfilesRoute, POST as createProfileRoute } from "@/app/api/ca/mapping-profiles/route";
import { GET as listDocumentsRoute } from "@/app/api/ca/sources/[id]/documents/route";
import { PUT as saveProfileRoute } from "@/app/api/ca/sources/[id]/profile/route";
import {
  DELETE as deleteSourceRoute,
  GET as getSourceRoute,
  PATCH as patchSourceRoute,
} from "@/app/api/ca/sources/[id]/route";
import { GET as listRunsRoute } from "@/app/api/ca/sources/[id]/runs/route";
import { GET as listSourcesRoute, POST as createSourceRoute } from "@/app/api/ca/sources/route";
import {
  createCaSource,
  createMappingProfile,
  deleteCaSource,
  deleteMappingProfile,
  getCaSource,
  getMappingProfile,
  listCaSourceDocuments,
  listCaSourceRuns,
  listCaSources,
  listMappingProfiles,
  saveCaSourceProfile,
  updateCaSource,
} from "@/lib/server/ca-source";

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

jest.mock("@/lib/server/ca-source", () => ({
  createCaSource: jest.fn(),
  listCaSources: jest.fn(),
  getCaSource: jest.fn(),
  updateCaSource: jest.fn(),
  deleteCaSource: jest.fn(),
  saveCaSourceProfile: jest.fn(),
  listCaSourceDocuments: jest.fn(),
  listCaSourceRuns: jest.fn(),
  ingestCaSource: jest.fn(),
  createMappingProfile: jest.fn(),
  listMappingProfiles: jest.fn(),
  getMappingProfile: jest.fn(),
  deleteMappingProfile: jest.fn(),
}));

const mocked = {
  createCaSource: jest.mocked(createCaSource),
  listCaSources: jest.mocked(listCaSources),
  getCaSource: jest.mocked(getCaSource),
  updateCaSource: jest.mocked(updateCaSource),
  deleteCaSource: jest.mocked(deleteCaSource),
  saveCaSourceProfile: jest.mocked(saveCaSourceProfile),
  listCaSourceDocuments: jest.mocked(listCaSourceDocuments),
  listCaSourceRuns: jest.mocked(listCaSourceRuns),
  createMappingProfile: jest.mocked(createMappingProfile),
  listMappingProfiles: jest.mocked(listMappingProfiles),
  getMappingProfile: jest.mocked(getMappingProfile),
  deleteMappingProfile: jest.mocked(deleteMappingProfile),
};

const SOURCE_ROW = {
  id: "s1",
  workspaceId: "w1",
  engagementId: null,
  sourceKind: "tally-vouchers",
  sourceLabel: "daybook.csv",
  displayName: "Day Book",
  profile: "{}",
  sourceColumns: ["voucher_number"],
  syncCount: 0,
  lastIngestedAt: null,
  lastError: null,
  documentFingerprint: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** Route handler props for a `[id]` segment. */
function props(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** A NextRequest carrying an optional JSON body. */
function request(url: string, method = "GET", payload?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
}

describe("CA source routes", () => {
  it("creates a source and returns 201", async () => {
    mocked.createCaSource.mockResolvedValue(SOURCE_ROW);
    const res = await createSourceRoute(
      request("http://localhost/api/ca/sources", "POST", {
        sourceKind: "tally-vouchers",
        sourceLabel: "daybook.csv",
        displayName: "Day Book",
      }),
    );

    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.data.source.id).toBe("s1");
    expect(mocked.createCaSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKind: "tally-vouchers", sourceLabel: "daybook.csv", engagementId: null }),
    );
  });

  it("rejects an unknown source kind with 400", async () => {
    const res = await createSourceRoute(
      request("http://localhost/api/ca/sources", "POST", { sourceKind: "not-a-kind", sourceLabel: "x.csv" }),
    );

    expect(res.status).toBe(400);
    expect(mocked.createCaSource).not.toHaveBeenCalled();
  });

  it("lists sources and forwards the engagement filter", async () => {
    mocked.listCaSources.mockResolvedValue([SOURCE_ROW]);
    const res = await listSourcesRoute(request("http://localhost/api/ca/sources?engagementId=e1"));

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.sources).toHaveLength(1);
    expect(mocked.listCaSources).toHaveBeenCalledWith(expect.anything(), { engagementId: "e1" });
  });

  it("reads, patches and deletes one source", async () => {
    mocked.getCaSource.mockResolvedValue(SOURCE_ROW);
    mocked.updateCaSource.mockResolvedValue({ ...SOURCE_ROW, displayName: "Renamed" });
    mocked.deleteCaSource.mockResolvedValue(true);

    const getRes = await getSourceRoute(request("http://localhost/api/ca/sources/s1"), props("s1"));
    expect(getRes.status).toBe(200);

    const patchRes = await patchSourceRoute(
      request("http://localhost/api/ca/sources/s1", "PATCH", { displayName: "Renamed" }),
      props("s1"),
    );
    expect(patchRes.status).toBe(200);
    expect(mocked.updateCaSource).toHaveBeenCalledWith(expect.anything(), "s1", { displayName: "Renamed" });

    const deleteRes = await deleteSourceRoute(request("http://localhost/api/ca/sources/s1", "DELETE"), props("s1"));
    expect(deleteRes.status).toBe(200);
    expect(mocked.deleteCaSource).toHaveBeenCalledWith(expect.anything(), "s1");
  });

  it("saves a mapping profile on a source", async () => {
    mocked.saveCaSourceProfile.mockResolvedValue(SOURCE_ROW);
    const res = await saveProfileRoute(
      request("http://localhost/api/ca/sources/s1/profile", "PUT", {
        name: "HDFC SB",
        sourceKind: "bank-statement",
        sourceLabel: "SB-2026-03.csv",
        sourceColumns: ["date", "reference", "amount"],
        mapping: { fingerprint: { column: "reference" }, sourceAmount: { column: "amount" } },
      }),
      props("s1"),
    );

    expect(res.status).toBe(200);
    expect(mocked.saveCaSourceProfile).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      expect.objectContaining({ name: "HDFC SB", sourceKind: "bank-statement" }),
    );
  });

  it("lists runs, and requires a runId before listing documents", async () => {
    mocked.listCaSourceRuns.mockResolvedValue([]);
    const runsRes = await listRunsRoute(request("http://localhost/api/ca/sources/s1/runs"), props("s1"));
    expect(runsRes.status).toBe(200);

    const missing = await listDocumentsRoute(request("http://localhost/api/ca/sources/s1/documents"), props("s1"));
    expect(missing.status).toBe(400);

    mocked.listCaSourceDocuments.mockResolvedValue([
      {
        fingerprint: "V-1",
        rowIndex: 1,
        document: {
          fingerprint: "V-1",
          traceLabel: "V-1",
          date: "2026-03-01",
          sourceKind: "tally-vouchers",
          party: null,
          account: null,
          debit: 0,
          credit: 0,
          sourceAmount: 1000,
          sourceId: null,
          metadata: {},
          provenance: null,
        },
      },
    ]);
    const found = await listDocumentsRoute(
      request("http://localhost/api/ca/sources/s1/documents?runId=r1"),
      props("s1"),
    );
    expect(found.status).toBe(200);
    expect(mocked.listCaSourceDocuments).toHaveBeenCalledWith(expect.anything(), "s1", "r1");
  });
});

describe("CA mapping profile routes", () => {
  it("lists profiles for a source kind and rejects an unknown kind", async () => {
    mocked.listMappingProfiles.mockResolvedValue([]);
    const res = await listProfilesRoute(request("http://localhost/api/ca/mapping-profiles?sourceKind=bank-statement"));
    expect(res.status).toBe(200);
    expect(mocked.listMappingProfiles).toHaveBeenCalledWith(expect.anything(), "bank-statement");

    const bad = await listProfilesRoute(request("http://localhost/api/ca/mapping-profiles?sourceKind=nope"));
    expect(bad.status).toBe(400);
  });

  it("creates a reusable profile", async () => {
    mocked.createMappingProfile.mockResolvedValue({
      id: "p1",
      name: "HDFC SB",
      sourceKind: "bank-statement",
      sourceLabel: "SB.csv",
      sourceColumns: ["reference"],
      mapping: {},
      firstUsedAt: new Date().toISOString(),
      note: null,
    });
    const res = await createProfileRoute(
      request("http://localhost/api/ca/mapping-profiles", "POST", {
        sourceKind: "bank-statement",
        name: "HDFC SB",
        sourceLabel: "SB.csv",
        sourceColumns: ["reference"],
        mapping: { fingerprint: { column: "reference" } },
      }),
    );

    expect(res.status).toBe(201);
    expect(mocked.createMappingProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKind: "bank-statement", name: "HDFC SB" }),
    );
  });

  it("gets and deletes one profile, 404ing when it is missing", async () => {
    mocked.getMappingProfile.mockResolvedValue(null);
    const missing = await getMappingProfileRoute(request("http://localhost/api/ca/mapping-profiles/p1"), props("p1"));
    expect(missing.status).toBe(404);

    mocked.deleteMappingProfile.mockResolvedValue(true);
    const deleted = await deleteMappingProfileRoute(
      request("http://localhost/api/ca/mapping-profiles/p1", "DELETE"),
      props("p1"),
    );
    expect(deleted.status).toBe(200);
    expect(mocked.deleteMappingProfile).toHaveBeenCalledWith("p1");
  });
});
