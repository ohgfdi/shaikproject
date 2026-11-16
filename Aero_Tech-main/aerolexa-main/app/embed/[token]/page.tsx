// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - dashboard embed is a deployment-wide aggregate operation
import type { Metadata } from "next";
import Link from "next/link";

import { PublishedDashboardView } from "@/components/dashboards/published-view";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import { parseJsonArray } from "@/lib/json";
import { verifyEmbedToken } from "@/lib/server/embed";
import type { ReportPage, ReportTheme } from "@/lib/types";

export const metadata: Metadata = {
  title: "Embedded dashboard",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Public embed surface for dashboards (signed-token embedding).
 *
 * The token is verified SERVER-SIDE (HMAC + expiry) before any data is
 * touched; the dashboard must also still be published (accessMode "public")
 * — an unpublished dashboard's embed stops rendering immediately, which is
 * the kill-switch. Rendering reuses the exact published-view component so
 * the embed always matches what the owner sees, and the route stays outside
 * the auth middleware (public by token, not by accident).
 */
export default async function EmbedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const claims = verifyEmbedToken(decodeURIComponent(token));

  if (!claims) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="max-w-md p-6">
          <EmptyState
            title="This embed is no longer valid"
            description="The embed link has expired or was revoked. Ask the dashboard owner for a fresh link."
          />
        </Card>
      </main>
    );
  }

  const dashboard = await prisma.dashboard.findUnique({
    where: { id: claims.dashboardId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      description: true,
      widgets: true,
      pages: true,
      theme: true,
      accessMode: true,
      publishedAt: true,
    },
  });

  // Revocation paths: unpublished, deleted, or moved workspace.
  if (!dashboard || dashboard.workspaceId !== claims.workspaceId || dashboard.accessMode !== "public") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="max-w-md p-6">
          <EmptyState
            title="This dashboard is not available"
            description="The dashboard was unpublished or removed. Contact the dashboard owner if you should still have access."
          />
        </Card>
      </main>
    );
  }

  const widgets = parseJsonArray(dashboard.widgets, []);
  const pages = parseJsonArray<ReportPage>(dashboard.pages ?? "", []);
  const theme = dashboard.theme ? (JSON.parse(dashboard.theme) as ReportTheme) : null;

  return (
    <main className="min-h-screen bg-background p-3">
      <PublishedDashboardView
        app={{
          title: dashboard.title,
          description: dashboard.description,
          widgets,
          pages,
          theme,
          publishedAt: dashboard.publishedAt ? dashboard.publishedAt.toISOString() : null,
        }}
        viewerTier={null}
      />
      <p className="mt-3 text-center text-caption text-muted">
        Powered by{" "}
        <Link href="/" target="_blank" rel="noopener noreferrer" className="underline">
          Ledgerly
        </Link>
      </p>
    </main>
  );
}
