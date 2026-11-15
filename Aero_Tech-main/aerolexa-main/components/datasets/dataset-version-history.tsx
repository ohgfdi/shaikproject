"use client";

import { History, RefreshCw, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import type { ConnectorChangeLog } from "@/lib/types";

export interface DatasetVersionRow {
  id: string;
  version: number;
  label: string;
  source: "upload" | "re-upload" | "sync" | "materialize" | "demo" | "connector-import";
  rowCount: number;
  columnCount: number;
  changeLog: ConnectorChangeLog | null;
  createdByName: string | null;
  createdAt: string;
}

const SOURCE_LABELS: Record<DatasetVersionRow["source"], string> = {
  upload: "Upload",
  "re-upload": "Re-upload",
  sync: "Connector sync",
  materialize: "SQL materialize",
  demo: "Demo data",
  "connector-import": "Connector import",
};

export function DatasetVersionHistory({ datasetId }: { datasetId: string }) {
  const { toast } = useToast();
  const [versions, setVersions] = useState<DatasetVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ versions: DatasetVersionRow[] }>(`/api/datasets/${datasetId}/versions`);
      setVersions(data.versions);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [datasetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api<{ version: number; changeLog: ConnectorChangeLog }>(`/api/datasets/${datasetId}/replace`, {
        method: "POST",
        body: fd,
      });
      toast({
        title: "Dataset replaced",
        message: `v${res.version} — ${res.changeLog.rowsAdded.toLocaleString()} rows added, ${res.changeLog.rowsRemoved.toLocaleString()} removed. The previous version stays retrievable.`,
        type: "success",
      });
      await load();
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (!versions) return <LoadingSkeleton rows={2} />;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <History aria-hidden className="size-4 text-accent" /> Version history
          {versions.length > 0 && (
            <Badge variant="outline">
              {versions.length} snapshot{versions.length === 1 ? "" : "s"}
            </Badge>
          )}
        </p>
        <div className="flex-1" />
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.pdf"
          className="hidden"
          aria-label="Replace dataset file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void replace(file);
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          icon={<UploadCloud aria-hidden className="size-4" />}
          onClick={() => inputRef.current?.click()}
        >
          Replace data
        </Button>
      </div>

      {error && (
        <ErrorMessage
          title="Could not load version history"
          message={error}
          howToFix="Check the file is a .csv/.xlsx/text-layer .pdf under the upload limit and try again."
          onRetry={() => void load()}
          className="mb-3"
        />
      )}

      {versions.length === 0 ? (
        <p className="text-sm text-muted">
          No snapshots yet — uploading, re-uploading, connector syncs and materialized queries each create an immutable
          version here.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {versions.map((v, i) => (
            <li
              key={v.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm"
            >
              <Badge variant={i === 0 ? "accent" : "outline"}>v{v.version}</Badge>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{v.label}</span>
              <Badge variant="outline">{SOURCE_LABELS[v.source]}</Badge>
              {v.changeLog && (
                <span className="text-caption text-muted" title={v.changeLog.note}>
                  +{v.changeLog.rowsAdded.toLocaleString()} / −{v.changeLog.rowsRemoved.toLocaleString()} rows
                </span>
              )}
              <span className="text-caption text-muted">
                {v.rowCount.toLocaleString()} rows · {timeAgo(v.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 flex items-center gap-1.5 text-caption text-muted">
        <RefreshCw aria-hidden className="size-3.5" />
        Replacing appends a new version — analyses pinned to an old version keep reading its snapshot, and everything is
        diffable.
      </p>
    </Card>
  );
}
