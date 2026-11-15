"use client";

import { NotebookPen } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { PublishedNotebookView } from "@/components/notebook/published-view";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary } from "@/components/ui/feedback";
import { Card } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/client/api";
import type { NotebookCell, PublishedNotebook } from "@/lib/types";

/**
 * Workspace-authenticated published view: /published-notebook?notebookId=…
 *
 * Anyone who can view the notebook in the workspace can open this read-only
 * rendering of it (the same renderer the public link uses). The live editor
 * remains the project's notebook tab.
 */
export default function PublishedNotebookPage() {
  const searchParams = useSearchParams();
  const notebookId = searchParams.get("notebookId") ?? "";
  const [app, setApp] = useState<PublishedNotebook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!notebookId) {
      setError("Missing notebookId — open this view from a notebook's Publish panel.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/notebooks/${notebookId}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { notebook: { id: string; title: string; dataset: { name: string } | null; cells: NotebookCell[] } };
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.ok || !data.data?.notebook) {
          setError(data?.error?.message ?? "This notebook could not be loaded.");
          return;
        }
        const notebook = data.data.notebook;
        setApp({
          id: notebook.id,
          title: notebook.title,
          datasetName: notebook.dataset?.name ?? null,
          accessMode: "workspace",
          publishedAt: null,
          cells: notebook.cells,
        });
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId]);

  if (loading) {
    return (
      <Card className="flex h-64 items-center justify-center">
        <span className="text-caption text-muted">Loading published notebook…</span>
      </Card>
    );
  }

  if (error || !app) {
    return (
      <Card className="h-64">
        <EmptyState
          icon={NotebookPen}
          title="Published notebook unavailable"
          description={error ?? "The notebook could not be loaded."}
          action={
            <Button variant="secondary" onClick={() => window.history.back()}>
              Go back
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <ErrorBoundary fallbackTitle="Failed to render notebook" onReset={() => setApp(null)}>
      <PublishedNotebookView app={app} />
    </ErrorBoundary>
  );
}
