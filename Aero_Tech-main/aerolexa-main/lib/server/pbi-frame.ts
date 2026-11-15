/**
 * Shared server helper for the Power BI–style feature endpoints:
 * loads a dataset with role checks and returns columns + rows plus the
 * project context needed for activity logging.
 *
 * Row-level security is enforced by the shared chokepoint
 * (`lib/server/dataset-access.ts`), which resolves the rules from the
 * workspace that OWNS the dataset — not the caller's workspace.
 */
import { ApiError, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { loadAuthorizedDataset } from "@/lib/server/dataset-access";
import type { SqlValue } from "@/lib/types";

export interface DatasetFrame {
  datasetId: string;
  datasetName: string;
  projectId: string | null;
  columns: { name: string; type: string }[];
  rows: SqlValue[][];
  rowCount: number;
  rowsLoaded: number;
  /** Non-empty when row-level security restricted the loaded rows. */
  rlsNote: string;
}

export async function loadDatasetFrame(ctx: AuthContext, datasetId: string): Promise<DatasetFrame> {
  const loaded = await loadAuthorizedDataset(ctx, datasetId, { minRole: "VIEWER" });
  return {
    datasetId: loaded.datasetId,
    datasetName: loaded.datasetName,
    projectId: loaded.projectId,
    columns: loaded.columns,
    rows: loaded.rows as SqlValue[][],
    rowCount: loaded.totalRows,
    rowsLoaded: loaded.rowsLoaded,
    rlsNote: loaded.note,
  };
}

/** Reusable ApiError for malformed engine requests. */
export function badRequest(message: string): ApiError {
  return new ApiError(400, "BAD_REQUEST", message);
}

export { notFoundError };
