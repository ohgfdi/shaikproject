import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { dashboardLayout, widgetToRenderPlan } from "@/lib/engine/widget-render-spec";
import { parseJsonArray } from "@/lib/json";
import { toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { getVisualRenderer } from "@/lib/server/visual-render";
import type { DashboardWidget } from "@/lib/types";

/**
 * tenancy-audit: global-operator — dashboard render API renders dashboard
 * to PNG/PDF/JPEG for the workspace. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Widgets are stored as one opaque JSON column — parse defensively. */
function parseWidgets(raw: string | null): DashboardWidget[] {
  return parseJsonArray<DashboardWidget>(raw ?? "[]", []).filter(
    (w) => !!w && typeof w === "object" && typeof w.id === "string",
  );
}

/**
 * On-demand dashboard render to PNG/PDF/JPEG.
 * Query params: format=png|pdf|jpeg, theme=light|dark, fullPage=true
 * Returns: binary file download
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    if (!(await moduleEnabledForRequest("RENDERING_ENABLED"))) {
      return new Response("Rendering is disabled on this server.", { status: 403 });
    }
    const ctx = await requireAuth();

    const dashboard = await prisma.dashboard.findUnique({
      where: { id: params.id },
      select: { workspaceId: true, title: true, widgets: true },
    });
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) {
      return new Response("Dashboard not found.", { status: 404 });
    }

    const url = new URL(request.url);
    const format = (url.searchParams.get("format") ?? "pdf") as "png" | "pdf" | "jpeg";
    const theme = (url.searchParams.get("theme") ?? "light") as "light" | "dark";
    const fullPage = url.searchParams.get("fullPage") !== "false";

    const widgets = parseWidgets(dashboard.widgets);
    if (!widgets.length) {
      return new Response("Dashboard has no widgets to render.", { status: 400 });
    }

    // `DashboardWidget` has no generic `spec` field — its payload lives in
    // type-specific columns (`chart`, `kpi`, `table`, …). Reading `w.spec`
    // gave every widget `undefined`: tables threw a TypeError (500), charts
    // injected a bare `undefined` identifier into the page (blank image), and
    // KPIs rendered as an em-dash placeholder. The adapter maps the real shape
    // to the renderer's contract.
    const widgetInputs = widgets.map((w) => {
      const plan = widgetToRenderPlan(w);
      return {
        widgetId: plan.widgetId,
        type: w.type,
        // Retained for the legacy body contract; the renderer prefers `plan`.
        spec: plan.chart ?? plan.pbiVisual ?? plan.table ?? plan.kpi ?? {},
        containerSize: plan.containerSize,
        title: plan.title,
        plan,
      };
    });

    // The 12-column layout lives in the widget JSON itself; passing `undefined`
    // collapsed every widget onto CSS grid auto-placement.
    const layout = dashboardLayout(widgets);

    const renderer = getVisualRenderer();
    const buffer = await renderer.renderDashboard(
      {
        widgets: widgetInputs,
        layout,
        title: dashboard.title ?? "Dashboard",
        theme,
        pageSize: { width: 1920, height: 1080 },
      },
      {
        format,
        fullPage,
        pdfOptions: {
          format: "A4",
          landscape: true,
          margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
          printBackground: true,
          scale: 0.85,
        },
      },
    );

    const mimeType = format === "pdf" ? "application/pdf" : `image/${format}`;
    const safeTitle = (dashboard.title ?? "dashboard").replace(/[^a-z0-9]/gi, "_").slice(0, 60) || "dashboard";
    const fileName = `${safeTitle}.${format}`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
