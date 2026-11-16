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
 * This component is imported DYNAMICALLY (next/dynamic, ssr: false) from the
 * visual picker / studio — Leaflet touches `window` at import time and the
 * ~200 KB boundaries+library cost should only be paid by maps that render.
 */

import "leaflet/dist/leaflet.css";

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
  classification?: ClassificationMethod;
  height?: number;
}

type FeatureCollectionLike = { type: "FeatureCollection"; features: GeoFeatureLike[] };

export function ChoroplethMap({
  title,
  metricLabel,
  data,
  scope,
  geojson,
  classification = "quantile",
  height = 360,
}: ChoroplethMapProps) {
  const [collection, setCollection] = useState<FeatureCollectionLike | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Use custom geojson if provided, otherwise fetch based on scope
  useEffect(() => {
    let cancelled = false;
    setCollection(null);
    setLoadError(null);

    if (geojson) {
      // Custom GeoJSON provided — no fetch needed
      if (!cancelled) setCollection(geojson);
    } else {
      // Fetch based on scope
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
    }

    return () => {
      cancelled = true;
    };
  }, [geojson, scope]);

  const classified = useMemo(() => classifyValues(data, { method: classification }), [data, classification]);
  const report = useMemo(
    () => (collection ? buildChoropleth(collection.features, classified.classes) : null),
    [collection, classified],
  );

  if (loadError) {
    return (
      <div
        role="img"
        aria-label={title}
        className="flex items-center justify-center rounded-md border border-line bg-surface-2/60 text-sm text-muted"
        style={{ height }}
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
        style={{ height }}
      >
        Loading boundaries…
      </div>
    );
  }

  const colorOf = new Map(report.matched.map((m) => [m.region, m.color]));
  const valueOf = new Map(report.matched.map((m) => [m.region, m.value]));

  const renderMap = () => (
    <div style={{ height }} className="overflow-hidden rounded-md border border-line" role="img" aria-label={title}>
      <MapContainer
        center={[38, -96]}
        zoom={scope === "us-states" ? 4 : 2}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%", background: "#f4f3ee" }}
        attributionControl={false}
      >
        <GeoJSON
          key={`${scope}-${JSON.stringify(classified.breaks.bounds)}`}
          data={collection as FeatureCollectionLike}
          style={(feature) => {
            const name = String(feature?.properties?.name ?? "");
            return {
              fillColor: colorOf.get(name) ?? NO_DATA_COLOR,
              color: "#6B6B6B",
              weight: 0.6,
              fillOpacity: 0.9,
            };
          }}
          eventHandlers={{
            mouseover: (e) => e.target.setStyle({ weight: 1.6, color: "#121212" }),
            mouseout: (e) => e.target.setStyle({ weight: 0.6, color: "#6B6B6B" }),
          }}
          onEachFeature={(feature, layer) => {
            const name = String(feature.properties?.name ?? "");
            const value = valueOf.get(name);
            const html =
              value === undefined
                ? `<strong>${name}</strong><br/>No data`
                : `<strong>${name}</strong><br/>${metricLabel}: ${value.toLocaleString("en-US")}`;
            layer.bindTooltip(`<div>${html}</div>`, { sticky: true });
          }}
        />
      </MapContainer>
    </div>
  );

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

  const regionCount = report
    ? `${report.matched.length} of ${collection?.features.length ?? 0} regions have data`
    : "Loading boundaries…";

  const unmatchedValues = report?.unmatchedValues ?? [];

  return (
    <div className="flex flex-col gap-2">
      {renderMap()}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div
          role="list"
          aria-label="Choropleth legend"
          className="flex flex-col gap-1"
        >
          {legendItems}
          {noDataEntry}
          {!geojson && unmatchedValues.length > 0 && (
            <div
              role="listitem"
              className="flex items-center gap-2 text-caption text-muted"
            >
              <span aria-hidden className="inline-block size-3 rounded-sm border border-line" style={{ background: NO_DATA_COLOR }} />
              {unmatchedValues.length} value(s) matched no boundary:
              {unmatchedValues.slice(0, 5).join(", ")}{unmatchedValues.length > 5 ? "…" : ""}
            </div>
          )}
        </div>

        <p className="max-w-[16rem] text-caption text-muted">{regionCount}</p>
      </div>
    </div>
  );
}