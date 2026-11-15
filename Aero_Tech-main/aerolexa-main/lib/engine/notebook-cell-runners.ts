/**
 * Shared notebook cell executors — ONE implementation for interactive runs
 * (`POST /api/notebooks/[id]/run`) and scheduled runs
 * (`lib/server/scheduled-notebook.ts`).
 *
 * Extracted verbatim from the run route so a scheduled notebook computes the
 * SAME numbers as the interactive one: same aggregation rules, same rounding,
 * same limits. Executors are pure over an RLS-filtered dataset context; any
 * change here changes both surfaces (and their oracle tests) together.
 */
import type { ChartCellConfig, NotebookCellOutput, PivotCellConfig, TableDisplayConfig } from "@/lib/types";

export interface CellExecutorContext {
  datasetName: string;
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  rowLimit: number;
}

export function executeChartCell(cfg: ChartCellConfig, ctx: CellExecutorContext): NotebookCellOutput {
  const xCol = cfg.xColumn || ctx.columns[0]?.name || "";
  const yCol = cfg.yColumns[0] || ctx.columns[1]?.name || "";
  const xIdx = ctx.columns.findIndex((c) => c.name === xCol);
  const yIdx = ctx.columns.findIndex((c) => c.name === yCol);
  if (xIdx < 0 || yIdx < 0) {
    return { type: "error", message: `Column not found: ${xIdx < 0 ? xCol : yCol}. Use the dataset's columns.` };
  }

  // Aggregate values
  const groups = new Map<string, number[]>();
  for (const row of ctx.rows) {
    const key = String(row[xIdx] ?? "(empty)");
    const val = Number(row[yIdx]);
    if (Number.isFinite(val)) {
      const arr = groups.get(key) ?? [];
      arr.push(val);
      groups.set(key, arr);
    }
  }

  const categories = Array.from(groups.keys()).slice(0, 50);
  const seriesData = categories.map((k) => {
    const vals = groups.get(k)!;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  });

  return {
    type: "chart",
    title: cfg.title || `${yCol} by ${xCol}`,
    chart: {
      kind:
        cfg.chartType === "scatter"
          ? "scatter"
          : cfg.chartType === "donut"
            ? "donut"
            : cfg.chartType === "heatmap"
              ? "heatmap"
              : cfg.chartType,
      title: cfg.title || `${yCol} by ${xCol}`,
      subtitle: `Aggregated from ${ctx.totalRows.toLocaleString()} rows`,
      xLabel: xCol,
      yLabel: yCol,
      categories,
      series: [{ name: yCol, data: seriesData }],
    },
  };
}

export function executeTableDisplayCell(cfg: TableDisplayConfig, ctx: CellExecutorContext): NotebookCellOutput {
  const cols = cfg.columns?.length ? ctx.columns.filter((c) => cfg.columns!.includes(c.name)) : ctx.columns;
  const limit = Math.min(cfg.limit ?? 50, 200);

  const rows = ctx.rows.slice(0, limit).map((row) => {
    const filteredRow: (string | number | null)[] = [];
    for (const col of cols) {
      const idx = ctx.columns.findIndex((c) => c.name === col.name);
      filteredRow.push(idx >= 0 ? (row[idx] as string | number | null) : null);
    }
    return filteredRow;
  });

  // Apply sorting
  if (cfg.sortBy) {
    const sortIdx = cols.findIndex((c) => c.name === cfg.sortBy);
    if (sortIdx >= 0) {
      rows.sort((a, b) => {
        const av = a[sortIdx];
        const bv = b[sortIdx];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === "number" && typeof bv === "number") {
          return cfg.sortDir === "desc" ? bv - av : av - bv;
        }
        const cmp = String(av).localeCompare(String(bv));
        return cfg.sortDir === "desc" ? -cmp : cmp;
      });
    }
  }

  // Apply conditional formatting
  const cellStyles: Record<string, { bg?: string; color?: string }> = {};
  if (cfg.conditionalFormatting?.length) {
    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < cols.length; ci++) {
        const colName = cols[ci]!.name;
        const val = rows[ri]![ci] ?? null;
        for (const rule of cfg.conditionalFormatting) {
          if (rule.column !== colName) continue;
          if (matchesRule(val, rule)) {
            const key = `${ri}:${ci}`;
            cellStyles[key] = { bg: rule.color, color: rule.textColor };
          }
        }
      }
    }
  }

  return {
    type: "conditional-table",
    title: `Table view — ${cols.length} columns, ${rows.length} rows`,
    columns: cols.map((c) => ({
      key: c.name,
      label: c.name,
      format: c.type === "number" ? "number" : c.type === "date" ? "date" : "text",
    })),
    rows,
    cellStyles,
  };
}

function matchesRule(
  val: string | number | null,
  rule: { operator: string; value: number | string; value2?: number | string },
): boolean {
  if (val === null || val === undefined) return false;
  const num = Number(val);
  const isNum = Number.isFinite(num);
  const threshold = Number(rule.value);
  const isThresholdNum = Number.isFinite(threshold);

  switch (rule.operator) {
    case "gt":
      return isNum && isThresholdNum && num > threshold;
    case "lt":
      return isNum && isThresholdNum && num < threshold;
    case "eq":
      return String(val) === String(rule.value);
    case "gte":
      return isNum && isThresholdNum && num >= threshold;
    case "lte":
      return isNum && isThresholdNum && num <= threshold;
    case "between": {
      if (!isNum || !isThresholdNum) return false;
      const upper = Number(rule.value2 ?? rule.value);
      return num >= threshold && num <= upper;
    }
    case "contains":
      return String(val).toLowerCase().includes(String(rule.value).toLowerCase());
    case "regex": {
      try {
        return new RegExp(String(rule.value), "i").test(String(val));
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export function executePivotCell(cfg: PivotCellConfig, ctx: CellExecutorContext): NotebookCellOutput {
  if (!cfg.rowColumns.length || !cfg.values.length) {
    return { type: "error", message: "Pivot needs at least one row column and one value column." };
  }

  // Filter rows
  let filteredRows = ctx.rows;
  if (cfg.filters?.length) {
    for (const filter of cfg.filters) {
      const filterIdx = ctx.columns.findIndex((c) => c.name === filter.column);
      if (filterIdx >= 0) {
        const filterSet = new Set(filter.values);
        filteredRows = filteredRows.filter((row) => filterSet.has(String(row[filterIdx]!)));
      }
    }
  }

  // Build pivot
  const rowIndices = cfg.rowColumns.map((col) => ctx.columns.findIndex((c) => c.name === col));
  const colIndices = cfg.columnColumns.map((col) => ctx.columns.findIndex((c) => c.name === col));
  const valConfigs = cfg.values.map((v) => ({
    ...v,
    idx: ctx.columns.findIndex((c) => c.name === v.column),
  }));

  // Get unique column headers
  const columnHeaders = new Set<string>();
  for (const row of filteredRows) {
    if (colIndices.length === 0) {
      columnHeaders.add("Total");
    } else {
      const key = colIndices.map((i) => String(row[i] ?? "(empty)")).join(" | ");
      columnHeaders.add(key);
    }
  }
  const colHeaders = Array.from(columnHeaders).sort();

  // Get unique row headers
  const rowHeaderMap = new Map<string, (string | number | boolean | null)[]>();
  for (const row of filteredRows) {
    const key = rowIndices.map((i) => String(row[i] ?? "(empty)")).join(" | ");
    if (!rowHeaderMap.has(key)) {
      rowHeaderMap.set(
        key,
        rowIndices.map((i) => row[i] as string | number | null),
      );
    }
  }
  const rowHeaders = Array.from(rowHeaderMap.keys()).sort();

  // Aggregate values
  const data: (string | number | null)[][] = [];
  for (const rowKey of rowHeaders) {
    const matchingRows = filteredRows.filter((row) => {
      const key = rowIndices.map((i) => String(row[i] ?? "(empty)")).join(" | ");
      return key === rowKey;
    });

    const values: (string | number | null)[] = [];
    for (const colHeader of colHeaders) {
      for (const vc of valConfigs) {
        const colMatching =
          colHeader === "Total"
            ? matchingRows
            : matchingRows.filter((row) => {
                if (colIndices.length === 0) return true;
                const key = colIndices.map((i) => String(row[i] ?? "(empty)")).join(" | ");
                return key === colHeader;
              });
        const nums = colMatching.map((row) => Number(row[vc.idx])).filter((n) => Number.isFinite(n));

        if (nums.length === 0) {
          values.push(null);
          continue;
        }
        switch (vc.aggregation) {
          case "sum":
            values.push(Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100);
            break;
          case "avg":
            values.push(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100);
            break;
          case "min":
            values.push(Math.min(...nums));
            break;
          case "max":
            values.push(Math.max(...nums));
            break;
          case "count":
            values.push(nums.length);
            break;
        }
      }
    }
    data.push(values);
  }

  const valueLabels = cfg.values.map((v) => v.column + "(" + v.aggregation + ")").join(", ");
  return {
    type: "pivot-result" as const,
    title: "Pivot: " + cfg.rowColumns.join(" × ") + " by " + valueLabels,
    rowHeaders,
    columnHeaders: colHeaders.flatMap((ch) =>
      cfg.values.map((v) => {
        const prefix = ch === "Total" ? "" : ch + " — ";
        return prefix + v.column + " (" + v.aggregation + ")";
      }),
    ),
    data,
  };
}

export function executeMapCell(
  cfg: { latColumn: string; lngColumn: string; sizeColumn?: string; colorColumn?: string; labelColumn?: string },
  ctx: CellExecutorContext,
): NotebookCellOutput {
  const latIdx = ctx.columns.findIndex((c) => c.name === cfg.latColumn);
  const lngIdx = ctx.columns.findIndex((c) => c.name === cfg.lngColumn);
  if (latIdx < 0 || lngIdx < 0) {
    return { type: "error", message: "Column not found: " + (latIdx < 0 ? cfg.latColumn : cfg.lngColumn) };
  }
  const sizeIdx = cfg.sizeColumn ? ctx.columns.findIndex((c) => c.name === cfg.sizeColumn) : -1;
  const colorIdx = cfg.colorColumn ? ctx.columns.findIndex((c) => c.name === cfg.colorColumn) : -1;
  const labelIdx = cfg.labelColumn ? ctx.columns.findIndex((c) => c.name === cfg.labelColumn) : -1;

  const points: { lat: number; lng: number; label?: string; size?: number; color?: string }[] = [];
  const colorPalette = ["#5AA8AA", "#FFB400", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7"];
  const colorMap = new Map<string, string>();
  let colorIdx2 = 0;

  for (const row of ctx.rows) {
    const lat = Number(row[latIdx]);
    const lng = Number(row[lngIdx]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

    const point: { lat: number; lng: number; label?: string; size?: number; color?: string } = { lat, lng };
    if (sizeIdx >= 0) {
      const size = Number(row[sizeIdx]);
      if (Number.isFinite(size)) point.size = size;
    }
    if (colorIdx >= 0) {
      const colorKey = String(row[colorIdx]);
      if (!colorMap.has(colorKey)) {
        colorMap.set(colorKey, colorPalette[colorIdx2 % colorPalette.length]!);
        colorIdx2++;
      }
      point.color = colorMap.get(colorKey);
    }
    if (labelIdx >= 0) {
      point.label = String(row[labelIdx] ?? "");
    }
    points.push(point);
  }

  return {
    type: "map-result" as const,
    title: "Map — " + points.length + " points from " + ctx.datasetName,
    points: points.slice(0, 500),
  };
}
