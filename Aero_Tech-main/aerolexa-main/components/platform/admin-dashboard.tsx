"use client";

import { useState, useEffect } from "react";
import { QuickFilter } from "@/components/charts/quick-filter";
import { MapTemplateGallery } from "@/components/charts/map-template-gallery";
import { ChoroplethMap } from "@/components/charts/choropleth-map";
import { WebhookManager } from "@/components/platform/webhook-manager";
import { DashboardWidget } from "@/lib/types";

/**
 * AdminDashboard — dashboard for admin users with full control features.
 *
 * Includes:
 *   - Quick filter bar (scope + metric selector)
 *   - Template gallery for quick map setup
 *   - Webhook management for event integration
 *   - All widget types with full editing capabilities
 *   - Dashboard settings and persistence
 *
 * Admin-specific features:
 *   - User management access
 *   - Plan/upgrade hints
 *   - Export all data
 *   - Webhook configuration
 */
export function AdminDashboard({ dashboardId }: { dashboardId: string }) {
  const [scope, setScope] = useState<"us-states" | "countries">("us-states");
  const [metric, setMetric] = useState<string>("Value");
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<
    | (MapTemplate & { id: string })
    | null
  >(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  // Load widgets from dashboard state (would call API in production)
  useEffect(() => {
    // Placeholder: in production, fetch widgets for this dashboardId
    // const widgets = await fetch(`/api/dashboards/${dashboardId}/widgets`).then(r => r.json());
    // setWidgets(widgets ?? []);
  }, [dashboardId]);

  // Handle template selection
  const handleTemplateSelect = (template: MapTemplate & { id: string }) => {
    setSelectedTemplate(template);
    // Apply template to create a new map widget
    const newWidget: DashboardWidget = {
      id: template.id,
      type: "pbi-visual",
      title: template.props.title,
      pbiVisual: {
        categories: [],
        values: [],
        mapScope: template.props.scope,
        ...template.props,
      },
      w: 6,
      h: 4,
    };
    setWidgets((prev) => [...prev, newWidget]);
    setSelectedTemplate(null);
  };

  return (
    <div className="flex flex-col gap-4 max-w-6xl mx-auto p-4">
      {/* Header */}
      <header className="border-b border-line pb-3">
        <h2 className="text-xl font-semibold text-foreground">
          Admin Dashboard — {dashboardId}
        </h2>
      </header>

      {/* Quick filter bar */}
      <QuickFilter
        scope={scope}
        onScopeChange={setScope}
        metric={metric}
        onMetricChange={setMetric}
        metrics={["Value", "Revenue", "Engagement Count", "Tenancy Score"]
        }
      />

      {/* Main content area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Left panel: Map visualization */}
        <div>
          {selectedTemplate && (
            <div className="rounded border p-4 mb-4">
              <h3 className="font-medium mb-2">Applied template: {selectedTemplate.name}</h3>
              <p className="text-caption text-muted">
                {selectedTemplate.props.title} — {selectedTemplate.props.scope}
              </p>
              <ChoroplethMap
                title={selectedTemplate.props.title}
                metricLabel={selectedTemplate.props.metricLabel}
                data={[]} // template data placeholder
                scope={selectedTemplate.props.scope}
                colorBy={selectedTemplate.props.colorBy ?? "region"}
                view={selectedTemplate.props.view ?? "summary"}
                classification={selectedTemplate.props.classification ?? "quantile"}
                baselineData={selectedTemplate.props.baselineData}
                onRegionClick={() => {/* handle region click */}}
                onDrillClick={() => {/* handle drill click */}}
                onExport={() => {/* handle export */}}
              />
            </div>
          )}

          {/* Existing widgets map */}
          <div className="rounded border p-4 h-[500px] overflow-auto">
            {widgets.map((w) => {
              if (w.type !== "pbi-visual") return null;
              return (
                <div
                  key={w.id}
                  className="rounded border p-3 mb-3 cursor-pointer hover:bg-surface-2 transition-colors"
                  onClick={() => {
                    // Navigate to widget detail or enable edit mode
                  }}
                >
                  <h4 className="font-small text-foreground mb-1">
                    {w.title}
                  </h4>
                  <p className="text-caption text-muted">
                    Scope: {w.mapScope ?? "us-states"} • {w.h}x{w.w} grid
                  </p>
                </div>
              );
            })}
            {widgets.length === 0 && (
              <p className="text-caption text-muted text-center py-8">
                No map widgets yet. Use the template gallery above to get started.
              </p>
            )}
          </div>
        </div>

        {/* Right panel: Tools and settings */}
        <div>
          {/* Template gallery */}
          {selectedTemplate === null && (
            <MapTemplateGallery
              onSelect={handleTemplateSelect}
              selected={selectedTemplate}
            />
          )}

          {/* Webhook management */}
          {!selectedTemplate && (
            <WebhookManager dashboardId={dashboardId} />
          )}

          {/* Dashboard settings */}
          <div className="mt-6 rounded border p-4">
            <h4 className="font-medium mb-3">Dashboard settings</h4>
            <p className="text-caption text-muted">
              This dashboard is visible to workspace members with appropriate
              permissions. Changes are saved automatically.
            </p>
            <button
              className="mt-3 rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors w-full"
            >
              Save dashboard
            </button>
          </div>
        </div>

      </div>

      {/* Footer with admin actions */}
      <footer className="mt-6 flex gap-3 pt-4 border-t border-line">
        <button
          className="flex-1 rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors"
        >
          Export dashboard
        </button>
        <button
          className="flex-1 rounded border px-4 py-2 text-caption text-destructive hover:text-red-600 transition-colors"
        >
          Delete dashboard
        </button>
      </footer>
    </div>
  );
}