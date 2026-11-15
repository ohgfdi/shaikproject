"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Upload a CSV/XLSX into a project. Uploads are project-scoped (the server
 * requires a projectId), so the reviewer picks the project up front — this is
 * the entry point the command palette's "Datasets upload" action leads to.
 */
export function DatasetUploader({ projects }: { projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
        Create a project first — every dataset is stored against one.
      </div>
    );
  }

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!projectId) {
      setError("Choose a project to store the dataset.");
      return;
    }
    if (!file) {
      setError("Choose a CSV or XLSX file to upload.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("projectId", projectId);
      fd.append("file", file);
      const res = await api<{ datasetId: string }>("/api/upload", { method: "POST", body: fd });
      toast({ title: "Dataset uploaded & profiled", type: "success" });
      router.push(`/datasets/${res.datasetId}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Store in project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700">CSV / XLSX file</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="h-9 text-sm file:mr-2 file:rounded file:border-0 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-white"
          />
        </label>
        <Button disabled={busy} onClick={() => void upload()}>
          {busy ? "Uploading…" : "Upload dataset"}
        </Button>
      </div>
      {error && <ErrorMessage message={error} />}
    </div>
  );
}
