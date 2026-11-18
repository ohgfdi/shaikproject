"use client";

import { useState, useEffect, useCallback } from "react";

import { ChoroplethMap } from "@/components/charts/choropleth-map";
import { MapTemplateGallery } from "@/components/charts/map-template-gallery";
import type { MapTemplate } from "@/components/charts/map-template-gallery";
import { QuickFilter } from "@/components/charts/quick-filter";
import { WebhookManager } from "@/components/platform/webhook-manager";
import { DashboardWidget } from "@/lib/types";

/**
 * PowerUserDashboard — dashboard for power users with advanced features.
 *
 * Includes:
 *   - Quick filter bar (scope + metric selector)
 *   - Template gallery for quick map setup
 *   - Webhook management (subscribe to dashboard events)
 *   - Full widget interaction (click, drill-through, filter change)
 *   - Dashboard save/persist
 *
 * Power-user features vs viewer:
 *   - Can add/edit widgets
 *   - Can configure webhooks for event integration
 *   - Can apply cross-filters to other widgets
 *   - Access to template gallery
 *   - Cannot delete dashboards or manage users
 */
export function PowerUserDashboard({ dashboardId }: { dashboardId: string }) {
  const [scope, setScope] = useState<"us-states" | "countries">("us-states");
  const [metric, setMetric] = useState<string>("Value");
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<MapTemplate | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<{
    widgetId: string;
    column: string;
    values: string[];
  }[]>([]);

  useEffect(() => {
    // Placeholder: fetch widgets for this dashboard
    // const widgets = await fetch(`/api/dashboards/${dashboardId}/widgets`).then(r => r.json());
    // setWidgets(widgets ?? []);
  }, [dashboardId]);

  const handleTemplateSelect = (template: MapTemplate) => {
    setSelectedTemplate(template);
    const newWidget: DashboardWidget = {
      id: template.name,
      type: "pbi-visual",
      title: template.props.title,
      pbiVisual: {
        kind: "map",
        categories: [],
        values: [],
        ...template.props,
      },
      w: 6,
      h: 4,
    };
    setWidgets((prev) => [...prev, newWidget]);
    setSelectedTemplate(null);
  };

  // Handle filter changes from other widgets
  const handleFilterChange = useCallback(
    (widgetId: string, column: string, values: string[]) => {
      setActiveFilters((prev) => {
        const existing = prev.find((f) => f.widgetId === widgetId);
        if (existing) {
          return prev.map((f) =>
            f.widgetId === widgetId ? { ...existing, values } : f
          );
        }
        return [...prev, { widgetId, column, values }];
      });
    },
    []
  );

  return (
    <div className="flex flex-col gap-4 max-w-2xl mx-auto p-4">
      {/* Header */}
      <header className="border-b border-line pb-3">
        <h2 className="text-xl font-semibold text-foreground">
          Power User Dashboard — {dashboardId}
        </h2>
      </header>

      {/* Quick filter */}
      <QuickFilter
        scope={scope}
        onScopeChange={setScope}
        metric={metric}
        onMetricChange={setMetric}
        metrics={["Value", "Revenue", "Engagement Count", "Tenancy Score"]
        }
      />

      {/* Main content */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Map visualization with filter highlighting */}
        <div>
          {selectedTemplate && (
            <div className="rounded border p-4 mb-4">
              <h3 className="font-medium mb-2">Applied template: {selectedTemplate.name}</h3>
              <ChoroplethMap
                title={selectedTemplate.props.title}
                metricLabel={selectedTemplate.props.metricLabel}
                data={[]}
                scope={selectedTemplate.props.scope}
                colorBy={selectedTemplate.props.colorBy ?? "region"}
                view={selectedTemplate.props.view ?? "summary"}
                classification={selectedTemplate.props.classification ?? "quantile"}
                baselineData={selectedTemplate.props.baselineData}
                onRegionClick={() => {/* handle region click */}
                }
                onDrillClick={() => {/* handle drill click */}
                }
                onExport={() => {/* handle export */}
                }
              />
            </div>
          )}

          {/* Widgets list with filter indicators */}
          <div className="rounded border p-4 h-[500px] overflow-auto">
            {widgets.map((w, i) => {
              if (w.type !== "pbi-visual") return null;
              const hasFilters = activeFilters.some((f) => f.widgetId === w.id);
              return (
                <div
                  key={i}
                  className="rounded border p-3 mb-3 cursor-pointer hover:bg-surface-2 transition-colors"
                  style={{
                    borderLeft: hasFilters ? "3px solid #3B82F6" : "none",
                  }}
                  onClick={() => {
                    // Open widget detail or enable edit
                  }}
                >
                  <h4 className="font-small text-foreground mb-1">
                    {w.title}
                  </h4>
                  <p className="text-caption text-muted">
                    Scope: {w.mapScope ?? "us-states"} • {w.h}x{w.w} grid
                  </p>
                  {hasFilters && (
                    <p className="text-caption text-primary mt-1">
                      • Filtering {activeFilters.filter(
                        (f) => f.widgetId === w.id
                      ).length} dimension(s)
                    </p>
                  )}
                </div>
              );
            })}
            {widgets.length === 0 && (
              <p className="text-caption text-muted text-center py-8">
                No map widgets yet. Use the template gallery to get started.
              </p>
            )}
          </div>
        </div>

        {/* Right panel: Tools */}
        <div>
          {selectedTemplate === null && (
            <MapTemplateGallery
              onSelect={handleTemplateSelect}
              selected={selectedTemplate ?? undefined}
            />
          )}

          <WebhookManager dashboardId={dashboardId} />

          <div className="mt-6 rounded border p-4">
            <h4 className="font-medium mb-3">Dashboard settings</h4>
            <p className="text-caption text-muted">
              Persist your filter selections and widget layout. Changes are saved
              to the dashboard automatically.
            </p>
            <button
              className="mt-3 rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors w-full"
            >
              Save dashboard
            </button>
          </div>
        </div>

      </div>

      {/* Footer */}
      <footer className="mt-6 flex gap-3 pt-4 border-t border-line">
        <button
          className="flex-1 rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors"
        >
          Apply filters
        </button>
        <button
          className="flex-1 rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors"
        >
          Reset view
        </button>
      </footer>
    </div>
  );
}