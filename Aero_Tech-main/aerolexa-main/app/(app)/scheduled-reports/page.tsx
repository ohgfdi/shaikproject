import { PageHeader } from "@/components/layout/page-header";
import { ScheduledPanel } from "@/components/settings/scheduled-panel";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { featureFlags } from "@/lib/server/features";

export const metadata = { title: "Scheduled Reports" };

export default async function ScheduledReportsPage() {
  const ctx = await requirePageAuth();
  const flags = featureFlags({ isAdmin: ctx.user.isAdmin })

  const reports = await withTenantDb(ctx, (db)
    db.report.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { updatedAt: "desc" },
      include: { project: { select: { name: true } } },
      take: 100,
    }),
  );

  return (
    <div>
      <PageHeader
        title="Scheduled Reports"
        description="Automated report generation via cron scheduling. Reports generate prototype PDF/HTML and can be delivered via email."
      />
      <div className="mt-6">
        <ScheduledPanel
          schedulerEnabled={flags.schedulerEnabled}
          reports={reports.map((r) => ({ id: r.id, title: r.title, projectName: r.project?.name ?? null }))}
        />
      </div>
    </div>
  );
}
