/**
 * Deterministic natural-language → pandas translation.
 *
 * The copilot's honesty contract: a live model is OPTIONAL. When none is
 * configured (or its answer fails the safety gate) this translator produces
 * real, runnable pandas from keyword + schema matching — the same approach as
 * the DSL translator (lib/engine/nl-to-code.ts) one level up. Generated code
 * always passes the Python safety gate before execution, and the UI labels
 * which path produced the cell ("llm" | "deterministic-pandas" | "dsl").
 *
 * The generated code operates on `df` (the notebook's dataset) and ends with
 * an expression or print() so the kernel captures a result.
 */
import type { ColumnDef } from "@/lib/types";

export interface PandasTranslation {
  code: string;
  explanation: string;
  matched: boolean;
  help?: string;
}

const AGG_RE =
  /\b(sum|total|totals|mean|average|avg|median|min|max|minimum|maximum|count|std|stddev|standard deviation|variance|nunique|unique)\b/i;
const GROUP_RE = /\b(by|per|grouped by|for each|across)\b/i;
const TREND_RE = /\b(trend|over time|by month|by week|by day|by quarter|by year|timeline|time series|evolution)\b/i;
const SORT_RE = /\b(sort|rank|order(ed)? by|top \d+|bottom \d+|largest|smallest|highest|lowest|best|worst)\b/i;
const HEAD_RE = /\b(preview|first|show|head|sample|rows)\b/i;
const DESCRIBE_RE =
  /\b(describe|statistics|stats|summary|summarize|distribution|spread|profile|quality|missing|overview)\b/i;
const CORR_RE = /\b(correlat\w*|relat\w*|associat\w*)\b/i;

function esc(name: string): string {
  return JSON.stringify(name);
}

function findColumns(text: string, columns: ColumnDef[]): ColumnDef[] {
  const found: ColumnDef[] = [];
  for (const column of columns) {
    if (new RegExp(`\\b${column.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
      found.push(column);
    }
  }
  return found;
}

function aggFor(text: string): string {
  if (/\b(sum|total|totals)\b/i.test(text)) return "sum";
  if (/\b(mean|average|avg)\b/i.test(text)) return "mean";
  if (/\bmedian\b/i.test(text)) return "median";
  if (/\bmin|minimum\b/i.test(text)) return "min";
  if (/\bmax|maximum\b/i.test(text)) return "max";
  if (/\bstd|stddev|standard deviation\b/i.test(text)) return "std";
  if (/\bvariance\b/i.test(text)) return "var";
  if (/\b(nunique|distinct|unique)\b/i.test(text)) return "nunique";
  return "count";
}

function extractNumber(text: string, fallback: number): number {
  const match = /(\d+)/.exec(text);
  return match ? Math.max(1, Math.min(1000, Number(match[1]))) : fallback;
}

// ---------------------------------------------------------------------------
// Filter predicates: "where region is East", "revenue above 1000", …
// ---------------------------------------------------------------------------

export interface FilterSpec {
  column: string;
  op: "eq" | "neq" | "gt" | "lt" | "gte" | "lte";
  value: string;
  /** Python mask lines that define `f_df` from `df`. */
  mask: string;
  /** Plain-language description for the explanation line. */
  describe: string;
}

const OP_WORDS: [RegExp, FilterSpec["op"], string][] = [
  [/^(>=|at least|no less than)$/i, "gte", ">="],
  [/^(<=|at most|no more than)$/i, "lte", "<="],
  [/^(>|greater than|more than|above|over|exceeding)$/i, "gt", ">"],
  [/^(<|less than|fewer than|below|under)$/i, "lt", "<"],
  [/^(is not|isn't|!=|not equal to)$/i, "neq", "!="],
  [/^(==|=|is|equals|equal to)$/i, "eq", "=="],
];

const NUM_VALUE_RE = /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$|^-?\d+(?:\.\d+)?%?$/;

/**
 * Pull ONE filter predicate out of the request (the first column/op/value
 * match). Returns the remaining text with the filter clause removed so the
 * rest of the translator can still match ("top 5 products where region is
 * East" → filter on region + the top-5 branch on the rest).
 */
export function extractFilter(text: string, columns: ColumnDef[]): { filter: FilterSpec | null; rest: string } {
  for (const column of columns) {
    const colRe = column.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // OP_WORDS regexes are anchored (^…$) for standalone validation — strip
    // the anchors before joining them into one alternation, otherwise the
    // anchors sit mid-pattern where nothing can ever match. Inner groups are
    // made non-capturing so group indices stay stable (group 1 = op, 2 = value).
    const opAlternation = OP_WORDS.map(([re]) =>
      re.source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\((?!\?)/g, "(?:"),
    ).join("|");
    // "[rows] where <col> <op> <value>" or "<col> <op> <value>" — the leading
    // "rows" belongs to the filter clause ("show rows where region is East").
    const m = new RegExp(
      `(?:\\brows?\\b\\s+)?(?:\\bwhere\\s+)?\\b${colRe}\\s+(${opAlternation})\\s+([^;\n]+)`,
      "i",
    ).exec(text);
    if (!m) continue;
    const opWord = m[1]!.trim();
    const opEntry = OP_WORDS.find(([re]) => re.test(opWord));
    if (!opEntry) continue;
    const rawValue = (m[2] ?? "").trim();
    const opName = opEntry[1];
    const pyOp = opEntry[2];
    // Cut the value at clause boundaries: "East then sort", "East and year is
    // 2024", "East, sum of revenue". Commas INSIDE numbers ("1,000") survive:
    // the split only fires on a comma followed by whitespace.
    const value = rawValue
      .split(/\s*(?:\bthen\b|\band\b|,|;|\.)\s+|\s+(?:then|;),?\s*/i)[0]!
      .replace(/[.。]+$/, "")
      .trim();
    if (!value) continue;
    const quoted = /^["'](.*)["']$/.exec(value);
    const bare = (quoted ? quoted[1]! : value).trim();
    // Keep any trailing clause ("… is East and year > 2023") so chained
    // filters survive: shrink the consumed span by whatever the value split
    // discarded, then drop a dangling connective.
    const consumed = m[0].length - Math.max(0, rawValue.length - value.length);
    const rest = (text.slice(0, m.index) + " " + text.slice((m.index ?? 0) + consumed))
      .replace(/\s*(?:\band\b|\bthen\b|,)\s*$/i, " ")
      .replace(/\s+where\s*$/i, " ")
      .trim();
    const isNumeric = NUM_VALUE_RE.test(bare);
    const isBool = /^(true|false)$/i.test(bare);
    let mask: string;
    let pyValue: string;
    if (isBool) {
      pyValue = /^true$/i.test(bare) ? "True" : "False";
      mask = `f_df = df[df[${JSON.stringify(column.name)}] ${pyOp} ${pyValue}]`;
    } else if (isNumeric) {
      const n = bare.replace(/,/g, "").replace(/%$/, "");
      mask = `f_df = df[pd.to_numeric(df[${JSON.stringify(column.name)}], errors="coerce") ${pyOp} ${n}]`;
    } else {
      mask = `f_df = df[df[${JSON.stringify(column.name)}] ${pyOp} ${JSON.stringify(bare)}]`;
    }
    return {
      filter: { column: column.name, op: opName, value: bare, mask, describe: `${column.name} ${opWord} ${bare}` },
      rest,
    };
  }
  return { filter: null, rest: text };
}

/**
 * Apply 1..3 AND-composed filters to a generated core translation.
 *
 * The FIRST predicate defines f_df from df; each subsequent predicate filters
 * the PREVIOUS frame (f_df → f_df2 → f_df3) — conjunctive predicates in
 * pandas. The core code then reads the LAST frame. With one filter this is
 * byte-identical to the original single-filter behaviour.
 */
function applyFilters(core: PandasTranslation, filters: FilterSpec[]): PandasTranslation {
  const first = filters[0]!;
  const masks: string[] = [first.mask];
  let frame = "f_df";
  for (let i = 1; i < filters.length; i++) {
    const next = `f_df${i + 1}`;
    // The mask body is `… = df[<expr>]`: rename the assigned frame AND swap
    // the predicate's inner frame reference to the previous mask's frame so
    // chained predicates filter the filtered frame (pd.to_numeric(df[…] …)
    // becomes pd.to_numeric(f_df[…] …)).
    masks.push(filters[i]!.mask.replace(/^f_df = /, `${next} = `).replace(/(?<![\w])df(?![\w])/g, frame));
    frame = next;
  }
  const describe = filters.map((f) => f.describe).join(" AND ");
  if (!core.matched) {
    return {
      code: `${masks.join("\n")}\n\n${frame}.head(20)`,
      explanation: `Rows where ${describe} (first 20).`,
      matched: true,
    };
  }
  // The generated code only ever references the frame as the whole word `df`.
  const code = `${masks.join("\n")}\n\n${core.code.replace(/\bdf\b/g, frame)}`;
  return { ...core, code, explanation: `${core.explanation} Filtered: ${describe}.` };
}

/**
 * Translate a plain-language analytics request into safe pandas code.
 * Every branch uses real column names from the schema — the generator never
 * invents columns, and unmatched requests fail with guidance instead of guessing.
 *
 * CHAINED FILTERS: up to 3 predicates are extracted ("region is East and
 * revenue above 500 and units at least 5") and AND-composed into consecutive
 * masks — each mask filters the previous frame (f_df → f_df2 → f_df3), the
 * exact pandas idiom for conjunctive predicates. The help text is honest
 * about the cap; OR / NOT require Python directly.
 */
export function translateToPandas(request: string, columns: ColumnDef[]): PandasTranslation {
  const text = request.trim();
  if (!text) {
    return {
      code: "",
      explanation: "",
      matched: false,
      help: "Describe what you want, e.g. “sum of revenue by region”.",
    };
  }

  const mentioned = findColumns(text, columns);
  const numericCols = columns.filter((c) => c.type === "number");
  const dateCols = columns.filter((c) => c.type === "date");
  const metric = mentioned.find((c) => c.type === "number") ?? mentioned[0] ?? numericCols[0];
  const dimension = mentioned.find((c) => c.type === "string" && c.name !== metric?.name);
  const dateCol = mentioned.find((c) => c.type === "date") ?? dateCols[0];
  // A mentioned string column can be the count/dimension even when it also
  // became the default metric ("count of each region" names no numeric).
  const countDimension = dimension ?? (metric?.type === "string" ? metric : undefined);

  // Filters first: every predicate is stripped ("… where A and B" leaves the
  // core request in `rest`), the core translation runs on the remainder, and
  // the masks AND-compose onto its frame swap.
  const MAX_FILTERS = 3;
  let remaining = text;
  const filters: FilterSpec[] = [];
  while (filters.length < MAX_FILTERS) {
    const step = extractFilter(remaining, columns);
    if (!step.filter) break;
    filters.push(step.filter);
    remaining = step.rest;
  }
  if (filters.length > 0) {
    // A 4th predicate means the user asked for more than we compose — stay
    // honest instead of silently dropping it.
    if (extractFilter(remaining, columns).filter !== null) {
      return {
        code: "",
        explanation: "",
        matched: false,
        help: `The translator composes at most ${MAX_FILTERS} AND-ed filters; this request has more (or an OR/NOT clause). Write a Python cell directly for complex logic.`,
      };
    }
    const core = translateToPandas(remaining, columns);
    return applyFilters(core, filters);
  }

  // Value counts / distinct counts on any column ("count of each region").
  if (/\b(count of each|value counts?|count per|frequency of|distribution of each)\b/i.test(text) && countDimension) {
    return {
      code: `df[${esc(countDimension.name)}].value_counts().head(25)`,
      explanation: `Row counts per value of ${countDimension.name} (top 25).`,
      matched: true,
    };
  }
  if (/\b(distinct|unique values|list of unique)\b/i.test(text) && countDimension) {
    return {
      code: `sorted(df[${esc(countDimension.name)}].dropna().unique().tolist())`,
      explanation: `Distinct values of ${countDimension.name}.`,
      matched: true,
    };
  }

  // 1. Schema / quality overviews
  if (/\b(schema|columns|fields|structure)\b/i.test(text) && !DESCRIBE_RE.test(text)) {
    return {
      code: `df.dtypes.to_frame("dtype")`,
      explanation: "Lists every column with its inferred dtype.",
      matched: true,
    };
  }
  if (/\b(missing|nulls?|nan|quality|completeness)\b/i.test(text)) {
    return {
      code: `pd.DataFrame({\n    "missing": df.isna().sum(),\n    "missing_pct": (df.isna().mean() * 100).round(2),\n})`,
      explanation: "Counts missing values per column, absolute and as a percentage.",
      matched: true,
    };
  }
  if (DESCRIBE_RE.test(text) && !metric) {
    return {
      code: `df.describe(include="all").T`,
      explanation: "Summary statistics for every column (count, mean, quartiles, extremes).",
      matched: true,
    };
  }

  // 2. Correlation between two mentioned numeric columns
  if (CORR_RE.test(text)) {
    const pair = mentioned.filter((c) => c.type === "number");
    if (pair.length >= 2) {
      const [a, b] = pair as [ColumnDef, ColumnDef];
      return {
        code: `from scipy import stats\n\nx = pd.to_numeric(df[${esc(a.name)}], errors="coerce")\ny = pd.to_numeric(df[${esc(b.name)}], errors="coerce")\nmask = x.notna() & y.notna()\nr, p = stats.pearsonr(x[mask], y[mask])\n{"r": round(float(r), 4), "p_value": round(float(p), 6), "n": int(mask.sum())}`,
        explanation: `Pearson correlation between ${a.name} and ${b.name} with its p-value (scipy.stats.pearsonr).`,
        matched: true,
      };
    }
    return {
      code: `df.select_dtypes("number").corr().round(4)`,
      explanation: "Correlation matrix of all numeric columns (no pair specified).",
      matched: true,
    };
  }

  // 3. Trend: metric over a date column
  if (TREND_RE.test(text) && metric && dateCol) {
    return {
      code: `period = pd.to_datetime(df[${esc(dateCol.name)}], errors="coerce").dt.to_period("M")\nseries = df.groupby(period)[${esc(metric.name)}].sum()\nseries.index = series.index.astype(str)\nseries`,
      explanation: `Sum of ${metric.name} per month bucketed from ${dateCol.name}.`,
      matched: true,
    };
  }

  // 4. Grouped aggregation: "<agg> of metric by dimension"
  if (metric && dimension && AGG_RE.test(text) && GROUP_RE.test(text)) {
    const agg = aggFor(text);
    const nTop = extractNumber(text, 15);
    return {
      code: `(df.groupby(${esc(dimension.name)})[${esc(metric.name)}]\n   .${agg === "var" ? "var" : agg}()\n   .sort_values(ascending=False)\n   .head(${nTop})\n   .round(4))`,
      explanation: `${agg} of ${metric.name} grouped by ${dimension.name}, largest first (top ${nTop}).`,
      matched: true,
    };
  }

  // 5. Simple aggregation of one metric
  if (metric && AGG_RE.test(text)) {
    const agg = aggFor(text);
    if (agg === "nunique") {
      return {
        code: `int(df[${esc(metric.name)}].nunique())`,
        explanation: `Number of distinct values in ${metric.name}.`,
        matched: true,
      };
    }
    const series = `pd.to_numeric(df[${esc(metric.name)}], errors="coerce").dropna()`;
    const expr =
      agg === "sum"
        ? `${series}.sum()`
        : agg === "mean"
          ? `${series}.mean()`
          : agg === "median"
            ? `${series}.median()`
            : agg === "min"
              ? `${series}.min()`
              : agg === "max"
                ? `${series}.max()`
                : agg === "std"
                  ? `${series}.std()`
                  : agg === "var"
                    ? `${series}.var()`
                    : `df[${esc(metric.name)}].count()`;
    return {
      code: `round(float(${expr}), 4)`,
      explanation: `${agg} of ${metric.name} computed over its non-missing values.`,
      matched: true,
    };
  }

  // 6. Sorting / ranking
  if (SORT_RE.test(text) && metric) {
    const n = extractNumber(text, 10);
    const ascending = /\b(bottom|smallest|lowest|worst|ascending)\b/i.test(text);
    return {
      code: `(df.sort_values(${esc(metric.name)}, ascending=${ascending})\n   [[${[metric.name, ...(dimension ? [dimension.name] : [])].map(esc).join(", ")}]]\n   .head(${n}))`,
      explanation: `Top ${n} rows by ${metric.name}${ascending ? " (ascending)" : ""}${dimension ? `, showing ${dimension.name}` : ""}.`,
      matched: true,
    };
  }

  // 7. Row preview
  if (HEAD_RE.test(text) || /\brows?\b/i.test(text)) {
    const n = extractNumber(text, 10);
    return {
      code: `df.head(${n})`,
      explanation: `First ${n} rows of the dataset.`,
      matched: true,
    };
  }

  // 8. Full describe as the final catch-all when a real column was named or
  // an explicit aggregation was requested — never on an arbitrary sentence
  // that merely inherited the numeric-column fallback.
  if (metric && (mentioned.length > 0 || AGG_RE.test(text))) {
    return {
      code: `pd.to_numeric(df[${esc(metric.name)}], errors="coerce").describe().round(4)`,
      explanation: `Summary statistics for ${metric.name}.`,
      matched: true,
    };
  }

  return {
    code: "",
    explanation: "",
    matched: false,
    help: `I could not map that to pandas. Try naming a column: e.g. “sum of ${numericCols[0]?.name ?? "revenue"} by ${columns.find((c) => c.type === "string")?.name ?? "region"}”, “trend of sales over time”, “rows where ${columns[0]?.name ?? "region"} is East”, or “missing values”.`,
  };
}

/**
 * System prompt for the live-LLM Python path. The model must answer with one
 * pandas cell operating on `df`; the safety gate + real execution validate it.
 */
export function buildPandasLlmPrompt(request: string, columns: ColumnDef[], datasetName: string): string {
  return [
    `You are the Python copilot inside Ledgerly, a self-hosted analytics workspace.`,
    `The active dataset is "${datasetName}" loaded as a pandas DataFrame named df with columns:`,
    ...columns.map((c) => `  - ${c.name} (${c.type})`),
    ``,
    `Return EXACTLY ONE short pandas snippet (no markdown fences, no prose) that computes the user's request.`,
    `Rules:`,
    `- Use only df, pandas as pd, numpy as np, and scipy/sklearn/statsmodels imports if needed.`,
    `- Never invent columns. Use the column names above verbatim.`,
    `- End with an expression or print() so the result is visible.`,
    `- No file I/O, no network, no os/subprocess — the kernel has no filesystem or sockets.`,
    ``,
    `User request: ${request.slice(0, 500)}`,
  ].join("\n");
}
