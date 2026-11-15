import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { getVisualRenderer } from "@/lib/server/visual-render";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Render a single widget to PNG/PDF/JPEG.
 * Body: { widgetSpec, format, options? }
 * Returns: base64-encoded image/PDF
 */
export async function POST(request: Request) {
  try {
    if (!(await moduleEnabledForRequest("RENDERING_ENABLED"))) {
      return ok({ ok: false, message: "Rendering is disabled on this server." }, { status: 403 });
    }
    // Auth gate only — the render plan is fully client-supplied, so there is
    // no row context to thread into the renderer.
    await requireAuth();

    const body = await readJsonBody<{
      widget: {
        widgetId: string;
        type: "chart" | "table" | "text" | "filter" | "kpi" | "pivot" | "pbi-visual";
        spec: Record<string, unknown>;
        containerSize: { width: number; height: number };
        title?: string;
      };
      format: "png" | "pdf" | "jpeg";
      options?: {
        viewport?: { width: number; height: number };
        waitForNetworkIdle?: boolean;
        waitAfterLoad?: number;
        waitForSelector?: string;
        clip?: { x: number; y: number; width: number; height: number };
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

    if (!body.widget || !body.format) {
      return ok({ ok: false, message: "Missing widget or format." }, { status: 400 });
    }

    const renderer = getVisualRenderer();
    const buffer = await renderer.renderWidget(
      {
        widgetId: body.widget.widgetId,
        type: body.widget.type,
        spec: body.widget.spec,
        containerSize: body.widget.containerSize,
        title: body.widget.title,
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
