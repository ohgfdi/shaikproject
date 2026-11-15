/**
 * `DashboardWidget -> renderable payload` adapter for the headless renderer.
 *
 * ## Why this exists
 *
 * `DashboardWidget` stores type-specific payload fields (`chart`, `kpi`,
 * `table`, `content`, `insight`, `recommendation`, `pivot`, `pbiVisual`,
 * `slicer`) and has **no generic `spec` field**. The render routes assumed one
 * existed and read `w.spec`, which is `undefined` for every widget:
 *
 *   - `table`  -> destructured from `undefined` -> `TypeError`, HTTP 500
 *   - `chart`  -> `JSON.stringify(undefined)` -> `"undefined"` injected as a
 *                 bare JS identifier -> in-page `ReferenceError`, blank image
 *   - `kpi`    -> silently rendered as the em-dash placeholder
 *
 * Because widgets are stored *snapshots* rather than live queries, the
 * renderer needs no data access — it needs exactly this adapter. It is pure,
 * dependency-free, and unit-tested, so a payload mismatch fails a test instead
 * of producing a plausible-looking empty PNG.
 */

import type {
  ChartSpec,
  DashboardWidget,
  InsightCard,
  KpiCard,
  PbiVisualSpec,
  RecommendationWidget,
  SlicerSpec,
  TableSpec,
  VisualFormat,
} from "@/lib/types";

/** Every widget type the renderer can draw, plus the honest fallbacks. */
export type RenderableWidgetKind =
  "chart" | "pbi-visual" | "table" | "kpi" | "text" | "insight" | "recommendation" | "slicer" | "pivot" | "unsupported";

/** The pivot field well, as stored. Requires a live query to show numbers. */
export interface PivotDefinition {
  rows: string[];
  columns: string[];
  values: { column: string; aggregation: "sum" | "count" | "avg" | "min" | "max" }[];
}

export interface WidgetRenderPlan {
  widgetId: string;
  /** The renderer branch to take. */
  kind: RenderableWidgetKind;
  title: string;
  containerSize: { width: number; height: number };
  /** Canvas-drawn payloads. */
  chart?: ChartSpec;
  pbiVisual?: PbiVisualSpec;
  table?: TableSpec;
  kpi?: KpiCard;
  /** HTML-drawn payloads. */
  text?: string;
  insight?: InsightCard;
  recommendation?: RecommendationWidget;
  slicer?: SlicerSpec;
  pivot?: PivotDefinition;
  /**
   * Report-grade formatting (ROADMAP 3.4) carried from the widget so the
   * headless renderer draws the SAME visual the dashboard shows — data
   * labels, reference lines and palette overrides are not lost in export.
   */
  format?: VisualFormat;
  /**
   * Why this widget cannot be drawn at full fidelity, in plain language.
   * Surfaced in the image so a degraded export is never mistaken for a
   * complete one — the same honesty contract as `lib/export/svg-chart.ts`.
   */
  note?: string;
}

/** Dashboard grid geometry: 12 columns, a fixed column width and row height. */
export const GRID_COLUMNS = 12;
const COLUMN_WIDTH = 152;
const ROW_HEIGHT = 96;
const MIN_SIZE = 160;
const MAX_SIZE = 2400;

/** Grid cell spans -> pixel container size, clamped so no widget renders 0x0. */
export function widgetContainerSize(w: number | undefined, h: number | undefined): { width: number; height: number } {
  const spanW = Number.isFinite(w) && (w ?? 0) > 0 ? (w as number) : GRID_COLUMNS / 2;
  const spanH = Number.isFinite(h) && (h ?? 0) > 0 ? (h as number) : 3;
  return {
    width: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(spanW * COLUMN_WIDTH))),
    height: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(spanH * ROW_HEIGHT))),
  };
}

/**
 * Extract the 12-column layout from the widget JSON itself.
 *
 * `renderDashboard` previously hardcoded `layout = undefined`, so every widget
 * fell back to CSS grid auto-placement and the saved `x`/`y`/`w`/`h` was
 * silently discarded — the exported image did not match the dashboard.
 */
export function dashboardLayout(
  widgets: Pick<DashboardWidget, "id" | "x" | "y" | "w" | "h">[],
): Array<{ widgetId: string; x: number; y: number; w: number; h: number }> {
  return widgets
    .filter((w) => Number.isFinite(w.x) && Number.isFinite(w.y))
    .map((w) => ({
      widgetId: w.id,
      x: Math.max(0, Math.round(w.x as number)),
      y: Math.max(0, Math.round(w.y as number)),
      w: Math.max(1, Math.min(GRID_COLUMNS, Math.round(w.w || GRID_COLUMNS / 2))),
      h: Math.max(1, Math.round(w.h || 3)),
    }));
}

function pivotDefinition(widget: DashboardWidget): PivotDefinition | null {
  const p = widget.pivot;
  if (!p || typeof p !== "object") return null;
  const rows = Array.isArray(p.rows) ? p.rows.filter((r) => typeof r === "string") : [];
  const columns = Array.isArray(p.columns) ? p.columns.filter((c) => typeof c === "string") : [];
  const values = Array.isArray(p.values)
    ? p.values.filter(
        (v): v is PivotDefinition["values"][number] =>
          !!v && typeof v.column === "string" && typeof v.aggregation === "string",
      )
    : [];
  if (rows.length === 0 && columns.length === 0 && values.length === 0) return null;
  return { rows, columns, values };
}

/**
 * Map a stored widget to a renderer plan.
 *
 * Never throws and never invents data: an unrecognised type becomes
 * `kind: "unsupported"` with a note explaining why, so the renderer can draw
 * an honest placeholder instead of an empty frame.
 */
export function widgetToRenderPlan(widget: DashboardWidget): WidgetRenderPlan {
  const title = typeof widget.title === "string" ? widget.title : "";
  const containerSize = widgetContainerSize(widget.w, widget.h);
  const base = { widgetId: widget.id, title, containerSize };

  switch (widget.type) {
    case "chart":
      if (!widget.chart || typeof widget.chart !== "object") {
        return {
          ...base,
          kind: "chart",
          note: "This chart widget has no saved snapshot yet. Run or republish the dashboard to capture one.",
        };
      }
      return { ...base, kind: "chart", chart: widget.chart, format: widget.format };

    case "pbi-visual":
      if (!widget.pbiVisual || typeof widget.pbiVisual !== "object") {
        return {
          ...base,
          kind: "pbi-visual",
          note: "This visual has no saved snapshot yet. Run or republish the dashboard to capture one.",
        };
      }
      return { ...base, kind: "pbi-visual", pbiVisual: widget.pbiVisual, format: widget.format };

    case "table":
      if (!widget.table || !Array.isArray(widget.table.columns)) {
        return { ...base, kind: "table", note: "This table widget has no saved data." };
      }
      return {
        ...base,
        kind: "table",
        table: {
          title: widget.table.title ?? title,
          columns: widget.table.columns ?? [],
          rows: Array.isArray(widget.table.rows) ? widget.table.rows : [],
        },
      };

    case "kpi":
      if (!widget.kpi || typeof widget.kpi !== "object" || typeof widget.kpi.value !== "string") {
        return { ...base, kind: "kpi", note: "This KPI has no saved value." };
      }
      return { ...base, kind: "kpi", kpi: widget.kpi };

    case "text":
      return { ...base, kind: "text", text: typeof widget.content === "string" ? widget.content : "" };

    case "insight":
      if (!widget.insight || typeof widget.insight !== "object") {
        return { ...base, kind: "insight", note: "This insight has not been generated yet." };
      }
      return { ...base, kind: "insight", insight: widget.insight };

    case "recommendation":
      if (
        !widget.recommendation ||
        typeof widget.recommendation.text !== "string" ||
        !Array.isArray(widget.recommendation.nextSteps)
      ) {
        return { ...base, kind: "recommendation", note: "This recommendation has not been generated yet." };
      }
      return { ...base, kind: "recommendation", recommendation: widget.recommendation };

    case "slicer":
    case "filter":
      // `slicer` is the real Power BI control; `filter` is a legacy alias with
      // no payload field and no producer anywhere in the app. Both normalise
      // onto `SlicerSpec` here.
      if (!widget.slicer || typeof widget.slicer.column !== "string") {
        return { ...base, kind: "slicer", note: "This slicer has no configured column." };
      }
      const spec: SlicerSpec = {
        column: widget.slicer.column,
        values: Array.isArray(widget.slicer.values)
          ? widget.slicer.values.filter((v): v is string => typeof v === "string")
          : [],
        style: widget.slicer.style,
        multiSelect: widget.slicer.multiSelect,
      };
      return { ...base, kind: "slicer", slicer: spec, title: title || spec.column };

    case "pivot": {
      const pivot = pivotDefinition(widget);
      if (!pivot) return { ...base, kind: "pivot", note: "This pivot has no configured fields." };
      return {
        ...base,
        kind: "pivot",
        pivot,
        // A pivot stores a *field well*, not results — the numbers require a
        // live query against the dataset, which a static export cannot make.
        note: "Pivot results are calculated at view time and are not included in a static export. Shown: the configured fields.",
      };
    }

    default:
      return {
        ...base,
        kind: "unsupported",
        note: `Widget type "${String(widget.type)}" cannot be rendered to an image.`,
      };
  }
}
