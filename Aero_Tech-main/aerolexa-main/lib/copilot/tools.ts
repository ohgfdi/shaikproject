/**
 * Copilot tool registry — the ONLY way the agent can affect the world.
 *
 * Design contract (enforced here, not by convention):
 *
 * - Every tool executes a REAL engine over the dataset's REAL rows:
 *   `compute_metrics` runs the governed semantic layer, `run_analysis` runs
 *   the same deterministic `runAnalysis` engine the Analysis Lab uses, and
 *   `get_schema` reads the dataset's actual column definitions. No tool
 *   fabricates a value, and none of them exists merely to make the model look
 *   capable.
 * - Each execution returns `facts`: verbatim strings containing the real
 *   numbers that were computed. The grounding guard (lib/copilot/guard.ts)
 *   only lets a model-authored sentence cite numbers that appear in these
 *   facts. Anything else is treated as an invented number and withheld.
 * - Tools are total: a bad config becomes `{ ok: false, error }` — the agent
 *   sees the engine's own error text (e.g. "Column X is string; this analysis
 *   needs a number column") and can correct itself on the next step. A tool
 *   never throws out of this module.
 * - `run_analysis` performs NO writes. It computes a result in memory and
 *   returns the exact `AnalysisConfig`; persisting an analysis stays an
 *   explicit user action through the existing API.
 */ import type { MetricValue } from "@/lib/analytics/semantic-layer";
import { verifyMeasureProposal } from "@/lib/copilot/measure-proposal";
import { welchTTest } from "@/lib/engine/advisor-analysis";
import { buildDecompositionTree, findKeyInfluencers } from "@/lib/engine/ai-visuals";
import { runAnalysis, type RunAnalysisInput } from "@/lib/engine/analyses";
import type { Cell } from "@/lib/engine/dataset";
import type { DaxModel } from "@/lib/engine/dax";
import { runWhatIf, WhatIfError } from "@/lib/engine/whatif";
import type { AnalysisConfig, AnalysisResult, ColumnDef, Granularity } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata about the dashboard page the copilot is bound to (Roadmap A1). */
export interface DashboardAgentMeta {
  title: string;
  pageName: string;
  widgets: { title: string; type: string; analysisId: string | null }[];
  crossFilters: { column: string; values: string[] }[];
}

/** Everything a tool is allowed to read. Built once per request by the route. */
export interface AgentContext {
  datasetId: string;
  datasetName: string;
  columns: ColumnDef[];
  rows: Cell[][];
  totalRows: number;
  datasetWarnings: string[];
  /** Computed over the real rows; supplied so `compute_metrics` has no side effects. */
  metricValues: MetricValue[];
  /** Present when the copilot is bound to a dashboard page (get_dashboard_context). */
  dashboard?: DashboardAgentMeta;
  /** The saved analysis configs behind the page's widgets, by analysis id. */
  analyses?: { id: string; kind: string; config: AnalysisConfig }[];
  /** A3 — present when measure proposal is enabled (route builds it from RLS rows). */
  daxModel?: DaxModel;
}

/**
 * Build a single-table DaxModel from the dataset's REAL (RLS-filtered) rows
 * so measure proposals are verified against exactly what the user may see.
 */
export function buildDaxModelForAgent(columns: ColumnDef[], rows: Cell[][]): DaxModel {
  return {
    columns: columns.map((c) => c.name),
    rows: rows.map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "number" || typeof cell === "boolean") return cell;
        return String(cell);
      }),
    ),
  };
}

/** A tool execution result. `facts` is what the guard trusts; `digest` is for the model. */
export interface ToolExecution {
  tool: string;
  ok: boolean;
  digest: string;
  /** Verbatim real numbers/provenance the final answer may cite. */
  facts: string[];
  data?: unknown;
  error?: string;
}

/** A declarative description of a tool, rendered into the model prompt. */
export interface CopilotToolSpec {
  name: string;
  description: string;
  /** Argument name → what it is. Empty object means the tool takes no arguments. */
  args: Record<string, string>;
  required: string[];
}

// ---------------------------------------------------------------------------
// Specs (the model's entire vocabulary)
// ---------------------------------------------------------------------------

export const TOOL_SPECS: CopilotToolSpec[] = [
  {
    name: "get_schema",
    description:
      "Read this dataset's real columns, their types, and how many rows were analysed. Use this before choosing metrics or analyses.",
    args: {},
    required: [],
  },
  {
    name: "compute_metrics",
    description:
      "Compute this dataset's governed business metrics (total revenue, profit margin, order count, …) from the real rows. Returns each metric's value, formula, resolved source columns and measured row coverage. These are the ONLY metric values that exist.",
    args: {
      ids: 'Optional array of metric ids to compute (e.g. ["revenue_total"]). Omit to compute every available metric.',
    },
    required: [],
  },
  {
    name: "run_analysis",
    description:
      "Run one real, deterministic analysis over the dataset and get its computed result. Use this to answer questions that need a chart, trend, distribution, correlation, forecast, variance or segmentation. Returns the headline numbers plus the exact config, so the UI can offer to save it.",
    args: {
      kind: "One of: eda, trend, kpi, correlation, distribution, forecast, variance, segmentation, cohort, funnel.",
      metric: "Numeric column name (trend/kpi/variance/forecast).",
      dateCol: "Date column name (trend/kpi/forecast/cohort).",
      dimensionCol: "Categorical column name to group by (variance).",
      column: "Single numeric column name (distribution).",
      columns: "Array of column names (correlation: numbers; segmentation: numbers).",
      granularity: "day | week | month | quarter | year. Defaults to month when omitted.",
      horizon: "Periods ahead for forecast (1–12).",
      k: "Cluster count for segmentation (2–6).",
      bins: "Histogram bins for distribution (0 = engine default).",
      entityCol: "Entity column for cohort.",
      stageCol: "Stage column for funnel.",
      filterCol: "Optional categorical column to filter on.",
      filterValue: "Optional value for filterCol.",
    },
    required: ["kind"],
  },
  {
    name: "propose_measure",
    description:
      "Propose a DAX measure for this dataset (e.g. SUM([revenue]), AVERAGE([price]) * COUNTROWS(...)). The engine verifies the proposal by evaluating it against the real rows — a simple aggregation is also cross-checked against a direct recomputation — and returns the computed value. A verified proposal is offered to the user to save; an invalid one returns the engine's real error so you can fix it. Requires user consent to save.",
    args: {
      name: "Short human name for the measure, e.g. 'Gross revenue'.",
      dax: "The DAX expression, e.g. SUM([revenue]). Use exact column names from get_schema.",
      format: "Optional: number (default) | currency | percentage.",
      filters: "Optional array of { column, values } applied during verification.",
    },
    required: ["name", "dax"],
  },
  {
    name: "explain_key_influencers",
    description:
      "Explain WHY a boolean outcome happens: which categorical values raise or lower its likelihood, with real proportions, Wilson 95% intervals and lift versus the base rate. Use for questions like 'why do customers churn?' or 'which region is most likely to renew?'. The outcome column must contain true/false, 1/0 or yes/no values.",
    args: {
      outcomeColumn: "Boolean outcome column name (true/1/yes = positive class), e.g. 'churned'.",
      analyzeColumns: "Optional array of categorical columns to analyse. Defaults to every other column.",
      minCount: "Optional minimum rows behind an estimate (default 5). Raise it to demand stronger evidence.",
    },
    required: ["outcomeColumn"],
  },
  {
    name: "build_decomposition_tree",
    description:
      "Decompose a measure along up to 4 slice levels to find WHERE the total concentrates — which slice explains the most variance (e.g. revenue by region → product → rep). Children are ranked by contribution contrast against their siblings. Use for 'where did revenue go?' or 'what drives the total?'.",
    args: {
      measureColumn: "Numeric column to sum, e.g. 'revenue'.",
      levels: "Array of 1-4 slice columns in drill order, e.g. ['region', 'product'].",
      filters: "Optional array of { column, value } applied before building the tree.",
    },
    required: ["measureColumn", "levels"],
  },
  {
    name: "run_whatif",
    description:
      "Simulate a signed percentage change in one numeric driver column (e.g. +5% price) and get the projected effect on an outcome column, fitted from the real rows with regression — controls are held at their means, a binary treatment column adds a propensity-score causal cross-check. Use for 'what would happen to margin if we raised price 5%?' questions. The result is an associative projection, never a causal claim.",
    args: {
      driverColumn: "Numeric column to perturb, e.g. 'price'.",
      outcomeColumn: "Numeric outcome column, e.g. 'margin'.",
      pctChange: "Signed percentage as a number, e.g. 5 or -10 (range -100 to +1000).",
      controlColumns: "Optional array of numeric control columns held at their means.",
      treatmentColumn: "Optional binary column (two distinct values) enabling the IPW causal cross-check.",
    },
    required: ["driverColumn", "outcomeColumn", "pctChange"],
  },
  {
    name: "run_significance_test",
    description:
      "Test whether a numeric metric truly differs between two groups with Welch's t-test (unequal variances, exact two-sided p-value): group means, sizes, t statistic, degrees of freedom, and a significance verdict at α = 0.05. Use for 'do North and South really differ on revenue?' questions.",
    args: {
      metricColumn: "Numeric column to compare, e.g. 'revenue'.",
      groupColumn: "Categorical column defining the groups, e.g. 'region'.",
      groupA: "First group's value, e.g. 'North'.",
      groupB: "Second group's value, e.g. 'South'.",
    },
    required: ["metricColumn", "groupColumn", "groupA", "groupB"],
  },
  {
    name: "finish",
    description:
      "End the turn with a short, plain-language summary for the user. You may ONLY mention numbers that appeared in tool results — every number you write is verified against them, and the summary is withheld if any number cannot be verified.",
    args: { summary: "One or two sentences written for the user." },
    required: ["summary"],
  },
];

const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.name));
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out.length ? out : null;
}

function asInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const GRANULARITIES: Granularity[] = ["day", "week", "month", "quarter", "year"];
function asGranularity(v: unknown): Granularity | null {
  const s = asString(v)?.toLowerCase();
  return s && (GRANULARITIES as string[]).includes(s) ? (s as Granularity) : null;
}

/**
 * Build an AnalysisConfig from untrusted model args. Column names are passed
 * through verbatim — `runAnalysis` is the authority on whether they exist and
 * have the right type, and it throws a readable error when they do not.
 */
function buildConfig(kind: string, a: Record<string, unknown>): AnalysisConfig {
  const base = {
    filterCol: asString(a.filterCol),
    filterValue: asString(a.filterValue),
  };
  const granularity = asGranularity(a.granularity) ?? "month";
  switch (kind) {
    case "trend":
      return {
        kind: "trend",
        dateCol: asString(a.dateCol) ?? "",
        metric: asString(a.metric) ?? "",
        granularity,
        ...base,
      };
    case "kpi":
      return {
        kind: "kpi",
        metric: asString(a.metric) ?? "",
        dateCol: asString(a.dateCol),
        granularity,
        ...base,
      };
    case "correlation":
      return { kind: "correlation", columns: asStringArray(a.columns) ?? [], ...base };
    case "distribution":
      return { kind: "distribution", column: asString(a.column) ?? "", bins: asInt(a.bins) ?? 0, ...base };
    case "forecast":
      return {
        kind: "forecast",
        dateCol: asString(a.dateCol) ?? "",
        metric: asString(a.metric) ?? "",
        granularity,
        horizon: asInt(a.horizon) ?? 4,
        cvFolds: asInt(a.cvFolds) ?? 0,
        ...base,
      };
    case "variance":
      return {
        kind: "variance",
        metric: asString(a.metric) ?? "",
        dimensionCol: asString(a.dimensionCol),
        dateCol: asString(a.dateCol),
        ...base,
      };
    case "segmentation":
      return { kind: "segmentation", columns: asStringArray(a.columns) ?? [], k: asInt(a.k) ?? 3, ...base };
    case "cohort":
      return { kind: "cohort", dateCol: asString(a.dateCol) ?? "", entityCol: asString(a.entityCol) ?? "", ...base };
    case "funnel":
      return {
        kind: "funnel",
        stageCol: asString(a.stageCol) ?? "",
        stages: asStringArray(a.stages) ?? undefined,
        ...base,
      };
    case "eda":
    default:
      return { kind: "eda", ...base };
  }
}

/**
 * Pull the real numbers out of an AnalysisResult as citable facts. Every entry
 * is a string already produced by the engine — never re-derived here.
 */
function resultFacts(result: AnalysisResult): string[] {
  const facts: string[] = [];
  for (const card of result.charts.flatMap((c) => c.kpis ?? [])) {
    facts.push(`${card.label}: ${card.value}`);
  }
  for (const stat of result.stats ?? []) {
    facts.push(`${stat.label}: ${stat.value}`);
  }
  for (const finding of result.quickFindings ?? []) {
    facts.push(finding);
  }
  facts.push(`${result.scope.rowsUsed} of ${result.scope.totalRows} rows analysed`);
  for (const line of result.configHuman) facts.push(line);
  for (const warning of result.qualityWarnings) facts.push(warning);
  return facts;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export function execGetSchema(ctx: AgentContext): ToolExecution {
  const schema = ctx.columns.map((c) => ({ name: c.name, type: c.type }));
  const digest = [
    `dataset "${ctx.datasetName}"`,
    `analysed rows: ${ctx.rows.length} of ${ctx.totalRows} total`,
    `columns (${ctx.columns.length}):`,
    ...ctx.columns.map((c) => `  - ${c.name} (${c.type})`),
  ].join("\n");
  return {
    tool: "get_schema",
    ok: true,
    digest,
    facts: [`${ctx.rows.length} of ${ctx.totalRows} rows analysed`],
    data: { datasetName: ctx.datasetName, analyzedRows: ctx.rows.length, totalRows: ctx.totalRows, columns: schema },
  };
}

export function execComputeMetrics(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  if (ctx.metricValues.length === 0) {
    return {
      tool: "compute_metrics",
      ok: true,
      digest:
        "No governed metric could be computed for this dataset (its columns do not match any known metric definition).",
      facts: [],
      data: { metrics: [] },
    };
  }

  const requestedIds = asStringArray(a.ids);
  const values = requestedIds
    ? ctx.metricValues.filter((v) => requestedIds.includes(v.metricId) || requestedIds.includes(v.metricName))
    : ctx.metricValues;

  if (values.length === 0) {
    const available = ctx.metricValues.map((v) => `${v.metricId} (${v.metricName})`).join(", ");
    return {
      tool: "compute_metrics",
      ok: false,
      digest: "",
      facts: [],
      error: `None of the requested metrics exist for this dataset. Available: ${available}`,
    };
  }

  const facts = values.map(
    (v) =>
      `${v.metricName}: ${v.formattedValue} (formula ${v.formula}; columns ${Object.values(v.resolvedColumns).join(", ")}; ` +
      `${v.sampleSize} of ${v.totalRows} rows, ${Math.round(v.confidence * 100)}% coverage)`,
  );
  return {
    tool: "compute_metrics",
    ok: true,
    digest: ["Computed metrics (these are the real values):", ...facts.map((f) => `  - ${f}`)].join("\n"),
    facts,
    data: { metrics: values },
  };
}

export function execRunAnalysis(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  const kind = asString(a.kind);
  const validKinds = [
    "eda",
    "trend",
    "kpi",
    "correlation",
    "distribution",
    "forecast",
    "variance",
    "segmentation",
    "cohort",
    "funnel",
    "regression",
    "abtest",
    "automl",
    "arimax",
    "dataquality",
    "accounting",
    "syntheticcontrol",
    "uplift",
    "sprt",
    "drift",
    "compliance",
  ];
  if (!kind || !validKinds.includes(kind)) {
    return {
      tool: "run_analysis",
      ok: false,
      digest: "",
      facts: [],
      error: `Unknown analysis kind "${kind ?? "(missing)"}". Use one of: ${validKinds.join(", ")}.`,
    };
  }

  let cfg: AnalysisConfig;
  try {
    cfg = buildConfig(kind, a);
  } catch (err) {
    return { tool: "run_analysis", ok: false, digest: "", facts: [], error: errorText(err) };
  }

  const input: RunAnalysisInput = {
    datasetId: ctx.datasetId,
    datasetName: ctx.datasetName,
    totalRows: ctx.totalRows,
    columns: ctx.columns,
    rows: ctx.rows,
    datasetWarnings: ctx.datasetWarnings,
  };

  let result: AnalysisResult;
  try {
    result = runAnalysis(input, cfg);
  } catch (err) {
    // The engine's own message is the correction signal for the next step.
    return { tool: "run_analysis", ok: false, digest: "", facts: [], error: errorText(err) };
  }

  const facts = resultFacts(result);
  const headline = [
    ...(result.charts.flatMap((c) => c.kpis ?? []).map((k) => `  - ${k.label}: ${k.value}`) ?? []),
    ...(result.stats ?? []).map((s) => `  - ${s.label}: ${s.value}`),
  ];
  return {
    tool: "run_analysis",
    ok: true,
    digest: [
      `Ran "${result.title}" (${kind}).`,
      `${result.methodology.method}.`,
      ...(headline.length ? ["Headline numbers (real):", ...headline] : []),
      ...(result.quickFindings?.length ? ["Findings:", ...result.quickFindings.map((f) => `  - ${f}`)] : []),
      `Scope: ${result.scope.rowsUsed} of ${result.scope.totalRows} rows.`,
    ].join("\n"),
    facts,
    data: { kind, title: result.title, config: cfg, result },
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "The tool failed for an unknown reason.";
}

/**
 * A3 — propose_measure executor. Verification runs here (pure, no I/O): the
 * route supplies a DaxModel built from the RLS-filtered rows via
 * `buildDaxModelForAgent`. A measure is offered to the user only when the
 * engine verified it; the model's PROSE about it is still guard-checked like
 * every other number.
 */
export function execProposeMeasure(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  if (!ctx.daxModel) {
    return {
      tool: "propose_measure",
      ok: false,
      digest: "",
      facts: [],
      error: 'Measure proposal needs "propose_measure enabled" mode. This copilot request does not support it.',
    };
  }
  const result = verifyMeasureProposal(ctx.daxModel, a);
  if (!result.ok) {
    return {
      tool: "propose_measure",
      ok: false,
      digest: "",
      facts: [],
      error: result.error ?? "The proposal failed verification.",
    };
  }
  const fact = `proposed measure "${result.name}" = ${result.evaluatedValue} (DAX: ${result.dax}; cross-check ${result.crossCheck})`;
  return {
    tool: "propose_measure",
    ok: true,
    digest: [
      `Verified proposed measure "${result.name}".`,
      `  - DAX: ${result.dax}`,
      `  - Value over the real rows: ${result.evaluatedValue} (verified${result.crossCheck === "matched" ? ", cross-checked against a direct recomputation" : ""}).`,
      `  - NOT saved yet — offer the user to save it via the metric UI; never claim it is stored.`,
    ].join("\n"),
    facts: [fact],
    data: { proposal: result },
  };
}

/**
 * ROADMAP 6.2 — grounded data answers. `explain_key_influencers` runs the
 * SAME deterministic engine as the AI-visuals route (Wilson intervals, lift
 * vs base rate) over the agent's RLS-filtered rows. Every likelihood it
 * reports becomes a citable fact, so the guard can hold the model to them.
 */
export function execExplainKeyInfluencers(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  const outcomeColumn = asString(a.outcomeColumn);
  if (!outcomeColumn) {
    return {
      tool: "explain_key_influencers",
      ok: false,
      digest: "",
      facts: [],
      error: "An outcome column is required, e.g. 'churned'.",
    };
  }
  const knownColumns = new Set(ctx.columns.map((c) => c.name));
  if (!knownColumns.has(outcomeColumn)) {
    return {
      tool: "explain_key_influencers",
      ok: false,
      digest: "",
      facts: [],
      error: `Outcome column "${outcomeColumn}" is not in this dataset. Known columns: ${ctx.columns.map((c) => c.name).join(", ")}.`,
    };
  }
  const analyzeColumns = (asStringArray(a.analyzeColumns) ?? undefined)?.filter(
    (c) => knownColumns.has(c) && c !== outcomeColumn,
  );
  const minCount = asInt(a.minCount) ?? undefined;

  const columns = ctx.columns.map((c) => c.name);
  const rows = ctx.rows.map((row) =>
    row.map((cell) =>
      cell === null || cell === undefined
        ? null
        : typeof cell === "number" || typeof cell === "boolean"
          ? cell
          : String(cell),
    ),
  );

  let result;
  try {
    result = findKeyInfluencers({ columns, rows, outcomeColumn, analyzeColumns, minCount });
  } catch (err) {
    return { tool: "explain_key_influencers", ok: false, digest: "", facts: [], error: errorText(err) };
  }

  if (result.influencers.length === 0) {
    return {
      tool: "explain_key_influencers",
      ok: true,
      digest:
        `No categorical influencer met the evidence threshold` +
        `${result.skippedColumns.length ? ` (skipped: ${result.skippedColumns.join(", ")})` : ""}. ` +
        "The outcome column may be constant, or every candidate column is near-unique (ids) — neither can explain anything.",
      facts: [`base rate of ${outcomeColumn}: ${(result.baseRate * 100).toFixed(1)}% over ${result.totalRows} rows`],
      data: result,
    };
  }

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const facts = result.influencers
    .slice(0, 12)
    .map(
      (i) =>
        `${i.category} = "${i.value}": ${pct(i.likelihood)} ${outcomeColumn} vs base rate ${pct(result.baseRate)} (lift ${i.lift.toFixed(2)}×, n=${i.count}, Wilson 95% CI ${pct(i.ciLow)}–${pct(i.ciHigh)}, ${i.strength})`,
    );
  const digest = [
    `Key influencers of "${outcomeColumn}" (base rate ${pct(result.baseRate)} over ${result.totalRows} rows):`,
    ...facts.map((f) => `  - ${f}`),
    ...(result.skippedColumns.length ? [`Skipped (no generalizable signal): ${result.skippedColumns.join(", ")}`] : []),
  ].join("\n");
  return {
    tool: "explain_key_influencers",
    ok: true,
    digest,
    facts,
    data: result,
  };
}

/**
 * ROADMAP 6.2 — `build_decomposition_tree`: same engine as the AI-visuals
 * route, over the agent's RLS-filtered rows. The tree's top contributions
 * become citable facts; the full tree goes to `data` so the UI can offer to
 * render it as an actual visual.
 */
export function execBuildDecompositionTree(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  const measureColumn = asString(a.measureColumn);
  const levels = asStringArray(a.levels);
  if (!measureColumn) {
    return {
      tool: "build_decomposition_tree",
      ok: false,
      digest: "",
      facts: [],
      error: "A measure column is required, e.g. 'revenue'.",
    };
  }
  if (!levels?.length) {
    return {
      tool: "build_decomposition_tree",
      ok: false,
      digest: "",
      facts: [],
      error: "Provide 1-4 level columns to slice by, e.g. ['region', 'product'].",
    };
  }
  const knownColumns = new Set(ctx.columns.map((c) => c.name));
  for (const col of [measureColumn, ...levels]) {
    if (!knownColumns.has(col)) {
      return {
        tool: "build_decomposition_tree",
        ok: false,
        digest: "",
        facts: [],
        error: `Column "${col}" is not in this dataset. Known columns: ${ctx.columns.map((c) => c.name).join(", ")}.`,
      };
    }
  }
  const filters = Array.isArray(a.filters)
    ? (a.filters as unknown[])
        .map((f) => (f && typeof f === "object" ? (f as { column?: unknown; value?: unknown }) : null))
        .filter(
          (f): f is { column: string; value: string } =>
            !!f && typeof f.column === "string" && typeof f.value === "string" && knownColumns.has(f.column),
        )
    : undefined;

  const columns = ctx.columns.map((c) => c.name);
  const rows = ctx.rows.map((row) =>
    row.map((cell) =>
      cell === null || cell === undefined
        ? null
        : typeof cell === "number" || typeof cell === "boolean"
          ? cell
          : String(cell),
    ),
  );

  let tree;
  try {
    tree = buildDecompositionTree({ columns, rows, measureColumn, levels: levels.slice(0, 4), filters });
  } catch (err) {
    return { tool: "build_decomposition_tree", ok: false, digest: "", facts: [], error: errorText(err) };
  }

  const fmt = (v: number) => Math.round(v * 100) / 100;
  const facts: string[] = [`total ${measureColumn}: ${fmt(tree.value)}`];
  for (const child of tree.children.slice(0, 8)) {
    facts.push(
      `${child.levelColumn} = "${child.label}": ${fmt(child.value)} (${(child.shareOfParent * 100).toFixed(1)}% of total)`,
    );
  }
  // Second level of the biggest branch — the classic drill-path answer.
  const top = tree.children[0];
  if (top?.children.length) {
    for (const sub of top.children.slice(0, 4)) {
      facts.push(
        `within ${top.levelColumn} = "${top.label}", ${sub.levelColumn} = "${sub.label}": ${fmt(sub.value)} (${(sub.shareOfParent * 100).toFixed(1)}% of the branch)`,
      );
    }
  }
  const digest = [
    `Decomposition of ${measureColumn} by ${levels.slice(0, 4).join(" → ")}.`,
    ...facts.map((f) => `  - ${f}`),
    "Children are ranked by contribution contrast against their siblings.",
  ].join("\n");
  return {
    tool: "build_decomposition_tree",
    ok: true,
    digest,
    facts,
    data: { tree, measureColumn, levels: levels.slice(0, 4) },
  };
}

/**
 * ROADMAP 6.3 — `run_whatif`: the causal/what-if engine as a copilot tool.
 * Same deterministic engine as the What-if surface (multivariate OLS, ceteris-
 * paribus controls, optional IPW cross-check, CV-ridge weak-signal rescue).
 * Every number the model may cite comes from the engine's own result.
 */
export function execRunWhatIf(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  const driverColumn = asString(a.driverColumn);
  const outcomeColumn = asString(a.outcomeColumn);
  const pctRaw =
    typeof a.pctChange === "number" ? a.pctChange : typeof a.pctChange === "string" ? Number(a.pctChange) : Number.NaN;
  if (!driverColumn || !outcomeColumn) {
    return {
      tool: "run_whatif",
      ok: false,
      digest: "",
      facts: [],
      error:
        "Both a driverColumn and an outcomeColumn are required, e.g. driverColumn='price', outcomeColumn='margin'.",
    };
  }
  if (!Number.isFinite(pctRaw)) {
    return {
      tool: "run_whatif",
      ok: false,
      digest: "",
      facts: [],
      error: "pctChange must be a signed percentage number, e.g. 5 or -10.",
    };
  }

  const source = {
    columns: ctx.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: ctx.rows.map((row) =>
      row.map((cell) =>
        cell === null || cell === undefined
          ? null
          : typeof cell === "number" || typeof cell === "boolean"
            ? cell
            : String(cell),
      ),
    ),
  };

  let result: ReturnType<typeof runWhatIf>;
  try {
    result = runWhatIf(source, {
      driverColumn,
      outcomeColumn,
      pctChange: pctRaw,
      controlColumns: asStringArray(a.controlColumns) ?? undefined,
      treatmentColumn: asString(a.treatmentColumn) ?? undefined,
    });
  } catch (err) {
    // WhatIfError messages are user-actionable validation text — surface them
    // verbatim so the model can correct its own arguments on the next step.
    const hint = err instanceof WhatIfError || err instanceof Error ? err.message : "The what-if engine failed.";
    return { tool: "run_whatif", ok: false, digest: "", facts: [], error: hint };
  }

  const fmt = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "—");
  const facts: string[] = [
    `${result.pctChange > 0 ? "+" : ""}${result.pctChange}% ${driverColumn} → ${outcomeColumn}: ${fmt(result.beforeValue)} → ${fmt(
      result.afterValue,
    )} (change ${fmt(result.delta)}, ${fmt(result.deltaPct)}%)`,
    `model: slope ${fmt(result.model.slope)}, r² ${fmt(result.model.rSquared)}, ${result.model.points} rows`,
    result.fallback
      ? "verdict: hypothetical proportional fallback — the data's signal is too weak for a fitted projection"
      : "verdict: fitted regression projection (associative, not causal)",
  ];
  if (result.regularized) {
    facts.push(
      `regularized: ridge α = ${fmt(result.regularized.alpha)}, CV R² = ${fmt(result.regularized.cvR2)} over ${result.regularized.folds} folds`,
    );
  }
  if (result.causal) {
    facts.push(
      `causal cross-check (${result.causal.method} on “${result.causal.treatmentColumn}”): estimate ${fmt(result.causal.estimate)} (95% CI ${fmt(
        result.causal.ci95.low,
      )} to ${fmt(result.causal.ci95.high)}), ${result.causal.agreement} with the regression slope`,
    );
  }
  // Methodology lines carry real numbers too — the guard verifies against them.
  for (const line of result.methodology) facts.push(line);

  const digest = [
    `Ran the what-if engine: ${result.pctChange > 0 ? "+" : ""}${result.pctChange}% ${driverColumn} → ${outcomeColumn}.`,
    `  - ${fmt(result.beforeValue)} → ${fmt(result.afterValue)} (Δ ${fmt(result.delta)}, ${fmt(result.deltaPct)}%), slope ${fmt(result.model.slope)}, r² ${fmt(result.model.rSquared)}.`,
    `  - ${result.fallback ? "Hypothetical fallback (weak signal)" : "Fitted projection"}${result.regularized ? " via cross-validated ridge" : ""}.`,
    `Narrative: ${result.narrative}`,
  ].join("\n");
  return {
    tool: "run_whatif",
    ok: true,
    digest,
    facts,
    data: { result },
  };
}

/**
 * ROADMAP 6.3 — `run_significance_test`: Welch's t-test between two groups of
 * a numeric column, straight from the validated advisor engine (exact
 * two-sided p-value). Group means/sizes/t/p/df all become citable facts.
 */
export function execRunSignificanceTest(ctx: AgentContext, a: Record<string, unknown>): ToolExecution {
  const metricColumn = asString(a.metricColumn);
  const groupColumn = asString(a.groupColumn);
  const groupA = a.groupA;
  const groupB = a.groupB;
  if (!metricColumn || !groupColumn) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error:
        "Both a metricColumn (numeric) and a groupColumn (categorical) are required, e.g. metricColumn='revenue', groupColumn='region'.",
    };
  }
  if (
    groupA === undefined ||
    groupA === null ||
    groupA === "" ||
    groupB === undefined ||
    groupB === null ||
    groupB === ""
  ) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error: "Both groupA and groupB values are required, e.g. groupA='North', groupB='South'.",
    };
  }
  const metricIdx = ctx.columns.findIndex((c) => c.name === metricColumn);
  const groupIdx = ctx.columns.findIndex((c) => c.name === groupColumn);
  if (metricIdx < 0 || groupIdx < 0) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error: `Unknown column(s). Known columns: ${ctx.columns.map((c) => c.name).join(", ")}.`,
    };
  }
  if (metricIdx === groupIdx) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error: "metricColumn and groupColumn must be different columns.",
    };
  }

  const key = (v: unknown) => String(v).trim().toLowerCase();
  const wantA = key(groupA);
  const wantB = key(groupB);
  if (wantA === wantB) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error: "groupA and groupB must be two different values.",
    };
  }
  const valsA: number[] = [];
  const valsB: number[] = [];
  for (const row of ctx.rows) {
    const g = row[groupIdx];
    if (g === null || g === undefined || g === "") continue;
    const k = key(g);
    if (k !== wantA && k !== wantB) continue;
    const raw = row[metricIdx];
    const v =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,$\s%€£]/g, "")) : Number.NaN;
    if (!Number.isFinite(v)) continue;
    (k === wantA ? valsA : valsB).push(v);
  }
  if (valsA.length < 2 || valsB.length < 2) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error: `Not enough numeric rows to compare (found ${valsA.length} in “${String(groupA)}” vs ${valsB.length} in “${String(
        groupB,
      )}”). Each group needs at least 2 numeric rows.`,
    };
  }

  const t = welchTTest(valsA, valsB);
  if (!t) {
    return {
      tool: "run_significance_test",
      ok: false,
      digest: "",
      facts: [],
      error: "The Welch t-test could not be computed for these groups (degenerate variance).",
    };
  }
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const meanA = mean(valsA);
  const meanB = mean(valsB);
  const significant = t.p < 0.05;
  const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);
  const facts = [
    `${String(groupA)}: mean ${fmt(meanA)} over n = ${valsA.length}`,
    `${String(groupB)}: mean ${fmt(meanB)} over n = ${valsB.length}`,
    `Welch t-test: t = ${fmt(t.t)}, df = ${fmt(t.df)}, two-sided p = ${fmt(t.p)}`,
    `verdict at α = 0.05: ${significant ? "the difference IS statistically significant" : "the difference is NOT statistically significant"} (mean difference ${fmt(meanA - meanB)})`,
  ];
  const digest = [
    `Welch's t-test on ${metricColumn}: “${String(groupA)}” vs “${String(groupB)}”.`,
    ...facts.map((f) => `  - ${f}`),
    "The test compares means only — it does not by itself prove causation.",
  ].join("\n");
  return {
    tool: "run_significance_test",
    ok: true,
    digest,
    facts,
    data: {
      metricColumn,
      groupColumn,
      groupA: String(groupA),
      groupB: String(groupB),
      nA: valsA.length,
      nB: valsB.length,
      meanA,
      meanB,
      t: t.t,
      p: t.p,
      df: t.df,
      significant,
    },
  };
}

/**
 * Execute one tool call. Never throws: failures come back as `{ ok: false }`
 * with the real error text so the agent can adapt and the transcript stays
 * honest.
 */
export function executeTool(name: string, args: Record<string, unknown>, ctx: AgentContext): ToolExecution {
  if (!isKnownTool(name)) {
    return {
      tool: name,
      ok: false,
      digest: "",
      facts: [],
      error: `Unknown tool "${name}". Allowed tools: ${[...TOOL_NAMES].join(", ")}.`,
    };
  }
  if (name === "finish") {
    // `finish` has no side effect; the agent loop reads args.summary directly.
    return {
      tool: "finish",
      ok: true,
      digest: "finish acknowledged",
      facts: [],
      data: { summary: asString(args.summary) },
    };
  }
  try {
    switch (name) {
      case "get_schema":
        return execGetSchema(ctx);
      case "compute_metrics":
        return execComputeMetrics(ctx, args);
      case "run_analysis":
        return execRunAnalysis(ctx, args);
      case "propose_measure":
        return execProposeMeasure(ctx, args);
      case "explain_key_influencers":
        return execExplainKeyInfluencers(ctx, args);
      case "build_decomposition_tree":
        return execBuildDecompositionTree(ctx, args);
      case "run_whatif":
        return execRunWhatIf(ctx, args);
      case "run_significance_test":
        return execRunSignificanceTest(ctx, args);
      case "get_dashboard_context":
        return execDashboardContextTool(ctx);
      default:
        return { tool: name, ok: false, digest: "", facts: [], error: `Tool "${name}" is not implemented.` };
    }
  } catch (err) {
    return { tool: name, ok: false, digest: "", facts: [], error: errorText(err) };
  }
}

/**
 * A1 — the dashboard-aware get_dashboard_context tool. Only available when
 * the route bound the agent to a dashboard (ctx.dashboard set); otherwise it
 * answers with an honest "not on a dashboard" so the model can adapt.
 */
export function execDashboardContextTool(ctx: AgentContext): ToolExecution {
  if (!ctx.dashboard) {
    return {
      tool: "get_dashboard_context",
      ok: false,
      digest: "",
      facts: [],
      error:
        "This copilot is not bound to a dashboard. There is no dashboard context to read; answer from the dataset tools only.",
    };
  }
  const dash = ctx.dashboard;
  const widgetLines = dash.widgets.length
    ? dash.widgets
        .map((w) => `  - "${w.title}" (${w.type})${w.analysisId ? ` [analysis ${w.analysisId}]` : ""}`)
        .join("\n")
    : "  (no widgets on this page)";
  const filterLines = dash.crossFilters.length
    ? dash.crossFilters.map((f) => `  - ${f.column}: ${f.values.join(", ")}`).join("\n")
    : "  (none — the page is unfiltered)";
  const configLines = (ctx.analyses ?? []).length
    ? (ctx.analyses ?? []).map((a) => `  - ${a.id}: ${a.kind} ${JSON.stringify(a.config)}`).join("\n")
    : "  (none resolvable)";
  const digest = [
    `dashboard "${dash.title}" — page "${dash.pageName}"`,
    `widgets on page:`,
    widgetLines,
    `active cross-filters:`,
    filterLines,
    `saved analysis configs behind the widgets:`,
    configLines,
    `To explain a widget's numbers, call run_analysis with the SAME kind/columns as its config, adding filterCol/filterValue from the active cross-filters.`,
  ].join("\n");
  return {
    tool: "get_dashboard_context",
    ok: true,
    digest,
    // Metadata only — zero numbers, so nothing here is citable as a value.
    facts: [],
    data: { dashboard: dash, analyses: ctx.analyses ?? [] },
  };
}
