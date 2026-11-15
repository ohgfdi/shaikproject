import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJsonArray } from "@/lib/json";
import { ok, toErrorResponse } from "@/lib/server/api";
import { PUBLIC_ARTIFACT_CACHE, cacheInit } from "@/lib/server/cache-control";
import { moduleEnabled } from "@/lib/server/modules";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Every successful response on this route is a PUBLISHED artifact, addressed
 * by an unguessable share token and public by design — so this is the one
 * response in the app a shared cache (CDN, corporate proxy) may hold. Without
 * the header, every viewer of a shared dashboard hit the database on every page
 * load. The short s-maxage keeps "unpublish" responsive.
 */
function publicOk<T>(data: T) {
  return ok(data, cacheInit(PUBLIC_ARTIFACT_CACHE));
}

/**
 * Public published-app snapshot.
 *
 * A notebook / dashboard / report published with accessMode "public" is
 * viewable at /apps/<shareToken> by anyone — no session required. The
 * response is a read-only snapshot. Code is never executed for anonymous
 * viewers; the snapshot is what was published.
 *
 * The ?type= query param disambiguates when a token is shared across
 * kinds; kind is auto-detected when type is omitted.
 */
export async function GET(request: Request, props: { params: Promise<{ shareToken: string }> }) {
  const params = await props.params;
  try {
    const url = new URL(request.url);
    const typeHint = url.searchParams.get("type"); // notebook | dashboard | report

    // Auto-detect: notebooks are the legacy kind; try it first unless hinted otherwise.
    if (typeHint === "dashboard") return findDashboard(params.shareToken);
    if (typeHint === "report") return findReport(params.shareToken);

    const notebook = await prisma.notebook.findUnique({ where: { shareToken: params.shareToken } });
    // A published notebook is still a notebook: freezing the module must not
    // leave a live public snapshot of it reachable. Dashboards/reports below
    // are core and stay public.
    if (notebook && notebook.accessMode === "public" && !moduleEnabled("NOTEBOOK_ENABLED")) {
      throw new ApiError(404, "NOT_FOUND", "Not found.");
    }
    if (notebook && notebook.accessMode === "public") {
      const dataset = notebook.datasetId
        ? await prisma.dataset.findUnique({ where: { id: notebook.datasetId }, select: { name: true } })
        : null;

      const cells = parseJsonArray<NotebookCell>(notebook.cells, []);
      return publicOk({
        kind: "notebook" as const,
        app: {
          id: notebook.id,
          title: notebook.title,
          datasetName: dataset?.name ?? null,
          accessMode: "public" as const,
          publishedAt: notebook.publishedAt ? notebook.publishedAt.toISOString() : null,
          cells,
        },
      });
    }

    const dashboard = await prisma.dashboard.findUnique({ where: { shareToken: params.shareToken } });
    if (dashboard && dashboard.accessMode === "public") {
      return publicOk({
        kind: "dashboard" as const,
        app: {
          id: dashboard.id,
          title: dashboard.title,
          description: dashboard.description,
          widgets: parseJsonArray(dashboard.widgets, []),
          pages: parseJsonArray(dashboard.pages ?? "", []),
          theme: dashboard.theme ? JSON.parse(dashboard.theme) : null,
          accessMode: "public" as const,
          publishedAt: dashboard.publishedAt ? dashboard.publishedAt.toISOString() : null,
        },
      });
    }

    const report = await prisma.report.findUnique({ where: { shareToken: params.shareToken } });
    if (report && report.accessMode === "public") {
      return publicOk({
        kind: "report" as const,
        app: {
          id: report.id,
          title: report.title,
          sections: parseJsonArray(report.sections, []),
          accessMode: "public" as const,
          publishedAt: report.publishedAt ? report.publishedAt.toISOString() : null,
        },
      });
    }

    throw new ApiError(404, "NOT_FOUND", "This published app does not exist or is no longer public.");
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function findDashboard(shareToken: string) {
  const dashboard = await prisma.dashboard.findUnique({ where: { shareToken } });
  if (!dashboard || dashboard.accessMode !== "public") {
    throw new ApiError(404, "NOT_FOUND", "This published dashboard does not exist or is no longer public.");
  }
  return publicOk({
    kind: "dashboard" as const,
    app: {
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      widgets: parseJsonArray(dashboard.widgets, []),
      pages: parseJsonArray(dashboard.pages ?? "", []),
      theme: dashboard.theme ? JSON.parse(dashboard.theme) : null,
      accessMode: "public" as const,
      publishedAt: dashboard.publishedAt ? dashboard.publishedAt.toISOString() : null,
    },
  });
}

async function findReport(shareToken: string) {
  const report = await prisma.report.findUnique({ where: { shareToken } });
  if (!report || report.accessMode !== "public") {
    throw new ApiError(404, "NOT_FOUND", "This published report does not exist or is no longer public.");
  }
  return publicOk({
    kind: "report" as const,
    app: {
      id: report.id,
      title: report.title,
      sections: parseJsonArray(report.sections, []),
      accessMode: "public" as const,
      publishedAt: report.publishedAt ? report.publishedAt.toISOString() : null,
    },
  });
}
