/**
 * Notebook version history engine.
 *
 * Implements Hex's version history feature: every meaningful edit creates an
 * immutable snapshot. Users can browse, compare, and restore previous versions.
 *
 * Dependency-free + unit-tested (__tests__/unit/notebook-versions.test.ts).
 */

import type { NotebookCell, NotebookVersion } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VersionDiff {
  /** Cells added in the new version. */
  added: NotebookCell[];
  /** Cells removed in the new version. */
  removed: NotebookCell[];
  /** Cells whose content changed. */
  modified: { cellId: string; oldContent: string; newContent: string; kind?: string }[];
  /** Cells that were reordered (same content, different position). */
  reordered: string[];
  /** Cells whose outputs changed. */
  outputChanged: string[];
  /** Whether the notebook title changed. */
  titleChanged: boolean;
  oldTitle?: string;
  newTitle?: string;
}

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

let snapshotCounter = 0;

/**
 * Create an immutable snapshot of the current notebook state.
 */
export function createSnapshot(
  notebookId: string,
  cells: NotebookCell[],
  title: string,
  version: number,
  authorName: string,
  label?: string,
): NotebookVersion {
  return {
    id: `v${version}-${notebookId}-${++snapshotCounter}`,
    notebookId,
    version,
    cells: structuredClone(cells),
    title,
    createdAt: new Date().toISOString(),
    authorName,
    label: label ?? "auto",
  };
}

/**
 * Determine if a cell change is significant enough to warrant a new version.
 */
export function isSignificantChange(
  oldCells: NotebookCell[],
  newCells: NotebookCell[],
  oldTitle: string,
  newTitle: string,
): boolean {
  // Title changed
  if (oldTitle !== newTitle) return true;

  // Number of cells changed
  if (oldCells.length !== newCells.length) return true;

  // Build ID sets
  const oldIds = new Set(oldCells.map((c) => c.id));
  const newIds = new Set(newCells.map((c) => c.id));

  // Any cell added or removed?
  if (oldIds.size !== newIds.size) return true;
  for (const id of oldIds) {
    if (!newIds.has(id)) return true;
  }

  // Check content changes
  const oldMap = new Map(oldCells.map((c) => [c.id, c]));
  for (const cell of newCells) {
    const old = oldMap.get(cell.id);
    if (!old) return true;
    if (old.content !== cell.content) return true;
    if (old.kind !== cell.kind) return true;
    // Widget config changes
    if (JSON.stringify(old.widget) !== JSON.stringify(cell.widget)) return true;
    if (JSON.stringify(old.sqlConfig) !== JSON.stringify(cell.sqlConfig)) return true;
    if (JSON.stringify(old.chartConfig) !== JSON.stringify(cell.chartConfig)) return true;
    if (JSON.stringify(old.tableDisplayConfig) !== JSON.stringify(cell.tableDisplayConfig)) return true;
    if (JSON.stringify(old.pivotConfig) !== JSON.stringify(cell.pivotConfig)) return true;
    if (JSON.stringify(old.mapConfig) !== JSON.stringify(cell.mapConfig)) return true;
    if (old.outputVariable !== cell.outputVariable) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Compute a detailed diff between two notebook versions.
 */
export function computeVersionDiff(oldVersion: NotebookVersion, newVersion: NotebookVersion): VersionDiff {
  const oldMap = new Map(oldVersion.cells.map((c) => [c.id, c]));
  const newMap = new Map(newVersion.cells.map((c) => [c.id, c]));

  const added: NotebookCell[] = [];
  const removed: NotebookCell[] = [];
  const modified: VersionDiff["modified"] = [];
  const outputChanged: string[] = [];

  // Find added and modified cells
  for (const cell of newVersion.cells) {
    const old = oldMap.get(cell.id);
    if (!old) {
      added.push(cell);
      continue;
    }
    if (old.content !== cell.content) {
      modified.push({
        cellId: cell.id,
        oldContent: old.content,
        newContent: cell.content,
        kind: cell.kind,
      });
    }
    // Check output changes
    if (JSON.stringify(old.output) !== JSON.stringify(cell.output)) {
      outputChanged.push(cell.id);
    }
  }

  // Find removed cells
  for (const cell of oldVersion.cells) {
    if (!newMap.has(cell.id)) {
      removed.push(cell);
    }
  }

  // Detect reorders (cells with same content but different position)
  const reordered: string[] = [];
  const oldOrder = oldVersion.cells.map((c) => c.id);
  const newOrder = newVersion.cells.map((c) => c.id);
  if (oldOrder.length === newOrder.length) {
    // Find cells whose position changed but content didn't
    for (let i = 0; i < newOrder.length; i++) {
      const newId = newOrder[i]!;
      const oldIdx = oldOrder.indexOf(newId);
      const cell = newMap.get(newId);
      const oldCell = oldMap.get(newId);
      if (cell && oldCell && cell.content === oldCell.content && oldIdx !== i) {
        reordered.push(newId);
      }
    }
  }

  // Title change
  const titleChanged = oldVersion.title !== newVersion.title;

  return {
    added,
    removed,
    modified,
    reordered,
    outputChanged,
    titleChanged,
    oldTitle: oldVersion.title,
    newTitle: newVersion.title,
  };
}

/**
 * Summarize a diff as human-readable bullet points.
 */
export function summarizeDiff(diff: VersionDiff): string[] {
  const lines: string[] = [];

  if (diff.titleChanged) {
    lines.push(`Title changed: "${diff.oldTitle}" → "${diff.newTitle}"`);
  }
  if (diff.added.length > 0) {
    lines.push(`Added ${diff.added.length} cell(s): ${diff.added.map((c) => c.kind).join(", ")}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`Removed ${diff.removed.length} cell(s): ${diff.removed.map((c) => c.kind).join(", ")}`);
  }
  if (diff.modified.length > 0) {
    lines.push(`Modified ${diff.modified.length} cell(s)`);
    for (const m of diff.modified.slice(0, 3)) {
      const preview = m.newContent.slice(0, 60).replace(/\n/g, " ");
      lines.push(`  - ${m.cellId.slice(0, 8)}…: "${preview}${m.newContent.length > 60 ? "…" : ""}"`);
    }
    if (diff.modified.length > 3) {
      lines.push(`  … and ${diff.modified.length - 3} more`);
    }
  }
  if (diff.reordered.length > 0) {
    lines.push(`Reordered ${diff.reordered.length} cell(s)`);
  }
  if (diff.outputChanged.length > 0) {
    lines.push(`Outputs changed for ${diff.outputChanged.length} cell(s)`);
  }

  return lines.length > 0 ? lines : ["No changes detected"];
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a specific version's cells into the current notebook state.
 * Returns the cells from the restored version.
 */
export function restoreVersion(version: NotebookVersion, currentCells: NotebookCell[]): NotebookCell[] {
  // Restore cells but preserve current IDs for cells that still exist
  const currentMap = new Map(currentCells.map((c) => [c.id, c]));
  const result: NotebookCell[] = [];

  for (const vCell of version.cells) {
    const current = currentMap.get(vCell.id);
    if (current) {
      // Keep current ID, restore version content
      result.push({
        ...vCell,
        id: current.id,
        // Clear outputs since they may be stale
        output: null,
        ranAt: null,
      });
    } else {
      // Cell was added in the old version; restore with new IDs
      const newId = `restored-${vCell.id}-${Date.now()}`;
      result.push({
        ...vCell,
        id: newId,
        output: null,
        ranAt: null,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Prune old versions to keep at most `maxVersions` snapshots.
 * Always keeps the first version, the most recent version, and any
 * manually labelled versions (non-auto).
 */
export function pruneVersions(versions: NotebookVersion[], maxVersions: number): NotebookVersion[] {
  if (versions.length <= maxVersions) return versions;

  const sorted = [...versions].sort((a, b) => a.version - b.version);

  // Always keep first and last
  const keep = new Set<string>();
  keep.add(sorted[0]!.id);
  keep.add(sorted[sorted.length - 1]!.id);

  // Keep manually labelled versions
  for (const v of sorted) {
    if (v.label && v.label !== "auto") {
      keep.add(v.id);
    }
  }

  // Fill remaining slots with most recent auto versions
  const remaining = maxVersions - keep.size;
  if (remaining > 0) {
    const autoVersions = sorted.filter((v) => !keep.has(v.id)).sort((a, b) => b.version - a.version);
    for (let i = 0; i < Math.min(remaining, autoVersions.length); i++) {
      keep.add(autoVersions[i]!.id);
    }
  }

  return sorted.filter((v) => keep.has(v.id));
}
