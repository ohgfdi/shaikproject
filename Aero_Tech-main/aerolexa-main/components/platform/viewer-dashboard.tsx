"use client";

import { useState, useEffect } from "react";

import { ChoroplethMap } from "@/components/charts/choropleth-map";
import { MapTemplateGallery } from "@/components/charts/map-template-gallery";
import type { MapTemplate } from "@/components/charts/map-template-gallery";
import { QuickFilter } from "@/components/charts/quick-filter";
import { DashboardWidget } from "@/lib/types";

/**
 * ViewerDashboard — dashboard for viewer users with read-only access.
 *
 * Includes:
 *   - Quick filter bar (scope + metric selector) — read-only, no persistence
 *   - Choropleth map visualization
 *   - Template gallery for browsing pre-configured maps
 *   - No widget editing, webhook configuration, or dashboard persistence
 *
 * Viewer-specific limitations:
 *   - Cannot add or edit widgets
 *   - Cannot configure webhooks
 *   - Filter changes are not persisted
 *   - Dashboard layout is fixed
 *   - Read-only: view and interact but cannot modify
 */
export function ViewerDashboard({ dashboardId }: { dashboardId: string }) {
  const [scope, setScope] = useState<"us-states" | "countries">("us-states");
  const [metric, setMetric] = useState<string>("Value");
  const [widgets] = useState<DashboardWidget[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<MapTemplate | null>(null);

  useEffect(() => {
    // Placeholder: in production, fetch read-only widget state
    // const state = await fetch(`/api/dashboards/${dashboardId}/state`).then(r => r.json());
    // setWidgets(state?.widgets ?? []);
  }, [dashboardId]);

  const handleTemplateSelect = (template: MapTemplate) => {
    setSelectedTemplate(template);
    // Show template preview — no widget created for viewers
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl mx-auto p-4">
      {/* Header */}
      <header className="border-b border-line pb-3">
        <h2 className="text-xl font-semibold text-foreground">
          Dashboard — {dashboardId}
        </h2>
        <p className="text-caption text-muted">
          View-only mode — changes are not saved
        </p>
      </header>

      {/* Quick filter (read-only - scope/metric change doesn't persist) */}
      <QuickFilter
        scope={scope}
        onScopeChange={setScope}
        metric={metric}
        onMetricChange={setMetric}
        metrics={["Value", "Revenue", "Engagement Count", "Tenancy Score"]}
      />

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Map visualization */}
        <div>
          {selectedTemplate && (
            <div className="rounded border p-4 mb-4">
              <h3 className="font-medium mb-2">Template: {selectedTemplate.name}</h3>
              <ChoroplethMap
                title={selectedTemplate.props.title}
                metricLabel={selectedTemplate.props.metricLabel}
                data={[]}
                scope={selectedTemplate.props.scope}
                colorBy={selectedTemplate.props.colorBy ?? "region"}
                view={selectedTemplate.props.view ?? "summary"}
                classification={selectedTemplate.props.classification ?? "quantile"}
                baselineData={selectedTemplate.props.baselineData}
                onRegionClick={() => {/* read-only: no action */}
                }
                onDrillClick={() => {/* read-only: no action */}
                }
                onExport={() => {/* read-only: disabled */}
                }
              />
            </div>
          )}

          <div className="rounded border p-4 h-[500px] overflow-auto">
            {widgets.map((w) => {
              if (w.type !== "pbi-visual") return null;
              return (
                <div
                  key={w.id}
                  className="rounded border p-3 mb-3 cursor-default"
                  style={{ borderLeft: "3px solid #6B7280" }}
                >
                  <h4 className="font-small text-foreground mb-1">
                    {w.title}
                  </h4>
                  <p className="text-caption text-muted">
                    Scope: {w.mapScope ?? "us-states"} • {w.h}x{w.w} grid
                  </p>
                  <p className="text-caption text-muted/70">
                    Read-only — widget configuration fixed by admin
                  </p>
                </div>
              );
            })}
            {widgets.length === 0 && (
              <p className="text-caption text-muted text-center py-8">
                No maps available. Contact your administrator.
              </p>
            )}
          </div>
        </div>

        {/* Right panel: Template browsing (read-only) */}
        <div>
          <MapTemplateGallery
            onSelect={handleTemplateSelect}
            selected={selectedTemplate ?? undefined}
          />
          <div className="mt-6 rounded border p-4">
            <h4 className="font-medium mb-3">About this dashboard</h4>
            <p className="text-caption text-muted">
              You are viewing this dashboard in read-only mode. Your administrator
              can configure widgets, webhooks, and dashboard permissions. Sign in
              with a power-user or admin account to make changes.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}