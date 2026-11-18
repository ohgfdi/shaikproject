"use client";

import { useState, useMemo, useEffect } from "react";

/**
 * QuickFilter — dropdown selector for choropleth map scope + metric.
 *
 * Usage in dashboard:
 *   const [scope, setScope] = useState<"us-states" | "countries">("us-states");
 *   const [metric, setMetric] = useState<string>("Value");
 *   const mapData = useMemo(() => fetchMapData(scope, metric), [scope, metric]);
 *
 * The onChange handler is shared across all filter widgets on the page,
 * so the dashboard cross-filter engine can propagate selections.
 */
export interface QuickFilterProps {
  /** Currently selected boundary scope. */
  scope: "us-states" | "countries";
  /** Called when scope changes. */
  onScopeChange: (scope: "us-states" | "countries") => void;
  /** Currently selected metric/value label. */
  metric: string;
  /** Called when metric changes. */
  onMetricChange: (metric: string) => void;
  /** All available metrics for this map (passed from the analysis spec). */
  metrics: string[];
  /** Called when the user clicks outside the dropdown or presses Escape. */
  onEsc?: () => void;
}

/**
 * Renders a compact filter bar:
 *   [ Scope: US States | Countries ]   [ Metric: Value | Revenue | ... ]
 *
 * Clicking either control opens a small modal dropdown. Pressing Escape
 * while focused closes the dropdown.
 */
export function QuickFilter({ scope, onScopeChange, metric, onMetricChange, metrics, onEsc }: QuickFilterProps) {
  const [open, setOpen] = useState(false);
  const [focusOrigin, setFocusOrigin] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Close on Escape key
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        setOpen(false);
        if (onEsc) onEsc();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onEsc]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (open && focusOrigin && !focusOrigin.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, focusOrigin]);

  const handleScopeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(true);
    setFocusOrigin(e.currentTarget as HTMLElement);
  };

  const _handleMetricClick = (e: React.MouseEvent, m: string) => {
    e.stopPropagation();
    onMetricChange(m);
    setOpen(false);
  };

  const sortedMetrics = useMemo(() => [...metrics].sort(), [metrics]);

  if (open && !focusOrigin) {
    // If open without a focus origin, just render closed
    return null;
  }

  return (
    <div className="flex items-center gap-2 relative" onClick={handleScopeClick}>
      {/* Scope button */}
      <div
        role="button"
        aria-expanded={open}
        aria-label={open ? "Close scope selector" : "Open scope selector (us-states or countries)"}
        className={`
          rounded border border-line px-2.5 py-1.5 text-caption text-foreground
          transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus-ring-offset-2
          ${open ? "bg-primary text-primary-foreground" : ""}
        `}
      >
        {scope === "us-states" ? "US States" : "Countries"}
      </div>

      {/* Metric dropdown */}
      <div
        role="button"
        aria-expanded={open}
        aria-label={open ? "Close metric selector" : `Select metric (${metrics.length} available)`}
        className={`
          rounded border border-line px-2.5 py-1.5 text-caption text-foreground
          transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus-ring-offset-2
          ${open ? "bg-primary text-primary-foreground" : ""}
        `}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
          setFocusOrigin(e.currentTarget as HTMLElement);
        }}
      >
        {metric || "Select metric"}
      </div>

      {/* Dropdown panels */}
      {open && (
        <div
          role="menu"
          className="fixed inset-0 z-50 bg-popover p-4 text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Scope options */}
          <div className="mb-3 border-b border-line pb-3">
            <p className="text-caption text-muted mb-2">Scope</p>
            <div className="flex gap-2">
              <button
                role="menuitem"
                onClick={() => {
                  onScopeChange("us-states");
                  setOpen(false);
                }}
                className={`
                  flex-1 rounded border ${scope === "us-states" ? "bg-primary" : "border-line"} text-sm
                  px-2 py-1 transition-colors ${scope === "us-states" ? "bg-primary-foreground" : "text-foreground"}
                `}
              >
                US States
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  onScopeChange("countries");
                  setOpen(false);
                }}
                className={`
                  flex-1 rounded border ${scope === "countries" ? "bg-primary" : "border-line"} text-sm
                  px-2 py-1 transition-colors ${scope === "countries" ? "bg-primary-foreground" : "text-foreground"}
                `}
              >
                Countries
              </button>
            </div>
          </div>

          {/* Metric options */}
          <div className="mb-3 border-b border-line pb-3">
            <p className="text-caption text-muted mb-2">Metric</p>
            <div className="flex flex-col gap-1">
              {sortedMetrics.map((m) => (
                <button
                  key={m}
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMetricChange(m);
                    setOpen(false);
                  }}
                  className={`
                    flex py-1.5 px-2 rounded border ${m === metric ? "bg-primary" : "border-line"} text-sm
                    ${m === metric ? "text-primary-foreground" : "text-foreground"}
                  `}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Close button */}
          <div className="pt-2 border-t border-line">
            <button
              role="menuitem"
              onClick={() => setOpen(false)}
              className="text-caption text-muted hover:text-foreground transition-colors py-1"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}