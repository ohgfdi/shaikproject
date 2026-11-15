/**
 * Copilot intent engine — grounded in the real dataset schema.
 *
 * Design contract (enforced here, not by convention):
 * - The copilot may only NAME data it has actually computed. Metric values
 *   come from the semantic layer (`SemanticLayerManager.computeMetrics`),
 *   which resolves source columns by exact/normalized name and omits any
 *   metric whose formula cannot be computed. Nothing here invents numbers.
 * - "Matched" metrics are matched on REAL tokens: the request text is
 *   tokenized, stop-words dropped, and a metric matches only via its name,
 *   tags or a resolved source column. A bare "for"/"the" can never match.
 * - Suggestions are executable: every action carries the exact
 *   `AnalysisConfig` the POST /api/datasets/[id]/analyses route accepts, so
 *   the UI can run the real engine — never a dead-end promise.
 * - When the request cannot be matched to anything, the answer says so and
 *   lists what IS possible. It never guesses.
 *
 * Every response carries a `grounding` block (which metric definitions were
 * used, which columns resolved, how many rows were analysed) so the client
 * can show provenance instead of asking the user to trust a paragraph.
 */

import type { MetricValue } from "@/lib/analytics/semantic-layer";
import type { AnalysisConfig, ColumnDef, Granularity } from "@/lib/types";

// ---------------------------------------------------------------------------
// Public types (mirror the API contract — keep in sync with dataset-copilot.tsx)
// ---------------------------------------------------------------------------

export interface GroundedMetric {
  metricId: string;
  metricName: string;
  value: number;
  formattedValue: string;
  formula: string;
  resolvedColumns: Record<string, string>;
  sampleSize: number;
  totalRows: number;
  /** Measured coverage (contributing rows / analysed rows) — never invented. */
  confidence: number;
  /** Which tokens in the request caused the match (for provenance display). */
  matchedOn: string[];
}

export interface CopilotAction {
  kind: string;
  title: string;
  description: string;
  /** Executable payload for POST /api/datasets/[id]/analyses, or null when the action is only guidance. */
  config: AnalysisConfig | null;
  /** Honest blocker when the request needs something this dataset lacks. */
  missingRequirement?: string;
}

export interface CopilotGrounding {
  analyzedRows: number;
  totalRows: number;
  sampled: boolean;
  columns: { name: string; type: string }[];
  /** Metric definitions that exist for this dataset, whether or not matched. */
  availableMetrics: { id: string; name: string; formula: string }[];
}

/** Which brain produced an answer: the deterministic engine or the tool-calling agent. */
export type CopilotMode = "deterministic" | "agent";

/** One entry in the agent's tool trace, shown to the user as provenance. */
export interface CopilotToolTrace {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  error?: string;
}

/** Metadata about an agent-mode answer. */
export interface CopilotAgentInfo {
  provider: string;
  model: string;
  latencyMs: number;
  steps: CopilotToolTrace[];
  /** True when the model's prose was discarded because it cited unverified numbers. */
  summaryWithheld: boolean;
  withheldReason: string | null;
}

export interface CopilotAnswer {
  explanation: string;
  matchedMetrics: GroundedMetric[];
  suggestedActions: CopilotAction[];
  grounded: boolean;
  grounding: CopilotGrounding;
  /** Which brain produced this answer. */
  mode: CopilotMode;
  /** Present only when mode === "agent". */
  agent?: CopilotAgentInfo;
  /** Dataset the numbers were computed from — lets the UI run suggested analyses. */
  datasetId?: string;
  /** A3 — a verified DAX measure proposal (offered for save, never auto-saved). */
  measureProposal?: {
    ok: boolean;
    name: string;
    dax: string;
    format: string;
    evaluatedValue: string | null;
    crossCheck: string;
  };
}

// ---------------------------------------------------------------------------
// Tokenization + stop-words (small, auditable, dependency-free)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "any",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "give",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "per",
  "please",
  "show",
  "some",
  "tell",
  "that",
  "the",
  "their",
  "there",
  "this",
  "to",
  "us",
  "vs",
  "versus",
  "want",
  "was",
  "we",
  "what",
  "whats",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

export function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Intent rules over the REAL schema (no suggestion without the columns to run it)
// ---------------------------------------------------------------------------

interface IntentRule {
  kind: string;
  title: string;
  patterns: RegExp;
  /** Build the executable config, or return null + a reason when impossible. */
  build: (ctx: SchemaContext) => { config: AnalysisConfig | null; missing?: string };
  describe: (ctx: SchemaContext) => string;
}

export interface SchemaContext {
  columns: ColumnDef[];
  numeric: ColumnDef[];
  dates: ColumnDef[];
  categorical: ColumnDef[];
  /** Chosen automatically: the date column with the most rows, else the first. */
  dateCol: ColumnDef | null;
  granularity: Granularity;
}

/**
 * Numeric columns the request actually names (normalized token match), in
 * request order — so “trend of profit by month” trends profit, not whatever
 * numeric column happens to be first in the file.
 */
function requestedNumericColumns(request: string, numeric: ColumnDef[]): ColumnDef[] {
  const tokens = new Set(tokenize(request).map(normalize));
  return numeric.filter((c) => tokens.has(normalize(c.name)));
}

/** Build the schema context used by every intent rule. */
export function schemaContext(columns: ColumnDef[]): SchemaContext {
  const numeric = columns.filter((c) => c.type === "number");
  const dates = columns.filter((c) => c.type === "date");
  const categorical = columns.filter((c) => c.type === "string" || c.type === "boolean");
  return {
    columns,
    numeric,
    dates,
    categorical,
    dateCol: dates[0] ?? null,
    // Monthly is the safest default: readable, and the forecast engine's
    // seasonal detection is calibrated for monthly cycles.
    granularity: "month",
  };
}

export const INTENT_RULES: IntentRule[] = [
  {
    kind: "trend",
    title: "Trend over time",
    patterns: /\b(trend|over time|growth|decline|increas\w*|decreas\w*|moving|evolution|timeline)\b/i,
    build: (ctx) => {
      const metric = ctx.numeric[0];
      if (!metric || !ctx.dateCol) {
        return {
          config: null,
          missing: !ctx.dateCol
            ? "This dataset has no date column, so nothing can be plotted over time."
            : "No numeric column is available to trend over time.",
        };
      }
      return {
        config: {
          kind: "trend",
          dateCol: ctx.dateCol.name,
          metric: metric.name,
          granularity: ctx.granularity,
        },
      };
    },
    describe: (ctx) =>
      ctx.dateCol && ctx.numeric[0]
        ? `Plot ${ctx.numeric[0].name} grouped by ${ctx.dateCol.name} (${ctx.granularity}) with period-over-period change.`
        : "Trend analysis is unavailable for this schema.",
  },
  {
    kind: "kpi",
    title: "KPI summary",
    patterns:
      /\b(kpi|kpis|metric|metrics|performance|indicator|total|sum|average|revenue|count|how many|number of|margin|profit)\b/i,
    build: (ctx) => {
      const metric = ctx.numeric[0];
      if (!metric) return { config: null, missing: "No numeric column exists to compute KPIs from." };
      return {
        config: {
          kind: "kpi",
          metric: metric.name,
          dateCol: ctx.dateCol?.name ?? null,
          granularity: ctx.granularity,
        },
      };
    },
    describe: (ctx) =>
      ctx.numeric[0]
        ? `Totals, averages, min/max and latest-vs-previous period for ${ctx.numeric[0].name}.`
        : "KPI analysis is unavailable for this schema.",
  },
  {
    kind: "correlation",
    title: "Correlation analysis",
    patterns: /\b(correlat\w*|relationship|associated|association|related)\b/i,
    build: (ctx) => {
      const usable = ctx.numeric.slice(0, 12);
      if (usable.length < 2) {
        return { config: null, missing: "Correlation needs at least two numeric columns with 5+ values each." };
      }
      return { config: { kind: "correlation", columns: usable.map((c) => c.name) } };
    },
    describe: (ctx) =>
      ctx.numeric.length >= 2
        ? `Pearson + Spearman correlation across ${Math.min(ctx.numeric.length, 12)} numeric columns with p-values.`
        : "Correlation analysis is unavailable for this schema.",
  },
  {
    kind: "distribution",
    title: "Distribution analysis",
    patterns: /\b(distribut\w*|histogram|spread|outlier\w*|skew\w*|quartile\w*)\b/i,
    build: (ctx) => {
      const col = ctx.numeric[0];
      if (!col) return { config: null, missing: "No numeric column exists to profile a distribution for." };
      return { config: { kind: "distribution", column: col.name, bins: 0 } };
    },
    describe: (ctx) =>
      ctx.numeric[0]
        ? `Histogram, box-plot, outlier counts and a normality screen for ${ctx.numeric[0].name}.`
        : "Distribution analysis is unavailable for this schema.",
  },
  {
    kind: "forecast",
    title: "Backtested forecast",
    patterns: /\b(forecast\w*|predict\w*|projection|future|next (month|week|quarter|year|period)s?\b)\b/i,
    build: (ctx) => {
      const metric = ctx.numeric[0];
      if (!metric || !ctx.dateCol) {
        return {
          config: null,
          missing: !ctx.dateCol
            ? "Forecasting needs a date column — this dataset has none."
            : "Forecasting needs a numeric metric column — this dataset has none.",
        };
      }
      return {
        config: {
          kind: "forecast",
          dateCol: ctx.dateCol.name,
          metric: metric.name,
          granularity: ctx.granularity,
          horizon: 4,
          // Single walk-forward backtest — multi-fold CV stays a user choice.
          cvFolds: 0,
        },
      };
    },
    describe: (ctx) =>
      ctx.dateCol && ctx.numeric[0]
        ? `Project ${ctx.numeric[0].name} 4 periods ahead — candidate models are backtested on your own history and the lowest-error model wins.`
        : "Forecasting is unavailable for this schema.",
  },
  {
    kind: "variance",
    title: "Variance by group",
    patterns:
      /\b(compar\w*|variance|difference|versus|vs\.?|group\w*|breakdown|by (region|product|channel|category|department))\b/i,
    build: (ctx) => {
      const metric = ctx.numeric[0];
      const dim = ctx.categorical[0];
      if (!metric) return { config: null, missing: "No numeric column exists to compare." };
      if (!dim) return { config: null, missing: "No categorical column exists to group by." };
      return {
        config: {
          kind: "variance",
          metric: metric.name,
          dimensionCol: dim.name,
          dateCol: ctx.dateCol?.name ?? null,
        },
      };
    },
    describe: (ctx) =>
      ctx.numeric[0] && ctx.categorical[0]
        ? `Compare ${ctx.numeric[0].name} across ${ctx.categorical[0].name} groups, ranked by total.`
        : "Variance analysis is unavailable for this schema.",
  },
  {
    kind: "segmentation",
    title: "Segmentation (clustering)",
    patterns: /\b(cluster\w*|segments?\b|cohorts?\b|personas?\b)\b/i,
    build: (ctx) => {
      const cols = ctx.numeric.slice(0, 6);
      if (cols.length < 1) return { config: null, missing: "Segmentation needs at least one numeric column." };
      return { config: { kind: "segmentation", columns: cols.map((c) => c.name), k: 3 } };
    },
    describe: (ctx) =>
      ctx.numeric.length > 0
        ? `Group rows into k-means clusters using ${Math.min(ctx.numeric.length, 6)} numeric columns.`
        : "Segmentation is unavailable for this schema.",
  },
  {
    kind: "eda",
    title: "Data quality profile",
    patterns: /\b(quality|missing|incomplete|clean\w*|duplicat\w*|health|profiler|explore)\b/i,
    build: () => ({ config: { kind: "eda" } }),
    describe: () => "Missing values, duplicates, per-column stats and distribution shapes across the whole dataset.",
  },
];

// ---------------------------------------------------------------------------
// Metric matching (token-based — stop-words can never match)
// ---------------------------------------------------------------------------

function metricTokens(definition: { name: string; tags: string[] }, resolvedColumns: Record<string, string>): string[] {
  const tokens = new Set<string>();
  for (const t of tokenize(definition.name)) tokens.add(t);
  for (const tag of definition.tags) tokens.add(normalize(tag));
  for (const col of Object.values(resolvedColumns)) tokens.add(normalize(col));
  return [...tokens].filter((t) => t.length > 1);
}

/**
 * Match computed metric values against the request. A metric is "matched"
 * only when a real token of the request equals one of the metric's name
 * tokens, tags, or a resolved source column. Returns matches with the
 * tokens that caused them (provenance).
 */
export function matchMetrics(request: string, values: MetricValue[]): GroundedMetric[] {
  const requestTokens = new Set(tokenize(request));
  const requestNormalized = new Set([...requestTokens].map(normalize));
  const matches: { metric: GroundedMetric; score: number }[] = [];

  for (const mv of values) {
    const tokens = metricTokens({ name: mv.metricName, tags: tagsForMetric(mv.metricId) }, mv.resolvedColumns);
    const matchedOn = tokens.filter((t) => requestNormalized.has(t));
    if (matchedOn.length === 0) continue;

    matches.push({
      metric: {
        metricId: mv.metricId,
        metricName: mv.metricName,
        value: mv.value,
        formattedValue: mv.formattedValue,
        formula: mv.formula,
        resolvedColumns: mv.resolvedColumns,
        sampleSize: mv.sampleSize,
        totalRows: mv.totalRows,
        confidence: mv.confidence,
        matchedOn,
      },
      score: matchedOn.length,
    });
  }

  // More matching tokens = more specific hit; then by sample size.
  matches.sort((a, b) => b.score - a.score || b.metric.sampleSize - a.metric.sampleSize);
  return matches.slice(0, 4).map((m) => m.metric);
}

/** Tags per builtin metric id (kept here so the matcher stays pure/testable). */
function tagsForMetric(metricId: string): string[] {
  switch (metricId) {
    case "revenue_total":
    case "revenue_avg":
      return ["revenue", "sales", "financial"];
    case "profit_margin":
      return ["profit", "margin", "efficiency"];
    case "cost_per_unit":
      return ["cost", "unit", "efficiency"];
    case "customer_count":
      return ["customer", "customers", "clients"];
    case "customer_lifetime_value":
      return ["customer", "value", "ltv", "arpu"];
    case "order_count":
      return ["order", "orders", "transaction", "transactions"];
    case "average_order_value":
      return ["order", "aov", "value"];
    case "conversion_rate":
      return ["conversion", "marketing", "funnel"];
    case "defect_rate":
      return ["defect", "quality", "manufacturing"];
    case "completion_rate":
      return ["completion", "quality", "tasks"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Suggestions (schema-gated)
// ---------------------------------------------------------------------------

export function suggestActions(request: string, ctx: SchemaContext): CopilotAction[] {
  const actions: CopilotAction[] = [];
  const seen = new Set<string>();
  // Prefer columns the request explicitly names over schema file order —
  // “trend of cost by month” must trend cost, not the first numeric column.
  const requested = requestedNumericColumns(request, ctx.numeric);
  const effective: SchemaContext =
    requested.length > 0
      ? {
          ...ctx,
          numeric: [...requested, ...ctx.numeric.filter((c) => !requested.includes(c))],
        }
      : ctx;

  for (const rule of INTENT_RULES) {
    if (!rule.patterns.test(request)) continue;
    if (seen.has(rule.kind)) continue;
    seen.add(rule.kind);
    const built = rule.build(effective);
    actions.push({
      kind: rule.kind,
      title: rule.title,
      description: rule.describe(effective),
      config: built.config,
      ...(built.missing ? { missingRequirement: built.missing } : {}),
    });
  }

  // Fallback: dataset-wide exploration is always executable.
  if (actions.length === 0) {
    actions.push({
      kind: "eda",
      title: "Explore the dataset",
      description: INTENT_RULES.find((r) => r.kind === "eda")!.describe(ctx),
      config: { kind: "eda" },
    });
  }

  return actions.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Small-talk / greeting detection (ChatGPT-style politeness, still grounded)
// ---------------------------------------------------------------------------

/**
 * Recognises conversational openers that carry no analytical intent —
 * greetings, thanks, identity questions, capability probes. When one is
 * detected the copilot answers like a person FIRST and only then shows what
 * it can compute, instead of replying "No governed metric matches “hi”".
 *
 * The returned text names only real facts (dataset size, metric count), so
 * the honesty contract holds even in small talk.
 */
export function detectSmallTalk(request: string): string | null {
  const text = request.trim().toLowerCase();
  if (!text || text.length > 60) return null;

  const greeting =
    /^(hi+|hey+|hello+|yo|hiya|howdy|greetings|good\s*(morning|afternoon|evening)|sup|whats? up|what's up|namaste)\b/.test(
      text,
    );
  const thanks = /^\s*(thanks?|thank you|thx|ty|cheers|appreciate( it)?)\b[.\s!]*$/.test(text);
  const identity =
    /\b(who are you|what are you|your name|what can you do|what do you do|help me|how do you work|are you (an? )?(ai|bot|robot|human))\b/.test(
      text,
    );
  const howAreYou = /^\s*(how are you|how('s| is| are) it going|how('s| is) it going|how do you do)\b/.test(text);

  if (!greeting && !thanks && !identity && !howAreYou) return null;

  if (thanks) return "You're welcome! Anything else you'd like to explore in this dataset?";

  const intro =
    identity || howAreYou
      ? "I'm Ledgerly Copilot — your data assistant for this dataset. I'm doing well, thanks for asking! "
      : "Hi! I'm Ledgerly Copilot. ";

  return (
    intro +
    "I can compute real numbers from this dataset — ask me things like “what is our total revenue?”, " +
    "“show revenue trends by month”, “any strong correlations?” or “what are the data quality issues?”. " +
    "Every answer cites the formula, columns and row coverage behind each number, and if I can't compute something I'll say so instead of guessing."
  );
}

// ---------------------------------------------------------------------------
// Explanation builder (grounded — states what was and wasn't computed)
// ---------------------------------------------------------------------------

export function buildExplanation(
  request: string,
  matched: GroundedMetric[],
  actions: CopilotAction[],
  ctx: SchemaContext,
  counts: { analyzedRows: number; totalRows: number },
): string {
  const lines: string[] = [];

  if (matched.length > 0) {
    const top = matched[0]!;
    const coverage = Math.round(top.confidence * 100);
    lines.push(
      `From this dataset: **${top.metricName} = ${top.formattedValue}** (formula: ${top.formula}; columns: ${Object.values(top.resolvedColumns).join(", ")}) — computed over ${top.sampleSize.toLocaleString()} of ${top.totalRows.toLocaleString()} analysed rows (${coverage}% coverage).`,
    );
    if (matched.length > 1) {
      lines.push(
        `Also matched: ${matched
          .slice(1)
          .map((m) => `${m.metricName} = ${m.formattedValue}`)
          .join(" · ")}.`,
      );
    }
  } else {
    const colList =
      ctx.columns.length <= 8
        ? ctx.columns.map((c) => c.name).join(", ")
        : `${ctx.columns
            .slice(0, 8)
            .map((c) => c.name)
            .join(", ")}, +${ctx.columns.length - 8} more`;
    lines.push(
      `No governed metric matches “${request}”. This dataset has ${counts.totalRows.toLocaleString()} rows and these columns: ${colList}. You can still run the analyses below — every number they produce is computed from those real rows.`,
    );
  }

  if (actions.some((a) => a.config)) {
    lines.push("Pick a suggestion to run it against the real data — results open as a full analysis.");
  }

  return lines.join("\n\n");
}
