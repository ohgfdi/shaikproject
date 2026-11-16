import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CalendarClock,
  FileSpreadsheet,
  FolderKanban,
  MessageSquareText,
  Sparkles,
  UploadCloud,
  BarChart3,
} from "lucide-react";

/**
 * tenancy-audit: global-operator — dashboard page aggregates
 * workspace-wide metrics and recent activity for the firm home view.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { activityMeta } from "@/components/activity/activity-meta";
import { KpiSlabRow, type KpiSlab } from "@/components/dashboard/kpi-slabs";
import { InsightCardView } from "@/components/insight/insight-card";
import { PageHeader } from "@/components/layout/page-header";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { fmtDate, timeAgo } from "@/lib/format";
import { insightCard } from "@/lib/serialize";
import { getFirmCockpit } from "@/lib/server/firm-cockpit";

export const metadata = { title: "Home" };

export default async function DashboardHome() {
  const ctx = await requirePageAuth();

  // Firm home. For a user attached to an organization, the daily question is
  // "what is due next, for which client" — the statutory calendar, not an
  // analytics overview. Opt-in at the instance level until pilot evidence says
  // otherwise, and reversible with FIRM_HOME=analytics.
  if (ctx.organization && (process.env.FIRM_HOME ?? "analytics") === "compliance") {
    redirect("/compliance");
  }

  const workspaceId = ctx.workspace.id;

  const today = new Date().toISOString().slice(0, 10);
  const [
    datasetCount,
    datasets,
    insights,
    projects,
    activity,
    books,
    bookCount,
    filings,
    filingCount,
    sources,
    sourceCount,
    sourceErrorCount,
    imports,
    errorRunCount,
    unmatchedInvoiceCount,
  ] = await Promise.all([
    await withTenantDb(ctx, (db) => prisma.dataset.count({ where: { workspaceId } })),
    await withTenantDb(ctx, (db) => prisma.dataset.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 5 })),
    await withTenantDb(ctx, (db) => prisma.insight.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 4 })),
    await withTenantDb(ctx, (db) => prisma.project.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, take: 6 })),
    await withTenantDb(ctx, (db) => prisma.activity.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { project: { select: { name: true, id: true } } },
    })),
    // CA-firm work queue. Every value below is read from this workspace; an
    // empty list renders an empty state rather than a sample figure.
    await withTenantDb(ctx, (db) => prisma.book.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 3,
      select: { id: true, name: true, gstin: true },
    })),
    await withTenantDb(ctx, (db) => prisma.book.count({ where: { workspaceId } })),
    await withTenantDb(ctx, (db) => prisma.gstFilingCampaign.findMany({
      where: { book: { workspaceId }, status: { not: "filed" } },
      orderBy: { dueDate: "asc" },
      take: 4,
      select: {
        id: true,
        formType: true,
        period: true,
        dueDate: true,
        status: true,
        gstin: true,
        book: { select: { id: true, name: true } },
      },
    })),
    await withTenantDb(ctx, (db) => prisma.gstFilingCampaign.count({ where: { book: { workspaceId }, status: { not: "filed" } } })),
    await withTenantDb(ctx, (db) => prisma.caSource.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 3,
      select: { id: true, sourceLabel: true, displayName: true, sourceKind: true, lastError: true },
    })),
    await withTenantDb(ctx, (db) => prisma.caSource.count({ where: { workspaceId } })),
    await withTenantDb(ctx, (db) => prisma.caSource.count({ where: { workspaceId, lastError: { not: null } } })),
    await withTenantDb(ctx, (db) => prisma.caIngestRun.findMany({
      where: { workspaceId },
      orderBy: { startedAt: "desc" },
      take: 4,
      select: {
        id: true,
        status: true,
        startedAt: true,
        error: true,
        syncVersion: true,
        rowCount: true,
        caSource: { select: { sourceLabel: true, displayName: true } },
      },
    })),
    await withTenantDb(ctx, (db) => prisma.caIngestRun.count({ where: { workspaceId, status: "ERROR" } })),
    await withTenantDb(ctx, (db) => prisma.gstInvoice.count({ where: { book: { workspaceId }, matched2a2b: false } })),
  ]);

  const kpis: KpiSlab[] = [
    { label: "Clients", value: bookCount, href: "/books", hint: "client books" },
    { label: "Filings due", value: filingCount, href: "/books", hint: "not yet filed" },
    { label: "Client sources", value: sourceCount, href: "/ca-sources", hint: "imports recorded" },
    { label: "Open exceptions", value: errorRunCount + sourceErrorCount, href: "/ca-sources", hint: "failed imports" },
  ];

  const overdue = filings.filter((filing) => filing.dueDate < today).length;
  const cockpit = await getFirmCockpit(ctx);

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${ctx.user.name.split(" ")[0]}`}
        description="Your uploaded data drives everything below — no sample workspaces, no invented numbers."
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/projects" icon={<FolderKanban aria-hidden className="size-4" />}>
              New project
            </ButtonLink>
            <ButtonLink href="/advisor" variant="secondary" icon={<MessageSquareText aria-hidden className="size-4" />}>
              Ask the advisor
            </ButtonLink>
          </div>
        }
      />

      {/* Needs attention — the unified queue. Every row is a stored record with
          its real due date; the list ranks late work above soon-due work. */}
      {cockpit.total > 0 && (
        <section aria-labelledby="needs-attention" className="mb-8">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="needs-attention" className="text-h3 text-foreground">
                Needs attention
              </h2>
              <p className="mt-0.5 text-caption text-muted">
                {cockpit.counts.critical} overdue · {cockpit.counts.warning} due soon · {cockpit.counts.info} to review
              </p>
            </div>
            <ButtonLink
              href="/compliance/filings"
              variant="secondary"
              icon={<CalendarClock aria-hidden className="size-4" />}
            >
              Open filing board
            </ButtonLink>
          </div>
          <ul className="grid gap-2 md:grid-cols-2">
            {cockpit.items.slice(0, 6).map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="card flex items-start justify-between gap-3 px-3 py-2.5 transition-shadow hover:shadow-pop"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground" title={item.title}>
                      {item.title}
                    </span>
                    <span className="block truncate text-caption text-muted" title={item.detail}>
                      {item.detail}
                    </span>
                  </span>
                  <Badge
                    variant={
                      item.severity === "critical" ? "critical" : item.severity === "warning" ? "warning" : "info"
                    }
                    className="shrink-0"
                  >
                    {item.severity === "critical" ? "Overdue" : item.severity === "warning" ? "Soon" : "Review"}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
          {cockpit.total > 6 && (
            <p className="mt-2 text-caption text-muted">
              +{cockpit.total - 6} more in the filing board, deliverables and operations pages.
            </p>
          )}
        </section>
      )}

      {/* CA-firm work queue — the first block after the greeting. Every figure
          is a workspace count or an explicit empty state; no sample numbers. */}
      <section aria-labelledby="firm-queue" className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="firm-queue" className="text-h3 text-foreground">
              Firm work queue
            </h2>
            <p className="mt-0.5 text-caption text-muted">
              Client books, unfiled GST returns and source imports recorded in this workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/books" variant="secondary" icon={<BookOpen aria-hidden className="size-4" />}>
              Open client books
            </ButtonLink>
            <ButtonLink
              href="/ca-sources"
              variant="secondary"
              icon={<FileSpreadsheet aria-hidden className="size-4" />}
            >
              Import client data
            </ButtonLink>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="flex h-full flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <BookOpen aria-hidden className="size-4 text-accent" /> Clients
                </h3>
                <span className="text-h3 text-foreground">{bookCount}</span>
              </div>
              {books.length === 0 ? (
                <p className="text-caption text-muted">
                  No client books yet. Create one in Client Books to keep each client&apos;s ledger, statements and GST
                  filing separate.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {books.map((book) => (
                    <li key={book.id} className="min-w-0">
                      <Link
                        href="/books"
                        className="block truncate text-sm text-foreground hover:underline"
                        title={book.name}
                      >
                        {book.name}
                      </Link>
                      <span className="block truncate text-caption text-muted">
                        {book.gstin ? `GSTIN ${book.gstin}` : "GSTIN not set"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/books" className="mt-auto text-caption text-accent-strong hover:underline">
                View all client books
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex h-full flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <CalendarClock aria-hidden className="size-4 text-accent" /> Filings due
                </h3>
                <span className="text-h3 text-foreground">{filingCount}</span>
              </div>
              {filings.length === 0 ? (
                <p className="text-caption text-muted">
                  No unfiled GST returns recorded. Prepare GSTR-1, GSTR-3B or GSTR-9 from a client book.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {filings.map((filing) => (
                    <li key={filing.id} className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">
                          {filing.formType.toUpperCase()} · {filing.book.name}
                        </span>
                        <span className="block text-caption text-muted">
                          {filing.period} · due {fmtDate(filing.dueDate)}
                        </span>
                      </span>
                      {filing.dueDate < today && (
                        <Badge variant="warning" className="shrink-0">
                          Overdue
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-auto text-caption text-muted">
                {overdue > 0 ? `${overdue} overdue in the list above.` : "Due dates come from each filing campaign."}
              </p>
              <Link href="/books" className="text-caption text-accent-strong hover:underline">
                Open GST filing
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex h-full flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <UploadCloud aria-hidden className="size-4 text-accent" /> Recent imports
                </h3>
                <span className="text-h3 text-foreground">{sourceCount}</span>
              </div>
              {imports.length === 0 ? (
                <p className="text-caption text-muted">
                  No source imports yet. Add a Tally, bank statement, GST invoice or TDS challan export in Client
                  Imports.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {imports.map((run) => (
                    <li key={run.id} className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span
                          className="block truncate text-sm text-foreground"
                          title={run.caSource.displayName ?? run.caSource.sourceLabel}
                        >
                          {run.caSource.displayName ?? run.caSource.sourceLabel}
                        </span>
                        <span className="block text-caption text-muted">
                          sync {run.syncVersion} · {timeAgo(run.startedAt)}
                          {typeof run.rowCount === "number" ? ` · ${run.rowCount} rows` : ""}
                        </span>
                      </span>
                      <Badge
                        variant={run.status === "SUCCESS" ? "success" : run.status === "ERROR" ? "critical" : "info"}
                        className="shrink-0"
                      >
                        {run.status.toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/ca-sources" className="mt-auto text-caption text-accent-strong hover:underline">
                Open client imports
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex h-full flex-col gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <AlertTriangle aria-hidden className="size-4 text-amber" /> Exceptions
              </h3>
              {errorRunCount + sourceErrorCount + unmatchedInvoiceCount === 0 ? (
                <p className="text-caption text-muted">
                  No exceptions recorded. Failed imports and GST invoices not yet matched to GSTR-2A/2B would appear
                  here.
                </p>
              ) : (
                <ul className="space-y-1.5 text-caption">
                  {errorRunCount > 0 && (
                    <li className="flex items-center justify-between gap-2">
                      <span className="text-muted">Failed import runs</span>
                      <span className="font-medium text-foreground">{errorRunCount}</span>
                    </li>
                  )}
                  {sourceErrorCount > 0 && (
                    <li className="flex items-center justify-between gap-2">
                      <span className="text-muted">Sources with a last error</span>
                      <span className="font-medium text-foreground">{sourceErrorCount}</span>
                    </li>
                  )}
                  {unmatchedInvoiceCount > 0 && (
                    <li className="flex items-center justify-between gap-2">
                      <span className="text-muted">GST invoices not matched to 2A/2B</span>
                      <span className="font-medium text-foreground">{unmatchedInvoiceCount}</span>
                    </li>
                  )}
                </ul>
              )}
              {sources.some((source) => source.lastError) && (
                <p
                  className="line-clamp-2 text-caption text-amber"
                  title={sources.find((source) => source.lastError)?.lastError ?? undefined}
                >
                  Last error: {sources.find((source) => source.lastError)?.lastError}
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-3 text-caption">
                <Link href="/ca-sources" className="text-accent-strong hover:underline">
                  Review imports
                </Link>
                <Link href="/books" className="text-accent-strong hover:underline">
                  Review GST invoices
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {datasetCount === 0 && (
        <Card className="mb-6 border-dashed">
          <CardContent className="px-4 py-8">
            <EmptyState
              icon={UploadCloud}
              title="Start with your data"
              description="Upload a CSV or Excel file into a project. Ledgerly profiles it instantly, then every analysis, insight, dashboard and report is built from that exact file."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <ButtonLink href="/projects" icon={<UploadCloud aria-hidden className="size-4" />}>
                    Upload your first dataset
                  </ButtonLink>
                </div>
              }
            />
          </CardContent>
        </Card>
      )}

      <KpiSlabRow slabs={kpis} />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section aria-labelledby="recents" className="xl:col-span-2">
          <h2 id="recents" className="mb-3 text-h3 text-foreground">
            Recent projects & data
          </h2>
          {projects.length === 0 ? (
            <Card>
              <EmptyState
                icon={FolderKanban}
                title="No projects yet"
                description="Create a project to group datasets, analyses, dashboards, reports and presentations."
                action={
                  <ButtonLink href="/projects">
                    Create your first project <ArrowRight aria-hidden className="size-4" />
                  </ButtonLink>
                }
              />
            </Card>
          ) : (
            <ul className="flex flex-col gap-3">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="card flex items-center gap-3 px-4 py-3 transition-shadow hover:shadow-pop"
                  >
                    <span
                      aria-hidden
                      className="flex size-9 items-center justify-center rounded-md bg-accent/12 text-accent"
                    >
                      <FolderKanban className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{p.name}</span>
                      <span className="block truncate text-caption text-muted">
                        {p.company ?? p.description ?? "Project"} · updated {timeAgo(p.updatedAt)}
                      </span>
                    </span>
                    <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {datasets.length > 0 && (
            <>
              <h2 className="mb-3 mt-7 text-h3 text-foreground">Latest insight cards</h2>
              {insights.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={Sparkles}
                    title="Insights are waiting"
                    description='Open a dataset and choose "Generate insights" — Ledgerly scans your data for movements, outliers, correlations and risks.'
                    action={<ButtonLink href="/projects">Go to your datasets</ButtonLink>}
                  />
                </Card>
              ) : (
                <div className="flex flex-col gap-3">
                  {insights.map((i) => (
                    <InsightCardView key={i.id} insight={insightCard(i)} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="activity">
          <h2 id="activity" className="mb-3 text-h3 text-foreground">
            Recent activity
          </h2>
          <Card>
            {activity.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <BarChart3 aria-hidden className="mx-auto size-8 text-muted/50" />
                <p className="mt-2 text-sm text-muted">Your workspace activity will appear here.</p>
              </div>
            ) : (
              // tabIndex=0 so the scrollable activity list is reachable by
              // keyboard (axe's `scrollable-region-focusable` rule).
              <ol
                tabIndex={0}
                className="thin-scroll max-h-[420px] overflow-y-auto px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                {activity.map((a) => {
                  const meta = activityMeta(a.type);
                  const Icon = meta.icon;
                  return (
                    <li key={a.id} className="flex gap-2.5 px-2 py-2.5">
                      <span
                        aria-hidden
                        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md"
                        style={{
                          backgroundColor: meta?.bg ?? "rgba(90,168,170,0.15)",
                          color: meta?.color ?? "#5AA8AA",
                        }}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <div className="min-w-0 text-sm">
                        <p className="text-foreground">
                          {a.message}{" "}
                          {a.project && (
                            <Link
                              href={`/projects/${a.project.id}`}
                              className="font-medium text-accent hover:underline"
                            >
                              {a.project.name}
                            </Link>
                          )}
                        </p>
                        <p className="text-caption text-muted">{timeAgo(a.createdAt)}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
