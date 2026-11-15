/**
 * Row-level diff between two pulls of a connector-backed table.
 *
 * Pure function over materialized row arrays: each sync records how many rows
 * were added and removed versus the previous pull so nothing is ever a silent
 * overwrite. Row identity is the full serialized row (there is no guaranteed
 * primary key), so an in-place edit surfaces as one removal + one addition —
 * the note says so explicitly rather than pretending to detect edits.
 */
import type { SqlValue } from "@/lib/types";

export interface ConnectorChangeLog {
  previousRowCount: number;
  newRowCount: number;
  rowsAdded: number;
  rowsRemoved: number;
  comparedRows: number;
  truncated: boolean;
  note: string;
}

const rowKey = (row: SqlValue[]): string => JSON.stringify(row);

export function computeChangeLog(prevRows: SqlValue[][], nextRows: SqlValue[][]): ConnectorChangeLog {
  const prevKeys = new Set(prevRows.map(rowKey));
  const nextKeys = new Set(nextRows.map(rowKey));
  const rowsAdded = nextRows.filter((row) => !prevKeys.has(rowKey(row))).length;
  const rowsRemoved = prevRows.filter((row) => !nextKeys.has(rowKey(row))).length;
  const comparedRows = Math.max(prevRows.length, nextRows.length);

  let note: string;
  if (rowsAdded === 0 && rowsRemoved === 0) {
    note = `No row-level differences detected (${comparedRows.toLocaleString()} rows compared).`;
  } else if (rowsAdded > 0 && rowsRemoved > 0) {
    note = `${rowsAdded.toLocaleString()} row(s) added and ${rowsRemoved.toLocaleString()} row(s) removed or changed. An in-place edit counts as one removal plus one addition because rows are compared as whole records.`;
  } else if (rowsAdded > 0) {
    note = `${rowsAdded.toLocaleString()} new row(s) since the previous pull.`;
  } else {
    note = `${rowsRemoved.toLocaleString()} row(s) no longer present in the source.`;
  }

  return {
    previousRowCount: prevRows.length,
    newRowCount: nextRows.length,
    rowsAdded,
    rowsRemoved,
    comparedRows,
    truncated: false,
    note,
  };
}
