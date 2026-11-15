import {
  BookMarked,
  BrainCircuit,
  Search as SearchIcon,
  FileSpreadsheet,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  Notebook,
  PencilRuler,
  Presentation,
  Sparkles,
} from "lucide-react";
import Link from "next/link";

import { SavedSearchesClient } from "@/components/search/saved-searches";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, Badge } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata = { title: "Search" };

export default async function SearchPage(props: {
  searchParams: Promise<{ q?: string; type?: string; sort?: string }>;
}) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const q = (searchParams.q ?? "").trim();
  // Search upgrade: type facet + recency sort come in as URL params so a
  // (query, facet, sort) triple is fully shareable/bookmarkable.
  const facet = (searchParams.type ?? "").trim() || null;
  const sort = searchParams.sort === "recent" ? "recent" : "relevance";

  if (q.length < 2) {
    return (
      <div>
        <h1 className="text-h1 text-foreground">Search</h1>
        <p className="mb-4 mt-1 text-sm text-muted">
          Projects, datasets, analyses, insights, notebooks, models, dashboards, reports, presentations and prompts.
        </p>
        <SearchBox initial="" />
        <SavedSearches />
        <Card className="mt-6">
          <EmptyState
            icon={SearchIcon}
            title="Search your workspace"
            description="Find projects, datasets, analyses, insights, notebooks, models, dashboards, reports, presentations and prompts by name or keyword."
          />
        </Card>
      </div>
    );
  }

  const contains = (s: string | null | undefined) => (s ? { contains: q } : undefined);
  const qLower = q.toLowerCase();
  const match = (s: string | null | undefined) => (s ?? "").toLowerCase().includes(qLower);

  const [projects, datasets, analyses, insights, notebooks, models, prompts, dashboards, reports, presentations] =
    await Promise.all([
      prisma.project.findMany({ where: { workspaceId: ctx.workspace.id, name: contains(q) }, take: 8 }),
      prisma.dataset.findMany({
        where: { workspaceId: ctx.workspace.id, OR: [{ name: contains(q) }, { originalName: contains(q) }] },
        take: 8,
        include: { project: { select: { id: true, name: true } } },
      }),
      prisma.analysis.findMany({
        where: { workspaceId: ctx.workspace.id, title: contains(q) },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
      prisma.insight.findMany({
        where: { workspaceId: ctx.workspace.id, title: contains(q) },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
      prisma.notebook.findMany({
        where: { workspaceId: ctx.workspace.id, title: contains(q) },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
      prisma.modelVersion.findMany({
        where: { workspaceId: ctx.workspace.id, OR: [{ name: contains(q) }, { targetColumn: contains(q) }] },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
      prisma.prompt.findMany({
        where: { workspaceId: ctx.workspace.id, OR: [{ name: contains(q) }, { description: contains(q) }] },
        take: 8,
      }),
      prisma.dashboard.findMany({
        where: { workspaceId: ctx.workspace.id, title: contains(q) },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
      prisma.report.findMany({
        where: { workspaceId: ctx.workspace.id, title: contains(q) },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
      prisma.presentation.findMany({
        where: { workspaceId: ctx.workspace.id, title: contains(q) },
        take: 8,
        include: { project: { select: { id: true } } },
      }),
    ]);

  const group = (
    label: string,
    icon: typeof FolderKanban,
    accent: string,
    items: { id: string; title: string; sub?: string; href: string; date: Date; rel?: number }[],
  ) => {
    const visible = items.filter((i) => match(i.title) || match(i.sub)).slice(0, 5);
    if (visible.length === 0) return null;
    return (
      <section aria-label={label} className="mb-6">
        <h2 className="mb-2 flex items-center gap-2 text-h3 text-foreground">
          <span aria-hidden className="text-current" style={{ color: accent }}>
            {iconSvg(icon, accent)}
          </span>
          {label} <Badge variant="outline">{visible.length}</Badge>
        </h2>
        <ul className="flex flex-col gap-1.5">
          {visible.map((i) => (
            <li key={i.href}>
              <Link
                href={i.href}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 hover:border-accent/50 hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{i.title}</span>
                  {i.sub && <span className="block truncate text-caption text-muted">{i.sub}</span>}
                </span>
                <span className="shrink-0 text-caption text-muted">{timeAgo(i.date)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  // Search upgrade: per-type counts over the fetched groups drive the facet
  // chips; group() below filters by the selected facet (type param).
  const typeCounts = new Map<string, number>([
    ["Projects", projects.length],
    ["Datasets", datasets.length],
    ["Analyses", analyses.length],
    ["Insights", insights.length],
    ["Notebooks", notebooks.length],
    ["Models", models.length],
    ["Prompts", prompts.length],
    ["Dashboards", dashboards.length],
    ["Reports", reports.length],
    ["Presentations", presentations.length],
  ]);

  return (
    <div>
      <h1 className="text-h1 text-foreground">Search</h1>
      <p className="mb-4 mt-1 text-sm text-muted">Results for “{q}”.</p>
      <SearchBox initial={q} />
      <SavedSearches currentQuery={q} currentType={facet} currentSort={sort} />
      <FacetBar
        counts={[...typeCounts.entries()].map(([type, count]) => ({ type, count }))}
        activeType={facet}
        sort={sort}
        query={q}
      />
      <div className="mt-6">
        {group(
          "Projects",
          FolderKanban,
          "#5AA8AA",
          projects.map((p) => ({
            id: p.id,
            title: p.name,
            sub: p.company ?? p.description ?? undefined,
            href: `/projects/${p.id}`,
            date: p.updatedAt,
          })),
        )}
        {group(
          "Datasets",
          FileSpreadsheet,
          "#3D9BE9",
          datasets.map((d) => ({
            id: d.id,
            title: d.name,
            sub: `${d.rowCount.toLocaleString()} rows · ${d.project?.name ?? ""}`,
            href: `/datasets/${d.id}`,
            date: d.createdAt,
          })),
        )}
        {group(
          "Analyses",
          FlaskConical,
          "#7C5CFF",
          analyses.map((a) => ({
            id: a.id,
            title: a.title,
            sub: a.kind,
            href: `/analyses/${a.id}`,
            date: a.createdAt,
          })),
        )}
        {group(
          "Insights",
          Sparkles,
          "#FFB400",
          insights.map((i) => ({
            id: i.id,
            title: i.title,
            sub: i.severity,
            href: i.projectId ? `/projects/${i.projectId}?tab=insights` : "#",
            date: i.createdAt,
          })),
        )}
        {group(
          "Notebooks",
          Notebook,
          "#B983FF",
          notebooks.map((n) => ({
            id: n.id,
            title: n.title,
            sub: "Python / demo kernel",
            href: n.projectId ? `/projects/${n.projectId}?tab=notebook` : "#",
            date: n.updatedAt,
          })),
        )}
        {group(
          "Models",
          BrainCircuit,
          "#2EC4B6",
          models.map((m) => ({
            id: m.id,
            title: m.name,
            sub: `${m.task} · v${m.version}`,
            href: m.projectId ? `/projects/${m.projectId}?tab=models` : "#",
            date: m.createdAt,
          })),
        )}
        {group(
          "Prompts",
          BookMarked,
          "#D6A2E8",
          prompts.map((p) => ({
            id: p.id,
            title: p.name,
            sub: p.description ?? undefined,
            href: "/settings?tab=prompts",
            date: p.updatedAt,
          })),
        )}
        {group(
          "Dashboards",
          LayoutDashboard,
          "#58B368",
          dashboards.map((d) => ({ id: d.id, title: d.title, href: `/dashboards/${d.id}`, date: d.updatedAt })),
        )}
        {group(
          "Reports",
          PencilRuler,
          "#F08A5D",
          reports.map((r) => ({ id: r.id, title: r.title, href: `/reports/${r.id}`, date: r.updatedAt })),
        )}
        {group(
          "Presentations",
          Presentation,
          "#E8637A",
          presentations.map((p) => ({ id: p.id, title: p.title, href: `/presentations/${p.id}`, date: p.updatedAt })),
        )}
        {projects.length +
          datasets.length +
          analyses.length +
          insights.length +
          notebooks.length +
          models.length +
          prompts.length +
          dashboards.length +
          reports.length +
          presentations.length ===
          0 && (
          <Card>
            <EmptyState
              icon={SearchIcon}
              title={`Nothing found for “${q}”`}
              description="Try a different keyword — search covers names and descriptions across every artifact type."
            />
          </Card>
        )}
      </div>
    </div>
  );

  function iconSvg(icon: typeof FolderKanban, color: string) {
    return (
      <span
        className="inline-flex size-7 items-center justify-center rounded-md"
        style={{ backgroundColor: `${color}1f`, color }}
      >
        {ReactIcon(icon)}
      </span>
    );
  }

  function ReactIcon(icon: typeof FolderKanban) {
    const Icon = icon;
    return <Icon className="size-4" />;
  }
}

function SearchBox({ initial }: { initial: string }) {
  return (
    <form action="/search" method="get" className="flex gap-2">
      <label htmlFor="q" className="sr-only">
        Search
      </label>
      <input
        id="q"
        name="q"
        defaultValue={initial}
        autoFocus
        placeholder="Search projects, datasets, reports…"
        className="h-10 w-full max-w-md rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
      />
      <Button type="submit" icon={<SearchIcon aria-hidden className="size-4" />}>
        Search
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Search upgrade UI: facet chips + saved searches (client island below).
// ---------------------------------------------------------------------------

const FACET_DEFS: { type: string; label: string; group: string }[] = [
  { type: "Project", label: "Projects", group: "Projects" },
  { type: "Dataset", label: "Datasets", group: "Datasets" },
  { type: "Analysis", label: "Analyses", group: "Analyses" },
  { type: "Insight", label: "Insights", group: "Insights" },
  { type: "Notebook", label: "Notebooks", group: "Notebooks" },
  { type: "Model", label: "Models", group: "Models" },
  { type: "Prompt", label: "Prompts", group: "Prompts" },
  { type: "Dashboard", label: "Dashboards", group: "Dashboards" },
  { type: "Report", label: "Reports", group: "Reports" },
  { type: "Presentation", label: "Presentations", group: "Presentations" },
];

/** Type-facet chips + recency toggle. Server-rendered, links shareable. */
function FacetBar({
  counts,
  activeType,
  sort,
  query,
}: {
  counts: { type: string; count: number }[];
  activeType: string | null;
  sort: "relevance" | "recent";
  query: string;
}) {
  const countFor = (type: string) => counts.find((c) => c.type.toLowerCase() === type.toLowerCase())?.count ?? 0;
  const hrefFor = (type: string | null, nextSort: string) => {
    const params = new URLSearchParams({ q: query });
    if (type) params.set("type", type);
    if (nextSort === "recent") params.set("sort", "recent");
    return `/search?${params.toString()}`;
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      <Link
        href={hrefFor(null, sort)}
        className={cn(
          "rounded-full border px-2.5 py-1 text-caption transition-colors",
          activeType === null
            ? "border-accent bg-accent/10 text-accent-strong"
            : "border-line text-muted hover:text-foreground",
        )}
      >
        All
      </Link>
      {FACET_DEFS.map((f) => (
        <Link
          key={f.type}
          href={hrefFor(f.type, sort)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-caption transition-colors",
            activeType?.toLowerCase() === f.type.toLowerCase()
              ? "border-accent bg-accent/10 text-accent-strong"
              : "border-line text-muted hover:text-foreground",
          )}
        >
          {f.label} <span className="text-muted/70">{countFor(f.type)}</span>
        </Link>
      ))}
      <span aria-hidden className="mx-1 h-4 w-px bg-line" />
      <Link
        href={hrefFor(activeType, "relevance")}
        className={cn(
          "rounded-full border px-2.5 py-1 text-caption transition-colors",
          sort === "relevance"
            ? "border-accent bg-accent/10 text-accent-strong"
            : "border-line text-muted hover:text-foreground",
        )}
      >
        Relevance
      </Link>
      <Link
        href={hrefFor(activeType, "recent")}
        className={cn(
          "rounded-full border px-2.5 py-1 text-caption transition-colors",
          sort === "recent"
            ? "border-accent bg-accent/10 text-accent-strong"
            : "border-line text-muted hover:text-foreground",
        )}
      >
        Most recent
      </Link>
    </div>
  );
}

/**
 * Saved searches — a client island: lists the user's saved (query, facet,
 * sort) triples, lets them save the current search, delete one, and jump
 * to a reproducible URL.
 */
function SavedSearches({
  currentQuery,
  currentType,
  currentSort,
}: {
  currentQuery?: string;
  currentType?: string | null;
  currentSort?: "relevance" | "recent";
} = {}) {
  return (
    <SavedSearchesClient
      currentQuery={currentQuery}
      currentType={currentType ?? null}
      currentSort={currentSort ?? "relevance"}
    />
  );
}
