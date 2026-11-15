/**
 * Natural-language → notebook cell code (deterministic assistant).
 *
 * The copilot's `/llm <request>` flow translates a plain-language request
 * into a runnable DSL command against the notebook's real dataset schema.
 * Translation is deterministic and honest: keyword + column-name matching
 * over the known command set, no invented results. When ANTHROPIC_API_KEY is
 * set (see app/api/notebooks/[id]/ai/route.ts) the same request is sent to
 * Claude first, and this translator doubles as the validator that only known,
 * safe DSL commands ever execute.
 */

import type { ColumnDef } from "@/lib/types";

export interface DslTranslation {
  /** The runnable cell content (always a single % command). */
  code: string;
  /** Plain-language explanation of what the command computes. */
  explanation: string;
  /** True when a confident match was found. */
  matched: boolean;
  /** When unmatched: honest guidance for the user. */
  help?: string;
}

export const DSL_COMMANDS = [
  { command: "%help", description: "List all notebook commands" },
  { command: "%rows", description: "Preview the first rows of the dataset" },
  { command: "%columns", description: "Show the dataset schema" },
  { command: "%profile", description: "Data-quality overview of the dataset" },
  { command: "%describe", description: "Numeric statistics for one column" },
  { command: "%kpi", description: "Totals, averages and extremes of a metric" },
  { command: "%trend", description: "A metric over time (needs a date column)" },
  { command: "%corr", description: "Correlation between two numeric columns" },
  { command: "%histogram", description: "Distribution of one numeric column" },
  { command: "%sum", description: "Sum of a numeric column" },
  { command: "%average", description: "Average/mean of a numeric column" },
  { command: "%min", description: "Minimum value of a numeric column" },
  { command: "%max", description: "Maximum value of a numeric column" },
  { command: "%count", description: "Count of rows" },
  { command: "%unique", description: "Count of unique values in a column" },
  { command: "%top", description: "Top N values of a numeric column" },
] as const;

/** Whitelist of commands the assistant may generate (execution safety). */
export const EXECUTABLE_DSL_COMMANDS = new Set<string>(DSL_COMMANDS.map((c) => c.command));

/** Commands that require an argument (used for validation). */
const ARG_REQUIRED: Record<string, number> = {
  "%describe": 1,
  "%kpi": 1,
  "%trend": 1,
  "%corr": 2,
  "%histogram": 1,
  "%sum": 1,
  "%average": 1,
  "%min": 1,
  "%max": 1,
  "%count": 0,
  "%unique": 0,
  "%top": 1,
};

/** Reject anything that is not a single, known % command. */
export function isSafeDslCommand(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed.startsWith("%")) return false;
  const [command, ...args] = trimmed.split(/\s+/);
  const cmd = command?.toLowerCase() ?? "";
  if (!EXECUTABLE_DSL_COMMANDS.has(cmd)) return false;
  const required = ARG_REQUIRED[cmd] ?? 0;
  const argString = args.join(" ").trim();
  if (required > 0 && argString.length === 0) return false;
  if (required === 2 && (args.length ?? 0) < 2) return false;
  // No shell metacharacters / newlines: a single-line command only.
  if (trimmed.includes("\n")) return false;
  if (/[;&|`$]/.test(trimmed)) return false;
  return true;
}

const NUMERIC_RE = /\b(sum|total|totals?|mean|average|avg|kpi|min|max|minimum|maximum|count|value|metric)\b/i;
const DESCRIBE_RE = /(describe|statistics?|stats|distribution|spread)\b/i;
const HISTOGRAM_RE = /(histogram|bins?|frequency)\b/i;
const CORR_RE = /\b(correlat\w*|relat\w*|associat\w*)\b/i;
const TREND_RE = /(trend|over time|overtime|by month|by week|by day|by year|by quarter|evolution|timeline|series)\b/i;
const ROWS_RE = /(preview|first\s+\d+|top\s+\d+|show\s+(the\s+)?(rows|data)|head|rows?)\b/i;
const PROFILE_RE = /(profile|quality|overview|summary|completeness|missing|health)\b/i;
const SCHEMA_RE = /(columns?|schema|fields?|structure|headers?|names)\b/i;
const HELP_RE = /(help|commands?|what can|usage)\b/i;

function extractNumber(text: string): number | null {
  const match = /\d+/.exec(text);
  return match ? Math.max(1, Math.min(500, Number(match[0]))) : null;
}

function findColumn(text: string, columns: ColumnDef[]): string | null {
  for (const column of columns) {
    if (new RegExp(`\\b${escapeRegExp(column.name)}\\b`, "i").test(text)) return column.name;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a natural-language request into a single DSL command.
 * `columns` is the dataset schema (used to resolve column names).
 */
export function translateToDsl(request: string, columns: ColumnDef[]): DslTranslation {
  const text = request.trim();
  if (!text) {
    return {
      code: "",
      explanation: "",
      matched: false,
      help: "Describe what you want to compute, e.g. “average revenue” or “trend of sales by date”.",
    };
  }

  if (HELP_RE.test(text)) {
    return { code: "%help", explanation: "Lists every command this notebook kernel supports.", matched: true };
  }
  if (SCHEMA_RE.test(text) && !DESCRIBE_RE.test(text)) {
    return { code: "%columns", explanation: "Shows the dataset's columns and their inferred types.", matched: true };
  }
  if (PROFILE_RE.test(text)) {
    return {
      code: "%profile",
      explanation: "Runs a data-quality overview of the dataset (missing values, duplicates, column stats).",
      matched: true,
    };
  }

  const n = extractNumber(text);
  if (ROWS_RE.test(text)) {
    return {
      code: `%rows ${n ?? 20}`,
      explanation: `Previews the first ${n ?? 20} rows of the dataset.`,
      matched: true,
    };
  }

  const trendColumn = findColumn(text, columns);
  const isTrend = TREND_RE.test(text);
  if (isTrend && trendColumn) {
    // Look for a date-ish column to bucket by.
    const dateColumn = columns.find((c) => c.type === "date");
    return {
      code: `%trend ${trendColumn}${dateColumn ? ` by ${dateColumn.name}` : ""}`,
      explanation: dateColumn
        ? `Charts ${trendColumn} over time, bucketed by the ${dateColumn.name} date column.`
        : `Charts ${trendColumn} over time (no date column found — pass one explicitly, e.g. %trend ${trendColumn} by date).`,
      matched: true,
    };
  }

  if (CORR_RE.test(text)) {
    const numeric = columns.filter((c) => c.type === "number");
    const target = findColumn(text, columns);
    const others = numeric.filter((c) => c.name !== target);
    if (target && others[0]) {
      return {
        code: `%corr ${target} ${others[0].name}`,
        explanation: `Computes the Pearson correlation between ${target} and ${others[0].name}.`,
        matched: true,
      };
    }
    if (numeric.length >= 2) {
      return {
        code: `%corr ${numeric[0]!.name} ${numeric[1]!.name}`,
        explanation: `Computes the Pearson correlation between ${numeric[0]!.name} and ${numeric[1]!.name}.`,
        matched: true,
      };
    }
    return {
      code: "",
      explanation: "",
      matched: false,
      help: "Correlation needs at least two numeric columns — pick a request like “correlation between revenue and costs”.",
    };
  }

  const isHistogram = HISTOGRAM_RE.test(text);
  if (isHistogram && trendColumn) {
    return {
      code: `%histogram ${trendColumn}`,
      explanation: `Plots the distribution of ${trendColumn} with a histogram.`,
      matched: true,
    };
  }

  if (trendColumn && (DESCRIBE_RE.test(text) || isHistogram)) {
    return {
      code: `%describe ${trendColumn}`,
      explanation: `Computes numeric statistics (mean, quartiles, extremes) for ${trendColumn}.`,
      matched: true,
    };
  }

  if (trendColumn && (NUMERIC_RE.test(text) || isTrend)) {
    const isAverage = /\b(mean|average|avg)\b/i.test(text);
    return {
      code: isAverage ? `%describe ${trendColumn}` : `%kpi ${trendColumn}`,
      explanation: isAverage
        ? `Computes statistics including the average for ${trendColumn}.`
        : `Computes total, mean, count, min and max for ${trendColumn}.`,
      matched: true,
    };
  }

  const countColumn = findColumn(text, columns);
  if (text.includes("unique") || text.includes("distinct")) {
    if (countColumn) {
      return {
        code: `%unique ${countColumn}`,
        explanation: `Counts the number of unique values in ${countColumn}.`,
        matched: true,
      };
    }
    return {
      code: "%unique",
      explanation: "Counts the number of unique values in the dataset.",
      matched: true,
    };
  }

  if (/%top\s+\d+/i.test(text)) {
    const match = text.match(/%top\s+(\d+)/i);
    const n = match ? Math.max(1, Math.min(1000, parseInt(match[1]!, 10))) : 10;
    const topCol = findColumn(text, columns);
    if (topCol) {
      return {
        code: `%top ${n} ${topCol}`,
        explanation: `Shows the top ${n} values of ${topCol}.`,
        matched: true,
      };
    }
  }

  if (/%top\b/i.test(text)) {
    const topCol = findColumn(text, columns);
    if (topCol) {
      return {
        code: `%top 10 ${topCol}`,
        explanation: `Shows the top 10 values of ${topCol}.`,
        matched: true,
      };
    }
    // Fallback to first numeric column if no column mentioned
    const firstNumeric = columns.find((c) => c.type === "number");
    if (firstNumeric) {
      return {
        code: `%top 10 ${firstNumeric.name}`,
        explanation: `Shows the top 10 values of ${firstNumeric.name}.`,
        matched: true,
      };
    }
  }

  if (ROWS_RE.test(text)) {
    const n = extractNumber(text) ?? 10;
    return {
      code: `%rows ${n}`,
      explanation: `Previews the first ${n} rows of the dataset.`,
      matched: true,
    };
  }

  return {
    code: "",
    explanation: "",
    matched: false,
    help: `I couldn't map that to a command. I can: ${DSL_COMMANDS.map((c) => c.command).join(", ")}. Try e.g. “sum of ${columns[0]?.name ?? "revenue"}”, “average of ${columns[0]?.name ?? "revenue"}”, or “show the first 10 rows”.`,
  };
}

/**
 * System prompt for the optional live-LLM path. The model is asked to return
 * exactly one DSL command; the response is validated with isSafeDslCommand
 * before execution, so a bad answer degrades to the deterministic path.
 */
export function buildLlmPrompt(request: string, columns: ColumnDef[], datasetName: string): string {
  return [
    `You are the notebook assistant inside Ledgerly, a data workspace.`,
    `The active dataset is “${datasetName}” with columns: ${columns.map((c) => `${c.name} (${c.type})`).join(", ")}.`,
    `Answer the user's request by returning EXACTLY ONE line of notebook DSL code — nothing else, no markdown, no explanation.`,
    `Available commands:`,
    ...DSL_COMMANDS.map((c) => `  ${c.command} <args> — ${c.description}`),
    `Use the real column names from the list above.`,
    `User request: ${request.slice(0, 500)}`,
  ].join("\n");
}
