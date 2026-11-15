"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/overlays";
import { api, errorMessage } from "@/lib/client/api";

/** Client entry point for server pages — the button owns the dialog state. */
export function ProjectCreateButton({ label = "New project" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inline-flex">
      <Button onClick={() => setOpen(true)} icon={<Plus aria-hidden className="size-4" />}>
        {label}
      </Button>
      <ProjectCreateDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function ProjectCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", description: "", company: "", industry: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (form.name.trim().length < 2) {
      setError("Give the project a name (at least 2 characters).");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          company: form.company || undefined,
          industry: form.industry || undefined,
        }),
      });
      toast({ title: "Project created", type: "success" });
      onClose();
      router.push(`/projects/${res.project.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="Projects group datasets, analyses, insights, dashboards, reports and presentations."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} loading={busy}>
            Create project
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorMessage title="Could not create project" message={error} />}
        <Input
          label="Project name"
          id="p-name"
          required
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Q3 performance review"
        />
        <Field label="Description" helper="Optional — who this project is for and what it decides." htmlFor="p-desc">
          <textarea
            id="p-desc"
            className="min-h-16 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Client / company"
            id="p-company"
            value={form.company}
            onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
          />
          <Input
            label="Industry"
            id="p-industry"
            value={form.industry}
            onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))}
          />
        </div>
      </div>
    </Dialog>
  );
}
