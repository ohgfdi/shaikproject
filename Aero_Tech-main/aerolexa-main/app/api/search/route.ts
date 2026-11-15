import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { applyTypeFacet, countTypeFacets, sortHits, type FacetHit, type SearchSort } from "@/lib/search/facets";
import { ok, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=… — workspace-wide search for the command palette and
 * the /search page (search upgrade: facets + sort + analytics).
 *
 * Mirrors the queries behind the /search page (same models, same contains
 * semantics) but returns JSON. Auth + tenancy: requireAuth scopes every
 * query to the caller's workspace — a user can only ever find artifacts in
 * their own workspace.
 *
 * Upgrade additions:
 *  - `type` facet: `facets` (count per hit type) is always returned; pass
 *    `&type=Dashboard` to filter hits to one type.
 *  - `sort=recent` re-orders hits by artifact recency (relevance is default).
 *  - every non-empty query is logged to SearchQueryLog (query + hitCount)
 *    for the workspace's search analytics floor.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    const facet = url.searchParams.get("type");
    const sort: SearchSort = url.searchParams.get("sort") === "recent" ? "recent" : "relevance";

    // Empty query: the palette shows navigation actions instead — nothing to
    // search for yet. (Static actions live client-side in the palette.)
    if (q.length < 2) return ok({ hits: [] as FacetHit[], facets: [], query: q, sort });

    const contains = (s: string | null | undefined) => (s ? { contains: q } : undefined);

    const [projects, datasets, analyses, insights, notebooks, models, prompts, dashboards, reports, presentations] =
      await Promise.all([
        prisma.project.findMany({
          where: { workspaceId: ctx.workspace.id, name: contains(q) },
          take: 6,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.dataset.findMany({
          where: { workspaceId: ctx.workspace.id, OR: [{ name: contains(q) }, { originalName: contains(q) }] },
          take: 6,
          orderBy: { createdAt: "desc" },
          include: { project: { select: { name: true } } },
        }),
        prisma.analysis.findMany({
          where: { workspaceId: ctx.workspace.id, title: contains(q) },
          take: 6,
          orderBy: { createdAt: "desc" },
        }),
        prisma.insight.findMany({
          where: { workspaceId: ctx.workspace.id, title: contains(q) },
          take: 6,
          orderBy: { createdAt: "desc" },
        }),
        prisma.notebook.findMany({
          where: { workspaceId: ctx.workspace.id, title: contains(q) },
          take: 6,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.modelVersion.findMany({
          where: { workspaceId: ctx.workspace.id, OR: [{ name: contains(q) }, { targetColumn: contains(q) }] },
          take: 6,
          orderBy: { createdAt: "desc" },
        }),
        prisma.prompt.findMany({
          where: { workspaceId: ctx.workspace.id, OR: [{ name: contains(q) }, { description: contains(q) }] },
          take: 6,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.dashboard.findMany({
          where: { workspaceId: ctx.workspace.id, title: contains(q) },
          take: 6,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.report.findMany({
          where: { workspaceId: ctx.workspace.id, title: contains(q) },
          take: 6,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.presentation.findMany({
          where: { workspaceId: ctx.workspace.id, title: contains(q) },
          take: 6,
          orderBy: { updatedAt: "desc" },
        }),
      ]);

    const allHits: FacetHit[] = [
      ...projects.map((p) => ({
        id: p.id,
        type: "Project",
        title: p.name,
        sub: p.company ?? p.description ?? undefined,
        href: `/projects/${p.id}`,
        date: p.updatedAt.toISOString(),
      })),
      ...datasets.map((d) => ({
        id: d.id,
        type: "Dataset",
        title: d.name,
        sub: `${d.rowCount.toLocaleString()} rows${d.project ? ` · ${d.project.name}` : ""}`,
        href: `/datasets/${d.id}`,
        date: d.createdAt.toISOString(),
      })),
      ...analyses.map((a) => ({
        id: a.id,
        type: "Analysis",
        title: a.title,
        sub: a.kind,
        href: `/analyses/${a.id}`,
        date: a.createdAt.toISOString(),
      })),
      ...insights.map((i) => ({
        id: i.id,
        type: "Insight",
        title: i.title,
        sub: i.severity,
        href: i.projectId ? `/projects/${i.projectId}?tab=insights` : "/dashboard",
        date: i.createdAt.toISOString(),
      })),
      ...notebooks.map((n) => ({
        id: n.id,
        type: "Notebook",
        title: n.title,
        sub: n.projectId ? undefined : "Unfiled",
        href: n.projectId ? `/projects/${n.projectId}?tab=notebook` : "/notebooks",
        date: n.updatedAt.toISOString(),
      })),
      ...models.map((m) => ({
        id: m.id,
        type: "Model",
        title: m.name,
        sub: `${m.task} · v${m.version}`,
        href: m.projectId ? `/projects/${m.projectId}?tab=models` : "/models",
        date: m.createdAt.toISOString(),
      })),
      ...prompts.map((p) => ({
        id: p.id,
        type: "Prompt",
        title: p.name,
        sub: p.description ?? undefined,
        href: "/settings?tab=prompts",
        date: p.updatedAt.toISOString(),
      })),
      ...dashboards.map((d) => ({
        id: d.id,
        type: "Dashboard",
        title: d.title,
        href: `/dashboards/${d.id}`,
        date: d.updatedAt.toISOString(),
      })),
      ...reports.map((r) => ({
        id: r.id,
        type: "Report",
        title: r.title,
        href: `/reports/${r.id}`,
        date: r.updatedAt.toISOString(),
      })),
      ...presentations.map((p) => ({
        id: p.id,
        type: "Presentation",
        title: p.title,
        href: `/presentations/${p.id}`,
        date: p.updatedAt.toISOString(),
      })),
    ];

    const facets = countTypeFacets(allHits);
    const hits = sortHits(applyTypeFacet(allHits, facet), sort);

    // Analytics floor: best-effort logging, never fails the search.
    try {
      await prisma.searchQueryLog.create({
        data: { workspaceId: ctx.workspace.id, userId: ctx.user.id, query: q.slice(0, 120), hitCount: allHits.length },
      });
    } catch {
      /* analytics must never break search */
    }

    return ok({ hits, facets, query: q, sort });
  } catch (err) {
    return toErrorResponse(err);
  }
}
