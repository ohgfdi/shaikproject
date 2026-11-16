import { Shield, Plus } from "lucide-react";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { ButtonLink } from "@/components/ui/button";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  const ctx = await requirePageAuth();
  const reports = await withTenantDb(ctx, (db)
    db.report.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { updatedAt: "desc" },
      include: { project: { select: { name: true } } },
      take: 200,
    }),
  );

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Board-ready reports built from your analyses — export as printable HTML (PDF via your browser's print dialog) or schedule automated runs."
        actions={
          <ButtonLink href="/reports/new" icon={<Plus aria-hidden className="size-4" />}>
            New report
          </ButtonLink>
        }
      />
      <div className="mt-6">
        <ArtifactGrid
          icon={Shield}
          emptyTitle="No reports yet"
          emptyDescription="Create your first report — it pre-fills from your dataset profile, analyses and insights, and exports as a professional printable document."
          createHref="/reports/new"
          createLabel="New report"
          items={reports.map((r) => ({
            id: r.id,
            title: r.title,
            sub: r.project?.name,
            href: `/reports/${r.id}`,
            updatedAt: r.updatedAt,
          }))}
        />
      </div>
    </div>
  );
}
