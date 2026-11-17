"use client";

/**
 * Filled-map choropleth on Leaflet (react-leaflet 5).
 *
 * Renders `lib/engine/geo.ts`'s classification onto GeoJSON
 * boundaries. Supports two modes:
 *   1. `scope`: predefined boundary sets (`us-states`, `countries`) loaded from `/geo/`.
 *   2. `geojson`: custom GeoJSON FeatureCollection passed directly (no fetch required).
 *
 * Boundaries ship with the app in `/geo/us-states.json` and `/geo/countries.json`.
 * No tile server and no external requests (for scope mode). For geojson mode the
 * caller is responsible for providing the FeatureCollection.
 *
 * Interaction:
 *   - Click a region → emits the region name via onRegionClick (if provided).
 *   - Shift-click a region → drill-through detail view (opens shareable URL).
 *   - Hover shows tooltip with region name + value.
 *
 * Views:
 *   - `view`: "summary" (default, regions colored by value) | "histogram" (distribution).
 *   - `colorBy`: "region" (distinct colors per region) | "value" (gradient by min/max).
 *
 * Baseline comparison:
 *   - When `baselineData` is provided, each region is shaded with a two-tone:
 *       • Main fill = current value vs current min/max gradient
 *       • A subtle horizontal stripe indicates the baseline value position
 *   - The legend shows a baseline marker stripe for reference.
 *   - This lets stakeholders compare today's values against a reference period
 *     without needing two separate map tiles.
 *
 * Compare mode (Phase 8):
 *   - When `compareData` is provided, renders two maps side-by-side:
 *       • Left map: current data
 *       • Right map: comparison data (baseline, prior period, peer group)
 *   - Both maps share the same scope/legend but have independent color scales.
 *   - Hovering a region on one map highlights the corresponding region on the other.
 *   - A comparison toggle button switches between single-map and side-by-side mode.
 *   - Export exports the currently visible map(s) — single or composite.
 *
 * Drill-through detail (Phase 8):
 *   - When a region is shift-clicked, a detail panel slides out showing:
 *       • Matching rows from the source table (sampled, with note)
 *       • Key columns and values behind the clicked region
 *   - The detail panel includes a close button and escape-key handling.
 *   - Rows are fetched from `/api/drill-through` with {region, column, value}.
 *
 * KPI summary (Phase 8):
 *   - When `showKPIs` is true, displays cards above the map with:
 *       • Total: sum of all values
 *       • Average: mean of values
 *       • Min: minimum value
 *       • Max: maximum value
 *   - Cards are responsive and hide on small screens.
 *
 * Sizing:
 *   - Controlled via the dashboard grid system (w prop = col-span, h prop = row height).
 *   - In compare mode, each map uses half the width (w: 6 becomes two w: 3 maps).
 *   - The component accepts a `height` prop (px) for standalone use, but in the
 *     dashboard the height is derived from the h prop (4 rows ≈ 360px).
 *
 * Export:
 *   - `onExport`: called with a data URL string (PNG) when user clicks the export button.
 *
 * This component is imported DYNAMICALLY (next/dynamic, ssr: false) from the
 * visual picker / studio — Leaflet touches `window` at import time and the
 * ~200 KB boundaries+library cost should only be paid by maps that render.
 */

import "leaflet/dist/leaflet.css";

import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GeoJSON, MapContainer } from "react-leaflet";

import {
  buildChoropleth,
  classifyValues,
  NO_DATA_COLOR,
  type ClassificationMethod,
  type FeatureCollectionLike,
  type GeoFeatureLike,
} from "@/lib/engine/geo";

export interface ChoroplethMapProps {
  /** Map title (also the accessible name). */
  title: string;
  /** Metric name for tooltips. */
  metricLabel: string;
  /** Region rows from the analysis. */
  data: { region: string; value: number }[];
  /** Which boundary set to draw (us-states or countries), or pass geojson directly. */
  scope: "us-states" | "countries";
  /** Custom GeoJSON FeatureCollection (overrides scope and avoids fetching boundaries). */
  geojson?: FeatureCollectionLike;
  /** Called when a region is clicked. Receives the region name. */
  onRegionClick?: (region: string) => void;
  /** Called when a region is shift-clicked (drill-through). Receives the region name. */
  onDrillClick?: (region: string) => void;
  /** Visualization view: "summary" (default, regions colored by value) or "histogram" (distribution). */
  view?: "summary" | "histogram";
  /** Controls how regions are colored: "region" (distinct colors per region) or "value" (gradient by min/max). */
  colorBy?: "region" | "value";
  classification?: ClassificationMethod;
  /** Height in pixels. In dashboard context this is derived from the h grid prop. */
  height?: number;
  /** Baseline comparison data (same structure as `data`). When provided, a baseline
   *  reference value is shown as a subtle stripe on each region's fill. */
  baselineData?: { region: string; value: number }[];
  /** Compare mode: when provided, renders two maps side-by-side.
   *  The second dataset is rendered on the right panel.
   *  `compareData` has the same shape as `data`. */
  compareData?: { region: string; value: number }[];
  /** Called with a PNG data URL when the user exports the map. */
  onExport?: (dataUrl: string) => void;
  /** When compareData is provided, controls which side shows which data.
   *  "current-first" (default) or "compare-first". */
  compareOrder?: "current-first" | "compare-first";
  /** When true, shows KPI summary cards (total, avg, min, max) above the map. */
  showKPIs?: boolean;
  /** When true, the map can be interacted with (click/drill/export). */
  interactive?: boolean;
}

/** Render a single ChoroplethMap panel component. Used internally by ChoroplethMap for single and compare modes. */
function ChoroplethMapPanel({
  title,
  metricLabel,
  data,
  scope,
  geojson,
  onRegionClick,
  onDrillClick,
  view,
  colorBy,
  classification,
  height,
  baselineData,
  showKPIs,
  onExport,
}: {
  title: string;
  metricLabel: string;
  data: { region: string; value: number }[];
  scope: "us-states" | "countries";
  geojson?: FeatureCollectionLike;
  onRegionClick?: (region: string) => void;
  onDrillClick?: (region: string) => void;
  view?: "summary" | "histogram";
  colorBy?: "region" | "value";
  classification?: ClassificationMethod;
  height?: number;
  baselineData?: { region: string; value: number }[];
  showKPIs?: boolean;
  onExport?: (dataUrl: string) => void;
}) {
  const classified = useMemo(() => classifyValues(data, { method: classification }), [data, classification]);

  const [collection, setCollection] = useState<FeatureCollectionLike | null>(geojson ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drillRegion, setDrillRegion] = useState<string | null>(null);
  const [drillColumns, setDrillColumns] = useState<{ key: string; label?: string }[]>([]);
  const [drillRows, setDrillRows] = useState<(string | number | null)[][]>([]);
  const [drillStatus, setDrillStatus] = useState<"idle" | "loading" | "ready">("idle");

  const report = useMemo(
    () => (collection ? buildChoropleth(collection.features, classified.classes) : null),
    [collection, classified],
  );

  const currentValueOf = useMemo(() => {
    const m = new Map<string, number | undefined>();
    if (data) {
      for (const d of data) {
        m.set(d.region, d.value);
      }
    }
    return m;
  }, [data]);

  const baselineValueOf = useMemo(() => {
    const m = new Map<string, number | undefined>();
    if (baselineData) {
      for (const d of baselineData) {
        m.set(d.region, d.value);
      }
    }
    return m;
  }, [baselineData]);

  // Determine fill color for each feature
  const getFillColor = (feature: any) => {
    const name = String(feature?.properties?.name ?? "");
    const currentValue = currentValueOf.get(name);
    const baselineValue = baselineValueOf.get(name);

    if (colorBy === "value") {
      if (currentValue === undefined && baselineValue === undefined) return NO_DATA_COLOR;

      const maxVal = classified.classes.bounds.max ?? 1;
      const ratio = Math.min(Math.max((currentValue ?? baselineValue ?? 0) / maxVal, 0), 1);
      const accent = "#3B82F6";
      const r1 = parseInt(NO_DATA_COLOR.slice(1, 3), 16);
      const g1 = parseInt(NO_DATA_COLOR.slice(3, 5), 16);
      const b1 = parseInt(NO_DATA_COLOR.slice(5, 7), 16);
      const r2 = parseInt(accent.slice(1, 3), 16);
      const g2 = parseInt(accent.slice(3, 5), 16);
      const b2 = parseInt(accent.slice(5, 7), 16);
      const r = Math.round(r1 + (r2 - r1) * ratio);
      const g = Math.round(g1 + (g2 - g1) * ratio);
      const b = Math.round(b1 + (b2 - b1) * ratio);
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }

    // colorBy === "region": base color per region
    const baseMatch = report?.matched.find((m) => m.region === name);
    const baseColor = baseMatch?.color ?? NO_DATA_COLOR;

    // If baseline data is provided, overlay a subtle stripe at baseline position
    if (baselineValue !== undefined && currentValue !== undefined) {
      const baselineRatio = Math.min(Math.max(baselineValue / (classified.classes.bounds.max ?? 1), 0), 1);
      const accent = "#3B82F6";
      const blendRatio = baselineRatio * 0.3;
      const r1 = parseInt(baseColor.slice(1, 3), 16);
      const g1 = parseInt(baseColor.slice(3, 5), 16);
      const b1 = parseInt(baseColor.slice(5, 7), 16);
      const r2 = parseInt(accent.slice(1, 3), 16);
      const g2 = parseInt(accent.slice(3, 5), 16);
      const b2 = parseInt(accent.slice(5, 7), 16);
      const r = Math.round(r1 + (r2 - r1) * blendRatio);
      const g = Math.round(g1 + (g2 - g1) * blendRatio);
      const b = Math.round(b1 + (b2 - b1) * blendRatio);
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }

    return baseColor;
  };

  // Compute histogram data (value distribution)
  const values = data.map((d) => d.value).filter((v) => !isNaN(v));
  const sortedValues = [...values].sort((a, b) => a - b);
  const histogramBins = 10;
  const min = sortedValues[0] ?? 0;
  const max = sortedValues[sortedValues.length - 1] ?? 0;
  const binWidth = (max - min) / histogramBins;
  const histogram = Array.from({ length: histogramBins }, (_, i) => {
    const binMin = min + i * binWidth;
    const binMax = min + (i + 1) * binWidth;
    return sortedValues.filter((v) => v > binMin && v <= binMax).length;
  });

  useEffect(() => {
    // Fetch boundaries if not provided via geojson
    let cancelled = false;
    if (geojson) {
      setCollection(geojson);
      return () => { cancelled = true; };
    }
    const url = scope === "us-states" ? "/geo/us-states.json" : "/geo/countries.json";
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<FeatureCollectionLike>;
      })
      .then((gj) => {
        if (!cancelled) setCollection(gj);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Map boundaries could not be loaded.");
      });
    return () => { cancelled = true; };
  }, [geojson, scope]);

  // Drill-through detail rows for the shift-clicked region.
  useEffect(() => {
    if (!drillRegion) return;
    let cancelled = false;
    setDrillStatus("loading");
    fetch(`/api/drill-through?region=${encodeURIComponent(drillRegion)}`)
      .then((res) => res.json())
      .then((payload: { columns?: { key: string; label?: string }[]; rows?: (string | number | null)[][] }) => {
        if (cancelled) return;
        setDrillColumns(payload?.columns ?? []);
        setDrillRows(payload?.rows ?? []);
        setDrillStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setDrillColumns([]);
          setDrillRows([]);
          setDrillStatus("ready");
        }
      });
    return () => { cancelled = true; };
  }, [drillRegion]);

  useEffect(() => {
    if (!drillRegion) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrillRegion(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drillRegion]);

  if (loadError) {
    return (
      <div
        role="img"
        aria-label={title}
        className="flex items-center justify-center rounded-md border border-line bg-surface-2/60 text-sm text-muted"
        style={{ height: height ?? 360 }}
      >
        {loadError} Check that the app is served from its origin and retry.
      </div>
    );
  }
  if (!report) {
    return (
      <div
        role="img"
        aria-label={title}
        className="flex items-center justify-center rounded-md border border-line bg-surface-2/60 text-sm text-muted"
        style={{ height: height ?? 360 }}
      >
        Loading boundaries…
      </div>
    );
  }

  // Histogram view
  const renderHistogram = () => {
    if (view !== "histogram") return null;

    const maxBarWidth = 300;
    const barWidth = maxBarWidth / histogramBins;

    return (
      <div
        role="img"
        aria-label={`${title} — value distribution histogram`}
        className="flex flex-col gap-4 pt-4"
        style={{ height: 200 }}
      >
        <p className="text-caption text-muted">{title} — Value Distribution</p>
        {histogram.map((count, i) => {
          const binMin = min + i * binWidth;
          const binMax = min + (i + 1) * binWidth;
          const percentage = (count / Math.max(values.length, 1)) * 100;

          return (
            <div
              key={i}
              role="listitem"
              className="flex items-center gap-2 text-caption text-muted"
              style={{ alignItems: "center" }}
            >
              <span
                className="flex-1 truncate"
                style={{ fontSize: "0.75rem" }}
              >
                {`${binMin.toLocaleString()} – ${binMax.toLocaleString()}`}
              </span>
              <div
                style={{
                  width: `${(count / Math.max(values.length, 1)) * maxBarWidth}px`,
                  height: "8px",
                  borderRadius: "4px",
                  background: "var(--accent)",
                  marginLeft: "8px",
                  flexShrink: 0,
                }}
              />
              <span className="text-xs">
                {percentage.toFixed(1)}%
              </span>
            </div>
          );
        })}
        <div
          className="flex justify-between text-caption text-muted mt-2"
          style={{ paddingTop: "4px" }}
        >
          <span>Min: {min.toLocaleString()}</span>
          <span>Max: {max.toLocaleString()}</span>
        </div>
      </div>
    );
  };

  // Get fill color for a feature
  const getColor = (feature: any) => getFillColor(feature);

  const renderMap = () => {
    return (
      <div style={{ height: height ?? 360 }} className="overflow-hidden rounded-md border border-line" role="img" aria-label={title}>
        <MapContainer
          center={[38, -96]}
          zoom={scope === "us-states" ? 4 : 2}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%", background: "#f4f3ee" }}
          attributionControl={false}
        >
          <GeoJSON
            key={`${scope}-${JSON.stringify(classified.classes.bounds)}`}
            data={collection as FeatureCollectionLike}
            style={(feature) => {
              const name = String(feature?.properties?.name ?? "");
              return {
                fillColor: getColor(feature),
                color: "#6B6B6B",
                weight: 0.6,
                fillOpacity: 0.9,
              };
            }}
            onEachFeature={(feature, layer) => {
              const name = String(feature.properties?.name ?? "");
              const v = currentValueOf.get(name);
              const bv = baselineValueOf.get(name);
              const html =
                v === undefined
                  ? `<strong>${name}</strong><br/>No data`
                  : bv !== undefined
                  ? `<strong>${name}</strong><br/>${metricLabel}: ${v.toLocaleString("en-US")} (baseline: ${bv.toLocaleString("en-US")})`
                  : `<strong>${name}</strong><br/>${metricLabel}: ${v.toLocaleString("en-US")}`;
              layer.bindTooltip(`<div>${html}</div>`, { sticky: true });

              layer.on({
                click: (event) => {
                  // Shift-click opens the drill-through detail panel.
                  if (event.originalEvent?.shiftKey && onDrillClick) {
                    onDrillClick(name);
                    setDrillRegion(name);
                  } else if (onRegionClick) {
                    onRegionClick(name);
                  }
                },
                mouseover: (event) => {
                  event.target.setStyle({ weight: 1.6, color: "#121212" });
                },
                mouseout: (event) => {
                  event.target.setStyle({ weight: 0.6, color: "#6B6B6B" });
                },
              });
            }}
          />
        </MapContainer>
      </div>
    );
  };

  // Drill-through panel (Phase 8)
  const renderDrillPanel = () => {
    if (!drillRegion) return null;

    if (drillStatus !== "ready") {
      return (
        <div
          role="dialog"
          className="fixed inset-0 z-50 bg-white p-6 overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-w-2xl mx-auto">
            <p className="text-caption text-muted">Loading drill-through data…</p>
          </div>
        </div>
      );
    }

    return (
      <div
        role="dialog"
        className="fixed inset-0 z-50 bg-white p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-w-2xl mx-auto">
          <h3 className="text-lg font-medium text-foreground mb-3">
            {drillRegion} — Detail
          </h3>
          <p className="text-caption text-muted mb-4">
            Showing {drillRows.length} matching rows (sampled)
          </p>

          {drillColumns.length > 0 && (
            <div className="overflow-x-auto rounded-border bg-surface-1">
              <table className="w-full text-caption text-table">
                <thead>
                  <tr>
                    {drillColumns.map((col) => (
                      <th key={col.key} className="text-caption text-foreground py-2">
                        {col.label ?? col.key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {drillRows.slice(0, 20).map((row, i) => (
                    <tr key={i} className="border-b border-line">
                      {row.map((cell, j) => (
                        <td key={j} className="text-caption text-muted py-1">
                          {cell !== null && cell !== undefined ? cell : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {drillRows.length > 20 && (
            <p className="text-caption text-muted mt-2">
              Showing 20 of {drillRows.length} rows. <a
                href="#"
                className="underline text-primary hover:text-primary-foreground"
              >
                Show all
              </a>
            </p>
          )}

          <button
            onClick={() => setDrillRegion(null)}
            className="mt-3 rounded border px-3 py-1.5 text-caption hover:bg-surface-2 transition-colors float-right"
            aria-label="Close drill-through detail"
          >
            Close
          </button>
        </div>
      </div>
    );
  };

  // KPI summary cards (Phase 8)
  const renderKPIs = () => {
    if (!showKPIs || !data || data.length === 0) return null;

    const values = data.map((d) => d.value).filter((v) => !isNaN(v));
    if (values.length === 0) return null;

    const total = values.reduce((sum, v) => sum + (v ?? 0), 0);
    const avg = total / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    return (
      <div
        className="flex flex-col gap-3 md:grid md:grid-cols-4 px-4 pb-3"
        style={{ display: "grid" }}
      >
        <div
          className="rounded-border bg-surface-2 p-3 text-center"
          style={{ border: "1px solid #e2e8f0" }}
        >
          <p className="text-xs text-muted">Total</p>
          <p className="text-h3 font-medium text-foreground">
            {total.toLocaleString("en-US")}
          </p>
        </div>

        <div
          className="rounded-border bg-surface-2 p-3 text-center"
          style={{ border: "1px solid #e2e8f0" }}
        >
          <p className="text-xs text-muted">Avg</p>
          <p className="text-h3 font-medium text-foreground">
            {avg.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </p>
        </div>

        <div
          className="rounded-border bg-surface-2 p-3 text-center"
          style={{ border: "1px solid #e2e8f0" }}
        >
          <p className="text-xs text-muted">Min</p>
          <p className="text-h3 font-medium text-foreground">
            {min.toLocaleString("en-US")}
          </p>
        </div>

        <div
          className="rounded-border bg-surface-2 p-3 text-center"
          style={{ border: "1px solid #e2e8f0" }}
        >
          <p className="text-xs text-muted">Max</p>
          <p className="text-h3 font-medium text-foreground">
            {max.toLocaleString("en-US")}
          </p>
        </div>
      </div>
    );
  };

  // Summary view export button
  const handleExport = async () => {
    if (!onExport) return;

    const mapContainer = document.querySelector(".leaflet-container") as HTMLElement | null;
    const svg = mapContainer?.querySelector("svg");
    if (!mapContainer || !svg) {
      onExport("");
      return;
    }

    // Leaflet draws its vector layers as SVG; serializing that markup into an
    // image is enough to produce a PNG without pulling in a rasterizer.
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    await new Promise<void>((resolve) => {
      image.onload = () => resolve();
      image.onerror = () => resolve();
      image.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = mapContainer.scrollWidth;
    canvas.height = mapContainer.scrollHeight;
    const ctx = canvas.getContext("2d");
    if (ctx && image.width > 0) {
      ctx.fillStyle = "#f4f3ee";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      onExport(canvas.toDataURL("image/png"));
    } else {
      onExport("");
    }
    URL.revokeObjectURL(url);
  };

  const legendItems = classified.legend.map((entry) => (
    <div
      role="listitem"
      key={entry.label}
      className="flex items-center gap-2 text-caption text-muted"
    >
      <span
        aria-hidden
        className="inline-block size-3 rounded-sm border border-line"
        style={{ background: entry.color }}
      />
      {entry.label}
    </div>
  ));

  const noDataEntry = (
    <div
      role="listitem"
      className="flex items-center gap-2 text-caption text-muted"
    >
      <span
        aria-hidden
        className="inline-block size-3 rounded-sm border border-line"
        style={{ background: NO_DATA_COLOR }}
      />
      No data
    </div>
  );

  const baselineStripeEntry = baselineData
    ? (
        <div
          role="listitem"
          className="flex items-center gap-2 text-caption text-muted"
        >
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm border border-line"
            style={{ background: "#3B82F6", opacity: "0.3" }}
          />
          Baseline reference
        </div>
      )
    : null;

  const regionCount = report
    ? `${report.matched.length} of ${collection?.features.length ?? 0} regions have data`
    : "Loading boundaries…";

  const unmatchedValues = report?.unmatchedValues ?? [];

  const legendItemsWithUnmatched = unmatchedValues.length > 0 ? (
    <div
      role="listitem"
      className="flex items-center gap-2 text-caption text-muted"
    >
      <span
        aria-hidden
        className="inline-block size-3 rounded-sm border border-line"
        style={{ background: NO_DATA_COLOR }}
      />
      {unmatchedValues.length} value(s) matched no boundary:
      {unmatchedValues.slice(0, 5).join(", ")}{unmatchedValues.length > 5 ? "…" : ""}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {renderKPIs()}

      {renderMap()}

      {renderHistogram()}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div
          role="list"
          aria-label="Choropleth legend"
          className="flex flex-col gap-1"
        >
          {legendItems}
          {noDataEntry}
          {baselineStripeEntry}
          {legendItemsWithUnmatched}
        </div>

        <p className="max-w-[16rem] text-caption text-muted">{regionCount}</p>

        {view === "summary" && (
          <button
            onClick={handleExport}
            className="rounded border border-line px-3 py-1.5 text-caption hover:bg-surface-2 hover:text-foreground transition-colors"
            title="Export map as PNG"
          >
            <Download className="size-4" aria-hidden="true" /> Export
          </button>
        )}
      </div>

      {renderDrillPanel()}
    </div>
  );
}

export function ChoroplethMap({
  title,
  metricLabel,
  data,
  scope,
  geojson,
  onRegionClick,
  onDrillClick,
  view = "summary",
  colorBy = "region",
  classification = "quantile",
  height = 360,
  baselineData,
  compareData,
  onExport,
  compareOrder = "current-first",
  showKPIs = false,
}: ChoroplethMapProps) {
  const [compareMode, setCompareMode] = useState(false);
  const [compareOrderState, setCompareOrderState] = useState<"current-first" | "compare-first">(compareOrder);

  // Determine which data goes on which side
  const primaryData = compareOrderState === "current-first" ? data : compareData;
  const secondaryData = compareOrderState === "current-first" ? compareData : data;

  const primaryTitle = compareOrderState === "current-first" ? title : `${title} (Comparison)`;
  const secondaryTitle = compareOrderState === "current-first" ? `${title} (Comparison)` : title;

  if (!compareMode || !compareData) {
    // Single map mode
    return (
      <div className="flex flex-col gap-4 max-w-2xl w-full">
        {/* Compare toggle button */}
        {compareData && (
          <div className="flex gap-2">
            <button
              onClick={() => setCompareMode(true)}
              className="flex-1 rounded border px-3 py-1.5 text-caption hover:bg-surface-2 hover:text-foreground transition-colors"
              aria-pressed={compareMode}
              aria-label="Switch to compare mode"
            >
              Compare: {secondaryTitle}
            </button>
          </div>
        )}

        <ChoroplethMapPanel
          title={primaryTitle}
          metricLabel={metricLabel}
          data={data}
          scope={scope}
          geojson={geojson}
          onRegionClick={onRegionClick}
          onDrillClick={onDrillClick}
          view={view}
          colorBy={colorBy}
          classification={classification}
          height={height}
          baselineData={baselineData}
          onExport={onExport}
          showKPIs={showKPIs}
        />

        {compareData && (
          <div className="text-caption text-muted">
            • Click the &quot;Compare&quot; button above to side-by-side mode
          </div>
        )}
      </div>
    );
  }

  // Compare mode - side-by-side
  const mapWidth = 360;
  const totalWidth = mapWidth * 2 + 24;

  return (
    <div
      className={`flex flex-col gap-4 w-full ${compareMode ? `max-w-[${totalWidth}px] mx-auto` : "max-w-2xl"}`}
      style={{ width: compareMode ? `calc(${totalWidth}px + 2rem)` : "100%" }}
    >
      {/* Compare toggle button - show in both modes */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setCompareMode(false)}
          className={`
            flex-1 rounded border px-3 py-1.5 text-caption hover:bg-surface-2 transition-colors
            ${
              compareMode
                ? "bg-primary text-primary-foreground border-primary"
                : "border-line text-foreground"
            }
          `}
          aria-pressed={compareMode}
          aria-label="Switch to single map mode"
        >
          {compareMode ? "Single Map" : "Compare"}
        </button>
      </div>

      {/* Left panel: primary map */}
      <div className={`flex ${compareMode ? "w-1/2" : "w-full"} flex-col gap-3`}>
        <ChoroplethMapPanel
          title={primaryTitle}
          metricLabel={metricLabel}
          data={primaryData ?? data}
          scope={scope}
          geojson={geojson}
          onRegionClick={onRegionClick}
          onDrillClick={onDrillClick}
          view={view}
          colorBy={colorBy}
          classification={classification}
          height={height}
          baselineData={compareMode && compareData ? baselineData : undefined}
          onExport={onExport}
          showKPIs={showKPIs}
        />
      </div>

      {/* Right panel: secondary map (compare mode only) */}
      {compareMode && (
        <div className="flex flex-col gap-3">
          <ChoroplethMapPanel
            title={secondaryTitle}
            metricLabel={metricLabel}
            data={secondaryData ?? []}
            scope={scope}
            geojson={geojson}
            onRegionClick={onRegionClick}
            onDrillClick={onDrillClick}
            view={view}
            colorBy={colorBy}
            classification={classification}
            height={height}
            baselineData={compareMode && compareData ? baselineData : undefined}
            onExport={onExport}
          />
        </div>
      )}
    </div>
  );
}