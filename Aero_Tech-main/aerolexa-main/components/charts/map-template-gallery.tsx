"use client";

import { useState, useMemo } from "react";

/**
 * MapTemplateGallery — pre-built map templates for common use cases.
 *
 * Templates provide pre-configured ChoroplethMap specs (data, scope, colorBy,
 * view, classification) so users can get started quickly without building
 * the map from scratch. Each template is a ready-to-render ChoroplethMapProps
 * object that can be passed to the visual picker or dashboard.
 *
 * Templates included:
 *   1. "Sales by Region" — US States, value-colored, quantile classification
 *   2. "Compliance Coverage" — US States, region-colored, quantile, summary view
 *   3. "Global Operations" — Countries, value-colored, quantile
 *   4. "Engagement Distribution" — US States, histogram view, value-colored
 *   5. "Tenancy Health" — US States, baseline comparison + current view
 *
 * Usage:
 *   const [selectedTemplate, setSelectedTemplate] = useState<MapTemplate | undefined>;
 *   <MapTemplateGallery onSelect={setSelectedTemplate} selected={selectedTemplate} />
 *   {selectedTemplate && <ChoroplethMap {...selectedTemplate} />}
 */

export type MapTemplate = {
  /** Human-readable name shown in the gallery. */
  name: string;
  /** Description shown beneath the template preview. */
  description: string;
  /** ChoroplethMapProps to render (data is placeholder; caller provides real data). */
  props: ChoroplethMapProps;
};

export type MapTemplateName =
  | "sales-by-region"
  | "compliance-coverage"
  | "global-operations"
  | "engagement-distribution"
  | "tenancy-health";

const templates: MapTemplate[] = [
  {
    name: "Sales by Region",
    description: "US States map colored by sales value, quantile classification. Great for pipeline or revenue overview.",
    props: {
      title: "Sales by Region",
      metricLabel: "Revenue",
      data: [], // caller provides real data
      scope: "us-states",
      colorBy: "value",
      view: "summary",
      classification: "quantile",
      height: 360,
    },
  },
  {
    name: "Compliance Coverage",
    description: "US States map shaded by region, showing which areas have compliance data. Region-colored with legend.",
    props: {
      title: "Compliance Coverage",
      metricLabel: "Compliance Status",
      data: [],
      scope: "us-states",
      colorBy: "region",
      view: "summary",
      classification: "quantile",
      height: 360,
    },
  },
  {
    name: "Global Operations",
    description: "World map (countries) colored by operational metric, quantile classification. Pan/global view.",
    props: {
      title: "Global Operations",
      metricLabel: "Operations Score",
      data: [],
      scope: "countries",
      colorBy: "value",
      view: "summary",
      classification: "quantile",
      height: 420,
    },
  },
  {
    name: "Engagement Distribution",
    description: "US States map in histogram view, showing value distribution across regions. Helps spot outliers.",
    props: {
      title: "Engagement Distribution",
      metricLabel: "Engagement Count",
      data: [],
      scope: "us-states",
      colorBy: "value",
      view: "histogram",
      classification: "quantile",
      height: 400,
    },
  },
  {
    name: "Tenancy Health",
    description: "US States map comparing current period vs baseline, with baseline stripe overlay. Tenancy compliance use case.",
    props: {
      title: "Tenancy Health",
      metricLabel: "Tenancy Score",
      data: [], // current period data
      scope: "us-states",
      colorBy: "value",
      view: "summary",
      classification: "quantile",
      height: 360,
      baselineData: [], // baseline period data
    },
  },
];

/** Render the template gallery grid. */
export function MapTemplateGallery({
  onSelect,
  selected,
}: {
  onSelect: (template: MapTemplate) => void;
  selected?: MapTemplate;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = (template: MapTemplate) => {
    setIsOpen(false);
    onSelect(template);
  };

  const gridItemStyle = {
    borderRadius: "8px",
    overflow: "hidden",
    border: "1px solid #e2e8f0",
    transition: "border-color 0.2s",
    cursor: "pointer",
  };

  const hoverStyle = {
    borderColor: "var(--primary)",
  };

  return (
    <div>
      {/* Gallery trigger */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex flex-col items-center gap-2 rounded-md border border-line px-4 py-3 text-caption text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
        aria-haspopup="dialog"
        aria-label="Open map template gallery"
      >
        {isOpen ? "Close gallery" : "Select map template"}
        {isOpen && <ChevronDown className="size-4" aria-hidden="true" />}
      </div>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          role="dialog"
          className="fixed inset-0 z-50 bg-white p-6 overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-w-2xl mx-auto">
            <h3 className="text-lg font-medium mb-4">Map Templates</h3>
            <p className="text-sm text-muted mb-6">
              Quick-start map configurations for common use cases
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {templates.map((template) => (
                <div
                  key={template.name}
                  onClick={() => handleSelect(template)}
                  className={`
                    group
                    ${gridItemStyle}
                    ${selected?.name === template.name ? hoverStyle : ""}
                    ${selected?.name === template.name ? "border-primary" : ""}
                  `}
                  aria-selected={selected?.name === template.name}
                >
                  <div className="h-24 bg-surface-1 flex items-center justify-center text-caption">
                    {/* Template icon placeholder */}
                    {template.name.includes("Sales")
                      ? "USD"
                      : template.name.includes("Compliance")
                      ? "✓"
                      : template.name.includes("Global")
                      ? "🌍"
                      : template.name.includes("Engagement")
                      ? "📊"
                      : "📈"}
                  </div>
                  <div className="p-2 text-center">
                    <p className="text-sm font-medium line-clamp-1">{template.name}</p>
                    <p className="text-xs text-muted line-clamp-1">{template.description}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Cancel button */}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setIsOpen(false)}
                className="rounded border px-3 py-1.5 text-caption hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Preview a template's ChoroplethMap props without leaving the gallery. */
export function MapTemplatePreview({
  template,
}: {
  template: MapTemplate;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  // Render a minimal ChoroplethMap with the template props
  // Data is placeholder; caller should supply real data
  return (
    <div className="mt-6">
      <h4 className="text-sm font-medium mb-2">Preview</h4>
      <p className="text-caption text-muted">
        {template.props.title} — {template.props.scope}
      </p>
      {/* Note: Data must be supplied by caller; this is a props template only */}
      <p className="text-xs text-muted mt-2">
        Data placeholder — replace with real {template.props.scope} data
        for a live map.
      </p>
    </div>
  );
}