import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { reportSections } from "@/lib/serialize";
import { ok, toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { getVisualRenderer } from "@/lib/server/visual-render";
import type { ChartSpec, ReportSection, TableSpec } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Render a scheduled report to a PDF/PNG and stream it back for download.
 *
 * `?download=false` returns JSON metadata instead of the bytes.
 *
 * NOTE on `lastRunOutputUrl`: that column is owned by the HTML export
 * pipeline. `readExportHtml` accepts only `<kind>-<id8>-<stamp14>.html`, so
 * this route previously wrote `reports/<cuid>-<epochms>.pdf` there, which the
 * artifact route could never resolve — one call permanently 404'd the
 * scheduled report's download link until the next scheduled run overwrote it.
 * The rendered binary is therefore returned directly and the HTML slot is
 * left alone.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    if (!(await moduleEnabledForRequest("RENDERING_ENABLED"))) {
      return ok({ ok: false, message: "Rendering is disabled on this server." }, { status: 403 });
    }
    const ctx = await requireAuth();

    const report = await prisma.scheduledReport.findUnique({
      where: { id: params.id },
      include: { report: true },
    });
    if (!report || report.workspaceId !== ctx.workspace.id) {
      return ok({ ok: false, message: "Report not found." }, { status: 404 });
    }
    if (!report.report) {
      return ok({ ok: false, message: "Report has no associated report content." }, { status: 400 });
    }

    const sections = reportSections(report.report);
    if (!sections.length) {
      return ok({ ok: false, message: "Report has no sections to render." }, { status: 400 });
    }

    const url = new URL(request.url);
    const format = url.searchParams.get("format") === "png" ? "png" : "pdf";
    const asDownload = url.searchParams.get("download") !== "false";

    const widgets = sections.flatMap((section, i) => sectionWidgets(section, i));
    if (!widgets.length) {
      return ok({ ok: false, message: "Report has no renderable content." }, { status: 400 });
    }

    const renderer = getVisualRenderer();
    const buffer = await renderer.renderDashboard(
      {
        widgets,
        // Sections stack vertically, 12 columns wide, in document order.
        layout: widgets.map((w, i) => ({ widgetId: w.widgetId, x: 0, y: i, w: 12, h: 4 })),
        title: report.report.title,
        theme: "light",
        pageSize: { width: 1920, height: 1080 },
      },
      {
        format,
        fullPage: true,
        pdfOptions: {
          format: "A4",
          landscape: true,
          margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
          printBackground: true,
          scale: 0.85,
        },
      },
    );

    const renderedAt = new Date();
    await prisma.scheduledReport.update({
      where: { id: params.id },
      data: {
        lastRunAt: renderedAt,
        lastRunStatus: "ok",
        lastRunMessage: `Rendered ${sections.length} section(s) to ${format.toUpperCase()}.`,
        // `lastRunOutputUrl` deliberately untouched — see the note above.
      },
    });

    const mimeType = format === "pdf" ? "application/pdf" : "image/png";
    const safeTitle = (report.report.title ?? "report")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const fileName = `${safeTitle || "report"}.${format}`;

    if (!asDownload) {
      return ok({ ok: true, fileName, mimeType, size: buffer.length, sections: sections.length });
    }

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    try {
      await prisma.scheduledReport.update({
        where: { id: params.id },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: "error",
          lastRunMessage: err instanceof Error ? err.message : "Unknown error",
        },
      });
    } catch {
      // Never let a status-write failure mask the original error.
    }
    return toErrorResponse(err);
  }
}

/**
 * Map one `ReportSection` to renderable widgets.
 *
 * `ReportSection` is `{ id, heading, kind, content, chart?, insight?, table? }`
 * — it has **no `widgets` array and no `title` field**. The previous loop
 * branched on `section.widgets` (always undefined), so every section fell to
 * the text branch, `section.title` was always undefined (headerless output),
 * and `section.chart` / `section.table` were dropped entirely: a
 * chart-bearing report rendered as prose only, silently, at HTTP 200.
 */
function sectionWidgets(
  section: ReportSection,
  index: number,
): Array<{
  widgetId: string;
  type: "chart" | "table" | "text" | "insight";
  spec: ChartSpec | TableSpec | Record<string, unknown>;
  containerSize: { width: number; height: number };
  title?: string;
}> {
  const id = section.id || `section-${index}`;
  const heading = section.heading ?? "";

  switch (section.kind) {
    case "chart":
      if (section.chart) {
        return [
          {
            widgetId: id,
            type: "chart",
            spec: section.chart,
            containerSize: { width: 1200, height: 520 },
            title: section.chartTitle ?? heading,
          },
        ];
      }
      break;
    case "insight":
      if (section.insight) {
        return [
          {
            widgetId: id,
            type: "insight",
            spec: section.insight as unknown as Record<string, unknown>,
            containerSize: { width: 1200, height: 360 },
            title: heading,
          },
        ];
      }
      break;
    case "table":
      if (section.table) {
        return [
          {
            widgetId: id,
            type: "table",
            spec: section.table,
            containerSize: { width: 1200, height: 520 },
            title: heading,
          },
        ];
      }
      break;
    default:
      break;
  }

  // Fall through to the section's prose body. `content` is plain
  // markdown-ish text, so it goes through the text branch, which escapes it.
  if (!section.content) return [];
  return [
    {
      widgetId: id,
      type: "text",
      spec: { content: section.content },
      containerSize: { width: 1200, height: 320 },
      title: heading,
    },
  ];
}
