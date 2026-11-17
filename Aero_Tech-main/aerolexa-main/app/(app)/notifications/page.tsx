import { PageHeader } from "@/components/layout/page-header";
import { NotificationsPanel } from "@/components/notifications/notifications-panel";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requirePageAuth();
  const rows = await withTenantDb(ctx, (db) =>
    db.notification.findMany({
      where: { userId: ctx.user.id },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
  );

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Events from your workspace — anomalies, data-quality findings, completed analyses, reports and dashboard activity."
      />
      <NotificationsPanel
        initial={rows.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          readAt: n.readAt ? n.readAt.toISOString() : null,
          createdAt: n.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
