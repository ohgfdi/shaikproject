/**
 * THE dataset read chokepoint.
 *
 * Every user-facing read of dataset rows must go through this module. It is the
 * single place that:
 *
 *   1. authorizes the caller against the DATASET (project role / org role /
 *      workspace ownership) — never against the caller's own workspace;
 *   2. resolves row-level-security rules from the workspace that OWNS the
 *      dataset — not the caller's workspace. Shared projects legitimately span
 *      workspaces, so a member of workspace B reading a dataset owned by
 *      workspace A must be filtered by A's rules, not by B's (which are
 *      usually empty, i.e. unrestricted);
 *   3. applies those filters BEFORE any engine, export, copilot or report sees
 *      the rows, so filtered-out rows never reach a number, a chart, a CSV, an
 *      XLSX or a public share link.
 *
 * New dataset-reading endpoints should call `loadAuthorizedDataset`. Endpoints
 * that already hold a Prisma dataset row and their own loaded rows can call
 * `applyRowSecurity` to add the enforcement step.
 *
 * System/write paths (connector sync, transform apply, versioning, replace) are
 * deliberately NOT routed through here: they operate on the full stored
 * dataset as owner-level operations, not as a user's read.
 */

import { notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset, type Cell } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { artifactRoleWithOrg, requireRowRoleWithOrg } from "@/lib/server/members";
import { applyRlsToRows, filtersForUser, loadRlsRules } from "@/lib/server/rls";
import type { ColumnDef, ProjectRole } from "@/lib/types";

/**
 * Who is reading. Either a signed-in session (`AuthContext`) or an API-key
 * principal, which carries the same identity fields the role resolver needs.
 */
export type AccessPrincipal = AuthContext | { userId: string; workspaceId: string };

/** The subset of a Dataset row that authorization depends on. */
export interface DatasetAccessRow {
  id: string;
  workspaceId: string;
  projectId?: string | null;
  ownerId?: string | null;
}

export function toAuthContextLike(principal: AccessPrincipal): AuthContext {
  if ("user" in principal) return principal;
  // Role resolution only reads `user.id` / `workspace.id`; a structural stand-in
  // keeps one resolver for sessions and API keys alike.
  return {
    user: { id: principal.userId },
    workspace: { id: principal.workspaceId },
  } as unknown as AuthContext;
}

export interface RowSecurityResult {
  rows: Cell[][];
  /** True when RLS actually restricted the rows. */
  applied: boolean;
  /** Human-readable note for engine/UI disclosure; "" when unrestricted. */
  note: string;
  /** The caller's effective role on the dataset (null = no access). */
  role: ProjectRole | null;
  /** The restrictions that were applied, for "you are seeing a restricted view" UI. */
  restrictions: string[];
}

/**
 * Apply the dataset owner's RLS rules to already-loaded rows.
 *
 * `opts.skip` exists only for owner-level system operations; a user-facing read
 * must never set it.
 */
export async function applyRowSecurity(
  principal: AccessPrincipal,
  dataset: DatasetAccessRow,
  input: { rows: Cell[][]; columns: ColumnDef[] },
  opts: { skip?: boolean } = {},
): Promise<RowSecurityResult> {
  const ctx = toAuthContextLike(principal);
  const role = await artifactRoleWithOrg(ctx, dataset);

  if (opts.skip) {
    return { rows: input.rows, applied: false, note: "", role, restrictions: [] };
  }

  // Rules come from the workspace that OWNS the dataset. A shared project can
  // live in another workspace, and that workspace's rules are the ones that
  // describe who may see which rows.
  const rules = await loadRlsRules(dataset.workspaceId);
  const filters = filtersForUser(rules, role ?? "OWNER", dataset.id);
  const result = applyRlsToRows(input.rows, input.columns, filters);
  return {
    rows: result.rows,
    applied: result.applied,
    note: result.note,
    role,
    restrictions: filters.map((f) => `${f.column} ∈ { ${f.values.map(String).join(", ")} }`),
  };
}

export interface AuthorizedDataset extends RowSecurityResult {
  datasetId: string;
  datasetName: string;
  projectId: string | null;
  columns: ColumnDef[];
  /** Rows on disk before sampling/RLS — for honest coverage notes. */
  totalRows: number;
  /** Rows actually available to the caller after RLS. */
  rowsLoaded: number;
  /** Set when the engine only saw the first N rows of a larger file. */
  sampleNote: string;
}

export interface LoadOptions {
  minRole?: ProjectRole;
  /** Rows to stream into memory. Defaults to the analysis limit. */
  rowLimit?: number;
  /** Never set this for user-facing reads. */
  skipRls?: boolean;
}

/**
 * Authorize + load a dataset's rows for a user-facing read.
 *
 * Throws 404/403 when the caller has no access, and otherwise returns rows that
 * are already RLS-filtered.
 */
export async function loadAuthorizedDataset(
  principal: AccessPrincipal,
  datasetId: string,
  opts: LoadOptions = {},
): Promise<AuthorizedDataset> {
  const ctx = toAuthContextLike(principal);
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw notFoundError("Dataset not found.");
  const role = await requireRowRoleWithOrg(
    ctx,
    { workspaceId: dataset.workspaceId, projectId: dataset.projectId },
    opts.minRole ?? "VIEWER",
  );

  const columns = datasetColumns(dataset);
  const limit = opts.rowLimit ?? serverEnv().DATASET_ANALYSIS_LIMIT;
  const loaded = await loadParsedDataset(dataset.id, limit);
  const security = await applyRowSecurity(
    principal,
    { ...dataset, id: dataset.id },
    { rows: loaded.rows, columns },
    {
      skip: opts.skipRls,
    },
  );

  const sampleNote =
    loaded.totalRows > loaded.rows.length
      ? ` Showing the first ${loaded.rows.length.toLocaleString()} of ${loaded.totalRows.toLocaleString()} rows.`
      : "";

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    projectId: dataset.projectId,
    columns,
    totalRows: loaded.totalRows,
    rowsLoaded: security.rows.length,
    sampleNote,
    ...security,
    // requireRowRole already proved access; keep the resolved role authoritative.
    role: security.role ?? role,
  };
}
