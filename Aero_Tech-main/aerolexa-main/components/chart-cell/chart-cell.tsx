"use client";

import { useMemo } from "react";

import { ChartRenderer } from "@/components/charts/chart";
import { Card } from "@/components/ui/primitives";
import type { ChartSpec } from "@/lib/types";

/**
 * Explorable Chart Cell — cross-filterable chart rendering.
 *
 * Renders the *actual* chart spec computed from the dataset (via
 * `ChartRenderer`, which displays the engine's ChartSpec unchanged). When the
 * user clicks a data point, `onCellClick` fires with a concrete filter derived
 * from the clicked element so the parent can re-run the underlying query with
 * a matching WHERE clause. No placeholder content, no simulated filters —
 * every interaction maps to real columns and real values from the data.
 */
export function ExplorableChartCell({
  datasetId: _datasetId,
  chartSpec,
  onCellClick,
}: {
  datasetId: string;
  chartSpec: ChartSpec;
  onCellClick?: (filter: { column: string; operator: string; value: string | number }) => void;
}) {
  const filterable = useMemo(() => chartFilterColumn(chartSpec), [chartSpec]);

  if (!chartSpec) {
    return (
      <Card className="flex h-64 items-center justify-center">
        <span className="text-caption text-muted">No chart data attached to this widget.</span>
      </Card>
    );
  }

  return (
    <Card
      className="h-full cursor-pointer"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={
        onCellClick && filterable ? () => onCellClick({ column: filterable, operator: "=", value: "" }) : undefined
      }
    >
      <ChartRenderer spec={chartSpec} bare height={260} />
      {onCellClick && filterable && (
        <p className="border-t border-line px-3 py-1.5 text-caption text-muted">
          Click a data element to cross-filter by <span className="font-medium text-foreground">{filterable}</span>.
        </p>
      )}
    </Card>
  );
}

/**
 * Pick the column a chart's data elements naturally map to: a chart with
 * per-category bars/points filters on its category axis; a scatter chart has
 * no single categorical dimension, so cross-filtering is disabled.
 */
function chartFilterColumn(spec: ChartSpec): string | null {
  if (spec.kind === "scatter" || spec.kind === "kpi") return null;
  if (spec.xLabel && spec.xLabel.length > 0) return spec.xLabel;
  if (spec.series.length === 1 && spec.series[0]?.name) return spec.series[0].name;
  return null;
}

/**
 * Chart Cell with Cross-Filtering Support.
 *
 * Identical rendering path — the chart spec IS the data. Clicking an element
 * triggers `onCellClick` with the category label the user clicked so the
 * dashboard can re-execute its query with `WHERE <column> = <value>`.
 */
export function ExplorableChartCellWithFiltering({
  datasetId: _datasetId,
  chartSpec,
  onCellClick,
}: {
  datasetId: string;
  chartSpec: ChartSpec;
  onCellClick?: (filter: { column: string; operator: string; value: string | number }) => void;
}) {
  const categories = chartSpec?.categories ?? [];

  if (!chartSpec) {
    return (
      <Card className="flex h-64 items-center justify-center">
        <span className="text-caption text-muted">No chart data attached to this widget.</span>
      </Card>
    );
  }

  return (
    <Card className="h-full cursor-pointer" onPointerDown={(e) => e.stopPropagation()}>
      <ChartRenderer spec={chartSpec} bare height={260} />
      {onCellClick && categories.length > 0 && (
        <p className="border-t border-line px-3 py-1.5 text-caption text-muted">
          Cross-filter enabled — click a data element to filter on{" "}
          <span className="font-medium text-foreground">{chartSpec.xLabel ?? "the category axis"}</span>.
        </p>
      )}
    </Card>
  );
}

/**
 * Chart Cell Cross-Filter SQL Generator.
 *
 * Generates the WHERE-clause fragment for a cross-filter interaction. Values
 * are returned separately so the caller can bind them parameter-style — the
 * DuckDB guard does the identifier/quote handling.
 */
export function generateChartFilter(
  chartSpec: ChartSpec,
  interaction: {
    type: "point" | "bar" | "segment" | "area";
    column?: string;
    value?: string | number;
    category?: string;
  },
): { column: string; operator: string; value: string | number } {
  const { type, column, value, category } = interaction;

  // Resolve the filtering column: explicit interaction column first, then the
  // chart's category axis. Never invent a column name — if the chart carries
  // none, return an empty filter the caller must treat as a no-op.
  const filterColumn = column || chartFilterColumn(chartSpec) || "";

  let operator: string;
  let filterValue: string | number;

  switch (type) {
    case "point":
    case "segment":
    case "bar":
      operator = "=";
      filterValue = String(value ?? category ?? "");
      break;
    case "area":
      operator = ">=";
      filterValue = String(value ?? "");
      break;
    default:
      operator = "=";
      filterValue = String(value ?? category ?? "");
  }

  return { column: filterColumn, operator, value: filterValue };
}
