/**
 * Chart recommendation engine (WS4.3).
 *
 * Analyzes dataset schema and suggests optimal visualizations.
 * Combines deterministic heuristics with optional LLM reasoning.
 * Pure functions over schema + statistics — testable without LLM.
 */

import type { ChartKind, ChartSpec, ColumnDef } from "@/lib/types";

import { getLLMClient } from "./client";

/** Suggested column bindings for a recommended chart. */
export interface ChartMapping {
  x?: string;
  y?: string;
  group?: string;
  color?: string;
  size?: string;
  facet?: string;
}

export interface ChartRecommendation {
  /** Recommendation vocabulary — a superset of {@link ChartKind}; see {@link CHART_KIND}. */
  type: ChartType;
  /** Human-readable reason for this recommendation */
  reason: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Suggested column mappings */
  mapping: ChartMapping;
  /** ChartSpec template (partial, needs column names filled) */
  template?: Partial<ChartSpec>;
}

/** Per-column profile statistics consumed by the heuristics. */
export type ColumnProfileStats = {
  distinctCount: number;
  nullCount: number;
  min?: number;
  max?: number;
  mean?: number;
  stdDev?: number;
  topValues?: Array<{ value: string; count: number }>;
};

export interface RecommendationRequest {
  columns: ColumnDef[];
  /** Sample statistics for each column (from profiling) */
  stats?: Record<string, ColumnProfileStats>;
  /** Optional user intent hint */
  intent?: "trend" | "distribution" | "comparison" | "composition" | "relationship" | "ranking" | "overview";
  /** Max recommendations to return */
  max?: number;
}

/** Intent keywords understood by the recommender. */
type RecommendationIntent = NonNullable<RecommendationRequest["intent"]>;

/** Heuristic weights for scoring, keyed by intent.
 *  Uniformly `Record<string, number>` so callers can read any candidate chart
 *  weight (`heuristics.bar ?? 0`) regardless of which intent is active. */
const HEURISTICS: Record<RecommendationIntent, Record<string, number>> = {
  // Trend: date + numeric → line/area
  trend: { line: 1.0, area: 0.9, bar: 0.3 },
  // Distribution: single numeric → histogram/boxplot
  distribution: { histogram: 1.0, boxplot: 0.9, violin: 0.7 },
  // Comparison: categorical + numeric → bar/column
  comparison: { bar: 1.0, column: 0.9, groupedBar: 0.8 },
  // Composition: categorical + numeric (parts of whole) → pie/donut/treemap
  composition: { pie: 0.8, donut: 0.9, treemap: 0.7, sunburst: 0.6 },
  // Relationship: two numerics → scatter
  relationship: { scatter: 1.0, bubble: 0.8, hexbin: 0.7 },
  // Ranking: categorical + numeric (top N) → horizontal bar
  ranking: { bar: 1.0, horizontalBar: 0.9, lollipop: 0.7 },
  // Overview: mixed types → table
  overview: { table: 1.0, kpi: 0.7 },
};

/** Chart type definitions with required/optional fields.
 *  `satisfies` (rather than a type annotation) keeps the literal keys, so
 *  {@link ChartType} stays derived from — and in sync with — this table. */
const CHART_REQUIREMENTS = {
  line: { required: ["x", "y"], optional: ["color", "facet"] },
  area: { required: ["x", "y"], optional: ["color", "facet"] },
  bar: { required: ["x", "y"], optional: ["color", "group"] },
  column: { required: ["x", "y"], optional: ["color", "group"] },
  groupedBar: { required: ["x", "y", "color"], optional: ["facet"] },
  stackedBar: { required: ["x", "y", "color"], optional: [] },
  pie: { required: ["x", "y"], optional: [] },
  donut: { required: ["x", "y"], optional: [] },
  treemap: { required: ["x", "y"], optional: ["color"] },
  sunburst: { required: ["x", "y", "color"], optional: ["facet"] },
  scatter: { required: ["x", "y"], optional: ["color", "size", "facet"] },
  bubble: { required: ["x", "y", "size"], optional: ["color", "facet"] },
  hexbin: { required: ["x", "y"], optional: [] },
  boxplot: { required: ["x", "y"], optional: ["color"] },
  violin: { required: ["x", "y"], optional: ["color"] },
  histogram: { required: ["x"], optional: ["color"] },
  table: { required: [], optional: ["columns", "pageSize"] },
  kpi: { required: ["y"], optional: ["x", "trend"] },
  pivot: { required: ["x", "y"], optional: ["values", "aggregation"] },
  waterfall: { required: ["x", "y"], optional: [] },
  sankey: { required: ["source", "target", "value"], optional: [] },
  pareto: { required: ["x", "y"], optional: [] },
  map: { required: ["lat", "lon"], optional: ["color", "size"] },
  gauge: { required: ["y"], optional: ["min", "max", "target"] },
  funnel: { required: ["x", "y"], optional: ["color"] },
} satisfies Record<string, { required: string[]; optional: string[] }>;

/** The recommender's chart vocabulary, derived from {@link CHART_REQUIREMENTS}. */
export type ChartType = keyof typeof CHART_REQUIREMENTS;

/** Narrow an untrusted string (e.g. LLM output) to a known chart type. */
function isChartType(value: string): value is ChartType {
  return Object.prototype.hasOwnProperty.call(CHART_REQUIREMENTS, value);
}

/** Recommendation type → renderable {@link ChartKind}.
 *
 *  The recommender speaks a plotting-library vocabulary that is a superset of
 *  `ChartKind`; the names below are those the renderer has no distinct kind
 *  for, mapped to the closest renderable equivalent. `"table"` is absent on
 *  purpose: a table is a `TableSpec`, not a `ChartSpec`. */
const CHART_KIND: Record<Exclude<ChartType, "table">, ChartKind> = {
  line: "line",
  area: "area",
  bar: "bar",
  column: "bar", // vertical bar — same renderer as "bar"
  groupedBar: "bar",
  stackedBar: "stacked-bar",
  pie: "donut", // ChartKind has no pie; donut is the same part-to-whole read
  donut: "donut",
  treemap: "bar", // magnitude-by-category, laid out by area
  sunburst: "donut", // radial part-to-whole
  scatter: "scatter",
  bubble: "scatter", // size-encoded scatter
  hexbin: "scatter", // binned scatter
  boxplot: "box",
  violin: "box", // box is the available distribution view
  histogram: "histogram",
  kpi: "kpi",
  pivot: "pivot",
  waterfall: "waterfall",
  sankey: "funnel", // staged flow — funnel is the renderable flow kind
  pareto: "bar", // ranked bars; the cumulative overlay is renderer-specific
  map: "map",
  gauge: "kpi", // single-value readout
  funnel: "funnel",
};

/** Check if column looks like a measure (high cardinality numeric) */
function isMeasure(col: { name: string; type: string }, stats?: Record<string, ColumnProfileStats>): boolean {
  if (col.type !== "number") return false;
  const s = stats?.[col.name];
  if (!s) return true;
  // High cardinality numeric = measure
  return s.distinctCount > 20 || (s.stdDev ?? 0) > 0;
}

/** Deterministic heuristic recommendations */
export function recommendCharts(request: RecommendationRequest): ChartRecommendation[] {
  const { columns, intent = "overview", max = 5 } = request;
  const numericCols = columns.filter((c) => c.type === "number");
  const dateCols = columns.filter((c) => c.type === "date");
  const catCols = columns.filter((c) => c.type !== "number" && c.type !== "date");
  const measures = numericCols.filter((c) => isMeasure(c, request.stats));

  const recommendations: ChartRecommendation[] = [];

  // Helper to add a recommendation
  const add = (
    type: string,
    confidence: number,
    mapping: ChartMapping,
    reason: string,
    template?: Partial<ChartSpec>,
  ) => {
    if (!isChartType(type)) return;
    const req = CHART_REQUIREMENTS[type];
    const valid = req.required.every((field) => mapping[field as keyof ChartMapping]);
    if (valid) {
      recommendations.push({
        type,
        confidence: Math.min(1, Math.max(0, confidence)),
        reason,
        mapping,
        template: template ?? chartSpecFor(type, mapping) ?? undefined,
      });
    }
  };

  // Intent-based recommendations. `intent` is validated at the API boundary, but
  // the fallback keeps an unknown intent from throwing on a missing key.
  const heuristics = HEURISTICS[intent] ?? HEURISTICS.overview;

  // 1. Time series trends
  if (dateCols.length > 0 && measures.length > 0) {
    const dateCol = dateCols[0]!.name;
    const measureCol = measures[0]!.name;
    for (const [type, score] of Object.entries(heuristics)) {
      if (["line", "area", "bar", "column"].includes(type)) {
        add(type, score * 0.95, { x: dateCol, y: measureCol }, `Time series of ${measureCol} over ${dateCol}`);
      }
    }
  }

  // 2. Categorical comparison
  if (catCols.length > 0 && measures.length > 0) {
    const catCol = catCols[0]!.name;
    const measureCol = measures[0]!.name;
    add("bar", 0.9 * (heuristics.bar ?? 0), { x: catCol, y: measureCol }, `Compare ${measureCol} across ${catCol}`);
    add(
      "column",
      0.85 * (heuristics.column ?? 0),
      { x: catCol, y: measureCol },
      `Compare ${measureCol} across ${catCol} (vertical)`,
    );
  }

  // 3. Distribution
  if (measures.length > 0) {
    const measureCol = measures[0]!.name;
    add("histogram", 0.9 * (heuristics.histogram ?? 0), { x: measureCol }, `Distribution of ${measureCol}`);
    if (catCols.length > 0) {
      add(
        "boxplot",
        0.85 * (heuristics.boxplot ?? 0),
        { x: catCols[0]!.name, y: measureCol },
        `Distribution of ${measureCol} by ${catCols[0]!.name}`,
      );
    }
  }

  // 4. Relationship (scatter)
  if (measures.length >= 2) {
    const [x, y] = measures.map((m) => m.name);
    add("scatter", 0.9 * (heuristics.scatter ?? 0), { x, y }, `Relationship between ${x} and ${y}`);
    add(
      "bubble",
      0.8 * (heuristics.bubble ?? 0),
      { x, y, size: measures[2]?.name },
      `Relationship between ${x} and ${y} with size encoding`,
    );
  }

  // 5. Composition (pie/donut)
  if (catCols.length > 0 && measures.length > 0) {
    const catCol = catCols[0]!.name;
    const measureCol = measures[0]!.name;
    add(
      "donut",
      0.8 * (heuristics.donut ?? 0),
      { x: catCol, y: measureCol },
      `Composition of ${measureCol} by ${catCol}`,
    );
    add(
      "treemap",
      0.7 * (heuristics.treemap ?? 0),
      { x: catCol, y: measureCol },
      `Hierarchical composition of ${measureCol} by ${catCol}`,
    );
  }

  // 5. Ranking
  if (catCols.length > 0 && measures.length > 0) {
    const catCol = catCols[0]!.name;
    const measureCol = measures[0]!.name;
    add("bar", 0.8 * (heuristics.bar ?? 0), { x: catCol, y: measureCol }, `Top/bottom ${measureCol} by ${catCol}`);
  }

  // 6. Relationship / correlation
  if (measures.length >= 2) {
    const [x, y] = measures.map((m) => m.name);
    add("scatter", 0.9, { x, y }, `Correlation between ${x} and ${y}`);
  }

  // 7. Overview / table
  if (columns.length > 0) {
    add("table", 0.8, { x: columns[0]?.name }, "Full dataset view as table");
  }

  // Sort by confidence, deduplicate by type
  const seen = new Set<string>();
  return recommendations
    .sort((a, b) => b.confidence - a.confidence)
    .filter((r) => {
      if (seen.has(r.type)) return false;
      seen.add(r.type);
      return true;
    })
    .slice(0, max);
}

/** Optional LLM-enhanced recommendations */
export async function recommendChartsWithLLM(request: RecommendationRequest): Promise<ChartRecommendation[]> {
  const deterministic = recommendCharts(request);

  // If we have few recommendations or user wants LLM insight, try LLM
  if (deterministic.length >= (request.max ?? 5) || request.intent === "overview") {
    return deterministic;
  }

  try {
    const client = getLLMClient();
    const schema = request.columns.map((c) => `${c.name} (${c.type})`).join(", ");

    const prompt = `You are a data visualization expert. Given a dataset with columns: ${schema}

User intent: ${request.intent}

Recommend up to ${request.max ?? 5} chart types from this list:
line, area, bar, column, groupedBar, stackedBar, pie, donut, treemap, scatter, bubble, boxplot, histogram, table, kpi, pivot, heatmap, sankey, waterfall

For each recommendation, provide:
1. Chart type
2. Confidence (0-1)
2. Brief reason
3. Column mappings (x, y, color, group, facet, size)

Respond as JSON array of objects with: type, confidence, reason, mapping.`;

    const response = await client.completeJSON<
      {
        type: string;
        confidence: number;
        reason: string;
        mapping: Record<string, string>;
      }[]
    >(
      prompt,
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            confidence: { type: "number" },
            reason: { type: "string" },
            mapping: { type: "object" },
          },
          required: ["type", "confidence", "reason", "mapping"],
        },
      },
      { temperature: 0.2 },
    );

    // Convert LLM recommendations and merge with deterministic. The model may
    // invent chart names, so anything outside the vocabulary is dropped rather
    // than cast through.
    const llmRecs: ChartRecommendation[] = response.flatMap((r) => {
      if (!isChartType(r.type)) return [];
      return [
        {
          type: r.type,
          confidence: Math.min(1, Math.max(0, r.confidence)),
          reason: r.reason,
          mapping: r.mapping,
        },
      ];
    });

    // Merge and deduplicate
    const all = [...deterministic, ...llmRecs];
    const seen = new Set<string>();
    return all
      .sort((a, b) => b.confidence - a.confidence)
      .filter((r) => {
        if (seen.has(r.type)) return false;
        seen.add(r.type);
        return true;
      })
      .slice(0, request.max ?? 5);
  } catch {
    return deterministic;
  }
}

/** Build a renderable ChartSpec shell from a recommendation type + mapping.
 *  Returns null for "table", which renders as a TableSpec rather than a chart. */
function chartSpecFor(type: ChartType, mapping: ChartMapping): ChartSpec | null {
  if (type === "table") return null;
  const spec: ChartSpec = {
    kind: CHART_KIND[type],
    title: "",
    series: [],
  };
  if (mapping.x) spec.categories = [mapping.x];
  if (mapping.y) spec.series = [{ name: mapping.y, data: [] }];
  return spec;
}

/** Generate ChartSpec from recommendation.
 *
 *  `columns` is used to drop bindings that do not name a real column, so the
 *  returned spec never references a field the dataset does not have. */
export function buildChartSpec(recommendation: ChartRecommendation, columns: ColumnDef[]): ChartSpec | null {
  const known = new Set(columns.map((c) => c.name));
  const resolve = (col: string | undefined) => (col !== undefined && known.has(col) ? col : undefined);
  const mapping: ChartMapping = {
    x: resolve(recommendation.mapping.x),
    y: resolve(recommendation.mapping.y),
    group: resolve(recommendation.mapping.group),
    color: resolve(recommendation.mapping.color),
    size: resolve(recommendation.mapping.size),
    facet: resolve(recommendation.mapping.facet),
  };
  return chartSpecFor(recommendation.type, mapping);
}

/** Export intent keywords for UI */
export const INTENT_KEYWORDS: Record<string, string[]> = {
  trend: ["trend", "over time", "timeline", "evolution", "series", "by date", "by month", "by year"],
  distribution: ["distribution", "histogram", "spread", "frequency", "bins", "boxplot"],
  comparison: ["compare", "versus", "vs", "across", "by category", "by group"],
  composition: ["composition", "breakdown", "share", "proportion", "pie", "donut"],
  relationship: ["relationship", "correlation", "scatter", "vs", "versus", "between"],
  ranking: ["top", "bottom", "rank", "highest", "lowest", "best", "worst"],
  overview: ["overview", "summary", "show all", "table", "all data"],
};
