import { FolderKanban, ArrowRight, Archive, FileSpreadsheet, FlaskConical, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/layout/page-header";
import { ProjectCreateButton } from "@/components/projects/project-create-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { timeAgo, fmtDate } from "@/lib/format";
import { insightCard } from "@/lib/serialize";
import { withTenantDb } from "@/lib/server/tenant-db";

export const metadata = { title: "My Projects" };

/**
 * tenancy-audit: global-operator — projects page lists workspace-wide
 * projects for the firm home view.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */

const STATUS_BADGE: Record<string, "default" | "success" | "warning" | "outline"> = {
  ACTIVE: "success",
  DRAFT: "warning",
  COMPLETED: "default",
  ARCHIVED: "outline",
};

export default async function ProjectsPage(props: { searchParams: Promise<{ showAll?: string }> }) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const showAll = searchParams.showAll === "1";
  const where = { workspaceId: ctx.workspace.id };
  const [total, projects] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: showAll ? undefined : 50,
      include: {
        _count: {
          select: {
            datasets: true,
            analyses: true,
            insights: true,
            dashboards: true,
            reports: true,
            presentations: true,
          },
        },
      },
    }),
  ]);
  const hasMore = !showAll && projects.length < total;

  return (
    <div>
      <PageHeader
        title="My Projects"
        description="Every artifact lives inside a project — datasets, analyses, insights, dashboards, reports and presentations."
        actions={<ProjectCreateButton />}
      />
      {projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderKanban}
            title="Create your first project"
            description="A project keeps one engagement or initiative together. Start here, then upload the dataset that drives it."
            action={<ProjectCreateButton label="New project" />}
          />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="card group flex h-full flex-col p-4 transition-shadow hover:shadow-pop"
                aria-label={`Open project ${p.name}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    aria-hidden
                    className="flex size-10 items-center justify-center rounded-md bg-accent/12 text-accent"
                  >
                    <FolderKanban className="size-5" />
                  </span>
                  <Badge variant={STATUS_BADGE[p.status] ?? "default"}>{p.status.toLowerCase()}</Badge>
                </div>
                <h2 className="mt-3 text-h3 text-foreground">{p.name}</h2>
                <p className="mt-1 line-clamp-2 flex-1 text-sm text-muted">
                  {p.description ?? p.company ?? "No description yet."}
                </p>
                <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
                  <Stat
                    label="Data"
                    value={p._count.datasets}
                    icon={<FileSpreadsheet aria-hidden className="size-3.5" />}
                  />
                  <Stat
                    label="Analyses"
                    value={p._count.analyses}
                    icon={<FlaskConical aria-hidden className="size-3.5" />}
                  />
                  <Stat
                    label="Insights"
                    value={p._count.insights}
                    icon={<Sparkles aria-hidden className="size-3.5" />}
                  />
                </dl>
                <p className="mt-3 flex items-center justify-between text-caption text-muted">
                  <span>Updated {timeAgo(p.updatedAt)}</span>
                  {p.status === "ARCHIVED" ? (
                    <span className="inline-flex items-center gap-1">
                      <Archive aria-hidden className="size-3.5" /> archived
                    </span>
                  ) : (
                    <span className="text-accent">
                      Open <ArrowRight aria-hidden className="inline size-3.5" />
                    </span>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <p className="mt-4 flex items-center gap-1.5 text-caption text-muted">
          Showing {projects.length} of {total} projects
          <Link href="/projects?showAll=1" className="font-medium text-accent hover:underline">
            Show all
          </Link>
        </p>
      )}

      {projects.length > 0 && <InsightsStrip ctxUserId={ctx.user.id} />}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center justify-center gap-1 text-caption text-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-body font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

async function InsightsStrip({ ctxUserId }: { ctxUserId: string }) {
  const { prisma: p } = await import("@/lib/db");
  const user = await p.user.findUnique({ where: { id: ctxUserId }, include: { workspace: true } });
  if (!user?.workspace) return null;
  const insights = await p.insight.findMany({
    where: { workspaceId: user.workspace.id },
    orderBy: { createdAt: "desc" },
    take: 3,
    include: { project: { select: { id: true, name: true } } },
  });
  if (insights.length === 0) return null;
  return (
    <section className="mt-8" aria-labelledby="recent-insights">
      <div className="flex items-center justify-between">
        <h2 id="recent-insights" className="text-h3 text-foreground">
          Latest insights across projects
        </h2>
        <span className="text-caption text-muted">updated {fmtDate(new Date())}</span>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        {insights.map((i) => {
          const card = insightCard(i);
          return (
            <li key={i.id}>
              <Link href={`/projects/${i.projectId}`} className="card block h-full p-4 hover:shadow-pop">
                <Badge
                  variant={card.severity === "critical" ? "critical" : card.severity === "warning" ? "warning" : "info"}
                >
                  {card.severity}
                </Badge>
                <p className="mt-2 line-clamp-2 font-medium leading-snug text-foreground">{card.title}</p>
                {card.observedChange && (
                  <p className="mt-1 font-mono text-caption tabular-nums text-accent">{card.observedChange}</p>
                )}
                <p className="mt-2 text-caption text-muted">{i.project?.name}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
