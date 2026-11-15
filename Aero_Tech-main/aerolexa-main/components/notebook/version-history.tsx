"use client";

/**
 * Notebook Version History panel.
 *
 * Shows a timeline of notebook snapshots with diffs, allowing users to
 * browse and restore previous versions — equivalent to Hex's version history.
 */

import { Clock, Diff, RotateCcw, Save, Tag } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { api } from "@/lib/client/api";
import type { NotebookCell, NotebookVersion } from "@/lib/types";

interface VersionHistoryProps {
  notebookId: string;
  currentCells: NotebookCell[];
  currentTitle: string;
  onRestore: (cells: NotebookCell[]) => void;
}

interface VersionDiffSummary {
  added: number;
  removed: number;
  modified: number;
  reordered: number;
}

export function VersionHistory({
  notebookId,
  currentCells,
  currentTitle: _currentTitle,
  onRestore,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<NotebookVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ versions: NotebookVersion[] }>(`/api/notebooks/${notebookId}/versions`);
      setVersions(data.versions);
    } catch (err) {
      console.error("Failed to load versions:", err);
    } finally {
      setLoading(false);
    }
  }, [notebookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSnapshot = async (label?: string) => {
    setSaving(true);
    try {
      await api(`/api/notebooks/${notebookId}/versions`, {
        method: "POST",
        body: JSON.stringify({ cells: currentCells, label: label ?? "manual" }),
      });
      await load();
    } catch (err) {
      console.error("Failed to save version:", err);
    } finally {
      setSaving(false);
    }
  };

  const restoreVersion = async (version: NotebookVersion) => {
    setRestoring(version.id);
    try {
      const data = await api<{ cells: NotebookCell[] }>(`/api/notebooks/${notebookId}/versions`, {
        method: "PATCH",
        body: JSON.stringify({ versionId: version.id }),
      });
      onRestore(data.cells);
      await load();
    } catch (err) {
      console.error("Failed to restore version:", err);
    } finally {
      setRestoring(null);
    }
  };

  const computeDiff = (oldCells: NotebookCell[], newCells: NotebookCell[]): VersionDiffSummary => {
    const oldIds = new Set(oldCells.map((c) => c.id));
    const newIds = new Set(newCells.map((c) => c.id));

    const added = newCells.filter((c) => !oldIds.has(c.id));
    const removed = oldCells.filter((c) => !newIds.has(c.id));

    const modified = newCells.filter((nc) => {
      const oc = oldCells.find((c) => c.id === nc.id);
      return oc && (oc.content !== nc.content || oc.kind !== nc.kind);
    });

    const reordered = newCells.filter((nc, i) => {
      const oldIdx = oldCells.findIndex((c) => c.id === nc.id);
      return oldIdx >= 0 && oldIdx !== i;
    });

    return {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      reordered: reordered.length,
    };
  };

  if (loading) {
    return (
      <div className="p-3">
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock aria-hidden className="size-4 text-accent" />
            <h3 className="text-sm font-medium text-foreground">Version History</h3>
          </div>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => void saveSnapshot()}
            loading={saving}
            icon={<Save aria-hidden className="size-3" />}
          >
            Save snapshot
          </Button>
        </div>
        <p className="mt-1 text-caption text-muted">
          {versions.length} version{versions.length !== 1 ? "s" : ""} saved
        </p>
      </div>

      {/* Version list */}
      <div className="flex-1 overflow-y-auto thin-scroll">
        {versions.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Clock aria-hidden className="mx-auto size-8 text-muted" />
            <p className="mt-2 text-sm text-muted">No versions yet</p>
            <p className="text-caption text-muted">
              Versions are created automatically when cells run. You can also save a snapshot manually.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {versions.map((v, i) => {
              const isSelected = selectedVersion === v.id;
              const isCurrent = i === 0; // most recent is current
              const prevCells = i < versions.length - 1 ? (versions[i + 1]?.cells ?? []) : [];
              const diff = computeDiff(prevCells, v.cells);

              return (
                <li key={v.id}>
                  <button
                    onClick={() => setSelectedVersion(isSelected ? null : v.id)}
                    className="w-full px-3 py-2 text-left hover:bg-surface-2"
                    aria-expanded={isSelected}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={isCurrent ? "accent" : "outline"}>v{v.version}</Badge>
                      {v.label && v.label !== "auto" && (
                        <Badge variant="info">
                          <Tag aria-hidden className="size-2.5 mr-1" />
                          {v.label}
                        </Badge>
                      )}
                      <span className="ml-auto text-caption text-muted">{new Date(v.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {diff.added > 0 && <span className="text-xs text-success">+{diff.added} added</span>}
                      {diff.removed > 0 && <span className="text-xs text-danger">-{diff.removed} removed</span>}
                      {diff.modified > 0 && <span className="text-xs text-warning">{diff.modified} modified</span>}
                      {diff.reordered > 0 && <span className="text-xs text-muted">{diff.reordered} reordered</span>}
                    </div>
                  </button>

                  {/* Expanded version details */}
                  {isSelected && (
                    <div className="border-t border-line bg-surface px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Diff aria-hidden className="size-4 text-muted" />
                        <span className="text-sm font-medium text-foreground">Changes</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded bg-success/10 px-2 py-1 text-success">+{diff.added} cells added</div>
                        <div className="rounded bg-danger/10 px-2 py-1 text-danger">-{diff.removed} cells removed</div>
                        <div className="rounded bg-warning/10 px-2 py-1 text-warning">
                          {diff.modified} cells modified
                        </div>
                        <div className="rounded bg-surface-2 px-2 py-1 text-muted">{diff.reordered} cells moved</div>
                      </div>
                      <p className="mt-2 text-caption text-muted">
                        {v.cells.length} cells · {v.cells.filter((c) => c.kind === "code").length} code cells
                      </p>
                      {!isCurrent && (
                        <Button
                          size="xs"
                          variant="secondary"
                          className="mt-2"
                          onClick={() => void restoreVersion(v)}
                          loading={restoring === v.id}
                          icon={<RotateCcw aria-hidden className="size-3" />}
                        >
                          Restore this version
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
