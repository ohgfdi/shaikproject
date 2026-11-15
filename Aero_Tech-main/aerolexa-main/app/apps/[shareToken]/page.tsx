"use client";

import { LayoutDashboard, NotebookPen } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { PublishedDashboardView } from "@/components/dashboards/published-view";
import { PublishedNotebookView } from "@/components/notebook/published-view";
import { PublishedReportView } from "@/components/reports/published-view";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/client/api";
import { detectViewerTier, auditViewerMemory } from "@/lib/scene/viewer-tier";
import type { PublishedNotebook } from "@/lib/types";
import type { DashboardWidget } from "@/lib/types";
import type { ReportPage, ReportSection, ReportTheme } from "@/lib/types";

type PublishedApp =
  PublishedNotebook | (PublishedDashboard & { kind: "dashboard" }) | (PublishedReport & { kind: "report" });

interface PublishedDashboard {
  id: string;
  title: string;
  description?: string | null;
  widgets: DashboardWidget[];
  pages?: ReportPage[] | null;
  theme?: ReportTheme | null;
  accessMode: "public";
  publishedAt?: string | null;
}

interface PublishedReport {
  id: string;
  title: string;
  sections: ReportSection[];
  accessMode: "public";
  publishedAt?: string | null;
}

/**
 * Public published-app view — no sign-in required.
 *
 * Loads the snapshot taken at publish time by share token and renders it
 * read-only. Supports notebooks, dashboards and reports. The link stops
 * working when the owner unpublishes.
 *
 * Viewer-tier hardening (S10):
 * - Detects viewer's render capability honestly
 * - Passes tier info to chart components for appropriate quality
 * - Audits memory at load/render points
 * - iOS Safari gets conservative settings
 */
export default function PublishedAppPage() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [app, setApp] = useState<PublishedApp | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerTier, setViewerTier] = useState<ReturnType<typeof detectViewerTier> | null>(null);

  useEffect(() => {
    if (!shareToken) return;
    const cancelled = false;
    setLoading(true);
    setError(null);

    // Detect viewer capability early
    const tier = detectViewerTier();
    if (!cancelled) {
      setViewerTier(tier);
      auditViewerMemory("viewer-init");
    }

    fetch(`/api/apps/${shareToken}?type=${kind ?? ""}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { kind?: string; app: PublishedApp };
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.ok || !data.data?.app) {
          setError(data?.error?.message ?? "This published app could not be loaded.");
          return;
        }
        if (data.data.kind) setKind(data.data.kind);
        setApp(data.data.app);
        if (!cancelled) auditViewerMemory("data-loaded");
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken]);

  if (loading) {
    return (
      <div className="px-4 py-10">
        <Card className="mx-auto flex h-40 max-w-3xl items-center justify-center">
          <span className="text-caption text-muted">Loading published app…</span>
        </Card>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="px-4 py-10">
        <Card className="mx-auto max-w-3xl">
          <EmptyState
            icon={NotebookPen}
            title="Published app unavailable"
            description={error ?? "The app could not be loaded."}
            action={
              <Button variant="secondary" onClick={() => window.history.back()}>
                Go back
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="px-4 py-10">
      {kind === "dashboard" && "widgets" in app ? (
        <PublishedDashboardView app={app as PublishedDashboard} viewerTier={viewerTier} />
      ) : kind === "report" && "sections" in app ? (
        <PublishedReportView app={app as PublishedReport} viewerTier={viewerTier} />
      ) : "cells" in app ? (
        <PublishedNotebookView app={app as PublishedNotebook} viewerTier={viewerTier} />
      ) : (
        <Card className="mx-auto max-w-3xl">
          <EmptyState
            icon={LayoutDashboard}
            title="Unknown app type"
            description="This published app has an unrecognised format."
            action={
              <Button variant="secondary" onClick={() => window.history.back()}>
                Go back
              </Button>
            }
          />
        </Card>
      )}
    </div>
  );
}
