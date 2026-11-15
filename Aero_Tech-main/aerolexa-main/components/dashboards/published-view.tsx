"use client";

import { LayoutDashboard } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

import { renderSpec } from "@/components/charts/chart";
import { Badge, Card } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { applyCrossFilters } from "@/lib/engine/cross-filter";
import { DEFAULT_THEME } from "@/lib/engine/report-pages";
import { ViewerTierInfo } from "@/lib/scene/viewer-tier";
import type { DashboardWidget, ReportPage, ReportTheme } from "@/lib/types";

/**
 * ECharts (~1 MB) is loaded on demand. It was imported eagerly here, which put
 * the whole ECharts runtime in the INITIAL bundle of both public viewer routes
 * (/apps/[shareToken] and /embed/[token], ~550 kB each) even though a published
 * dashboard may contain no pbi-visual widget at all — the viewer paid for it on
 * first paint. The chunk is now fetched the first time a visual actually
 * renders, matching what the Power BI studio already does.
 *
 * The placeholder mirrors the real 260px tile height so the tile does not jump
 * when the chunk lands.
 */
const PbiVisual = dynamic(() => import("@/components/charts/pbi-visual").then((m) => m.PbiVisual), {
  ssr: false,
  loading: () => <div aria-hidden className="w-full animate-pulse rounded-md bg-surface-2" style={{ height: 260 }} />,
});

/**
 * Read-only published-dashboard renderer for /apps/[shareToken].
 *
 * Widgets carry their own inline snapshots (computed at publish/last-run
 * time) so anonymous viewers see real numbers without any code execution.
 *
 * Power BI parity: renders the saved report PAGES with page tabs (page 1
 * mirrors the legacy widgets array), applies the saved cross-filter state
 * (including slicers) to every tile, and tints each visual with the saved
 * report theme's palette.
 *
 * Viewer-tier hardening (S10):
 * - Accepts viewerTier to render charts at appropriate quality
 * - iOS Safari viewers get conservative settings
 * - Honest fallback to 2D when WebGL unavailable
 */
export function PublishedDashboardView({
  app,
  viewerTier,
}: {
  app: {
    title: string;
    description?: string | null;
    widgets: DashboardWidget[];
    pages?: ReportPage[] | null;
    theme?: ReportTheme | null;
    publishedAt?: string | null;
  };
  viewerTier: ViewerTierInfo | null;
}) {
  const pages: ReportPage[] =
    app.pages && app.pages.length > 0 ? app.pages : [{ id: "page-1", name: app.title, widgets: app.widgets }];
  const [activePageId, setActivePageId] = useState<string>(pages[0]?.id ?? "page-1");
  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0]!;
  const theme = app.theme ?? DEFAULT_THEME;

  // A published dashboard honors the cross-filter state saved with it (the
  // builder's "Save filters"), including slicer contributions — the same
  // engine the editor uses, applied once over the page's stored widgets.
  const savedFilters = activePage.widgets.find((w) => w.crossFilters?.length)?.crossFilters ?? [];
  const widgets = applyCrossFilters(activePage.widgets, savedFilters);
  const savedSelectionsByWidget = new Map<string, string[]>(
    savedFilters.filter((f) => f.sourceWidgetId !== undefined).map((f) => [f.sourceWidgetId, f.values]),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-h2 font-medium text-foreground">{app.title}</h1>
          <Badge variant="info">
            <LayoutDashboard className="mr-1 size-3" /> Published dashboard
          </Badge>
          <Badge variant="outline">Public link</Badge>
        </div>
        {app.description && <p className="mb-1 text-muted">{app.description}</p>}
        <p className="text-caption text-muted">
          {app.publishedAt ? `Published ${new Date(app.publishedAt).toLocaleDateString()}` : "Published"}
          {" · "}
          Values are snapshots from publish time.
        </p>
      </div>

      {/* Page tabs (only shown when the report has more than one page) */}
      {pages.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Report pages">
          {pages.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === activePage.id}
              onClick={() => setActivePageId(p.id)}
              className="rounded-full border px-3 py-1 text-caption transition-colors"
              style={{
                borderColor: p.id === activePage.id ? theme.palette[0] : undefined,
                background: p.id === activePage.id ? `${theme.palette[0]}1a` : undefined,
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {activePage.widgets.length === 0 && (
        <Card className="p-6 text-center text-caption text-muted">This page has no widgets.</Card>
      )}

      <div className="grid auto-rows-min grid-cols-1 gap-4 md:grid-cols-2">
        {widgets.map((widget) => (
          <WidgetCard
            key={widget.id}
            widget={widget}
            viewerTier={viewerTier}
            theme={theme}
            savedSelections={savedSelectionsByWidget.get(widget.id) ?? []}
          />
        ))}
      </div>
    </div>
  );
}

function WidgetCard({
  widget,
  viewerTier,
  theme,
  savedSelections,
}: {
  widget: DashboardWidget;
  viewerTier: ViewerTierInfo | null;
  theme: ReportTheme;
  savedSelections: string[];
}) {
  // Use 3D for supported chart kinds if viewer has WebGL and tier allows
  const use3D = widget.type === "chart" && widget.chart && viewerTier?.webgl && viewerTier?.tier !== "flat";

  if (widget.type === "slicer" && widget.slicer) {
    // Read-only on publish: show the saved selection state, no interaction.
    return (
      <Card className="p-4">
        <p className="mb-2 text-sm font-semibold text-foreground">{widget.title}</p>
        <p className="text-caption text-muted">Filter: {widget.slicer.column}</p>
        <p className="mt-1 text-sm text-foreground">{savedSelections.length ? savedSelections.join(", ") : "(All)"}</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 md:col-span-1">
      <p className="mb-2 text-sm font-semibold text-foreground">{widget.title}</p>
      {widget.type === "kpi" && widget.kpi && <KpiWidget widget={widget} />}
      {widget.type === "chart" && widget.chart && renderSpec(widget.chart, "comma", 260, use3D ? "3d" : "2d")}
      {widget.type === "table" && widget.table && <TableWidget widget={widget} />}
      {widget.type === "text" && widget.content && (
        <p className="whitespace-pre-wrap text-sm text-muted">{widget.content}</p>
      )}
      {widget.type === "insight" && widget.insight && <InsightCardView widget={widget} />}
      {widget.type === "pbi-visual" &&
        widget.pbiVisual &&
        (widget.pbiVisual.kind === ("map" as string) ? (
          <PublishedChoropleth widget={widget} />
        ) : (
          <PbiVisual
            spec={{
              ...widget.pbiVisual,
              format: {
                ...(widget.pbiVisual.format ?? {}),
                palette: widget.format?.palette ?? widget.pbiVisual.format?.palette ?? theme.palette,
                ...(widget.format?.dataLabels || theme.dataLabels || widget.pbiVisual.format?.dataLabels
                  ? { dataLabels: true }
                  : {}),
                ...(widget.format?.referenceLine ? { referenceLine: widget.format.referenceLine } : {}),
              },
            }}
            height={260}
          />
        ))}
      {widget.type === "pivot" && widget.pivot && (
        <p className="text-caption text-muted">Pivot summary — cross-tab rendered in the live app.</p>
      )}
      {widget.type === "recommendation" && widget.recommendation && (
        <div className="rounded-md border border-line bg-surface p-3">
          <p className="text-sm text-foreground">{widget.recommendation.text}</p>
          <ul className="mt-2 list-inside list-disc text-caption text-muted">
            {widget.recommendation.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function KpiWidget({ widget }: { widget: DashboardWidget }) {
  const kpi = widget.kpi;
  if (!kpi) return null;
  return (
    <div>
      <p className="text-h2 text-foreground">{kpi.value}</p>
      {typeof kpi.deltaPct === "number" && (
        <p className={`text-caption ${kpi.deltaPct >= 0 ? "text-success" : "text-danger"}`}>
          {kpi.deltaPct >= 0 ? "+" : ""}
          {kpi.deltaPct}%{kpi.deltaLabel ? ` ${kpi.deltaLabel}` : ""}
        </p>
      )}
      {kpi.label && <p className="text-caption text-muted">{kpi.label}</p>}
    </div>
  );
}

function TableWidget({ widget }: { widget: DashboardWidget }) {
  const table = widget.table;
  if (!table) return null;
  return (
    <DataTable
      columns={table.columns.map((c) => ({
        key: String(c.key ?? c),
        label: String(c.label ?? c),
      }))}
      rows={table.rows as (string | number | null)[][]}
      pageSize={10}
    />
  );
}

function InsightCardView({ widget }: { widget: DashboardWidget }) {
  const insight = widget.insight;
  if (!insight) return null;
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <p className="text-sm font-medium text-foreground">{insight.title}</p>
      {insight.metric != null && <p className="mt-1 text-h3 text-foreground">{String(insight.metric)}</p>}
      {insight.businessImplication && <p className="mt-2 text-sm text-muted">{insight.businessImplication}</p>}
    </div>
  );
}

/** Lazy Leaflet choropleth for published map widgets (client-only). */
const PublishedChoroplethMap = dynamic(
  () => import("@/components/charts/choropleth-map").then((m) => m.ChoroplethMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[260px] items-center justify-center rounded-md border border-line bg-surface-2/60 text-sm text-muted">
        Loading map…
      </div>
    ),
  },
);

function PublishedChoropleth({ widget }: { widget: DashboardWidget }) {
  const spec = widget.pbiVisual!;
  const data = spec.categories.map((region, i) => ({ region, value: spec.values[i] ?? 0 }));
  return (
    <PublishedChoroplethMap
      title={widget.title}
      metricLabel="Value"
      data={data}
      scope={widget.mapScope ?? "countries"}
      height={260}
    />
  );
}
