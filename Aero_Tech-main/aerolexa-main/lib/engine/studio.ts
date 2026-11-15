import {
  bucketByDate,
  bucketKey,
  cellDate,
  cellNumber,
  cellString,
  columnIndex,
  numericColumn,
  valueCounts,
  type Cell,
} from "@/lib/engine/dataset";
import { histogram, max, mean, min, pearson, sum } from "@/lib/engine/stats";
import type { ChartSeries, ChartSpec, ColumnDef, Granularity, KpiCard, ScopeInfo } from "@/lib/types";

import { AnalysisInputError } from "./analyses";

export interface StudioQueryInput {
  datasetId: string;
  datasetName: string;
  totalRows: number;
  columns: ColumnDef[];
  rows: Cell[][];
  datasetWarnings: string[];
  chartKind: string; // ChartKind | "geographic"
  metric?: string | null;
  metric2?: string | null;
  dimension?: string | null;
  date?: string | null;
  granularity?: Granularity;
  from?: string | null;
  to?: string | null;
  filterCol?: string | null;
  filterValues?: string[];
  bins?: number;
}

export interface StudioOutput {
  chart: ChartSpec;
  configHuman: string[];
  methodology: { method: string; steps: string[]; assumptions: string[] };
  scope: ScopeInfo;
  qualityWarnings: string[];
  isDemoLogic: boolean;
}

const PALETTE = ["#5AA8AA", "#FFB400", "#7C5CFF", "#3D9BE9", "#E8637A", "#58B368", "#F08A5D", "#B08BBB"];
const fmt = (v: number) =>
  Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(2);

export function buildStudioChart(input: StudioQueryInput): StudioOutput {
  const { columns } = input;
  let working = input.rows;

  // Filters — date range and/or categorical multi-select, applied first
  const filterNotes: string[] = [];
  if (input.date && input.from && input.to && columnIndex(columns, input.date) >= 0) {
    const idx = columnIndex(columns, input.date);
    working = working.filter((row) => {
      const d = cellDate(row[idx]);
      if (!d) return false;
      const iso = d.toISOString().slice(0, 10);
      return iso >= (input.from ?? "") && iso <= (input.to ?? "");
    });
    filterNotes.push(`${input.date} between ${input.from} and ${input.to}`);
  }
  if (input.filterCol && input.filterValues && input.filterValues.length > 0) {
    const idx = columnIndex(columns, input.filterCol);
    const allowed = new Set(input.filterValues);
    working = working.filter((row) => allowed.has(cellString(row[idx])));
    filterNotes.push(`${input.filterCol} in [${input.filterValues.join(", ")}]`);
  }

  const metric = input.metric && columnIndex(columns, input.metric) >= 0 ? input.metric : null;
  const metric2 = input.metric2 && columnIndex(columns, input.metric2) >= 0 ? input.metric2 : null;
  const dimension = input.dimension && columnIndex(columns, input.dimension) >= 0 ? input.dimension : null;
  const date = input.date && columnIndex(columns, input.date) >= 0 ? input.date : null;
  const sampled = input.totalRows > input.rows.length;
  const warnings = [...input.datasetWarnings];
  if (sampled) {
    warnings.push(
      `Chart computed on a sample: first ${working.length.toLocaleString()} of ${input.totalRows.toLocaleString()} rows.`,
    );
  }
  const scope: ScopeInfo = {
    rowsUsed: working.length,
    totalRows: input.totalRows,
    sampled,
    filters: filterNotes.map((v) => ({ column: "selection", value: v })),
  };
  const configHuman = buildHuman(input, metric, metric2, dimension, date, filterNotes);
  const methodology = {
    method: "Aggregation + grouping computed on the server from the uploaded row stream for the exact selection above.",
    steps: [...configHuman],
    assumptions: ["Blank values are excluded per aggregation.", "Chart reflects the filter selection currently shown."],
  };
  // Geographic requests degrade honestly to a bar view of the same real
  // totals (no tile server) — the UI explains this via the DemoBadge.
  const isDemoLogic = input.chartKind === "geographic" && Boolean(dimension);
  const granularity = input.granularity ?? "month";

  const dimensionTotals = (topN = 15): { groups: { value: string; total: number; count: number }[]; total: number } => {
    if (!dimension || !metric) return { groups: [], total: 0 };
    const didx = columnIndex(columns, dimension);
    const midx = columnIndex(columns, metric);
    const map = new Map<string, { total: number; count: number }>();
    for (const row of working) {
      const key = cellString(row[didx]);
      const v = cellNumber(row[midx]);
      if (!key || !Number.isFinite(v)) continue;
      const cur = map.get(key) ?? { total: 0, count: 0 };
      cur.total += v;
      cur.count++;
      map.set(key, cur);
    }
    const groups = [...map.entries()]
      .map(([value, s]) => ({ value, ...s }))
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);
    return { groups, total: sum(groups.map((g) => g.total)) };
  };

  const metricVals = metric ? numericColumn(working, columns, metric) : [];
  let chart: ChartSpec;
  const title =
    input.chartKind === "kpi"
      ? `${metric ?? "Key"} performance indicators`
      : `${titleCase(input.chartKind)} · ${metric ?? dimension ?? "dataset"}`;

  switch (input.chartKind) {
    case "kpi": {
      const kpis: KpiCard[] = [];
      let spark: number[] = [];
      if (date && metric) {
        const vals = bucketByDate(working, columns, date, metric, granularity).map((b) => b.value);
        spark = vals.slice(-12);
        const latest = vals[vals.length - 1] ?? 0;
        const prev = vals[vals.length - 2];
        const pct = prev !== undefined && prev !== 0 ? ((latest - prev) / Math.abs(prev)) * 100 : null;
        kpis.push({
          label: `Latest ${granularity}`,
          value: fmt(latest),
          deltaPct: pct,
          deltaLabel: "vs previous",
          kind: "sum",
          spark,
        });
      }
      kpis.push(
        { label: "Total", value: fmt(sum(metricVals)), kind: "sum", spark },
        { label: "Average per row", value: fmt(metricVals.length ? mean(metricVals) : 0), kind: "mean" },
        { label: "Max", value: fmt(max(metricVals)), kind: "max" },
        { label: "Min", value: fmt(min(metricVals)), kind: "min" },
      );
      chart = {
        kind: "kpi",
        title,
        subtitle: `Aggregates over ${working.length.toLocaleString()} rows`,
        kpis,
        series: [],
      };
      break;
    }

    case "histogram": {
      if (!metric)
        throw new AnalysisInputError(
          "A histogram needs a numeric metric column. What happened: no metric column was selected. How to fix: choose a numeric column (number type) to visualize its distribution.",
        );
      const h = histogram(metricVals, input.bins || 0);
      chart = {
        kind: "histogram",
        title: `Histogram of ${metric}`,
        subtitle: `${metricVals.length.toLocaleString()} numeric values · ${h.binLabels.length} bins`,
        categories: h.binLabels,
        series: [{ name: metric, data: h.counts, color: PALETTE[0] }],
        yLabel: "Count",
      };
      break;
    }

    case "box": {
      if (!metric)
        throw new AnalysisInputError(
          "A box plot needs a numeric metric column. What happened: no metric column was selected. How to fix: choose a numeric column (number type) to show its distribution statistics.",
        );
      if (dimension) {
        const didx = columnIndex(columns, dimension);
        const midx = columnIndex(columns, metric);
        const map = new Map<string, number[]>();
        for (const row of working) {
          const key = cellString(row[didx]);
          const v = cellNumber(row[midx]);
          if (!key || !Number.isFinite(v)) continue;
          const arr = map.get(key) ?? [];
          arr.push(v);
          map.set(key, arr);
        }
        const entries = [...map.entries()].sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 8);
        chart = {
          kind: "box",
          title: `Distribution of ${metric} by ${dimension}`,
          categories: entries.map(([n]) => n),
          series: entries.map(([name, vals]) => ({ name, box: five(vals) })),
          yLabel: metric,
        };
      } else {
        chart = {
          kind: "box",
          title: `Distribution of ${metric}`,
          categories: [metric],
          series: [{ name: metric, box: five(metricVals) }],
          yLabel: metric,
        };
      }
      break;
    }

    case "scatter": {
      if (!metric || !metric2)
        throw new AnalysisInputError(
          "A scatter chart needs two numeric metrics. What happened: one or both metric columns are missing. How to fix: select two numeric columns — one for the X axis and one for the Y axis.",
        );
      const xIdx = columnIndex(columns, metric);
      const yIdx = columnIndex(columns, metric2);
      const dimIdx = dimension ? columnIndex(columns, dimension) : -1;
      const points: { x: number; y: number; label?: string }[] = [];
      const step = Math.max(1, Math.floor(working.length / 800));
      for (let i = 0; i < working.length; i += step) {
        const x = cellNumber(working[i]?.[xIdx]);
        const y = cellNumber(working[i]?.[yIdx]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        points.push({ x, y, label: dimIdx >= 0 ? cellString(working[i]?.[dimIdx]) : undefined });
      }
      const { r, n } = pearson(
        points.map((p) => p.x),
        points.map((p) => p.y),
      );
      chart = {
        kind: "scatter",
        title: `${metric} vs ${metric2}`,
        subtitle:
          n > 3 ? `${n.toLocaleString()} points · Pearson r = ${Number.isFinite(r) ? r.toFixed(2) : "n/a"}` : undefined,
        xLabel: metric,
        yLabel: metric2,
        series: [{ name: "Rows", points }],
      };
      break;
    }

    case "funnel": {
      if (!dimension)
        throw new AnalysisInputError(
          "A funnel needs a category dimension column. What happened: no dimension column was selected. How to fix: choose a categorical column (string type) to define the funnel stages.",
        );
      const counts = valueCounts(
        working.map((r) => cellString(r[columnIndex(columns, dimension)])),
        200,
      );
      if (counts.length < 2)
        throw new AnalysisInputError(
          "A funnel needs at least 2 distinct values in the dimension. What happened: the selected dimension has fewer than 2 unique values. How to fix: choose a column with more variety, or check for data quality issues in the dimension column.",
        );
      chart = {
        kind: "funnel",
        title: `Conversion by ${dimension}`,
        subtitle: "Ranked by volume — supply an explicit stage order for strict funnel semantics.",
        categories: counts.map((c) => c.value),
        series: [{ name: "Rows", data: counts.map((c) => c.count), color: PALETTE[0] }],
      };
      break;
    }

    case "waterfall": {
      if (date && metric && dimension) {
        const buckets = bucketByDate(working, columns, date, metric, granularity);
        const prev = buckets[buckets.length - 2];
        const last = buckets[buckets.length - 1];
        if (!prev || !last)
          throw new AnalysisInputError(
            "A time waterfall needs two periods of history. What happened: not enough time periods to show a change. How to fix: select a date column with at least two time periods of data, or use a finer granularity (day/week instead of month).",
          );
        const dIdx = columnIndex(columns, date);
        const midx = columnIndex(columns, metric);
        const didx = columnIndex(columns, dimension);
        const sums = new Map<string, { a: number; b: number }>();
        for (const row of working) {
          const d = cellDate(row[dIdx]);
          if (!d) continue;
          const key = bucketKey(d, granularity);
          if (key !== prev.key && key !== last.key) continue;
          const v = cellNumber(row[midx]);
          const g = cellString(row[didx]);
          if (!Number.isFinite(v) || !g) continue;
          const cur = sums.get(g) ?? { a: 0, b: 0 };
          if (key === last.key) cur.b += v;
          else cur.a += v;
          sums.set(g, cur);
        }
        const deltas = [...sums.entries()]
          .map(([value, s]) => ({ value, delta: s.b - s.a }))
          .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
          .slice(0, 10);
        chart = {
          kind: "waterfall",
          title: `Change in ${metric}: ${prev.label} → ${last.label}`,
          subtitle: "Bridged by the largest group movers (top 10).",
          categories: [`Start (${prev.label})`, ...deltas.map((d) => d.value), `End (${last.label})`],
          series: [
            {
              name: metric,
              data: [prev.value, ...deltas.map((d) => d.delta), last.value],
              totals: [0, deltas.length + 1],
            },
          ],
          yLabel: metric,
        };
      } else {
        const { groups } = dimensionTotals(12);
        chart = {
          kind: "waterfall",
          title: `${metric ?? "Metric"} by ${dimension ?? "group"}`,
          subtitle: "Cumulative build-up of group totals.",
          categories: groups.map((g) => g.value),
          series: [{ name: metric ?? "Total", data: groups.map((g) => g.total), totals: [groups.length - 1] }],
        };
      }
      break;
    }

    case "heatmap": {
      if (!dimension || !metric || !date)
        throw new AnalysisInputError(
          "A heatmap needs a dimension, a metric and a date column. What happened: one or more required columns are missing. How to fix: select all three — a categorical dimension, a numeric metric, and a date column.",
        );
      if (granularity !== "month")
        throw new AnalysisInputError(
          "Heatmaps currently use monthly periods — switch granularity to month. What happened: the selected granularity is not supported for heatmaps. How to fix: change the time granularity to 'month' in the chart settings.",
        );
      const buckets = bucketByDate(working, columns, date, metric, "month");
      const recent = buckets.slice(-12);
      const colKeys = recent.map((b) => b.key);
      const colLabels = recent.map((b) => b.label);
      const dIdx = columnIndex(columns, date);
      const midx = columnIndex(columns, metric);
      const didx = columnIndex(columns, dimension);
      const cellSum = new Map<string, number>();
      for (const row of working) {
        const d = cellDate(row[dIdx]);
        if (!d) continue;
        const key = bucketKey(d, "month");
        const ci = colKeys.indexOf(key);
        if (ci < 0) continue;
        const dim = cellString(row[didx]);
        const v = cellNumber(row[midx]);
        if (!dim || !Number.isFinite(v)) continue;
        cellSum.set(`${dim}||${ci}`, (cellSum.get(`${dim}||${ci}`) ?? 0) + v);
      }
      const groupTotals = new Map<string, number>();
      for (const [ck, v] of cellSum) {
        const g = ck.split("||")[0] ?? "";
        groupTotals.set(g, (groupTotals.get(g) ?? 0) + v);
      }
      const topRows = [...groupTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name]) => name);
      const data: number[] = [];
      for (const rowName of topRows) {
        for (let ci = 0; ci < colLabels.length; ci++) data.push(cellSum.get(`${rowName}||${ci}`) ?? 0);
      }
      chart = {
        kind: "heatmap",
        title: `${metric} by ${dimension} over time`,
        subtitle: "Cells show summed metric per group & month.",
        rowLabels: topRows,
        categories: colLabels,
        series: [{ name: metric, data }],
      };
      break;
    }

    case "geographic": {
      // Honest degradation: Ledgerly has no tile server, so a geo request
      // renders the same dimension totals any chart would — real numbers,
      // clearly framed as a bar view of the regions, not a "placeholder".
      const { groups, total } = dimensionTotals(12);
      if (!groups.length)
        throw new AnalysisInputError(
          "A geographic view needs a categorical dimension (e.g. region/country) and a numeric metric. What happened: no usable dimension/metric pairs were found. How to fix: select a categorical dimension and a numeric metric, then run again.",
        );
      chart = {
        kind: "bar",
        title: `${metric ?? "Rows"} by ${dimension ?? "region"}`,
        subtitle: `Bar view of regional totals${total ? ` · top group holds ${(((groups[0]?.total ?? 0) / total) * 100).toFixed(0)}%` : ""}`,
        categories: groups.map((g) => g.value),
        series: [{ name: metric ?? "Count", data: groups.map((g) => g.total), color: PALETTE[0] }],
        yLabel: metric ?? undefined,
      };
      break;
    }

    default: {
      if (
        metric &&
        date &&
        dimension &&
        (input.chartKind === "line" ||
          input.chartKind === "area" ||
          input.chartKind === "bar" ||
          input.chartKind === "stacked-bar")
      ) {
        const buckets = bucketByDate(working, columns, date, metric, granularity);
        const topGroups = topGroupsByTotal(working, columns, dimension, metric, 6);
        const series: ChartSeries[] = topGroups.map((g, i) => ({
          name: g,
          data: buckets.map((b) => groupSumAtBucket(working, columns, date, dimension, metric, g, b.key, granularity)),
          color: PALETTE[i % PALETTE.length],
        }));
        chart = {
          kind: (input.chartKind === "stacked-bar" ? "stacked-bar" : input.chartKind) as ChartSpec["kind"],
          title: `${metric} by ${dimension} over time`,
          subtitle: `Top ${topGroups.length} ${dimension} groups · ${granularity}ly`,
          categories: buckets.map((b) => b.label),
          series,
          yLabel: metric,
        };
      } else if (metric && date) {
        const buckets = bucketByDate(working, columns, date, metric, granularity);
        const vals = buckets.map((b) => b.value);
        chart = {
          kind: (input.chartKind === "stacked-bar" ? "bar" : input.chartKind) as ChartSpec["kind"],
          title: `${metric} over time`,
          subtitle: `Summed per ${granularity} · ${vals.length} periods`,
          categories: buckets.map((b) => b.label),
          series: [{ name: metric, data: vals, color: PALETTE[0] }],
          yLabel: metric,
        };
      } else if (metric && dimension) {
        const { groups, total } = dimensionTotals(12);
        const kind: ChartSpec["kind"] =
          input.chartKind === "stacked-bar" || input.chartKind === "line" || input.chartKind === "area"
            ? "bar"
            : (input.chartKind as ChartSpec["kind"]);
        chart = {
          kind,
          title: `${metric} by ${dimension}`,
          subtitle: `Top ${groups.length} groups · ${total ? `${(((groups[0]?.total ?? 0) / total) * 100).toFixed(0)}%` : "0"}% in the leading group`,
          categories: groups.map((g) => g.value),
          series: [{ name: metric, data: groups.map((g) => g.total), color: PALETTE[0] }],
          yLabel: metric,
        };
      } else if (metric) {
        const h = histogram(metricVals, input.bins || 0);
        chart = {
          kind: "histogram",
          title: `Distribution of ${metric}`,
          subtitle: "No dimension or date chosen — showing the value spread.",
          categories: h.binLabels,
          series: [{ name: metric, data: h.counts, color: PALETTE[0] }],
          yLabel: "Count",
        };
      } else {
        throw new AnalysisInputError(
          "Pick a metric column to draw this chart. What happened: no metric column was selected. How to fix: choose a column with numeric values to visualize.",
        );
      }
    }
  }

  if (chart.kind === "donut" && chart.series.length > 1) {
    chart = { ...chart, series: [{ name: "Values", data: chart.series.map((s) => s.data?.[0] ?? 0) }] };
  }

  return { chart, configHuman, methodology, scope, qualityWarnings: warnings, isDemoLogic };
}

function topGroupsByTotal(rows: Cell[][], columns: ColumnDef[], dim: string, metric: string, n: number): string[] {
  const totals = new Map<string, number>();
  const didx = columnIndex(columns, dim);
  const midx = columnIndex(columns, metric);
  for (const row of rows) {
    const key = cellString(row[didx]);
    const v = cellNumber(row[midx]);
    if (!key || !Number.isFinite(v)) continue;
    totals.set(key, (totals.get(key) ?? 0) + v);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
}

function groupSumAtBucket(
  rows: Cell[][],
  columns: ColumnDef[],
  dateCol: string,
  dimCol: string,
  metricCol: string,
  group: string,
  key: string,
  granularity: Granularity,
): number {
  const dIdx = columnIndex(columns, dateCol);
  const midx = columnIndex(columns, metricCol);
  const didx = columnIndex(columns, dimCol);
  let acc = 0;
  for (const row of rows) {
    if (cellString(row[didx]) !== group) continue;
    const d = cellDate(row[dIdx]);
    if (!d) continue;
    if (bucketKey(d, granularity) !== key) continue;
    const v = cellNumber(row[midx]);
    if (Number.isFinite(v)) acc += v;
  }
  return acc;
}

function five(vals: number[]): [number, number, number, number, number] {
  const sorted = [...vals].sort((a, b) => a - b);
  if (sorted.length === 0) return [0, 0, 0, 0, 0];
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
  return [sorted[0] ?? 0, q(0.25), q(0.5), q(0.75), sorted[sorted.length - 1] ?? 0];
}

function buildHuman(
  input: StudioQueryInput,
  metric: string | null,
  metric2: string | null,
  dimension: string | null,
  date: string | null,
  filters: string[],
): string[] {
  const parts = [
    `${input.chartKind} over “${input.datasetName}”`,
    metric ? `metric: ${metric}` : null,
    metric2 ? `second metric: ${metric2}` : null,
    dimension ? `dimension: ${dimension}` : null,
    date ? `time column: ${date} (${input.granularity ?? "month"}ly buckets)` : null,
    ...filters,
  ];
  return parts.filter((x): x is string => Boolean(x));
}

function titleCase(s: string): string {
  return s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
