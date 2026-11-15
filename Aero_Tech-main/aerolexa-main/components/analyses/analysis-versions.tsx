"use client";

import { FileCode2, GitCompareArrows, History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { CALCULATED_LABEL, TRUST_EXPLANATION } from "@/lib/trust/labels";
import { timeAgo } from "@/lib/format";

export interface AnalysisVersionRow {
  id: string;
  version: number;
  kind: string;
  title: string;
  createdAt: string;
  createdByName: string | null;
  datasetVersion: { version: number; label: string; source: string } | null;
}

interface DiffRow {
  metric: string;
  from: number;
  to: number;
  delta: number;
  deltaPct: number | null;
}

interface DiffResponse {
  from: { version: number };
  to: { version: number };
  changed: DiffRow[];
  changedCount: number;
  error?: string;
}

export function AnalysisVersions({ analysisId }: { analysisId: string }) {
  const [versions, setVersions] = useState<AnalysisVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffing, setDiffing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ versions: AnalysisVersionRow[] }>(`/api/analyses/${analysisId}/versions`);
      setVersions(data.versions);
      // Default: newest vs the one before it.
      if (data.versions.length >= 2) {
        setFromId(data.versions[1]!.id);
        setToId(data.versions[0]!.id);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [analysisId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runDiff = async () => {
    if (!fromId || !toId || fromId === toId) return;
    setDiffing(true);
    setError(null);
    try {
      const data = await api<DiffResponse>(`/api/analyses/${analysisId}/diff?from=${fromId}&to=${toId}`);
      setDiff(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDiffing(false);
    }
  };

  if (!versions) return <LoadingSkeleton rows={2} />;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <History aria-hidden className="size-4 text-accent" /> Result versions
          <Badge variant="outline">
            {versions.length} run{versions.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="success">{CALCULATED_LABEL}</Badge>
        </p>
        <div className="flex-1" />
        {versions.length > 0 && (
          <a href={`/api/analyses/${analysisId}/export-python?versionId=${toId || versions[0]?.id}`} download>
            <Button variant="secondary" size="sm" icon={<FileCode2 aria-hidden className="size-4" />}>
              Export Python
            </Button>
          </a>
        )}
      </div>

      {error && (
        <ErrorMessage title="Could not load versions" message={error} onRetry={() => void load()} className="mb-3" />
      )}

      {versions.length === 0 ? (
        <p className="text-sm text-muted">
          Every run (and re-run) is recorded here as an immutable version — pin to a dataset snapshot, diff any two
          versions, and export runnable Python that reproduces the exact result.
        </p>
      ) : (
        <>
          <ol className="flex flex-col gap-2">
            {versions.map((v, i) => (
              <li
                key={v.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm"
              >
                <Badge variant={i === 0 ? "accent" : "outline"}>v{v.version}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={v.title}>
                  {v.title}
                </span>
                {v.datasetVersion && <Badge variant="outline">dataset v{v.datasetVersion.version}</Badge>}
                <span className="text-caption text-muted">
                  {v.createdByName ?? "unknown"} · {timeAgo(v.createdAt)}
                </span>
                <a href={`/api/analyses/${analysisId}/export-python?versionId=${v.id}`} download>
                  <Button variant="ghost" size="xs" icon={<FileCode2 aria-hidden className="size-3" />}>
                    .py
                  </Button>
                </a>
              </li>
            ))}
          </ol>

          {versions.length >= 2 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                <GitCompareArrows aria-hidden className="size-4 text-accent" /> Compare two versions
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-caption text-muted">From</span>
                  <select
                    value={fromId}
                    onChange={(e) => setFromId(e.target.value)}
                    className="h-9 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version} · {timeAgo(v.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-caption text-muted">To</span>
                  <select
                    value={toId}
                    onChange={(e) => setToId(e.target.value)}
                    className="h-9 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version} · {timeAgo(v.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void runDiff()}
                  loading={diffing}
                  disabled={!fromId || !toId || fromId === toId}
                  icon={<GitCompareArrows aria-hidden className="size-4" />}
                >
                  Diff
                </Button>
              </div>

              {diff && (
                <div className="mt-3">
                  {diff.error ? (
                    <p className="text-sm text-muted">{diff.error}</p>
                  ) : diff.changedCount === 0 ? (
                    <p className="text-sm text-muted">
                      v{diff.from.version} → v{diff.to.version}: no numeric metrics changed.
                    </p>
                  ) : (
                    <>
                      <p className="mb-2 text-caption text-muted">
                        v{diff.from.version} → v{diff.to.version}: {diff.changedCount} metric
                        {diff.changedCount === 1 ? "" : "s"} changed
                      </p>
                      <ul className="flex flex-col gap-1.5">
                        {diff.changed.map((row) => (
                          <li
                            key={row.metric}
                            className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate text-foreground" title={row.metric}>
                              {row.metric}
                            </span>
                            <span className="tabular-nums text-muted">{fmtVal(row.from)}</span>
                            <span aria-hidden className="text-muted">
                              →
                            </span>
                            <span className="tabular-nums font-medium text-foreground">{fmtVal(row.to)}</span>
                            <Badge variant={row.delta >= 0 ? "success" : "warning"}>
                              {row.delta >= 0 ? "+" : ""}
                              {fmtVal(row.delta)}
                              {row.deltaPct !== null
                                ? ` (${row.deltaPct >= 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%)`
                                : ""}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function fmtVal(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(4).replace(/\.?0+$/, "");
}
