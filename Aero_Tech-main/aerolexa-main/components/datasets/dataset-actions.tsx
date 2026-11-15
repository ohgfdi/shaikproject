"use client";

import { ArrowDown, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { ErrorMessage } from "@/components/ui/feedback";
import { Dialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/overlays";
import { api, errorMessage } from "@/lib/client/api";
import type { ColType } from "@/lib/types";

export interface ActionColumn {
  name: string;
  type: ColType;
}

export function DatasetColumnOps({ datasetId, columns }: { datasetId: string; columns: ActionColumn[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ActionColumn[]>(columns);

  const runOp = async (op: { kind: "cast" | "rename" | "drop"; name: string; type?: ColType; newName?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/datasets/${datasetId}`, { method: "PATCH", body: JSON.stringify({ ops: [op] }) });
      toast({
        title: "Dataset updated",
        message: op.kind === "drop" ? `Column “${op.name}” removed.` : "Column metadata updated. Profile recalculated.",
        type: "success",
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setType = (name: string, type: ColType) => {
    setRows((r) => r.map((c) => (c.name === name ? { ...c, type } : c)));
    void runOp({ kind: "cast", name, type });
  };

  const rename = (name: string) => {
    const fresh = window.prompt("New column name", name);
    const trimmed = fresh?.trim();
    if (!trimmed || trimmed === name) return;
    void runOp({ kind: "rename", name, newName: trimmed });
  };

  return (
    <div>
      {error && (
        <ErrorMessage
          title="Could not update the dataset"
          message={error}
          howToFix="Re-casting needs at least 2 characters; drops are immediate."
          className="mb-3"
        />
      )}
      <div className="thin-scroll overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {["Column", "Type", "Recast to", "Actions"].map((h) => (
                <th
                  key={h}
                  className="sticky top-0 border-b border-line bg-surface-2 px-3 py-2 text-caption font-semibold uppercase text-muted"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((col) => (
              <tr key={col.name} className="hover:bg-surface-2/50">
                <td className="px-3 py-2 font-medium text-foreground">{col.name}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-caption font-medium ${typeColor(col.type)}`}>
                    {col.type}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`Recast ${col.name}`}
                    value={col.type}
                    onChange={(e) => setType(col.name, e.target.value as ColType)}
                    disabled={busy}
                    className="h-8 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60 disabled:opacity-50"
                  >
                    {(["string", "number", "date", "boolean"] as ColType[]).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => rename(col.name)}
                      aria-label={`Rename ${col.name}`}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Drop column ${col.name}`}
                      className="text-muted hover:text-danger"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Drop column “${col.name}”?`,
                          message:
                            "Data in it will be removed from the stored dataset. Analyses already run keep their stored results.",
                          confirmLabel: "Drop column",
                        });
                        if (!ok) return;
                        await runOp({ kind: "drop", name: col.name });
                      }}
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-caption text-muted">
        <ArrowDown aria-hidden className="size-3.5" />
        Re-casting converts values and recomputes the profile; analyses already run keep their stored results.
      </p>
    </div>
  );
}

function typeColor(type: ColType): string {
  switch (type) {
    case "number":
      return "bg-[#58B368]/12 text-[#2E7D46] dark:text-[#7ED096]";
    case "date":
      return "bg-[#3D9BE9]/12 text-[#1E6FB5] dark:text-[#6FB8F0]";
    case "boolean":
      return "bg-[#7C5CFF]/12 text-[#5B3FBF] dark:text-[#B7A3FF]";
    default:
      return "bg-surface-2 text-muted";
  }
}

export function DatasetDeleteButton({ datasetId, projectId }: { datasetId: string; projectId: string | null }) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  return (
    <Button
      variant="danger"
      size="sm"
      onClick={async () => {
        const ok = await confirm({
          title: "Delete this dataset?",
          message: "Its analyses and insights are removed too (files on disk are cleaned up).",
          confirmLabel: "Delete",
        });
        if (!ok) return;
        try {
          await api(`/api/datasets/${datasetId}`, { method: "DELETE" });
          toast({ title: "Dataset deleted", type: "success" });
          router.push(projectId ? `/projects/${projectId}?tab=datasets` : "/projects");
          router.refresh();
        } catch (err) {
          toast({ title: "Could not delete dataset", message: errorMessage(err), type: "error" });
        }
      }}
    >
      Delete dataset
    </Button>
  );
}

export function GenerateInsightsButton({ datasetId }: { datasetId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<SparklesIcon />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api<{ created: number }>(`/api/datasets/${datasetId}/insights`, { method: "POST" });
          toast({
            title: "Insights generated",
            message: `${res.created} new evidence-backed card(s).`,
            type: "success",
          });
          router.refresh();
        } catch (err) {
          toast({ title: "Could not generate insights", message: errorMessage(err), type: "error" });
        } finally {
          setBusy(false);
        }
      }}
    >
      Generate insights
    </Button>
  );
}

function SparklesIcon() {
  return <Sparkles className="size-4" />;
}

export function DatasetRename({
  datasetId,
  current,
  onRenamed,
}: {
  datasetId: string;
  current: string;
  onRenamed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/datasets/${datasetId}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setOpen(false);
      toast({ title: "Dataset renamed", type: "success" });
      onRenamed?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Rename
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rename dataset"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={busy}>
              Save name
            </Button>
          </>
        }
      >
        {error && <ErrorMessage title="Rename failed" message={error} className="mb-3" />}
        <label className="text-sm">
          <span className="mb-1.5 block font-medium text-foreground">Display name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
          />
        </label>
      </Dialog>
    </>
  );
}
