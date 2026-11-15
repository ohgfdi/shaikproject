"use client";

import { FileCheck2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, apiMutate, errorMessage } from "@/lib/client/api";
import type { DataClassification, PracticeRole } from "@/lib/types";

export interface WorkingPaper {
  id: string;
  indexRef: string;
  title: string;
  section: string | null;
  saReference: string | null;
  status: string;
  classification: DataClassification;
  version: number;
  preparedById: string | null;
  reviewedById: string | null;
  signedOffById: string | null;
  signOffRole: PracticeRole | null;
}

export interface WorkingPaperIndex {
  entries: { ref: string; sa: string; title: string; status: "missing" | "prepared" | "signed-off" }[];
  signedOffCount: number;
  complete: boolean;
  missingRefs: string[];
}

interface WorkingPaperVersionView {
  id: string;
  version: number;
  contentHash: string;
  changeSummary: string;
  preparedById: string;
  createdAt: string;
  content: unknown;
}

interface WorkingPaperDetail {
  workingPaper: WorkingPaper;
  versions: WorkingPaperVersionView[];
}

const STATE_BADGE: Record<string, "outline" | "info" | "amber" | "success" | "warning"> = {
  DRAFT: "outline",
  IN_REVIEW: "amber",
  REVIEWED: "info",
  SIGNED_OFF: "success",
  ARCHIVED: "outline",
};

/** Lifecycle actions available from a given working-paper status. */
export function paperActions(status: string): { action: string; label: string; body?: Record<string, unknown> }[] {
  switch (status) {
    case "DRAFT":
      return [
        { action: "revise", label: "Edit content" },
        { action: "submit", label: "Submit for review" },
      ];
    case "IN_REVIEW":
      return [
        { action: "revise", label: "Edit content" },
        { action: "review", label: "Approve review", body: { approved: true } },
        { action: "review", label: "Return for changes", body: { approved: false } },
      ];
    case "REVIEWED":
      return [
        { action: "revise", label: "Edit content" },
        { action: "sign-off", label: "Sign off" },
      ];
    case "SIGNED_OFF":
      return [{ action: "archive", label: "Archive" }];
    default:
      return [];
  }
}

/**
 * Working papers with the SA 230 binder index.
 *
 * Shared by the dedicated working-papers page and the settings governance
 * panel: one implementation means the sign-off ladder a junior sees on the
 * audit screen is byte-for-byte the one a partner sees in governance.
 */
export function WorkingPapersCard({
  engagementId,
  papers,
  onChanged,
  onOk,
  onError,
}: {
  engagementId: string;
  papers: { workingPapers: WorkingPaper[]; index: WorkingPaperIndex } | null;
  onChanged: () => void;
  onOk: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const [indexRef, setIndexRef] = useState("");
  const [title, setTitle] = useState("");
  const [saReference, setSaReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    id: string;
    data: WorkingPaperDetail | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [revising, setRevising] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);

  if (!papers) return null;

  const create = async () => {
    setBusy(true);
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/working-papers`,
        { method: "POST", body: JSON.stringify({ indexRef, title, saReference }) },
        `/api/organization/engagements/${engagementId}`,
      );
      setIndexRef("");
      setTitle("");
      setSaReference("");
      onChanged();
      onOk("Working paper created");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const transition = async (id: string, action: string, body: Record<string, unknown> | undefined, label: string) => {
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/working-papers/${id}`,
        { method: "PATCH", body: JSON.stringify({ action, ...body }) },
        `/api/organization/engagements/${engagementId}`,
      );
      onChanged();
      onOk(label);
    } catch (err) {
      onError(err);
    }
  };

  const openPaper = async (paper: WorkingPaper) => {
    setDetail({ id: paper.id, data: null, loading: true, error: null });
    setRevisionError(null);
    try {
      const data = await api<WorkingPaperDetail>(
        `/api/organization/engagements/${engagementId}/working-papers/${paper.id}`,
      );
      setDetail({ id: paper.id, data, loading: false, error: null });
      setDraft(JSON.stringify(data.versions[0]?.content ?? {}, null, 2));
      setChangeSummary("");
    } catch (err) {
      setDetail({ id: paper.id, data: null, loading: false, error: errorMessage(err) });
    }
  };

  const saveRevision = async () => {
    if (!detail?.data) return;
    let content: unknown;
    try {
      content = JSON.parse(draft);
    } catch {
      setRevisionError("The working-paper content must be valid JSON.");
      return;
    }
    if (changeSummary.trim().length < 3) {
      setRevisionError("Describe what changed in this revision.");
      return;
    }
    setRevising(true);
    setRevisionError(null);
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/working-papers/${detail.data.workingPaper.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ action: "revise", content, changeSummary: changeSummary.trim() }),
        },
        `/api/organization/engagements/${engagementId}`,
      );
      onOk(`${detail.data.workingPaper.indexRef}: revision saved`);
      await openPaper(detail.data.workingPaper);
      onChanged();
    } catch (err) {
      setRevisionError(errorMessage(err));
    } finally {
      setRevising(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FileCheck2 aria-hidden className="size-4" />
          Working papers (SA 230)
        </div>
        <p className="text-caption text-muted">
          Binder coverage: {papers.index.signedOffCount}/{papers.index.entries.length} signed off
          {papers.index.complete ? " · complete" : ` · missing ${papers.index.missingRefs.join(", ")}`}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Index ref">
            <Input value={indexRef} onChange={(e) => setIndexRef(e.target.value)} placeholder="B-200" />
          </Field>
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Substantive testing of receivables"
            />
          </Field>
          <Field label="SA reference">
            <Input value={saReference} onChange={(e) => setSaReference(e.target.value)} placeholder="SA 500" />
          </Field>
        </div>
        <div>
          <Button onClick={create} disabled={busy || indexRef.trim().length === 0 || title.trim().length < 3}>
            Create working paper
          </Button>
        </div>
        <ul className="flex flex-col gap-2">
          {papers.workingPapers.length === 0 && <li className="text-caption text-muted">No working papers yet.</li>}
          {papers.workingPapers.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/40 px-3 py-2"
            >
              <Badge variant={STATE_BADGE[w.status] ?? "outline"}>{w.status}</Badge>
              <span className="text-sm font-medium text-foreground">
                {w.indexRef} · {w.title}
              </span>
              <span className="text-caption text-muted">
                v{w.version}
                {w.saReference ? ` · ${w.saReference}` : ""}
              </span>
              <span className="ml-auto flex gap-1.5">
                {paperActions(w.status).map((a) => (
                  <Button
                    key={a.label}
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      a.action === "revise"
                        ? void openPaper(w)
                        : void transition(w.id, a.action, a.body, `${w.indexRef}: ${a.label.toLowerCase()}`)
                    }
                  >
                    {a.label}
                  </Button>
                ))}
              </span>
            </li>
          ))}
        </ul>

        {detail && (
          <div className="rounded-md border border-line bg-surface-2/20 p-3">
            {detail.loading && <p className="text-caption text-muted">Loading the working paper…</p>}
            {detail.error && <p className="text-caption text-danger">{detail.error}</p>}
            {detail.data && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {detail.data.workingPaper.indexRef} · {detail.data.workingPaper.title}
                    </p>
                    <p className="text-caption text-muted">
                      v{detail.data.workingPaper.version} · {detail.data.workingPaper.status}
                      {detail.data.workingPaper.saReference ? ` · ${detail.data.workingPaper.saReference}` : ""}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDetail(null)}>
                    Close
                  </Button>
                </div>
                <Field label="Working-paper content (JSON)">
                  <Textarea
                    rows={10}
                    className="font-mono text-caption"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                </Field>
                <Field
                  label="Change summary"
                  helper="Required — this is what the reviewer sees in the immutable version chain."
                >
                  <Input
                    value={changeSummary}
                    onChange={(e) => setChangeSummary(e.target.value)}
                    placeholder="Tick-marked the sales sample and attached the exception note"
                  />
                </Field>
                {revisionError && <p className="text-sm text-danger">{revisionError}</p>}
                <Button type="button" onClick={() => void saveRevision()} loading={revising}>
                  Save revision
                </Button>
                <div>
                  <h3 className="text-sm font-medium text-foreground">Version history</h3>
                  <ul className="mt-2 space-y-2">
                    {detail.data.versions.map((v) => (
                      <li key={v.id} className="rounded-md border border-line/70 bg-background/40 p-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm text-foreground">
                            v{v.version} · {v.changeSummary}
                          </span>
                          <span className="text-caption text-muted">
                            {new Date(v.createdAt).toLocaleString("en-IN")}
                          </span>
                        </div>
                        <details className="mt-1">
                          <summary className="cursor-pointer text-caption text-muted">View content</summary>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-caption text-foreground">
                            {JSON.stringify(v.content, null, 2)}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
