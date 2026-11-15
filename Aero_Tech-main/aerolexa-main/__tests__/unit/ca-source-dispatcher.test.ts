/**
 * Unit tests for the CA source ingestion dispatcher wiring + canonical engine.
 *
 * These tests cover the orchestration layer (ingestCaSource, the repeat-sync
 * semantics, dedup, reconciliation attachment) and the canonical engine
 * (canonicaliseSourceRows, reconcileCa) WITHOUT booting a database or the server.
 * Auth and prisma are mocked so the handlers can be called directly.
 */

import { randomUUID } from "node:crypto";

import type { AuthContext } from "@/lib/auth/guard";
import {
  canonicaliseSourceRows,
  reconcileCa,
  type CaDocument,
  type CaMappingProfile,
  type CaSourceKind,
} from "@/lib/engine/ca-source";
import {
  ingestCaSource,
  createCaSource,
  listCaSources,
  getCaSource,
  deleteCaSource,
  updateCaSource,
  saveCaSourceProfile,
  createMappingProfile,
  listMappingProfiles,
  getMappingProfile,
  deleteMappingProfile,
} from "@/lib/server/ca-source";
import type { ColType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let ctx: AuthContext;
let createdSourceId: string | null = null;
let createdMappingProfileId: string | null = null;

beforeEach(() => {
  ctx = {
    user: {
      id: "u1",
      email: "a@t.com",
      name: "A",
      passwordHash: "",
      workspaceId: "w1",
    } as AuthContext["user"],
    workspace: { id: "w1", name: "W", settings: null } as AuthContext["workspace"],
    settings: {} as AuthContext["settings"],
    organization: {
      id: "o1",
      name: "Firm",
      gstin: null,
      ownerId: null,
      settings: null,
      partnerDigestLastSentOn: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
      engagements: [],
      projects: [],
      activities: [],
      organizationReportTemplates: [],
    } as AuthContext["organization"],
    organizationRole: "OWNER",
    isAdmin: false,
  };
  createdSourceId = null;
  createdMappingProfileId = null;
});

// ---------------------------------------------------------------------------
// Canonical engine — pure
// ---------------------------------------------------------------------------

describe("canonicaliseSourceRows", () => {
  it("canonicalises a simple bank-statement row through a custom mapping", () => {
    const columns: { name: string; type: ColType }[] = [
      { name: "date", type: "date" },
      { name: "reference", type: "string" },
      { name: "narration", type: "string" },
      { name: "amount", type: "number" },
    ];
    const rows = [
      ["2026-03-01", "REF-100", "Salary credit", 50000],
      ["2026-03-02", "REF-101", "UPI debit", -2500],
    ];
    const profile: CaMappingProfile = {
      id: randomUUID(),
      name: "HDFC SB",
      sourceKind: "bank-statement",
      sourceLabel: "SB-2026-03.csv",
      sourceColumns: ["date", "reference", "narration", "amount"],
      mapping: {
        fingerprint: { column: "reference" },
        traceLabel: { column: "reference" },
        date: { column: "date" },
        party: { column: "narration" },
        sourceAmount: { column: "amount" },
      },
      firstUsedAt: new Date().toISOString(),
    };

    const { documents, report } = canonicaliseSourceRows("bank-statement", columns, rows, profile);

    expect(report.mapped).toBe(2);
    expect(report.skipped).toBe(0);
    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      fingerprint: "REF-100",
      traceLabel: "REF-100",
      date: "2026-03-01",
      sourceKind: "bank-statement",
      party: "Salary credit",
      debit: 0,
      credit: 0,
      sourceAmount: 50000,
    });
    expect(documents[1]).toMatchObject({
      fingerprint: "REF-101",
      sourceAmount: -2500,
    });
  });

  it("skips a row whose identity cannot be resolved", () => {
    const columns: { name: string; type: ColType }[] = [
      { name: "date", type: "date" },
      { name: "amount", type: "number" },
    ];
    const rows = [["2026-03-01", 1000]];
    const profile: CaMappingProfile = {
      id: randomUUID(),
      name: "minimal",
      sourceKind: "bank-statement",
      sourceLabel: "x.csv",
      sourceColumns: ["date", "amount"],
      mapping: {
        date: { column: "date" },
        sourceAmount: { column: "amount" },
      },
      firstUsedAt: new Date().toISOString(),
    };

    const { documents, report } = canonicaliseSourceRows("bank-statement", columns, rows, profile);

    expect(documents).toHaveLength(0);
    expect(report.skipped).toBe(1);
    expect(report.warnings[0]).toContain("could not canonise");
  });

  it("is idempotent for a given (rows, profile): same fingerprints on re-canonicalisation", () => {
    const columns: { name: string; type: ColType }[] = [
      { name: "voucher_number", type: "string" },
      { name: "date", type: "date" },
      { name: "amount", type: "number" },
    ];
    const rows = [
      ["V-1", "2026-03-01", 1000],
      ["V-2", "2026-03-01", 2000],
    ];
    const profile: CaMappingProfile = {
      id: randomUUID(),
      name: "Tally",
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      sourceColumns: ["voucher_number", "date", "amount"],
      mapping: {
        fingerprint: { column: "voucher_number" },
        traceLabel: { column: "voucher_number" },
        date: { column: "date" },
        sourceAmount: { column: "amount" },
      },
      firstUsedAt: new Date().toISOString(),
    };

    const first = canonicaliseSourceRows("tally-vouchers", columns, rows, profile);
    const second = canonicaliseSourceRows("tally-vouchers", columns, rows, profile);

    expect(first.documents.map((d) => d.fingerprint)).toEqual(second.documents.map((d) => d.fingerprint));
    expect(first.documents.map((d) => d.traceLabel)).toEqual(second.documents.map((d) => d.traceLabel));
  });

  it("falls back to known identity columns when no explicit fingerprint mapping", () => {
    const columns: { name: string; type: ColType }[] = [
      { name: "voucher_number", type: "string" },
      { name: "date", type: "date" },
      { name: "amount", type: "number" },
    ];
    const rows = [["V-1", "2026-03-01", 1000]];
    const profile: CaMappingProfile = {
      id: randomUUID(),
      name: "no-fingerprint-mapping",
      sourceKind: "tally-vouchers",
      sourceLabel: "x.csv",
      sourceColumns: ["voucher_number", "date", "amount"],
      mapping: {
        date: { column: "date" },
        sourceAmount: { column: "amount" },
      },
      firstUsedAt: new Date().toISOString(),
    };

    const { documents } = canonicaliseSourceRows("tally-vouchers", columns, rows, profile);

    expect(documents).toHaveLength(1);
    expect(documents[0]!.fingerprint).toBe("V-1");
  });
});

describe("reconcileCa", () => {
  it("matches two sources on exact reference + amount", () => {
    const left: CaDocument[] = [
      {
        fingerprint: "L1",
        traceLabel: "INV-101",
        date: "2026-03-01",
        sourceKind: "gst-invoices",
        party: "Acme",
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 10000,
        sourceId: "27AAABC1234A1Z5",
        metadata: {},
        provenance: null,
      },
    ];
    const right: CaDocument[] = [
      {
        fingerprint: "R1",
        traceLabel: "INV-101",
        date: "2026-03-01",
        sourceKind: "gst-invoices",
        party: "Acme",
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 10000,
        sourceId: "27AAABC1234A1Z5",
        metadata: {},
        provenance: null,
      },
    ];

    const result = reconcileCa(left, right);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.matchType).toBe("reference");
    expect(result.matches[0]!.confidence).toBe(0.99);
    expect(result.unmatchedLeft).toHaveLength(0);
    expect(result.unmatchedRight).toHaveLength(0);
    expect(result.summary.note).toContain("Sources reconcile");
  });

  it("matches on date + amount when references differ", () => {
    const left: CaDocument[] = [
      {
        fingerprint: "L1",
        traceLabel: "A",
        date: "2026-03-01",
        sourceKind: "bank-statement",
        party: null,
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 5000,
        sourceId: null,
        metadata: {},
        provenance: null,
      },
    ];
    const right: CaDocument[] = [
      {
        fingerprint: "R1",
        traceLabel: "B",
        date: "2026-03-02",
        sourceKind: "bank-statement",
        party: null,
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 5000,
        sourceId: null,
        metadata: {},
        provenance: null,
      },
    ];

    const result = reconcileCa(left, right, { matchOnIdentity: false });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.matchType).toBe("date-amount");
    expect(result.matches[0]!.confidence).toBe(0.95);
  });

  it("reports unmatched items and a non-reconciling note", () => {
    const left: CaDocument[] = [
      {
        fingerprint: "L1",
        traceLabel: "A",
        date: "2026-03-01",
        sourceKind: "bank-statement",
        party: null,
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 5000,
        sourceId: null,
        metadata: {},
        provenance: null,
      },
    ];
    const right: CaDocument[] = [
      {
        fingerprint: "R1",
        traceLabel: "B",
        date: "2026-03-01",
        sourceKind: "bank-statement",
        party: null,
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 3000,
        sourceId: null,
        metadata: {},
        provenance: null,
      },
    ];

    const result = reconcileCa(left, right, { matchOnIdentity: false });

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedLeft).toHaveLength(1);
    expect(result.unmatchedRight).toHaveLength(1);
    expect(result.summary.note).toContain("do NOT fully reconcile");
  });

  it("is deterministic: same inputs produce the same matches", () => {
    const left: CaDocument[] = [
      {
        fingerprint: "L1",
        traceLabel: "INV-101",
        date: "2026-03-01",
        sourceKind: "gst-invoices",
        party: "Acme",
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 10000,
        sourceId: "27AAABC1234A1Z5",
        metadata: {},
        provenance: null,
      },
    ];
    const right: CaDocument[] = [
      {
        fingerprint: "R1",
        traceLabel: "INV-101",
        date: "2026-03-01",
        sourceKind: "gst-invoices",
        party: "Acme",
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: 10000,
        sourceId: "27AAABC1234A1Z5",
        metadata: {},
        provenance: null,
      },
    ];

    const first = reconcileCa(left, right);
    const second = reconcileCa(left, right);

    expect(first.matches).toEqual(second.matches);
    expect(first.summary.note).toBe(second.summary.note);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher wiring — DB-backed, mocked
// ---------------------------------------------------------------------------

jest.mock("@/lib/db", () => ({
  prisma: {
    caSource: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    caMappingProfile: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
    caIngestRun: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    caDocumentSnapshot: {
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    activity: {
      create: jest.fn(),
    },
  },
}));

// The factory above is hoisted by the transform, so the mock object is built inside
// it (referencing an outer const here would hit the temporal dead zone). Retrieve the
// same instance to drive it with per-test return values.
const mockPrisma = jest.requireMock("@/lib/db").prisma as {
  caSource: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  caMappingProfile: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    deleteMany: jest.Mock;
  };
  caIngestRun: { create: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  caDocumentSnapshot: { createMany: jest.Mock; findMany: jest.Mock };
  activity: { create: jest.Mock };
};

jest.mock("@/lib/server/activity", () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/server/engagement", () => ({
  requireEngagementRole: jest.fn().mockResolvedValue({
    role: "ASSISTANT",
    engagement: { id: "e1", organizationId: "o1", name: "E" },
    project: null,
  }),
  requireEngagementAccess: jest.fn().mockResolvedValue("ASSISTANT"),
}));

const columns: { name: string; type: ColType }[] = [
  { name: "voucher_number", type: "string" },
  { name: "date", type: "date" },
  { name: "amount", type: "number" },
];
const rows = [
  ["V-1", "2026-03-01", 1000],
  ["V-2", "2026-03-01", 2000],
];

function profileFor(
  sourceKind: CaSourceKind,
  sourceLabel: string,
): {
  profile: {
    id: string;
    name: string;
    sourceKind: CaSourceKind;
    sourceLabel: string;
    sourceColumns: string[];
    mapping: CaMappingProfile["mapping"];
    firstUsedAt: string;
    note: string | null;
  };
  sourceColumns: string[];
} {
  const profile: {
    id: string;
    name: string;
    sourceKind: CaSourceKind;
    sourceLabel: string;
    sourceColumns: string[];
    mapping: CaMappingProfile["mapping"];
    firstUsedAt: string;
    note: string | null;
  } = {
    id: randomUUID(),
    name: `auto-${sourceKind}`,
    sourceKind,
    sourceLabel,
    sourceColumns: ["voucher_number", "date", "amount"],
    mapping: {
      fingerprint: { column: "voucher_number" },
      traceLabel: { column: "voucher_number" },
      date: { column: "date" },
      sourceAmount: { column: "amount" },
    },
    firstUsedAt: new Date().toISOString(),
    note: null,
  };
  return { profile, sourceColumns: profile.sourceColumns };
}

describe("ingestCaSource", () => {
  it("canonicalises rows through the saved profile, dedupes by fingerprint, and records a SUCCESS run", async () => {
    const { profile, sourceColumns } = profileFor("tally-vouchers", "daybook.csv");
    createdSourceId = randomUUID();

    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const runId = randomUUID();
    mockPrisma.caIngestRun.create.mockResolvedValue({
      id: runId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "1",
      triggeredBy: "manual",
      status: "RUNNING",
      rowCount: null,
      documentCount: null,
      report: null,
      reconciliation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
    });

    mockPrisma.caDocumentSnapshot.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.caSource.update.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 1,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-abc",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finishedRunId = randomUUID();
    mockPrisma.caIngestRun.update.mockResolvedValue({
      id: finishedRunId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "1",
      triggeredBy: "manual",
      status: "SUCCESS",
      rowCount: rows.length,
      documentCount: 2,
      report: JSON.stringify({ mapped: 2, skipped: 0, warnings: [] }),
      reconciliation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await ingestCaSource(ctx, createdSourceId!, {
      sourceRows: { columns, rows },
    });

    expect(result.run.status).toBe("SUCCESS");
    expect(result.run.rowCount).toBe(rows.length);
    expect(result.run.documentCount).toBe(2);
    expect(result.documents).toHaveLength(2);
    expect(result.reconciliation).toBeNull();

    expect(mockPrisma.caIngestRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caSourceId: createdSourceId,
          syncVersion: "1",
          triggeredBy: "manual",
          status: "RUNNING",
        }),
      }),
    );
    expect(mockPrisma.caSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdSourceId },
        data: expect.objectContaining({
          syncCount: { increment: 1 },
          lastError: null,
        }),
      }),
    );
  });

  it("records a reconciliation summary when reconcileAgainstPrior is true and a prior ingest exists", async () => {
    const { profile, sourceColumns } = profileFor("tally-vouchers", "daybook.csv");
    createdSourceId = randomUUID();
    const priorRunId = randomUUID();

    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 1,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-prior",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const runId = randomUUID();
    mockPrisma.caIngestRun.create.mockResolvedValue({
      id: runId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "2",
      triggeredBy: "manual",
      status: "RUNNING",
      rowCount: null,
      documentCount: null,
      report: null,
      reconciliation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
    });

    mockPrisma.caIngestRun.findMany.mockResolvedValue([
      {
        id: priorRunId,
        workspaceId: ctx.workspace.id,
        caSourceId: createdSourceId,
        syncVersion: "1",
        triggeredBy: "manual",
        status: "SUCCESS",
        rowCount: 2,
        documentCount: 2,
        report: null,
        reconciliation: null,
        error: null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        documents: [
          { fingerprint: "V-1", rowIndex: 1 },
          { fingerprint: "V-2", rowIndex: 2 },
        ],
      },
    ]);

    const priorDoc = (fingerprint: string, amount: number) =>
      JSON.stringify({
        fingerprint,
        traceLabel: fingerprint,
        date: "2026-03-01",
        sourceKind: "tally-vouchers",
        party: null,
        account: null,
        debit: 0,
        credit: 0,
        sourceAmount: amount,
        sourceId: null,
        metadata: {},
        provenance: null,
      });
    mockPrisma.caDocumentSnapshot.findMany.mockResolvedValue([
      {
        fingerprint: "V-1",
        rowIndex: 1,
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        caSourceId: createdSourceId,
        runId: priorRunId,
        document: priorDoc("V-1", 1000),
        createdAt: new Date(),
      },
      {
        fingerprint: "V-2",
        rowIndex: 2,
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        caSourceId: createdSourceId,
        runId: priorRunId,
        document: priorDoc("V-2", 2000),
        createdAt: new Date(),
      },
    ]);

    mockPrisma.caDocumentSnapshot.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.caSource.update.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 2,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-new",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finishedRunId = randomUUID();
    mockPrisma.caIngestRun.update.mockResolvedValue({
      id: finishedRunId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "2",
      triggeredBy: "manual",
      status: "SUCCESS",
      rowCount: rows.length,
      documentCount: 2,
      report: JSON.stringify({ mapped: 2, skipped: 0, warnings: [] }),
      reconciliation: JSON.stringify({
        matches: [
          {
            leftFingerprint: "V-1",
            rightFingerprint: "V-1",
            leftTrace: "V-1",
            rightTrace: "V-1",
            leftSourceId: null,
            rightSourceId: null,
            confidence: 0.99,
            matchType: "reference",
            reasons: ["Exact reference/source-id match with matching amount within tolerance."],
            leftAmount: 1000,
            rightAmount: 1000,
          },
        ],
        unmatchedLeft: [],
        unmatchedRight: [],
        totalMatched: 1,
        matchRate: 50,
        summary: {
          leftTotal: 1000,
          rightTotal: 1000,
          matchedTotal: 1000,
          unmatchedLeftTotal: 0,
          unmatchedRightTotal: 0,
          leftNetReconciled: 1000,
          rightNetReconciled: 1000,
          leftResidual: 0,
          rightResidual: 0,
          note: "Matched 1 document(s) worth ₹1000.00 (traceable to source vouchers/invoices/challans/IRNs/txns). Sources reconcile: left and right totals agree to within ₹0.01.",
        },
      }),
      error: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await ingestCaSource(ctx, createdSourceId!, {
      sourceRows: { columns, rows },
      reconcileAgainstPrior: true,
    });

    expect(result.run.status).toBe("SUCCESS");
    expect(result.reconciliation).not.toBeNull();
    expect(result.reconciliation?.totalMatched).toBeGreaterThanOrEqual(0);
  });

  it("records an ERROR run when the ingest fails mid-way", async () => {
    const { profile, sourceColumns } = profileFor("tally-vouchers", "daybook.csv");
    createdSourceId = randomUUID();

    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const runId = randomUUID();
    mockPrisma.caIngestRun.create.mockResolvedValue({
      id: runId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "1",
      triggeredBy: "manual",
      status: "RUNNING",
      rowCount: null,
      documentCount: null,
      report: null,
      reconciliation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
    });

    // Canonicalisation never throws for unresolvable rows — it skips them and
    // reports — so exercise the error path the way a real failure arrives: the
    // snapshot write rejects after the run has been opened.
    mockPrisma.caDocumentSnapshot.createMany.mockRejectedValue(new Error("CA source ingest failed."));
    mockPrisma.caSource.update.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(profile.sourceColumns),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: "CA source ingest failed.",
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.caIngestRun.update.mockResolvedValue({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "1",
      triggeredBy: "manual",
      status: "ERROR",
      rowCount: null,
      documentCount: null,
      report: null,
      reconciliation: null,
      error: "CA source ingest failed.",
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      ingestCaSource(ctx, createdSourceId!, {
        sourceRows: {
          columns: [{ name: "unknown_col", type: "string" }],
          rows: [["x"]],
        },
      }),
    ).rejects.toThrow();

    expect(mockPrisma.caIngestRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expect.any(String) },
        data: expect.objectContaining({
          status: "ERROR",
          error: expect.stringContaining("CA source ingest failed"),
        }),
      }),
    );
    expect(mockPrisma.caSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdSourceId },
        data: expect.objectContaining({
          lastError: expect.stringContaining("CA source ingest failed"),
        }),
      }),
    );
  });

  it("increments syncCount and sets documentFingerprint on the source", async () => {
    const { profile, sourceColumns } = profileFor("tally-vouchers", "daybook.csv");
    createdSourceId = randomUUID();

    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const runId = randomUUID();
    mockPrisma.caIngestRun.create.mockResolvedValue({
      id: runId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "1",
      triggeredBy: "manual",
      status: "RUNNING",
      rowCount: null,
      documentCount: null,
      report: null,
      reconciliation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
    });

    mockPrisma.caDocumentSnapshot.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.caSource.update.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName: "Day Book",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(sourceColumns),
      syncCount: 1,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-abc",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finishedRunId = randomUUID();
    mockPrisma.caIngestRun.update.mockResolvedValue({
      id: finishedRunId,
      workspaceId: ctx.workspace.id,
      caSourceId: createdSourceId,
      syncVersion: "1",
      triggeredBy: "manual",
      status: "SUCCESS",
      rowCount: rows.length,
      documentCount: 2,
      report: JSON.stringify({ mapped: 2, skipped: 0, warnings: [] }),
      reconciliation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await ingestCaSource(ctx, createdSourceId!, {
      sourceRows: { columns, rows },
    });

    expect(result.run.syncVersion).toBe("1");
    expect(mockPrisma.caSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdSourceId },
        data: expect.objectContaining({
          syncCount: { increment: 1 },
          documentFingerprint: expect.stringMatching(/^fp-[0-9a-z]+$/),
        }),
      }),
    );
  });
});

describe("createCaSource / listCaSources / getCaSource / updateCaSource / deleteCaSource", () => {
  it("creates an engagement-scoped CA source", async () => {
    createdSourceId = randomUUID();
    const displayName = "Tally Day Book — Mar-26";

    mockPrisma.caSource.create.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: "e1",
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName,
      profile: JSON.stringify({
        id: randomUUID(),
        name: "auto-tally-vouchers",
        sourceKind: "tally-vouchers",
        sourceLabel: "daybook.csv",
        sourceColumns: ["voucher_number", "date", "amount"],
        mapping: {},
        firstUsedAt: new Date().toISOString(),
        note: "Auto-detected default mapping — save a custom mapping after the first ingest.",
      }),
      sourceColumns: JSON.stringify(["voucher_number", "date", "amount"]),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.activity.create.mockResolvedValue({ id: randomUUID(), createdAt: new Date() });

    const source = await createCaSource(ctx, {
      sourceKind: "tally-vouchers",
      sourceLabel: "daybook.csv",
      displayName,
      engagementId: "e1",
    });

    expect(source.id).toBe(createdSourceId);
    expect(source.engagementId).toBe("e1");
    expect(source.sourceKind).toBe("tally-vouchers");
    expect(source.displayName).toBe(displayName);
    expect(mockPrisma.caSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: ctx.workspace.id,
          engagementId: "e1",
          sourceKind: "tally-vouchers",
          sourceLabel: "daybook.csv",
          displayName,
        }),
      }),
    );
  });

  it("lists workspace-scoped sources", async () => {
    mockPrisma.caSource.findMany.mockResolvedValue([
      {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        engagementId: null,
        sourceKind: "bank-statement",
        sourceLabel: "SB-2026-03.csv",
        displayName: "HDFC SB Mar-26",
        profile: JSON.stringify({}),
        sourceColumns: JSON.stringify(["date", "reference", "amount"]),
        syncCount: 1,
        lastIngestedAt: new Date(),
        lastError: null,
        documentFingerprint: "fp-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const sources = await listCaSources(ctx);

    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceKind).toBe("bank-statement");
    expect(mockPrisma.caSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: ctx.workspace.id },
      }),
    );
  });

  it("lists engagement-scoped sources only when an engagement id is provided", async () => {
    mockPrisma.caSource.findMany.mockResolvedValue([
      {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        engagementId: "e1",
        sourceKind: "tally-vouchers",
        sourceLabel: "daybook.csv",
        displayName: "Day Book",
        profile: JSON.stringify({}),
        sourceColumns: JSON.stringify(["voucher_number", "date", "amount"]),
        syncCount: 0,
        lastIngestedAt: null,
        lastError: null,
        documentFingerprint: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const sources = await listCaSources(ctx, { engagementId: "e1" });

    expect(sources).toHaveLength(1);
    expect(sources[0]!.engagementId).toBe("e1");
    expect(mockPrisma.caSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: ctx.workspace.id, engagementId: "e1" },
      }),
    );
  });

  it("gets one source by id", async () => {
    createdSourceId = randomUUID();
    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "SB-2026-03.csv",
      displayName: "HDFC SB Mar-26",
      profile: JSON.stringify({}),
      sourceColumns: JSON.stringify(["date", "reference", "amount"]),
      syncCount: 1,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const source = await getCaSource(ctx, createdSourceId);

    expect(source.id).toBe(createdSourceId);
    expect(source.sourceKind).toBe("bank-statement");
    expect(mockPrisma.caSource.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdSourceId },
      }),
    );
  });

  it("returns 404 for a cross-workspace source", async () => {
    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: randomUUID(),
      workspaceId: "w2",
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "x.csv",
      displayName: null,
      profile: JSON.stringify({}),
      sourceColumns: JSON.stringify([]),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(getCaSource(ctx, "s1")).rejects.toThrow();
  });

  it("updates display metadata on a source", async () => {
    createdSourceId = randomUUID();
    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "SB-2026-03.csv",
      displayName: "HDFC SB Mar-26",
      profile: JSON.stringify({}),
      sourceColumns: JSON.stringify(["date", "reference", "amount"]),
      syncCount: 1,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.caSource.update.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "SB-2026-03.csv",
      displayName: "HDFC SB Mar-26 UPDATED",
      profile: JSON.stringify({}),
      sourceColumns: JSON.stringify(["date", "reference", "amount"]),
      syncCount: 1,
      lastIngestedAt: new Date(),
      lastError: null,
      documentFingerprint: "fp-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.activity.create.mockResolvedValue({ id: randomUUID(), createdAt: new Date() });

    const source = await updateCaSource(ctx, createdSourceId, {
      displayName: "HDFC SB Mar-26 UPDATED",
    });

    expect(source.displayName).toBe("HDFC SB Mar-26 UPDATED");
    expect(mockPrisma.caSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdSourceId },
        data: expect.objectContaining({
          displayName: "HDFC SB Mar-26 UPDATED",
        }),
      }),
    );
  });

  it("deletes a source and its runs + snapshots", async () => {
    createdSourceId = randomUUID();
    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "x.csv",
      displayName: null,
      profile: JSON.stringify({}),
      sourceColumns: JSON.stringify([]),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.caSource.delete.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
    });

    mockPrisma.activity.create.mockResolvedValue({ id: randomUUID(), createdAt: new Date() });

    const deleted = await deleteCaSource(ctx, createdSourceId);

    expect(deleted).toBe(true);
    expect(mockPrisma.caSource.delete).toHaveBeenCalledWith({
      where: { id: createdSourceId },
    });
  });

  it("saves a custom mapping profile on a source", async () => {
    createdSourceId = randomUUID();
    const profile = {
      id: randomUUID(),
      name: "HDFC SB custom",
      sourceKind: "bank-statement" as CaSourceKind,
      sourceLabel: "SB-2026-03.csv",
      sourceColumns: ["date", "reference", "narration", "amount"],
      mapping: {
        fingerprint: { column: "reference" },
        traceLabel: { column: "reference" },
        date: { column: "date" },
        party: { column: "narration" },
        sourceAmount: { column: "amount" },
      },
      firstUsedAt: new Date().toISOString(),
      note: "Custom mapping after first ingest.",
    };

    mockPrisma.caSource.findUnique.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "SB-2026-03.csv",
      displayName: "HDFC SB Mar-26",
      profile: JSON.stringify({}),
      sourceColumns: JSON.stringify([]),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.caSource.update.mockResolvedValue({
      id: createdSourceId,
      workspaceId: ctx.workspace.id,
      engagementId: null,
      sourceKind: "bank-statement",
      sourceLabel: "SB-2026-03.csv",
      displayName: "HDFC SB Mar-26",
      profile: JSON.stringify(profile),
      sourceColumns: JSON.stringify(profile.sourceColumns),
      syncCount: 0,
      lastIngestedAt: null,
      lastError: null,
      documentFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.activity.create.mockResolvedValue({ id: randomUUID(), createdAt: new Date() });

    const source = await saveCaSourceProfile(ctx, createdSourceId, profile);

    expect(source.profile).toBe(JSON.stringify(profile));
    expect(mockPrisma.caSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdSourceId },
        data: expect.objectContaining({
          profile: JSON.stringify(profile),
          sourceColumns: JSON.stringify(profile.sourceColumns),
        }),
      }),
    );
  });
});

describe("mapping profile storage", () => {
  it("creates a mapping profile", async () => {
    createdMappingProfileId = randomUUID();
    mockPrisma.caMappingProfile.create.mockResolvedValue({
      id: createdMappingProfileId,
      sourceKind: "bank-statement",
      name: "HDFC SB",
      sourceLabel: "SB-2026-03.csv",
      sourceColumns: JSON.stringify(["date", "reference", "narration", "amount"]),
      mapping: JSON.stringify({
        fingerprint: { column: "reference" },
        traceLabel: { column: "reference" },
        date: { column: "date" },
        party: { column: "narration" },
        sourceAmount: { column: "amount" },
      }),
      firstUsedAt: new Date().toISOString(),
      note: null,
    });

    const profile = await createMappingProfile(ctx, {
      sourceKind: "bank-statement",
      name: "HDFC SB",
      sourceLabel: "SB-2026-03.csv",
      sourceColumns: ["date", "reference", "narration", "amount"],
      mapping: {
        fingerprint: { column: "reference" },
        traceLabel: { column: "reference" },
        date: { column: "date" },
        party: { column: "narration" },
        sourceAmount: { column: "amount" },
      },
    });

    expect(profile.id).toBe(createdMappingProfileId);
    expect(profile.name).toBe("HDFC SB");
    expect(profile.sourceKind).toBe("bank-statement");
  });

  it("lists mapping profiles for a source kind", async () => {
    mockPrisma.caMappingProfile.findMany.mockResolvedValue([
      {
        id: randomUUID(),
        sourceKind: "bank-statement",
        name: "HDFC SB",
        sourceLabel: "SB-2026-03.csv",
        sourceColumns: JSON.stringify(["date", "reference", "narration", "amount"]),
        mapping: JSON.stringify({}),
        firstUsedAt: new Date().toISOString(),
        note: null,
      },
    ]);

    const profiles = await listMappingProfiles(ctx, "bank-statement");

    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.sourceKind).toBe("bank-statement");
    expect(mockPrisma.caMappingProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceKind: "bank-statement" },
      }),
    );
  });

  it("gets one mapping profile by id", async () => {
    const id = randomUUID();
    mockPrisma.caMappingProfile.findUnique.mockResolvedValue({
      id,
      sourceKind: "bank-statement",
      name: "HDFC SB",
      sourceLabel: "SB-2026-03.csv",
      sourceColumns: JSON.stringify(["date", "reference", "narration", "amount"]),
      mapping: JSON.stringify({}),
      firstUsedAt: new Date().toISOString(),
      note: null,
    });

    const profile = await getMappingProfile(id);

    expect(profile).not.toBeNull();
    expect(profile!.id).toBe(id);
  });

  it("returns null for a missing mapping profile", async () => {
    mockPrisma.caMappingProfile.findUnique.mockResolvedValue(null);

    const profile = await getMappingProfile(randomUUID());

    expect(profile).toBeNull();
  });

  it("deletes a mapping profile", async () => {
    mockPrisma.caMappingProfile.deleteMany.mockResolvedValue({ count: 1 });

    const deleted = await deleteMappingProfile(randomUUID());

    expect(deleted).toBe(true);
    expect(mockPrisma.caMappingProfile.deleteMany).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
    });
  });
});
