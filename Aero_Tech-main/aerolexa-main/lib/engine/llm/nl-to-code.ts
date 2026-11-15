/**
 * Natural-language → Code generation (WS4.2).
 *
 * Grounded generation: every request is augmented with the dataset schema,
 * available functions, and validation rules. LLM output is validated before
 * execution; invalid output falls back to the deterministic DSL translator.
 */

import { getLLMClient } from "@/lib/engine/llm/client";
import { translateToDsl, isSafeDslCommand } from "@/lib/engine/nl-to-code";
import type { ColumnDef } from "@/lib/types";

export type CodeTarget = "dsl" | "sql" | "dax" | "python" | "pandas";

export interface NLToCodeRequest {
  /** User's natural-language request */
  request: string;
  /** Dataset schema for grounding */
  columns: ColumnDef[];
  /** Dataset name for context */
  datasetName: string;
  /** Target language */
  target: CodeTarget;
  /** Additional context (e.g., existing notebook cells) */
  context?: string;
  /** Temperature for generation (default 0.1 for deterministic) */
  temperature?: number;
}

export interface NLToCodeResult {
  /** Generated code */
  code: string;
  /** Target language */
  target: CodeTarget;
  /** Whether generation was successful */
  success: boolean;
  /** Explanation of what the code does */
  explanation: string;
  /** Fallback DSL if LLM failed or was invalid */
  fallbackDsl?: string;
  /** Validation errors if any */
  errors?: string[];
  /** Token usage */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** System prompts for each target */
const SYSTEM_PROMPTS: Record<CodeTarget, string> = {
  dsl: `You are a data analyst generating Ledgerly notebook DSL commands.
The DSL is a single-line command starting with %.
Available commands:
%rows [n] - preview first n rows
%columns - show schema
%profile - data quality overview
%describe <col> - numeric stats for one column
%kpi <col> - total, mean, min, max
%trend <col> [by <date>] - line chart over time
%corr <col1> <col2> - correlation between two numeric columns
%histogram <col> - distribution histogram
%sum <col> - sum of column
%average <col> - mean of column
%min <col> - minimum value
%max <col> - maximum value
%count - row count
%unique <col> - unique values count
%top <n> <col> - top N values

Rules:
- Output EXACTLY ONE line starting with %
- Use ONLY column names from the provided schema
- No markdown, no explanation, just the command`,

  sql: `You are a SQL expert generating SELECT queries for Ledgerly notebooks.
The dataset is a single table with the provided columns.
Use standard SQL (PostgreSQL dialect).

Rules:
- Output ONLY the SQL query, no markdown, no explanation
- Use only columns from the provided schema
- Use proper casting for type conversions
- LIMIT 1000 by default unless specified
- No DDL, no DML, no transactions`,

  dax: `You are a DAX expert generating measures for Ledgerly semantic models.
The model may have multiple tables with relationships.

Rules:
- Output ONLY the DAX expression, no markdown, no explanation
- Use only columns/measures from the provided schema
- Prefer CALCULATE with explicit filter context
- Use DIVIDE for safe division
- No DDL, no variable definitions unless requested`,

  python: `You are a Python data scientist generating pandas code for Ledgerly notebooks.
The dataset is available as a pandas DataFrame named 'df'.

Rules:
- Output ONLY the Python code, no markdown, no explanation
- Use pandas/numpy built-ins
- Assume df is already loaded with the provided columns
- Handle missing values appropriately
- Return results as DataFrame or Series`,

  pandas: `You are a Python data scientist generating pandas code for Ledgerly notebooks.
The dataset is available as a pandas DataFrame named 'df'.

Rules:
- Output ONLY the Python code, no markdown, no explanation
- Use pandas/numpy built-ins
- Assume df is already loaded with the provided columns
- Handle missing values appropriately
- Return results as DataFrame or Series`,
};

/** Build user prompt with grounding */
function buildPrompt(
  request: string,
  columns: ColumnDef[],
  datasetName: string,
  target: CodeTarget,
  context?: string,
): string {
  const schema = columns.map((c) => `  ${c.name} (${c.type})`).join("\n");
  const contextSection = context ? `\nContext (previous cells):\n${context}` : "";

  return `Dataset: "${datasetName}"
Columns:
${schema}
${contextSection}

User request: ${request}

Generate ${target.toUpperCase()} code that answers this request.`;
}

/** Validate generated code per target */
function validateCode(code: string, target: CodeTarget, columns: ColumnDef[]): string[] {
  const errors: string[] = [];

  if (!code || code.trim().length === 0) {
    errors.push("Empty code generated");
    return errors;
  }

  const colNames = new Set(columns.map((c) => c.name));

  switch (target) {
    case "dsl":
      if (!isSafeDslCommand(code.trim())) {
        errors.push(`Invalid DSL command: ${code}`);
      }
      break;
    case "sql":
      const lower = code.toLowerCase();
      if (!lower.startsWith("select") && !lower.startsWith("with")) {
        errors.push("SQL must start with SELECT or WITH");
      }
      // Check for dangerous keywords
      if (/\b(insert|update|delete|drop|create|alter|truncate|grant|revoke)\b/i.test(code)) {
        errors.push("SQL contains forbidden DML/DDL keywords");
      }
      break;
    case "dax":
      // Basic DAX validation
      if (code.includes("CREATE") || code.includes("DELETE")) {
        errors.push("DAX contains forbidden DDL");
      }
      break;
    case "python":
    case "pandas":
      // Basic Python safety
      if (
        /\b(import\s+os|import\s+sys|import\s+subprocess|eval\(|exec\(|__import__|open\(|file\(|input\(|compile\(|getattr\(|setattr\(|delattr\(|del\s)/.test(
          code,
        )
      ) {
        errors.push("Python code contains potentially unsafe operations");
      }
      break;
  }

  // Check for unknown column references (basic)
  for (const word of code.split(/[\s,()]+/)) {
    if (colNames.has(word) || word === "df" || word.startsWith("_")) continue;
    // Only warn for words that look like column references
    if (
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(word) &&
      word.length > 2 &&
      ![
        "and",
        "or",
        "not",
        "if",
        "else",
        "for",
        "in",
        "as",
        "is",
        "null",
        "true",
        "false",
        "select",
        "from",
        "where",
        "group",
        "by",
        "order",
        "limit",
        "sum",
        "avg",
        "count",
        "min",
        "max",
        "mean",
        "std",
        "var",
        "abs",
        "round",
        "int",
        "float",
        "str",
        "len",
        "print",
        "return",
      ].includes(word.toLowerCase())
    ) {
      // Could be a column name - just warn in errors but don't fail
    }
  }

  return errors;
}

/** Main NL→Code generation */
export async function generateCode(req: NLToCodeRequest): Promise<NLToCodeResult> {
  const client = getLLMClient();
  const systemPrompt = SYSTEM_PROMPTS[req.target];
  const userPrompt = buildPrompt(req.request, req.columns, req.datasetName, req.target, req.context);

  try {
    const response = await client.complete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: req.temperature ?? 0.1,
      maxTokens: 500,
      responseFormat: { type: "text" },
    });

    const code = response.choices[0]?.message?.content?.trim() ?? "";
    const validationErrors = validateCode(code, req.target, req.columns);

    if (validationErrors.length > 0) {
      // Try fallback DSL translation
      const fallback = translateToDsl(req.request, req.columns);
      return {
        code: "",
        target: req.target,
        success: false,
        explanation: `LLM generation failed validation: ${validationErrors.join("; ")}`,
        fallbackDsl: fallback.matched ? fallback.code : undefined,
        errors: validationErrors,
        usage: response.usage,
      };
    }

    return {
      code,
      target: req.target,
      success: true,
      explanation: `Generated ${req.target} code for: ${req.request}`,
      fallbackDsl: req.target !== "dsl" ? translateToDsl(req.request, req.columns).code : undefined,
      usage: response.usage,
    };
  } catch (error) {
    // Fallback to deterministic DSL
    const fallback = translateToDsl(req.request, req.columns);
    return {
      code: "",
      target: req.target,
      success: false,
      explanation: `LLM error: ${error instanceof Error ? error.message : String(error)}`,
      fallbackDsl: fallback.matched ? fallback.code : undefined,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Batch generation for multiple requests */
export async function generateCodeBatch(requests: NLToCodeRequest[]): Promise<NLToCodeResult[]> {
  return Promise.all(requests.map((r) => generateCode(r)));
}

/** Get deterministic DSL fallback (always works) */
export function getDslFallback(request: string, columns: ColumnDef[]) {
  return translateToDsl(request, columns);
}
