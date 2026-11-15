"use client";

import { Download, FileCode, GitCompare, History } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Card, Badge } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { CALCULATED_LABEL, TRUST_EXPLANATION } from "@/lib/trust/labels";

export interface AnalysisVersionView {
  id: string;
  version: number;
  datasetVersionId: string | null;
  createdAt: string;
  title: string;
  metricCount: number;
}

export interface MetricDiffView {
  key: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  deltaPct: number | null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Version history + diff + "Export runnable code" for one analysis. */
export function VersionsPanel({ analysisId }: { analysisId: string }) {
  const [versions, setVersions] = useState<AnalysisVersionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{
    from: { version: number };
    to: { version: number };
    changed: MetricDiffView[];
    added: { label: string; value: number }[];
    removed: { label: string; value: number }[];
    unchangedCount: number;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const load = async () => {
    try {
      const data = await api<{ versions: AnalysisVersionView[] }>(`/api/analyses/${analysisId}/versions`);
      setVersions(data.versions);
    } catch (err) {
      setError(errorMessage(err));
      setVersions([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2);
      return next;
    });
  };

  const runDiff = async () => {
    if (selected.length !== 2 || !versions) return;
    const ordered = versions.filter((v) => selected.includes(v.id)).sort((a, b) => a.version - b.version);
    setError(null);
    try {
      const data = await api<{
        diff: {
          from: { version: number };
          to: { version: number };
          changed: MetricDiffView[];
          added: { label: string; value: number }[];
          removed: { label: string; value: number }[];
          unchangedCount: number;
        };
      }>(`/api/analyses/${analysisId}/versions`, {
        method: "POST",
        body: JSON.stringify({ fromVersionId: ordered[0]?.id, toVersionId: ordered[1]?.id }),
      });
      setDiff(data.diff);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const download = (format: "python" | "ipynb") => {
    // Simplest robust approach: navigate to the export endpoint with query
    // params so the browser handles the attachment download + auth cookie.
    window.location.href = `/api/analyses/${analysisId}/versions?format=${format}&export=1`;
    setDiff(null);
  };

  if (versions !== null && versions.length === 0 && !error) {
    return (
      <Card className="mt-5 p-4 text-sm text-muted">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <History aria-hidden className="size-4" /> Version history
        </p>
        <p className="mt-1.5">
          This analysis has no recorded versions yet. Re-running it (Analysis Lab → same dataset &amp; settings) records
          a new version you can diff against this one — and every result can be exported as runnable Python or a .ipynb
          notebook.
        </p>
      </Card>
    );
  }

  return (
    <Card className="mt-5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <History aria-hidden className="size-4" /> Version history
        </p>
        <span className="badge bg-success/10 text-success">{CALCULATED_LABEL}</span>
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="xs"
          onClick={() => download("python")}
          icon={<FileCode aria-hidden className="size-3.5" />}
        >
          Export .py
        </Button>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => download("ipynb")}
          icon={<Download aria-hidden className="size-3.5" />}
        >
          Export .ipynb
        </Button>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => void runDiff()}
          disabled={selected.length !== 2}
          icon={<GitCompare aria-hidden className="size-3.5" />}
        >
          Diff selected (2)
        </Button>
      </div>

      {error && <ErrorMessage title="Version history error" message={error} className="mt-3" />}

      {versions && versions.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {versions.map((v) => (
            <li
              key={v.id}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                aria-label={`Select version ${v.version} for diff`}
                checked={selected.includes(v.id)}
                onChange={() => toggle(v.id)}
                className="size-3.5"
              />
              <Badge variant="outline">v{v.version}</Badge>
              <span className="truncate text-foreground" title={v.title}>
                {v.title}
              </span>
              <span className="ml-auto whitespace-nowrap text-caption text-muted">
                {v.metricCount} metrics · {new Date(v.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {diff && (
        <div className="mt-4 rounded-md border border-line bg-surface p-3">
          <p className="text-sm font-medium text-foreground">
            Diff v{diff.from.version} → v{diff.to.version} · {diff.changed.length} changed, {diff.added.length} added,{" "}
            {diff.removed.length} removed, {diff.unchangedCount} unchanged
          </p>
          {diff.changed.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No numeric metric changed between these versions.</p>
          ) : (
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr className="text-caption text-muted">
                  <th className="py-1 pr-2">Metric</th>
                  <th className="py-1 pr-2 text-right">Before</th>
                  <th className="py-1 pr-2 text-right">After</th>
                  <th className="py-1 pr-2 text-right">Δ</th>
                  <th className="py-1 text-right">Δ%</th>
                </tr>
              </thead>
              <tbody>
                {diff.changed.map((m) => (
                  <tr key={m.key} className="border-t border-line">
                    <td className="py-1 pr-2">{m.label}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmt(m.before)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmt(m.after)}</td>
                    <td className={`py-1 pr-2 text-right tabular-nums ${m.delta > 0 ? "text-accent" : "text-warning"}`}>
                      {m.delta > 0 ? "+" : ""}
                      {fmt(m.delta)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {m.deltaPct === null ? "—" : `${m.deltaPct > 0 ? "+" : ""}${fmt(m.deltaPct)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}
