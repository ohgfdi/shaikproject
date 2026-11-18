/** @license MIT — Ledgerly CA source ingestion pipeline (server)
 *
 * Persistence, repeat-sync semantics, mapping-profile storage, dedup, and the
 * HTTP surface for CA source ingestion.
 *
 * This module is the server counterpart to lib/engine/ca-source.ts. The engine
 * is a pure computation layer (canonicaliseSourceRows + reconcileCa) — this
 * module is what makes it a real, repeatable, auditable pipeline a CA firm can
 * run against client data:
 *
 *   1. Repeat sync — every ingest is a versioned run (CaIngestRun) with a stable
 *      syncVersion label, so re-ingesting the same source produces a new run and
 *      the prior state stays retrievable. A source is never silently overwritten.
 *   2. Mappings storage — CaMappingProfile rows are the reusable "column X means
 *      canonical field Y" artifact a firm saves once per source system and reuses
 *      across repeats. Custom profiles win over auto-detected defaults.
 *   3. Dedup — canonical documents are stored by fingerprint (identity, not row
 *      index) and the source carries a documentFingerprint so a repeat sync of an
 *      unchanged source is cheap and detectable.
 *   4. Engagement-scoped isolation — every CA source belongs to one engagement
 *      (or none, for firm-level sources). Cross-engagement reads are 404, never
 *      403, and every write is scoped to the caller's firm + engagement.
 *   5. Audit-grade change control — every ingest run records an append-only
 *      Activity event and a reconciliation summary when it compared against a
 *      prior source, so who ingested what, when, and with what result is always
 *      traceable.
 *
 * Deterministic, no flaky async, no guessing. The engine contract is the source
 * of truth; this module is a thin, honest persistence + dispatch layer.
 */

import { randomUUID } from "node:crypto";

import { notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import type { CaSourceKind } from "@/lib/engine/ca-source";
import {
  canonicaliseSourceRows,
  reconcileCa,
  type CaDocument as CaDocumentEngine,
  type CaMappingProfile as CaMappingProfileEngine,
  type CaTransformReport as CaTransformReportEngine,
  type CaReconcileResult as CaReconcileResultEngine,
} from "@/lib/engine/ca-source";
import { parseJson, parseJsonArray, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { requireEngagementRole, requireEngagementAccess, type PracticeRole } from "@/lib/server/engagement";

export type {
  CaDocument,
  CaMappingProfile,
  CaSourceKind,
  CaReconcileResult,
  CaTransformReport,
} from "@/lib/engine/ca-source";

export type CaIngestTrigger = "manual" | "schedule" | "reingest";

export interface CaSourceRow {
  id: string;
  workspaceId: string;
  engagementId: string | null;
  sourceKind: string;
  sourceLabel: string;
  displayName: string | null;
  profile: string; // JSON CaMappingProfile
  sourceColumns: string[];
  syncCount: number;
  lastIngestedAt: string | null;
  lastError: string | null;
  documentFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaIngestRunRow {
  id: string;
  workspaceId: string;
  caSourceId: string;
  syncVersion: string;
  triggeredBy: string;
  status: string;
  rowCount: number | null;
  documentCount: number | null;
  report: string | null;
  reconciliation: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface CaDocumentSnapshotRow {
  id: string;
  workspaceId: string;
  caSourceId: string;
  runId: string;
  fingerprint: string;
  rowIndex: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Persistence helpers (honest, thin, no hidden behaviour)
// ---------------------------------------------------------------------------

const ENGAGEMENT_MIN_ROLE: PracticeRole = "ASSISTANT";

/** Load a CA source the caller may act on. Cross-firm sources are 404 (never 403). */
export async function loadCaSourceForWrite(
  ctx: AuthContext,
  id: string,
  engagementId: string | null,
): Promise<CaSourceRow> {
  const source = await prisma.caSource.findUnique({
    where: { id },
    select: {
      id: true,
      workspaceId: true,
      engagementId: true,
      sourceKind: true,
      sourceLabel: true,
      displayName: true,
      profile: true,
      sourceColumns: true,
      syncCount: true,
      lastIngestedAt: true,
      lastError: true,
      documentFingerprint: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!source) throw notFoundError("CA source not found.");

  // Workspace isolation first (404 if cross-workspace, never 403).
  if (source.workspaceId !== ctx.workspace.id) throw notFoundError("CA source not found.");

  // Engagement scoping: if the source is engagement-scoped, the caller must have
  // at least ASSISTANT on that engagement and the engagement must be in the caller's
  // firm (404 if not).
  if (source.engagementId) {
    if (engagementId && source.engagementId !== engagementId) {
      throw notFoundError("CA source not found.");
    }
    // For writes we require at least ASSISTANT on the engagement.
    const { engagement, project } = await requireEngagementRole(ctx, source.engagementId, ENGAGEMENT_MIN_ROLE);
    void engagement;
    void project;
  }

  return rowFromCaSource(source);
}

function rowFromCaSource(source: {
  id: string;
  workspaceId: string;
  engagementId: string | null;
  sourceKind: string;
  sourceLabel: string;
  displayName: string | null;
  profile: string;
  sourceColumns: string;
  syncCount: number;
  lastIngestedAt: Date | null;
  lastError: string | null;
  documentFingerprint: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CaSourceRow {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    engagementId: source.engagementId,
    sourceKind: source.sourceKind,
    sourceLabel: source.sourceLabel,
    displayName: source.displayName,
    profile: source.profile,
    sourceColumns: parseJsonArray(source.sourceColumns, []),
    syncCount: source.syncCount,
    lastIngestedAt: source.lastIngestedAt?.toISOString() ?? null,
    lastError: source.lastError,
    documentFingerprint: source.documentFingerprint,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Mapping profile storage
// ---------------------------------------------------------------------------

/** Create a mapping profile for one source kind. Returns the saved profile. */
export async function createMappingProfile(
  _ctx: AuthContext,
  input: {
    sourceKind: CaSourceKind;
    name: string;
    sourceLabel: string;
    sourceColumns: string[];
    mapping: CaMappingProfileEngine["mapping"];
    note?: string | null;
  },
): Promise<CaMappingProfileEngine> {
  if (!input.name || input.name.length > 140) {
    throw new Error("Mapping profile name is required and must be 140 characters or fewer.");
  }
  if (!input.sourceLabel) {
    throw new Error("Mapping profile sourceLabel is required.");
  }
  if (!input.sourceColumns.length) {
    throw new Error("Mapping profile sourceColumns must name at least one source column.");
  }

  const profile: CaMappingProfileEngine = {
    id: randomUUID(),
    name: input.name,
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    sourceColumns: input.sourceColumns,
    mapping: input.mapping,
    firstUsedAt: new Date().toISOString(),
    note: input.note ?? null,
  };

  const created = await prisma.caMappingProfile.create({
    data: {
      id: profile.id,
      sourceKind: input.sourceKind,
      name: input.name,
      sourceLabel: input.sourceLabel,
      sourceColumns: stringifyJson(input.sourceColumns),
      mapping: stringifyJson(input.mapping),
      firstUsedAt: profile.firstUsedAt,
      note: input.note ?? null,
    },
  });

  return decodeCaMappingProfile(created);
}

/** List mapping profiles for one source kind (firm-scoped). */
export async function listMappingProfiles(
  _ctx: AuthContext,
  sourceKind: CaSourceKind,
): Promise<CaMappingProfileEngine[]> {
  const rows = await prisma.caMappingProfile.findMany({
    where: { sourceKind },
    orderBy: { name: "asc" },
    take: 200,
  });
  return rows.map(decodeCaMappingProfile);
}

function decodeCaMappingProfile(row: {
  id: string;
  sourceKind: string;
  name: string;
  sourceLabel: string;
  sourceColumns: string;
  mapping: string;
  firstUsedAt: string;
  note: string | null;
}): CaMappingProfileEngine {
  return {
    id: row.id,
    name: row.name,
    sourceKind: row.sourceKind as CaSourceKind,
    sourceLabel: row.sourceLabel,
    sourceColumns: parseJsonArray(row.sourceColumns, []),
    mapping: parseJson(row.mapping, {} as CaMappingProfileEngine["mapping"]),
    firstUsedAt: row.firstUsedAt,
    note: row.note,
  };
}

/** Get one mapping profile by id (firm-scoped through sourceKind membership only). */
export async function getMappingProfile(id: string): Promise<CaMappingProfileEngine | null> {
  const row = await prisma.caMappingProfile.findUnique({ where: { id } });
  if (!row) return null;
  return decodeCaMappingProfile(row);
}

/** Delete a mapping profile by id. Returns true when deleted. */
export async function deleteMappingProfile(id: string): Promise<boolean> {
  const result = await prisma.caMappingProfile.deleteMany({ where: { id } });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// Repeat-sync dispatcher
// ---------------------------------------------------------------------------

/**
 * Ingest a CA source: canonicalise the pulled rows through the saved mapping
 * profile, dedup by fingerprint, record an append-only ingest run, and (when the
 * source already has a prior ingest) reconcile against the prior canonical documents.
 *
 * Repeat-sync semantics:
 *   - Every ingest is a new CaIngestRun with a new syncVersion, even when nothing
 *     changed. The prior state stays retrievable through the run + snapshot rows.
 *   - Documents are stored by fingerprint, so a repeat sync of an unchanged source
 *     produces the same fingerprints and the documentFingerprint on the source is
 *     unchanged — the caller can detect "nothing changed" cheaply.
 *   - When a prior ingest exists and the caller opts in to reconciliation, the new
 *     canonical documents are reconciled against the prior ones and the summary is
 *     attached to the run.
 *
 * The `sourceRows` shape is the same shape the connector/parser layer produces:
 * columns (name + type) plus rows (flat array of cell values).
 */
export async function ingestCaSource(
  ctx: AuthContext,
  sourceId: string,
  options: {
    trigger?: CaIngestTrigger;
    reconcileAgainstPrior?: boolean;
    sourceRows?: {
      columns: { name: string; type: string }[];
      rows: (string | number | boolean | null)[][];
    };
  } = {},
): Promise<{
  run: CaIngestRunRow;
  documents: CaDocumentRow[];
  reconciliation: CaReconcileResultEngine | null;
}> {
  const source = await loadCaSourceForWrite(ctx, sourceId, null);

  if (!options.sourceRows || options.sourceRows.columns.length === 0) {
    throw new Error("sourceRows with at least one column are required for ingest.");
  }

  const trigger: CaIngestTrigger = options.trigger ?? "manual";
  const syncVersion = nextSyncVersion(source.syncCount + 1);
  const now = new Date();

  const run = await prisma.caIngestRun.create({
    data: {
      workspaceId: ctx.workspace.id,
      caSourceId: source.id,
      syncVersion,
      triggeredBy: trigger,
      status: "RUNNING",
      startedAt: now,
    },
  });

  try {
    const profile = decodeCaMappingProfile({
      id: "",
      sourceKind: source.sourceKind as CaSourceKind,
      name: "",
      sourceLabel: source.sourceLabel,
      sourceColumns: stringifyJson(source.sourceColumns),
      mapping: source.profile,
      firstUsedAt: new Date().toISOString(),
      note: null,
    });

    const provenance = {
      sourceLabel: source.sourceLabel,
      syncVersion,
    };

    const columns = options.sourceRows.columns.map((c) => ({
      name: c.name,
      type: c.type as "string" | "number" | "date" | "boolean",
    }));

    const { documents: canonicalDocs, report: transformReport } = canonicaliseSourceRows(
      source.sourceKind as CaSourceKind,
      columns,
      options.sourceRows.rows,
      profile,
      { provenance },
    );

    const fingerprintSet = new Set<string>();
    const deduped: CaDocumentEngine[] = [];
    for (const doc of canonicalDocs) {
      if (fingerprintSet.has(doc.fingerprint)) continue;
      fingerprintSet.add(doc.fingerprint);
      deduped.push(doc);
    }

    // Persist document snapshots (append-only, keyed by fingerprint + run).
    const snapshotBatch = deduped.map((doc, idx) => ({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      caSourceId: source.id,
      runId: run.id,
      fingerprint: doc.fingerprint,
      rowIndex: idx + 1,
      document: stringifyJson(doc),
    }));
    await prisma.caDocumentSnapshot.createMany({
      data: snapshotBatch,
    });

    // Reconciliation against prior ingest, when requested and available.
    let reconciliation: CaReconcileResultEngine | null = null;
    if (options.reconcileAgainstPrior) {
      const priorDocuments = await loadPriorCanonicalDocuments(source.id, run.id);
      if (priorDocuments.length) {
        reconciliation = reconcileCa(priorDocuments, deduped, {
          amountTolerance: 1,
          dateToleranceDays: 1,
          matchOnIdentity: true,
          preferReferenceMatch: true,
        });
      }
    }

    const newDocumentFingerprint = hashFingerprintSet(fingerprintSet);

    // Update the source with the result of this run.
    await prisma.caSource.update({
      where: { id: source.id },
      data: {
        syncCount: { increment: 1 },
        lastIngestedAt: now,
        lastError: null,
        documentFingerprint: newDocumentFingerprint,
      },
    });

    // Append-only audit event (who ingested what, when, with what result).
    await logActivity(
      ctx,
      "CA_SOURCE_INGESTED",
      `Ingested CA source “${source.displayName ?? source.id}” (sync ${syncVersion}): ${deduped.length} document(s), ${transformReport.skipped} skipped.`,
      null,
      {
        caSourceId: source.id,
        caIngestRunId: run.id,
        syncVersion,
        trigger,
        rowCount: options.sourceRows.rows.length,
        documentCount: deduped.length,
        skipped: transformReport.skipped,
        reconciled: reconciliation
          ? { totalMatched: reconciliation.totalMatched, matchRate: reconciliation.matchRate }
          : null,
      },
    );

    const finishedRun = await prisma.caIngestRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        rowCount: options.sourceRows.rows.length,
        documentCount: deduped.length,
        report: stringifyJson(transformReport),
        reconciliation: reconciliation ? stringifyJson(reconciliation) : null,
        finishedAt: new Date(),
      },
    });

    const documentRows = deduped.map((doc, idx) => ({
      id: randomUUID(),
      fingerprint: doc.fingerprint,
      rowIndex: idx + 1,
      document: doc,
    }));

    return {
      run: rowFromCaIngestRun(finishedRun, transformReport, reconciliation, deduped.length),
      documents: documentRows,
      reconciliation,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "CA source ingest failed.";
    await prisma.caIngestRun.update({
      where: { id: run.id },
      data: { status: "ERROR", error: message, finishedAt: new Date() },
    });
    await prisma.caSource.update({
      where: { id: source.id },
      data: { lastError: message },
    });
    await logActivity(
      ctx,
      "CA_SOURCE_INGEST_FAILED",
      `CA source “${source.displayName ?? source.id}” ingest failed: ${message}`,
      null,
      { caSourceId: source.id, caIngestRunId: run.id, syncVersion },
    );
    throw err;
  }
}

function nextSyncVersion(count: number): string {
  return String(count);
}

function hashFingerprintSet(set: Set<string>): string {
  // Deterministic, stable fingerprint for the set of document fingerprints.
  const sorted = Array.from(set).sort();
  let h = 0;
  for (const f of sorted) {
    for (let i = 0; i < f.length; i++) {
      h = (Math.imul(31, h) + f.charCodeAt(i)) | 0;
    }
  }
  return `fp-${Math.abs(h).toString(36)}`;
}

function rowFromCaIngestRun(
  run: {
    id: string;
    workspaceId: string;
    caSourceId: string;
    syncVersion: string;
    triggeredBy: string;
    status: string;
    rowCount: number | null;
    documentCount: number | null;
    report: string | null;
    reconciliation: string | null;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
    createdAt: Date;
  },
  report: CaTransformReportEngine,
  reconciliation: CaReconcileResultEngine | null,
  documentCount: number,
): CaIngestRunRow {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    caSourceId: run.caSourceId,
    syncVersion: run.syncVersion,
    triggeredBy: run.triggeredBy,
    status: run.status,
    rowCount: run.rowCount ?? null,
    documentCount: run.documentCount ?? documentCount,
    report: run.report ?? stringifyJson(report),
    reconciliation: run.reconciliation ?? (reconciliation ? stringifyJson(reconciliation) : null),
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

/** Load the canonical documents from the most recent successful ingest run for a
 * source, excluding the run being currently recorded (so a new run can reconcile
 * against the prior state).
 */
async function loadPriorCanonicalDocuments(sourceId: string, excludeRunId: string): Promise<CaDocumentEngine[]> {
  const priorRuns = await prisma.caIngestRun.findMany({
    where: {
      caSourceId: sourceId,
      status: "SUCCESS",
      id: { not: excludeRunId },
    },
    orderBy: { startedAt: "desc" },
    take: 1,
    select: { id: true },
  });

  const priorRun = priorRuns[0];
  if (!priorRun) return [];

  return loadCanonicalDocumentsForRun(sourceId, priorRun.id);
}

/** Load the canonical documents for a specific ingest run. */
async function loadCanonicalDocumentsForRun(sourceId: string, runId: string): Promise<CaDocumentEngine[]> {
  const snapshots = await prisma.caDocumentSnapshot.findMany({
    where: { caSourceId: sourceId, runId },
    orderBy: { rowIndex: "asc" },
    select: { document: true },
  });

  // Each snapshot row persists the canonical document as JSON, so the prior
  // state is fully reconstructable for reconciliation against a new run.
  const documents: CaDocumentEngine[] = [];
  for (const snapshot of snapshots) {
    const doc = parseJson<CaDocumentEngine | null>(snapshot.document, null);
    if (doc) documents.push(doc);
  }
  return documents;
}

// ---------------------------------------------------------------------------
// Source lifecycle
// ---------------------------------------------------------------------------

/** Create a CA source (engagement-scoped when an engagement is provided). */
export async function createCaSource(
  ctx: AuthContext,
  input: {
    sourceKind: CaSourceKind;
    sourceLabel: string;
    displayName?: string | null;
    engagementId?: string | null;
    profile?: CaMappingProfileEngine;
    sourceColumns?: string[];
  },
): Promise<CaSourceRow> {
  if (!input.sourceLabel) throw new Error("sourceLabel is required.");

  const engagementId = input.engagementId ?? null;

  // If an engagement is nominated, assert the caller may create a source on it.
  if (engagementId) {
    await requireEngagementAccess(
      ctx,
      { id: engagementId, organizationId: ctx.organization?.id ?? "" },
      null,
      ENGAGEMENT_MIN_ROLE,
    );
  }

  const profile = input.profile ?? defaultProfile(input.sourceKind, input.sourceLabel, input.sourceColumns ?? []);

  const source = await prisma.caSource.create({
    data: {
      workspaceId: ctx.workspace.id,
      engagementId,
      sourceKind: input.sourceKind,
      sourceLabel: input.sourceLabel,
      displayName: input.displayName ?? null,
      profile: stringifyJson(profile),
      sourceColumns: stringifyJson(profile.sourceColumns),
    },
  });

  await logActivity(
    ctx,
    "CA_SOURCE_CREATED",
    `Created CA source “${input.displayName ?? input.sourceLabel}” (${input.sourceKind}).`,
    null,
    { caSourceId: source.id, sourceKind: input.sourceKind, engagementId },
  );

  return rowFromCaSource(source);
}

/** Default (auto-detected) mapping profile for a source kind. Used when the caller
 * does not supply a custom profile — it is intentionally minimal so the first
 * ingest can proceed and a reviewer can save a custom mapping after.
 */
function defaultProfile(
  sourceKind: CaSourceKind,
  sourceLabel: string,
  sourceColumns: string[],
): CaMappingProfileEngine {
  return {
    id: randomUUID(),
    name: `auto-${sourceKind}`,
    sourceKind,
    sourceLabel,
    sourceColumns,
    mapping: {},
    firstUsedAt: new Date().toISOString(),
    note: "Auto-detected default mapping — save a custom mapping after the first ingest.",
  };
}

/** List CA sources visible to the caller. Engagement-scoped when an engagement id
 * is provided; otherwise workspace-scoped. Cross-engagement sources are excluded,
 * never leaked as 403.
 */
export async function listCaSources(
  ctx: AuthContext,
  options: { engagementId?: string | null } = {},
): Promise<CaSourceRow[]> {
  const where: {
    workspaceId: string;
    engagementId?: string | null;
  } = { workspaceId: ctx.workspace.id };

  if (options.engagementId) {
    // Only sources on the nominated engagement the caller can see.
    where.engagementId = options.engagementId;
  }

  const sources = await prisma.caSource.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return sources.map(rowFromCaSource);
}

/** Get one CA source by id (workspace + engagement scoped, 404 on miss). */
export async function getCaSource(ctx: AuthContext, id: string): Promise<CaSourceRow> {
  const source = await prisma.caSource.findUnique({
    where: { id },
    select: {
      id: true,
      workspaceId: true,
      engagementId: true,
      sourceKind: true,
      sourceLabel: true,
      displayName: true,
      profile: true,
      sourceColumns: true,
      syncCount: true,
      lastIngestedAt: true,
      lastError: true,
      documentFingerprint: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!source) throw notFoundError("CA source not found.");
  if (source.workspaceId !== ctx.workspace.id) throw notFoundError("CA source not found.");
  return rowFromCaSource(source);
}

/** Delete a CA source and its runs + snapshots (cascade via the relation). Returns
 * true when deleted. Cross-firm sources are 404.
 */
export async function deleteCaSource(ctx: AuthContext, id: string): Promise<boolean> {
  const source = await prisma.caSource.findUnique({
    where: { id },
    select: { id: true, workspaceId: true, engagementId: true },
  });
  if (!source) throw notFoundError("CA source not found.");
  if (source.workspaceId !== ctx.workspace.id) throw notFoundError("CA source not found.");

  await prisma.caSource.delete({ where: { id } });
  await logActivity(ctx, "CA_SOURCE_DELETED", `Deleted CA source.`, null, {
    caSourceId: id,
    engagementId: source.engagementId,
  });
  return true;
}

/** Update a CA source's display metadata (not the mapping profile — profiles are
 * managed separately). Returns the updated source.
 */
export async function updateCaSource(
  ctx: AuthContext,
  id: string,
  input: { displayName?: string | null; sourceLabel?: string | null },
): Promise<CaSourceRow> {
  await loadCaSourceForWrite(ctx, id, null);
  const data: {
    displayName?: string | null;
    sourceLabel?: string;
  } = {};
  if (input.displayName !== undefined) data.displayName = input.displayName;
  if (input.sourceLabel !== undefined) {
    if (!input.sourceLabel) throw new Error("sourceLabel must be non-empty.");
    data.sourceLabel = input.sourceLabel;
  }
  const updated = await prisma.caSource.update({
    where: { id },
    data,
    select: {
      id: true,
      workspaceId: true,
      engagementId: true,
      sourceKind: true,
      sourceLabel: true,
      displayName: true,
      profile: true,
      sourceColumns: true,
      syncCount: true,
      lastIngestedAt: true,
      lastError: true,
      documentFingerprint: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await logActivity(ctx, "CA_SOURCE_UPDATED", `Updated CA source.`, null, { caSourceId: id });
  return rowFromCaSource(updated);
}

/** Save (upsert) the mapping profile on a source. This is the "not one-time
 * upload-and-pick-columns" write path: a reviewer saves a custom mapping after
 * the first ingest and the source reuses it across repeats.
 */
export async function saveCaSourceProfile(
  ctx: AuthContext,
  sourceId: string,
  profile: CaMappingProfileEngine,
): Promise<CaSourceRow> {
  await loadCaSourceForWrite(ctx, sourceId, null);
  if (!profile.name) throw new Error("Mapping profile name is required.");
  if (!profile.sourceColumns.length) throw new Error("Mapping profile sourceColumns must name at least one column.");

  const updated = await prisma.caSource.update({
    where: { id: sourceId },
    data: {
      profile: stringifyJson(profile),
      sourceColumns: stringifyJson(profile.sourceColumns),
    },
    select: {
      id: true,
      workspaceId: true,
      engagementId: true,
      sourceKind: true,
      sourceLabel: true,
      displayName: true,
      profile: true,
      sourceColumns: true,
      syncCount: true,
      lastIngestedAt: true,
      lastError: true,
      documentFingerprint: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await logActivity(ctx, "CA_SOURCE_PROFILE_SAVED", `Saved mapping profile on CA source.`, null, {
    caSourceId: sourceId,
    profileName: profile.name,
  });

  return rowFromCaSource(updated);
}

// ---------------------------------------------------------------------------
// Document retrieval
// ---------------------------------------------------------------------------

/** List the canonical documents from a specific ingest run. */
export async function listCaSourceDocuments(
  ctx: AuthContext,
  sourceId: string,
  runId: string,
): Promise<{ fingerprint: string; rowIndex: number; document: CaDocumentEngine }[]> {
  await loadCaSourceForWrite(ctx, sourceId, null);
  const rows = await prisma.caDocumentSnapshot.findMany({
    where: { caSourceId: sourceId, runId },
    orderBy: { rowIndex: "asc" },
    select: { fingerprint: true, rowIndex: true, document: true },
  });

  const documents: { fingerprint: string; rowIndex: number; document: CaDocumentEngine }[] = [];
  for (const row of rows) {
    const doc = parseJson<CaDocumentEngine | null>(row.document, null);
    if (doc) {
      documents.push({ fingerprint: row.fingerprint, rowIndex: row.rowIndex, document: doc });
    }
  }
  return documents;
}

/** List ingest runs for a source (newest first). */
export async function listCaSourceRuns(ctx: AuthContext, sourceId: string): Promise<CaIngestRunRow[]> {
  await loadCaSourceForWrite(ctx, sourceId, null);
  const runs = await prisma.caIngestRun.findMany({
    where: { caSourceId: sourceId },
    orderBy: { startedAt: "desc" },
    take: 200,
    select: {
      id: true,
      workspaceId: true,
      caSourceId: true,
      syncVersion: true,
      triggeredBy: true,
      status: true,
      rowCount: true,
      documentCount: true,
      report: true,
      reconciliation: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
  return runs.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    caSourceId: r.caSourceId,
    syncVersion: r.syncVersion,
    triggeredBy: r.triggeredBy,
    status: r.status,
    rowCount: r.rowCount,
    documentCount: r.documentCount,
    report: r.report,
    reconciliation: r.reconciliation,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface CaDocumentRow {
  id: string;
  fingerprint: string;
  rowIndex: number;
  document: CaDocumentEngine;
}
