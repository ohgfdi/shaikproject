import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { getVisualRenderer } from "@/lib/server/visual-render";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Render a full dashboard to PNG/PDF/JPEG.
 * Body: { widgets[], layout?, title?, theme?, pageSize?, format, options? }
 * Returns: base64-encoded image/PDF
 */
export async function POST(request: Request) {
  try {
    if (!(await moduleEnabledForRequest("RENDERING_ENABLED"))) {
      return ok({ ok: false, message: "Rendering is disabled on this server." }, { status: 403 });
    }
    await requireAuth();

    const body = await readJsonBody<{
      widgets: Array<{
        widgetId: string;
        type: "chart" | "table" | "text" | "filter" | "kpi" | "pivot" | "pbi-visual";
        spec: Record<string, unknown>;
        containerSize: { width: number; height: number };
        title?: string;
      }>;
      layout?: Array<{ widgetId: string; x: number; y: number; w: number; h: number }>;
      title?: string;
      theme?: "light" | "dark";
      pageSize?: { width: number; height: number };
      format: "png" | "pdf" | "jpeg";
      options?: {
        viewport?: { width: number; height: number };
        waitForNetworkIdle?: boolean;
        waitAfterLoad?: number;
        waitForSelector?: string;
        fullPage?: boolean;
        pdfOptions?: {
          format?: "A4" | "A3" | "Letter" | "Legal";
          landscape?: boolean;
          margin?: { top: string; right: string; bottom: string; left: string };
          printBackground?: boolean;
          scale?: number;
        };
        backgroundColor?: string;
        quality?: number;
      };
    }>(request);

    if (!body.widgets?.length || !body.format) {
      return ok({ ok: false, message: "Missing widgets or format." }, { status: 400 });
    }

    const renderer = getVisualRenderer();
    const buffer = await renderer.renderDashboard(
      {
        widgets: body.widgets,
        layout: body.layout,
        title: body.title,
        theme: body.theme ?? "light",
        pageSize: body.pageSize ?? { width: 1920, height: 1080 },
      },
      {
        format: body.format,
        ...body.options,
      },
    );

    const base64 = buffer.toString("base64");
    const mimeType = body.format === "pdf" ? "application/pdf" : `image/${body.format}`;

    return ok({ ok: true, data: base64, mimeType });
  } catch (err) {
    return toErrorResponse(err);
  }
}
