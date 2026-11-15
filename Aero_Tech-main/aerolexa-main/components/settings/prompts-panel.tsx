"use client";

import { BookMarked, GitBranch, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import type { PromptItem } from "@/lib/types";

const SUGGESTED = `You are the data advisor for {{project}}. Answer the business question below using the dataset “{{dataset}}”.
Business question: {{question}}
Use {{metric}} over {{timeframe}} as the primary evidence, and end with a clear recommendation.`;

export function PromptsPanel() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [prompts, setPrompts] = useState<PromptItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PromptItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState(SUGGESTED);
  const [isAdvisor, setIsAdvisor] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ prompts: PromptItem[] }>("/api/prompts");
      setPrompts(data.prompts);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setName("");
    setDescription("");
    setTemplate(SUGGESTED);
    setIsAdvisor(false);
    setEditing(null);
    setCreating(true);
  };
  const openEdit = (p: PromptItem) => {
    setName(p.name);
    setDescription(p.description ?? "");
    setTemplate(p.template);
    setIsAdvisor(p.isAdvisorTemplate);
    setEditing(p);
    setCreating(true);
  };

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      if (editing) {
        await api(`/api/prompts/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, description, template, isAdvisorTemplate: isAdvisor }),
        });
        toast({ title: "Prompt updated", type: "success" });
      } else {
        await api("/api/prompts", {
          method: "POST",
          body: JSON.stringify({ name, description, template, isAdvisorTemplate: isAdvisor }),
        });
        toast({ title: "Prompt created", type: "success" });
      }
      setCreating(false);
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PromptItem) => {
    const ok = await confirm({
      title: `Delete prompt “${p.name}”?`,
      message: "Saved prompts no longer in use will be removed from the workspace.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/prompts/${p.id}`, { method: "DELETE" });
      toast({ title: "Prompt deleted", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not delete prompt", message: errorMessage(err), type: "error" });
    }
  };

  const variablesIn = (t: string) => {
    const out: string[] = [];
    const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.push(m[1] as string);
    return out;
  };

  return (
    <section aria-label="Prompt library">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-h2 text-foreground">Prompt library</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Reusable prompt templates with {"{{variable}}"} slots for the Business Advisor and future chained agents.
            Prompts are stored in your workspace; advisor answers are computed locally by the deterministic,
            oracle-validated engine (labelled Calculated).
          </p>
        </div>
        <DemoBadge tooltip="Prompts execute through the deterministic advisor (oracle-validated statistics, Calculated label); live LLM backends plug in later without UI changes." />
      </div>
      <div className="mt-3">
        <Button onClick={openCreate} icon={<Plus aria-hidden className="size-4" />}>
          New prompt
        </Button>
      </div>

      {error && (
        <ErrorMessage title="Could not load prompts" message={error} onRetry={() => void load()} className="mt-4" />
      )}
      {!prompts && !error && (
        <div className="mt-4">
          <LoadingSkeleton rows={1} />
        </div>
      )}

      {prompts && prompts.length === 0 && (
        <Card className="mt-4">
          <EmptyState
            icon={BookMarked}
            title="No prompts yet"
            description="Create a template with {{dataset}}, {{metric}} or {{timeframe}} variables."
            action={
              <Button onClick={openCreate} icon={<Plus aria-hidden className="size-4" />}>
                New prompt
              </Button>
            }
          />
        </Card>
      )}

      {prompts && prompts.length > 0 && (
        <ul className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {prompts.map((p) => (
            <li key={p.id}>
              <Card className="flex h-full flex-col p-4">
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="flex size-8 items-center justify-center rounded-md bg-accent/12 text-accent"
                  >
                    <Sparkles className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                      {p.name}
                      {p.isAdvisorTemplate && <Badge variant="info">advisor template</Badge>}
                      {p.chain.length > 0 && (
                        <Badge variant="outline" className="gap-1">
                          <GitBranch aria-hidden className="size-3" /> chain ({p.chain.length})
                        </Badge>
                      )}
                    </p>
                    {p.description && <p className="text-caption text-muted">{p.description}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="xs" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="xs" aria-label="Delete prompt" onClick={() => void remove(p)}>
                      <Trash2 aria-hidden className="size-3.5 text-muted hover:text-danger" />
                    </Button>
                  </div>
                </div>
                <pre className="thin-scroll mt-3 max-h-32 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
                  {p.template}
                </pre>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {p.variables.length > 0 ? (
                    p.variables.map((v) => (
                      <Badge key={v} variant="outline">
                        {"{{"}
                        {v}
                        {"}}"}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-caption text-muted">No variables</span>
                  )}
                  <span className="ml-auto text-caption text-muted">updated {timeAgo(p.updatedAt)}</span>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={editing ? "Edit prompt" : "New prompt"}
        description="Template text may reference {{variable}} slots — they are detected automatically."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={busy}>
              {editing ? "Save changes" : "Create prompt"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <ErrorMessage title="Could not save the prompt" message={formError} />}
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Quarterly review prompt"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="For recurring executive updates"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 flex items-center justify-between font-medium text-foreground">
              Template
              <span className="flex items-center gap-2 text-caption font-normal text-muted">
                variables detected:{" "}
                {variablesIn(template).length
                  ? [...new Set(variablesIn(template))].map((v) => (
                      <Badge key={v} variant="outline">
                        {"{{"}
                        {v}
                        {"}}"}
                      </Badge>
                    ))
                  : "none"}
              </span>
            </span>
            <textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              rows={9}
              className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
            <span className="mt-1 block text-caption text-muted">
              {"Available slots: {{dataset}}, {{project}}, {{question}}, {{metric}}, {{timeframe}}"}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAdvisor}
              onChange={(e) => setIsAdvisor(e.target.checked)}
              className="size-4 rounded border-line text-accent focus:ring-2 focus:ring-focus/60"
            />
            <span className="text-foreground">Save as a reusable Business Advisor template</span>
          </label>
        </div>
      </Dialog>
    </section>
  );
}
