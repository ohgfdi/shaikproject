/**
 * Server-side Visual Rendering Service (WS5).
 *
 * Renders dashboards, reports, and individual widgets to PNG/PDF using
 * headless Chromium via Playwright. Used by scheduled reports, embed exports,
 * and on-demand PDF generation.
 *
 * Features:
 * - Pool of browser pages for concurrent rendering
 * - Widget-level rendering (charts, tables, PBI visuals, KPIs)
 * - Full dashboard/page rendering with layout preservation
 * - Authenticated rendering (cookies/headers passed through)
 * - Configurable viewport, wait conditions, timeouts
 * - Resource cleanup and error recovery
 */

import { chromium, Browser, BrowserContext, Page, devices } from "playwright";

import { chartSpecToECharts, isCanvasChartKind } from "@/lib/engine/chart-echarts";
import { pbiVisualToECharts } from "@/lib/engine/pbi-echarts";
import type { WidgetRenderPlan } from "@/lib/engine/widget-render-spec";
import { widgetToRenderPlan } from "@/lib/engine/widget-render-spec";
import { esc } from "@/lib/export/html";
import { fallbackTableSvg } from "@/lib/export/svg-chart";
import type {
  ChartSpec,
  DashboardWidget,
  InsightCard,
  KpiCard,
  PbiVisualSpec,
  RecommendationWidget,
  SlicerSpec,
  TableSpec,
} from "@/lib/types";

export interface RenderOptions {
  /** Output format */
  format: "png" | "pdf" | "jpeg";
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Device emulation (e.g., devices["iPhone 13"]) */
  device?: keyof typeof devices;
  /** Wait for network idle before capture */
  waitForNetworkIdle?: boolean;
  /** Additional wait time after load (ms) */
  waitAfterLoad?: number;
  /** Custom wait selector/function */
  waitForSelector?: string;
  /** Clip rectangle for element-specific capture */
  clip?: { x: number; y: number; width: number; height: number };
  /** Full page screenshot (for PDF) */
  fullPage?: boolean;
  /** PDF options */
  pdfOptions?: {
    format?: "A4" | "A3" | "Letter" | "Legal";
    landscape?: boolean;
    margin?: { top: string; right: string; bottom: string; left: string };
    printBackground?: boolean;
    scale?: number;
  };
  /** Background color (for PNG/JPEG) */
  backgroundColor?: string;
  /** Quality for JPEG (0-100) */
  quality?: number;
}

export interface WidgetRenderInput {
  widgetId: string;
  type: DashboardWidget["type"];
  spec: ChartSpec | TableSpec | PbiVisualSpec | Record<string, unknown>;
  /** Container dimensions for the widget */
  containerSize: { width: number; height: number };
  /** Widget title (optional) */
  title?: string;
  /**
   * Pre-computed plan from `widgetToRenderPlan`. Preferred over
   * reconstructing from `type` + `spec`, which is only correct for the legacy
   * ad-hoc `/api/render/widget` body shape.
   */
  plan?: WidgetRenderPlan;
}

export interface DashboardRenderInput {
  widgets: WidgetRenderInput[];
  /** Layout grid positions */
  layout?: Array<{ widgetId: string; x: number; y: number; w: number; h: number }>;
  /** Dashboard title */
  title?: string;
  /** Theme (light/dark) */
  theme?: "light" | "dark";
  /** Page size */
  pageSize?: { width: number; height: number };
}

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const MAX_CONCURRENT_RENDERS = 3;
const BROWSER_LAUNCH_TIMEOUT = 60_000;
const PAGE_LOAD_TIMEOUT = 30_000;
/**
 * Overall budget for the capture step (page.screenshot). PAGE_LOAD_TIMEOUT
 * covers `setContent`/`goto`; Playwright's page.pdf() takes no timeout option,
 * so PDF exports rely on the page default timeout set at acquisition.
 */
const RENDER_TIMEOUT = 60_000;

/**
 * Shared table/labelling chrome for both the widget and dashboard documents.
 * Every value here is a literal chosen by us, never user input.
 */
const TABLE_STYLES = `
  table.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.data-table th { padding: 8px; text-align: left; font-weight: 600; background: #f3f4f6; color: #374151; border-bottom: 1px solid #e5e7eb; }
  table.data-table td { padding: 6px 8px; vertical-align: top; border-bottom: 1px solid #f3f4f6; }
  .kpi-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .kpi-value { font-size: 32px; font-weight: 700; color: #1f2937; line-height: 1; }
`;

interface PooledPage {
  page: Page;
  inUse: boolean;
  lastUsed: number;
}

/**
 * Resolve the render plan for one input.
 *
 * Prefers a caller-supplied plan (the correct path — the adapter has already
 * read the widget's real payload columns). Falls back to reconstructing a
 * `DashboardWidget` from the legacy ad-hoc `{ type, spec }` body shape used by
 * `POST /api/render/widget`, mapping `spec` back onto the payload field that
 * `type` implies.
 */
function planFor(input: WidgetRenderInput): WidgetRenderPlan {
  if (input.plan) return input.plan;
  const spec = (input.spec ?? {}) as Record<string, unknown>;
  const as = <T>(v: unknown): T => v as T;
  const synthetic = {
    id: input.widgetId,
    type: input.type,
    title: input.title ?? "",
    w: 0,
    h: 0,
    // Map the flattened legacy payload back onto the column `type` implies.
    chart: input.type === "chart" ? as<ChartSpec>(spec) : undefined,
    pbiVisual: input.type === "pbi-visual" ? as<PbiVisualSpec>(spec) : undefined,
    table: input.type === "table" ? as<TableSpec>(spec) : undefined,
    kpi: input.type === "kpi" ? as<KpiCard>(spec) : undefined,
    content: input.type === "text" ? String(spec.content ?? "") : undefined,
    insight: input.type === "insight" ? as<InsightCard>(spec) : undefined,
    recommendation: input.type === "recommendation" ? as<RecommendationWidget>(spec) : undefined,
    slicer: input.type === "slicer" || input.type === "filter" ? as<SlicerSpec>(spec) : undefined,
    pivot:
      input.type === "pivot"
        ? as<{
            rows: string[];
            columns: string[];
            values: { column: string; aggregation: "sum" | "count" | "avg" | "min" | "max" }[];
          }>(spec)
        : undefined,
  } as unknown as DashboardWidget;
  const plan = widgetToRenderPlan(synthetic);
  return { ...plan, containerSize: input.containerSize ?? plan.containerSize };
}

export class VisualRenderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pagePool: PooledPage[] = [];
  private initializing = false;
  private initPromise: Promise<void> | null = null;

  /** Initialize browser and context (lazy, singleton) */
  async initialize(): Promise<void> {
    if (this.browser) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.initializing = true;
      try {
        this.browser = await chromium.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--disable-gpu",
            "--font-render-hinting=medium",
          ],
          timeout: BROWSER_LAUNCH_TIMEOUT,
        });
        this.context = await this.browser.newContext({
          viewport: DEFAULT_VIEWPORT,
          deviceScaleFactor: 2, // High-DPI for crisp charts
          colorScheme: "light",
        });
        // Pre-warm page pool
        for (let i = 0; i < MAX_CONCURRENT_RENDERS; i++) {
          const page = await this.context!.newPage();
          page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);
          this.pagePool.push({ page, inUse: false, lastUsed: Date.now() });
        }
      } finally {
        this.initializing = false;
      }
    })();

    return this.initPromise;
  }

  /** Acquire a page from the pool (creates new if pool exhausted) */
  private async acquirePage(): Promise<Page> {
    await this.initialize();

    // Find available page
    const available = this.pagePool.find((p) => !p.inUse);
    if (available) {
      available.inUse = true;
      available.lastUsed = Date.now();
      return available.page;
    }

    // Pool exhausted - create new page (up to reasonable limit)
    if (this.pagePool.length < MAX_CONCURRENT_RENDERS * 2) {
      const page = await this.context!.newPage();
      page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);
      const pooled = { page, inUse: true, lastUsed: Date.now() };
      this.pagePool.push(pooled);
      return page;
    }

    // Wait for a page to become available
    while (true) {
      const freed = this.pagePool.find((p) => !p.inUse);
      if (freed) {
        freed.inUse = true;
        freed.lastUsed = Date.now();
        return freed.page;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Release a page back to the pool */
  private releasePage(page: Page): void {
    const pooled = this.pagePool.find((p) => p.page === page);
    if (pooled) {
      pooled.inUse = false;
      pooled.lastUsed = Date.now();
    }
  }

  /** Render a single widget to image/PDF */
  async renderWidget(input: WidgetRenderInput, options: RenderOptions): Promise<Buffer> {
    const page = await this.acquirePage();
    try {
      const html = this.generateWidgetHTML(input);
      await page.setContent(html, { waitUntil: "networkidle", timeout: PAGE_LOAD_TIMEOUT });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10_000 });
      }
      if (options.waitAfterLoad) {
        await page.waitForTimeout(options.waitAfterLoad);
      }

      const clip = options.clip ?? {
        x: 0,
        y: 0,
        width: input.containerSize.width,
        height: input.containerSize.height,
      };

      if (options.format === "pdf") {
        return await page.pdf({
          format: options.pdfOptions?.format ?? "A4",
          landscape: options.pdfOptions?.landscape ?? false,
          margin: options.pdfOptions?.margin ?? { top: "0", right: "0", bottom: "0", left: "0" },
          printBackground: options.pdfOptions?.printBackground ?? true,
          scale: options.pdfOptions?.scale ?? 1,
        });
      }

      const screenshotOptions: Parameters<Page["screenshot"]>[0] = {
        type: options.format,
        clip,
        fullPage: options.fullPage ?? false,
        ...(options.format === "jpeg" && { quality: options.quality ?? 90 }),
        ...(options.backgroundColor && { omitBackground: false }),
        timeout: RENDER_TIMEOUT,
      };

      if (options.backgroundColor && options.format === "png") {
        // For PNG with background, inject background color
        await page.evaluate((color) => {
          document.body.style.backgroundColor = color;
        }, options.backgroundColor);
      }

      return await page.screenshot(screenshotOptions);
    } finally {
      this.releasePage(page);
    }
  }

  /** Render a full dashboard to image/PDF */
  async renderDashboard(input: DashboardRenderInput, options: RenderOptions): Promise<Buffer> {
    const page = await this.acquirePage();
    try {
      const html = this.generateDashboardHTML(input);
      await page.setContent(html, { waitUntil: "networkidle", timeout: PAGE_LOAD_TIMEOUT });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10_000 });
      }
      if (options.waitAfterLoad) {
        await page.waitForTimeout(options.waitAfterLoad);
      }

      if (options.format === "pdf") {
        return await page.pdf({
          format: options.pdfOptions?.format ?? "A4",
          landscape: options.pdfOptions?.landscape ?? true,
          margin: options.pdfOptions?.margin ?? { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
          printBackground: options.pdfOptions?.printBackground ?? true,
          scale: options.pdfOptions?.scale ?? 0.8,
        });
      }

      return await page.screenshot({
        type: options.format,
        fullPage: options.fullPage ?? true,
        ...(options.format === "jpeg" && { quality: options.quality ?? 90 }),
        timeout: RENDER_TIMEOUT,
      });
    } finally {
      this.releasePage(page);
    }
  }

  /** Render a URL directly (for public embed links) */
  async renderURL(url: string, options: RenderOptions): Promise<Buffer> {
    const page = await this.acquirePage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_LOAD_TIMEOUT });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10_000 });
      }
      if (options.waitAfterLoad) {
        await page.waitForTimeout(options.waitAfterLoad);
      }

      if (options.format === "pdf") {
        return await page.pdf({
          format: options.pdfOptions?.format ?? "A4",
          landscape: options.pdfOptions?.landscape ?? true,
          margin: options.pdfOptions?.margin ?? { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
          printBackground: options.pdfOptions?.printBackground ?? true,
        });
      }

      return await page.screenshot({
        type: options.format,
        fullPage: options.fullPage ?? true,
        clip: options.clip,
        ...(options.format === "jpeg" && { quality: options.quality ?? 90 }),
      });
    } finally {
      this.releasePage(page);
    }
  }

  /** Generate HTML for a single widget using embedded chart libraries */
  private generateWidgetHTML(input: WidgetRenderInput): string {
    const { width, height } = input.containerSize;
    const plan = planFor(input);
    const { html, scripts } = this.renderPlanBody(plan, "light");

    // Common styles for all widget types
    const styles = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: transparent; }
      .widget-container { width: ${width}px; height: ${height}px; display: flex; flex-direction: column; }
      .widget-header { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600; font-size: 14px; color: #1f2937; flex-shrink: 0; }
      .widget-body { flex: 1; overflow: hidden; position: relative; }
      ${TABLE_STYLES}
    `;

    const header = plan.title ? `<div class="widget-header">${this.escapeHtml(plan.title)}</div>` : "";
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${styles}</style>
        <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
      </head>
      <body>
        <div class="widget-container">
          ${header}
          <div class="widget-body">${html}</div>
        </div>
        ${scripts}
      </body>
      </html>
    `;
  }

  /** Generate HTML for a full dashboard */
  private generateDashboardHTML(input: DashboardRenderInput): string {
    const { widgets, layout, title, theme = "light", pageSize = { width: 1920, height: 1080 } } = input;
    const dark = theme === "dark";

    const styles = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${dark ? "#111827" : "#f9fafb"}; color: ${dark ? "#f3f4f6" : "#1f2937"}; }
      .dashboard { width: ${pageSize.width}px; height: ${pageSize.height}px; display: grid; grid-template-columns: repeat(12, 1fr); grid-template-rows: repeat(12, 1fr); gap: 8px; padding: 16px; }
      .dashboard-header { grid-column: 1 / -1; grid-row: 1; padding: 0 8px 16px; border-bottom: 1px solid ${dark ? "#374151" : "#e5e7eb"}; }
      .dashboard-title { font-size: 24px; font-weight: 700; }
      .widget { display: flex; flex-direction: column; background: ${dark ? "#1f2937" : "#ffffff"}; border-radius: 8px; border: 1px solid ${dark ? "#374151" : "#e5e7eb"}; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
      .widget-header { padding: 8px 12px; border-bottom: 1px solid ${dark ? "#374151" : "#e5e7eb"}; font-weight: 600; font-size: 13px; flex-shrink: 0; }
      .widget-body { flex: 1; overflow: hidden; position: relative; }
      ${TABLE_STYLES}
    `;

    // Layout lookup is now O(1) — the previous `layout?.find()` inside the
    // loop was O(n^2) across every widget on the dashboard.
    const layoutById = new Map((layout ?? []).map((l) => [l.widgetId, l]));

    let widgetHTML = "";
    let scripts = "";

    for (const widget of widgets) {
      const plan = planFor(widget);
      const info = layoutById.get(plan.widgetId);
      const style = info
        ? `grid-column: ${info.x + 1} / span ${info.w}; grid-row: ${info.y + 1} / span ${info.h};`
        : "";

      const body = this.renderPlanBody(plan, theme);
      scripts += body.scripts;
      const header = plan.title ? `<div class="widget-header">${this.escapeHtml(plan.title)}</div>` : "";
      widgetHTML += `<div class="widget" style="${style}">${header}<div class="widget-body">${body.html}</div></div>`;
    }

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=${pageSize.width}, initial-scale=1.0">
        <style>${styles}</style>
        <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
      </head>
      <body>
        <div class="dashboard">
          ${title ? `<div class="dashboard-header"><div class="dashboard-title">${this.escapeHtml(title)}</div></div>` : ""}
          ${widgetHTML}
        </div>
        ${scripts}
      </body>
      </html>
    `;
  }

  /**
   * Render one widget plan to HTML plus any ECharts bootstrap scripts.
   *
   * Every `RenderableWidgetKind` is handled. Two honest-degradation rules apply
   * everywhere:
   *   - a canvas chart whose kind has no canvas renderer, or which carries no
   *     data, degrades to the labelled data table;
   *   - a widget with no saved snapshot renders a stated reason, never a
   *     blank frame that reads as "the chart was empty".
   */
  private renderPlanBody(plan: WidgetRenderPlan, theme: "light" | "dark"): { html: string; scripts: string } {
    const dark = theme === "dark";
    switch (plan.kind) {
      case "chart": {
        if (!plan.chart) return { html: this.noteHTML(plan.note), scripts: "" };
        // Report-grade formatting (ROADMAP 3.4): the widget's format block
        // rides along into the export so the PDF/PNG matches the live
        // dashboard — data labels, reference line and palette override.
        const option = chartSpecToECharts(plan.chart, plan.format);
        if (!option) {
          // Either a non-canvas kind (map / AI visual) or an empty spec.
          return {
            html: isCanvasChartKind(plan.chart.kind)
              ? this.noteHTML(
                  plan.chart.placeholderNote ??
                    `"${plan.chart.title || plan.chart.kind}" has no plottable data in its snapshot.`,
                )
              : fallbackTableSvg(plan.chart, 640),
            scripts: "",
          };
        }
        return {
          html: `<div id="chart-${esc(plan.widgetId)}" style="width: 100%; height: 100%;"></div>`,
          scripts: this.echartsBootstrap(`chart-${esc(plan.widgetId)}`, option),
        };
      }

      case "pbi-visual": {
        if (!plan.pbiVisual) return { html: this.noteHTML(plan.note), scripts: "" };
        // Widget-level format wins, spec-level format fills the gaps — the
        // same precedence the published dashboard view applies.
        const specWithFormat: PbiVisualSpec = plan.format
          ? {
              ...plan.pbiVisual,
              format: {
                ...(plan.pbiVisual.format ?? {}),
                ...(plan.format.dataLabels ? { dataLabels: true } : {}),
                ...(plan.format.referenceLine ? { referenceLine: plan.format.referenceLine } : {}),
                ...(plan.format.palette?.length ? { palette: plan.format.palette } : {}),
              },
            }
          : plan.pbiVisual;
        const option = pbiVisualToECharts(specWithFormat);
        if (!option) {
          return {
            html:
              this.noteHTML(
                `"${plan.pbiVisual.kind}" visual cannot be drawn in a static export. Its data is listed below.`,
              ) + this.categoriesTable(plan.pbiVisual.categories, plan.pbiVisual.values),
            scripts: "",
          };
        }
        return {
          html: `<div id="pbi-${esc(plan.widgetId)}" style="width: 100%; height: 100%;"></div>`,
          scripts: this.echartsBootstrap(`pbi-${esc(plan.widgetId)}`, option),
        };
      }

      case "table":
        return { html: plan.table ? this.generateTableHTML(plan.table, dark) : this.noteHTML(plan.note), scripts: "" };

      case "kpi":
        return { html: plan.kpi ? this.generateKPIHTML(plan.kpi, dark) : this.noteHTML(plan.note), scripts: "" };

      case "text":
        return {
          html: `<div style="padding: 16px; white-space: pre-wrap; font-size: 13px; line-height: 1.6;">${this.escapeHtml(plan.text ?? "")}</div>`,
          scripts: "",
        };

      case "insight":
        return {
          html: plan.insight ? this.generateInsightHTML(plan.insight, dark) : this.noteHTML(plan.note),
          scripts: "",
        };

      case "recommendation":
        return {
          html: plan.recommendation
            ? this.generateRecommendationHTML(plan.recommendation, dark)
            : this.noteHTML(plan.note),
          scripts: "",
        };

      case "slicer":
        return {
          html: plan.slicer ? this.generateSlicerHTML(plan.slicer, dark) : this.noteHTML(plan.note),
          scripts: "",
        };

      case "pivot":
        return { html: this.generatePivotHTML(plan, dark), scripts: "" };

      default:
        return { html: this.noteHTML(plan.note ?? `Widget type "${plan.kind}" cannot be rendered.`), scripts: "" };
    }
  }

  /** Neutral, legible explanation block. Never rendered on its own. */
  private noteHTML(note: string | undefined, dark = false): string {
    if (!note) return "";
    return `<div style="padding: 16px; color: ${dark ? "#9ca3af" : "#6b7280"}; font-size: 12px; line-height: 1.6;">${this.escapeHtml(note)}</div>`;
  }

  /** Bootstrap script that mounts an ECharts option onto a container id. */
  private echartsBootstrap(containerId: string, option: unknown): string {
    // Serialised with JSON.stringify, then guarded: `</script` inside a string
    // would otherwise terminate the tag early and inject markup.
    const payload = JSON.stringify(option).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
    return `
      <script>
        (function() {
          var el = document.getElementById(${JSON.stringify(containerId)});
          if (!el || typeof echarts === "undefined") return;
          var chart = echarts.init(el, null, { renderer: "canvas" });
          chart.setOption(${payload});
          window.addEventListener("resize", function() { chart.resize(); });
        })();
      </script>
    `;
  }

  /** Two-column label/value table used by the pivot and PBI fallbacks. */
  private categoriesTable(categories: string[], values: number[]): string {
    const rows = categories
      .map(
        (c, i) =>
          `<tr><td>${this.escapeHtml(c)}</td><td style="text-align:right;font-weight:600">${this.escapeHtml(this.formatNumber(values[i]))}</td></tr>`,
      )
      .join("");
    return `<table class="data-table">${rows}</table>`;
  }

  private formatNumber(v: unknown): string {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    return Math.abs(v) >= 1e6
      ? `${(v / 1e6).toFixed(1)}M`
      : Math.abs(v) >= 1e3
        ? `${(v / 1e3).toFixed(1)}K`
        : Number.isInteger(v)
          ? String(v)
          : v.toFixed(2);
  }

  private generateEChartsScript(widgetId: string, spec: ChartSpec, isPivot = false): string {
    const containerId = isPivot ? `pivot-${widgetId}` : `chart-${widgetId}`;
    const option = chartSpecToECharts(spec);
    if (!option) return "";
    return this.echartsBootstrap(containerId, option);
  }

  private generatePbiVisualScript(widgetId: string, spec: PbiVisualSpec): string {
    const option = pbiVisualToECharts(spec);
    if (!option) return "";
    return this.echartsBootstrap(`pbi-${widgetId}`, option);
  }

  private generateTableHTML(spec: TableSpec, dark = false): string {
    const { columns, rows } = spec;
    const cols = Array.isArray(columns) ? columns : [];
    const allRows = Array.isArray(rows) ? rows : [];
    // A very long table is truncated with an explicit footer rather than being
    // silently clipped by the container's overflow:hidden.
    const limit = 200;
    const shown = allRows.slice(0, limit);
    const zebra = dark ? "#111827" : "#f9fafb";
    return `
      <div style="overflow: auto; width: 100%; height: 100%;">
        <table class="data-table">
          <thead>
            <tr>
              ${cols.map((c) => `<th style="text-align: left;">${this.escapeHtml(String(c.label ?? c.key))}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${shown
              .map(
                (row, ri) => `
              <tr style="${ri % 2 === 1 ? `background: ${zebra};` : ""}">
                ${cols.map((_, ci) => `<td>${this.formatCellValue(row[ci], cols[ci]?.format ?? "text")}</td>`).join("")}
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
        ${allRows.length > limit ? `<div style="padding: 6px 10px; font-size: 11px; color: #9ca3af;">Showing ${limit} of ${allRows.length} rows.</div>` : ""}
      </div>
    `;
  }

  /**
   * KPI tile.
   *
   * Reads the real `KpiCard` shape (`deltaPct`, not `trend`; no `prefix`/
   * `suffix` fields — the unit lives on the chart spec). The previous version
   * looked for `spec.trend` / `spec.prefix` / `spec.suffix`, none of which
   * exist on `KpiCard`, so every exported KPI silently dropped its delta
   * arrow and sparkline.
   */
  private generateKPIHTML(card: KpiCard, dark = false): string {
    const hasDelta = typeof card.deltaPct === "number" && Number.isFinite(card.deltaPct);
    const up = (card.deltaPct ?? 0) >= 0;
    const spark = Array.isArray(card.spark) ? card.spark.filter((v) => typeof v === "number") : [];
    const sparkline = spark.length >= 2 ? this.sparklineSVG(spark) : "";
    return `
      <div style="padding: 16px; text-align: center;">
        <div class="kpi-label">${this.escapeHtml(card.label ?? "")}</div>
        <div class="kpi-value">${this.escapeHtml(card.value ?? "—")}</div>
        ${
          hasDelta
            ? `<div style="margin-top: 8px; display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: ${up ? "#059669" : "#dc2626"};">
          <span>${up ? "▲" : "▼"}</span>
          <span>${Math.abs(card.deltaPct as number).toFixed(1)}%</span>
          ${card.deltaLabel ? `<span style="color: ${dark ? "#9ca3af" : "#6b7280"};">${this.escapeHtml(card.deltaLabel)}</span>` : ""}
        </div>`
            : ""
        }
        ${sparkline}
        ${card.hint ? `<div style="margin-top: 6px; font-size: 11px; color: ${dark ? "#9ca3af" : "#6b7280"};">${this.escapeHtml(card.hint)}</div>` : ""}
      </div>
    `;
  }

  /** Minimal inline sparkline (no canvas, no dependency). */
  private sparklineSVG(values: number[], color = "#5AA8AA"): string {
    const w = 120;
    const h = 28;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values
      .map((v, i) => {
        const x = (i / Math.max(1, values.length - 1)) * w;
        const y = h - ((v - min) / span) * (h - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="trend"><polyline points="${pts}" fill="none" stroke="${esc(color)}" stroke-width="1.5" /></svg>`;
  }

  /** Insight card: severity, metric, evidence and the recommended next step. */
  private generateInsightHTML(insight: InsightCard, dark = false): string {
    const sev = insight.severity ?? "info";
    const sevColor = sev === "critical" ? "#b91c1c" : sev === "warning" ? "#b45309" : "#0369a1";
    const evidence = (insight.evidence ?? []).filter((e) => typeof e === "string" && e.length > 0);
    return `
      <div style="padding: 14px 16px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="background: ${sevColor}; color: #fff; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px;">${this.escapeHtml(sev)}</span>
          ${insight.metric ? `<span style="font-size: 12px; color: ${dark ? "#9ca3af" : "#6b7280"};">${this.escapeHtml(insight.metric)}</span>` : ""}
          ${insight.confidence ? `<span style="margin-left: auto; font-size: 11px; color: ${dark ? "#9ca3af" : "#6b7280"};">${this.escapeHtml(insight.confidence)}</span>` : ""}
        </div>
        <div style="font-size: 13px; font-weight: 600;">${this.escapeHtml(insight.title ?? "")}</div>
        ${insight.observedChange ? `<div style="font-size: 12px; color: ${dark ? "#d1d5db" : "#374151"};">${this.escapeHtml(insight.observedChange)}</div>` : ""}
        ${evidence.length ? `<ul style="margin: 0; padding-left: 16px; font-size: 12px; color: ${dark ? "#d1d5db" : "#374151"};">${evidence.map((e) => `<li>${this.escapeHtml(e)}</li>`).join("")}</ul>` : ""}
        ${insight.possibleCause ? `<div style="font-size: 12px;"><strong>Possible cause:</strong> ${this.escapeHtml(insight.possibleCause)}</div>` : ""}
        ${insight.businessImplication ? `<div style="font-size: 12px;"><strong>Implication:</strong> ${this.escapeHtml(insight.businessImplication)}</div>` : ""}
        ${insight.recommendedNextStep ? `<div style="font-size: 12px;"><strong>Next step:</strong> ${this.escapeHtml(insight.recommendedNextStep)}</div>` : ""}
      </div>
    `;
  }

  /** Advisor recommendation: the text plus its ordered next steps. */
  private generateRecommendationHTML(rec: RecommendationWidget, dark = false): string {
    const priority = rec.priority ?? "info";
    const color = priority === "critical" ? "#b91c1c" : priority === "warning" ? "#b45309" : "#047857";
    const steps = (rec.nextSteps ?? []).filter((s) => typeof s === "string" && s.length > 0);
    return `
      <div style="padding: 14px 16px; display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: ${color};">${this.escapeHtml(priority)} priority</div>
        <div style="font-size: 13px; line-height: 1.5; color: ${dark ? "#f3f4f6" : "#1f2937"};">${this.escapeHtml(rec.text ?? "")}</div>
        ${steps.length ? `<ol style="margin: 0; padding-left: 18px; font-size: 12px; color: ${dark ? "#d1d5db" : "#374151"};">${steps.map((s) => `<li>${this.escapeHtml(s)}</li>`).join("")}</ol>` : ""}
      </div>
    `;
  }

  /**
   * Power BI slicer control.
   *
   * Replaces the old `generateFilterHTML`, which read a `{options, selected}`
   * shape that no `DashboardWidget` has ever carried — no code anywhere in the
   * app constructs `type: "filter"`, and the real control is `SlicerSpec`.
   */
  private generateSlicerHTML(spec: SlicerSpec, dark = false): string {
    const values = (spec.values ?? []).filter((v): v is string => typeof v === "string");
    const chips = values
      .map(
        (v) =>
          `<span style="display: inline-block; margin: 0 4px 4px 0; padding: 3px 8px; border: 1px solid ${dark ? "#4b5563" : "#d1d5db"}; border-radius: 999px; font-size: 12px;">${this.escapeHtml(v)}</span>`,
      )
      .join("");
    return `
      <div style="padding: 12px 14px;">
        <div style="font-size: 12px; color: ${dark ? "#9ca3af" : "#6b7280"}; margin-bottom: 8px;">
          ${this.escapeHtml(spec.column)}
          <span style="opacity: 0.7;">· ${values.length} value${values.length === 1 ? "" : "s"}${spec.multiSelect === false ? " · single-select" : ""}</span>
        </div>
        ${values.length ? chips : `<div style="font-size: 12px; color: #9ca3af;">No values captured for this column.</div>`}
      </div>
    `;
  }

  /**
   * Pivot widget.
   *
   * A pivot stores a *field well* (rows/columns/aggregations), not results —
   * the numbers require a live query. This renders the configuration and says
   * so, rather than casting the definition to a `ChartSpec` (which is what
   * produced a blank canvas and a `ReferenceError` in the page).
   */
  private generatePivotHTML(plan: WidgetRenderPlan, dark = false): string {
    const pivot = plan.pivot;
    const group = (label: string, items: string[]) =>
      items.length
        ? `<div style="margin-bottom: 6px;"><span style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: ${dark ? "#9ca3af" : "#6b7280"};">${this.escapeHtml(label)}</span><div style="font-size: 12px;">${items.map((i) => this.escapeHtml(i)).join(", ")}</div></div>`
        : "";
    const values = (pivot?.values ?? []).map((v) => `${v.aggregation} of ${v.column}`);
    return `
      <div style="padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;">
        ${this.noteHTML(plan.note, dark)}
        ${group("Rows", pivot?.rows ?? [])}
        ${group("Columns", pivot?.columns ?? [])}
        ${group("Values", values)}
      </div>
    `;
  }

  private formatCellValue(value: unknown, format: string): string {
    if (value === null || value === undefined) return '<span style="color: #9ca3af;">—</span>';
    switch (format) {
      case "number":
        return this.escapeHtml(typeof value === "number" ? value.toLocaleString() : String(value));
      case "currency":
        return this.escapeHtml(
          typeof value === "number"
            ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
            : String(value),
        );
      case "percent":
        return this.escapeHtml(typeof value === "number" ? (value * 100).toFixed(1) + "%" : String(value));
      case "date":
        return this.escapeHtml(typeof value === "string" ? value.slice(0, 10) : String(value));
      default:
        return this.escapeHtml(String(value));
    }
  }

  private escapeHtml(str: string): string {
    // Delegates to the canonical escaper. This method previously attempted to
    // escape `&`, `<` and `>` but replaced each with itself (the entities had
    // been lost in a bad find/replace), leaving `<`/`>` untouched. Every
    // widget title, text body, table header, KPI label and slicer option is
    // interpolated into a `page.setContent()` document — a real Chromium with
    // scripts enabled — so that made authoring a dashboard title a stored-XSS
    // vector against the render context.
    return esc(str).replace(/'/g, "&#039;");
  }

  /** Cleanup resources */
  async close(): Promise<void> {
    for (const pooled of this.pagePool) {
      try {
        await pooled.page.close();
      } catch {
        // ignore
      }
    }
    this.pagePool = [];
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /** Get pool stats */
  getStats(): { total: number; inUse: number; available: number } {
    const total = this.pagePool.length;
    const inUse = this.pagePool.filter((p) => p.inUse).length;
    return { total, inUse, available: total - inUse };
  }
}

/** Singleton instance */
let rendererInstance: VisualRenderer | null = null;

export function getVisualRenderer(): VisualRenderer {
  if (!rendererInstance) {
    rendererInstance = new VisualRenderer();
  }
  return rendererInstance;
}

export async function shutdownVisualRenderer(): Promise<void> {
  if (rendererInstance) {
    await rendererInstance.close();
    rendererInstance = null;
  }
}
