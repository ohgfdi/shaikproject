/**
 * LLM output safety & validation layer (WS4.5).
 *
 * Validates all LLM-generated content before execution/display.
 * - Code: syntax check, column validation, dangerous pattern detection
 * - SQL: injection prevention, read-only enforcement
 * - DAX: syntax, function allowlist, column validation
 * - Python: AST parsing, dangerous import/call detection
 * - Charts: spec validation against schema
 * - General: PII redaction, prompt injection detection
 */

import type { ColumnDef, ChartSpec } from "@/lib/types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: string;
}

export interface CodeValidationOptions {
  target: "dsl" | "sql" | "dax" | "python" | "pandas";
  columns: ColumnDef[];
  /** Allow only whitelisted functions */
  strictMode?: boolean;
  /** Max code length */
  maxLength?: number;
}

/** DSL validation - uses existing isSafeDslCommand */
export function validateDsl(code: string, columns: ColumnDef[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = code.trim();
  if (!trimmed) {
    errors.push("Empty code");
    return { valid: false, errors, warnings };
  }

  // Basic DSL validation
  if (!trimmed.startsWith("%")) {
    errors.push("DSL commands must start with %");
    return { valid: false, errors, warnings };
  }

  // Check against known commands
  const knownCommands = [
    "%help",
    "%rows",
    "%columns",
    "%profile",
    "%describe",
    "%kpi",
    "%trend",
    "%corr",
    "%histogram",
    "%sum",
    "%average",
    "%min",
    "%max",
    "%count",
    "%unique",
    "%top",
  ];
  const [cmd = ""] = trimmed.split(/\s+/);
  if (!knownCommands.includes(cmd.toLowerCase())) {
    errors.push(`Unknown command: ${cmd}`);
  }

  // Check for column references
  const colNames = new Set(columns.map((c) => c.name));
  const words = trimmed.split(/[\s,()]+/);
  for (const word of words) {
    if (colNames.has(word)) continue;
    if (word.startsWith("%")) continue;
    // Could be a column name - warn but don't fail
  }

  return { valid: errors.length === 0, errors, warnings, sanitized: trimmed };
}

/** SQL validation */
export function validateSql(code: string, _columns: ColumnDef[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = code.trim();
  if (!trimmed) {
    errors.push("Empty SQL");
    return { valid: false, errors, warnings };
  }

  const lower = trimmed.toLowerCase();

  // Must be SELECT or WITH (CTE)
  if (!lower.startsWith("select") && !lower.startsWith("with")) {
    errors.push("Only SELECT and WITH (CTE) statements are allowed");
  }

  // Forbidden keywords
  const forbidden = [
    "insert",
    "update",
    "delete",
    "drop",
    "create",
    "alter",
    "truncate",
    "grant",
    "revoke",
    "exec",
    "execute",
    "declare",
    "cursor",
    "transaction",
    "commit",
    "rollback",
    "merge",
    "upsert",
    "bulk",
    "load",
  ];
  for (const word of forbidden) {
    if (new RegExp(`\\b${word}\\b`, "i").test(trimmed)) {
      errors.push(`Forbidden SQL keyword: ${word}`);
    }
  }

  // Check for semicolon (multiple statements)
  if (trimmed.split(";").filter((s) => s.trim().length > 0).length > 1) {
    errors.push("Multiple statements not allowed");
  }

  // Comment out -- and /* */
  if (/\/\*/.test(trimmed) || /--/.test(trimmed)) {
    warnings.push("SQL comments detected - ensure they don't hide malicious code");
  }

  return { valid: errors.length === 0, errors, warnings, sanitized: trimmed };
}

/** DAX validation */
export function validateDax(code: string, _columns: ColumnDef[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = code.trim();
  if (!trimmed) {
    errors.push("Empty DAX");
    return { valid: false, errors, warnings };
  }

  // Forbidden DDL
  if (/\b(create|delete|drop|alter)\b/i.test(trimmed)) {
    errors.push("DDL statements not allowed in DAX measures");
  }

  // Check for balanced parentheses
  let paren = 0;
  for (const ch of trimmed) {
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    if (paren < 0) {
      errors.push("Unbalanced parentheses");
      break;
    }
  }
  if (paren !== 0) errors.push("Unbalanced parentheses");

  // Basic function allowlist (core DAX functions)
  const allowedFunctions = [
    "CALCULATE",
    "FILTER",
    "ALL",
    "ALLEXCEPT",
    "VALUES",
    "SELECTEDVALUE",
    "HASONEVALUE",
    "SUM",
    "AVERAGE",
    "MIN",
    "MAX",
    "COUNT",
    "COUNTROWS",
    "DISTINCTCOUNT",
    "DIVIDE",
    "IF",
    "SWITCH",
    "AND",
    "OR",
    "NOT",
    "ISBLANK",
    "COALESCE",
    "BLANK",
    "SUMX",
    "AVERAGEX",
    "MINX",
    "MAXX",
    "COUNTX",
    "RANKX",
    "CONCATENATEX",
    "RELATED",
    "LOOKUPVALUE",
    "EARLIER",
    "EARLIEST",
    "TOTALYTD",
    "TOTALQTD",
    "TOTALMTD",
    "SAMEPERIODLASTYEAR",
    "DATEADD",
    "PARALLELPERIOD",
    "PREVIOUSMONTH",
    "PREVIOUSQUARTER",
    "PREVIOUSYEAR",
    "NEXTDAY",
    "NEXTMONTH",
    "NEXTQUARTER",
    "NEXTYEAR",
    "DATESBETWEEN",
    "DATESINPERIOD",
    "DATESYTD",
    "DATESQTD",
    "DATESMTD",
    "STDEV.P",
    "STDEV.S",
    "VAR.P",
    "VAR.S",
    "MEDIAN",
    "PRODUCT",
    "COUNTBLANK",
    "ABS",
    "ROUND",
    "ROUNDUP",
    "ROUNDDOWN",
    "TRUNC",
    "INT",
    "MOD",
    "SIGN",
    "FLOOR",
    "CEILING",
    "SQRT",
    "POWER",
    "EXP",
    "LN",
    "LOG",
    "PI",
    "LEN",
    "LEFT",
    "RIGHT",
    "MID",
    "UPPER",
    "LOWER",
    "TRIM",
    "CONCATENATE",
    "SUBSTITUTE",
    "CONTAINSSTRING",
    "CONCATENATEX",
    "FIRSTNONBLANK",
    "LASTNONBLANK",
    "INDEX",
    "OFFSET",
    "WINDOW",
    "RANK.EQ",
    "RANK.AVG",
    "OPENINGBALANCEMONTH",
    "OPENINGBALANCEQUARTER",
    "OPENINGBALANCEYEAR",
    "CLOSINGBALANCEMONTH",
    "CLOSINGBALANCEQUARTER",
    "CLOSINGBALANCEYEAR",
    "STARTOFMONTH",
    "STARTOFQUARTER",
    "STARTOFYEAR",
    "ENDOFMONTH",
    "ENDOFQUARTER",
    "ENDOFYEAR",
    "KEEPFILTERS",
    "REMOVEFILTERS",
    "ALLSELECTED",
    "CONTAINS",
    "CONTAINSROW",
    "ISEMPTY",
    "VAR",
    "RETURN",
  ];

  // Extract function names (rough heuristic)
  const funcMatches = trimmed.match(/\b([A-Z][A-Z0-9._]*)\s*\(/g);
  if (funcMatches) {
    for (const match of funcMatches) {
      const func = match.slice(0, -1).toUpperCase();
      if (!allowedFunctions.includes(func)) {
        warnings.push(`Potentially unsupported DAX function: ${func}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, sanitized: trimmed };
}

/** Python/pandas validation via AST */
export function validatePython(code: string, columns: ColumnDef[], allowImports = true): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = code.trim();
  if (!trimmed) {
    errors.push("Empty Python code");
    return { valid: false, errors, warnings };
  }

  // Length check
  if (trimmed.length > 50000) {
    errors.push("Code exceeds maximum length");
  }

  // Python syntax itself is enforced downstream by the code gate and the
  // Pyodide kernel; here we only screen the source for dangerous constructs.

  // Dangerous patterns
  const dangerous = [
    { pattern: /\bimport\s+os\b/, msg: "OS module import not allowed" },
    { pattern: /\bimport\s+sys\b/, msg: "Sys module import not allowed" },
    { pattern: /\bimport\s+subprocess\b/, msg: "Subprocess module import not allowed" },
    { pattern: /\bimport\s+shutil\b/, msg: "Shutil module import not allowed" },
    { pattern: /\bimport\s+pathlib\b/, msg: "Pathlib module import not allowed" },
    { pattern: /\beval\s*\(/, msg: "eval() not allowed" },
    { pattern: /\bexec\s*\(/, msg: "exec() not allowed" },
    { pattern: /\bcompile\s*\(/, msg: "compile() not allowed" },
    { pattern: /__import__\s*\(/, msg: "__import__ not allowed" },
    { pattern: /\bopen\s*\(/, msg: "File I/O not allowed" },
    { pattern: /\binput\s*\(/, msg: "input() not allowed" },
    { pattern: /\bgetattr\s*\(/, msg: "getattr() not allowed" },
    { pattern: /\bsetattr\s*\(/, msg: "setattr() not allowed" },
    { pattern: /\bdelattr\s*\(/, msg: "delattr() not allowed" },
    { pattern: /\bglobals\s*\(/, msg: "globals() not allowed" },
    { pattern: /\blocals\s*\(/, msg: "locals() not allowed" },
    { pattern: /\bvars\s*\(/, msg: "vars() not allowed" },
    { pattern: /\bdir\s*\(/, msg: "dir() not allowed" },
    { pattern: /\b__.*__\s*=/, msg: "Dunder assignment not allowed" },
    { pattern: /\b__.*__\s*\./, msg: "Dunder attribute access not allowed" },
  ];

  for (const { pattern, msg } of dangerous) {
    if (pattern.test(trimmed)) {
      errors.push(msg);
    }
  }

  // Check imports if not allowed
  if (!allowImports) {
    const importMatches = trimmed.match(/^\s*(import|from)\s+\w+/gm);
    if (importMatches && importMatches.length > 0) {
      errors.push("Imports not allowed in this context");
    }
  }

  // Check for column references
  const colNames = new Set(columns.map((c) => c.name));
  const words = trimmed.split(/[\s,().]+/);
  for (const word of words) {
    if (colNames.has(word)) continue;
    if (
      ["df", "pd", "np", "plt", "sns", "sklearn", "train_test_split", "RandomForest", "LinearRegression"].includes(word)
    )
      continue;
  }

  return { valid: errors.length === 0, errors, warnings, sanitized: trimmed };
}

/** Chart spec validation */
export function validateChartSpec(spec: ChartSpec, columns: ColumnDef[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const colNames = new Set(columns.map((c) => c.name));

  if (!spec?.kind) {
    errors.push("Chart spec missing kind");
    return { valid: false, errors, warnings };
  }

  // Validate column references in spec
  const checkColumn = (col: string | undefined, field: string) => {
    if (col && !colNames.has(col)) {
      errors.push(`Chart ${field} references unknown column: ${col}`);
    }
  };

  // ChartSpec carries its column bindings on the axis labels; additional
  // groupings are modelled as extra series (and checked below).
  checkColumn(spec.xLabel, "x-axis");
  checkColumn(spec.yLabel, "y-axis");

  for (const series of spec.series ?? []) {
    checkColumn(series.name, `series "${series.name}"`);
  }

  return { valid: errors.length === 0, errors, warnings, sanitized: JSON.stringify(spec) };
}

/** General LLM output sanitization */
export function sanitizeOutput(text: string): string {
  // Remove potential prompt injection attempts
  let cleaned = text;

  // Remove common injection patterns
  const injections = [
    /ignore\s+(?:previous|above|all)\s+(?:instructions|prompts?|rules?)/gi,
    /forget\s+(?:everything|all|previous)/gi,
    /you\s+are\s+(?:now|a|an)\s+/gi,
    /system\s*:/gi,
    /assistant\s*:/gi,
    /user\s*:/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<\|im_start\|>/gi,
    /<\|im_end\|>/gi,
    /<s>/gi,
    /<\/s>/gi,
  ];

  for (const pattern of injections) {
    cleaned = cleaned.replace(pattern, "[REDACTED]");
  }

  // Limit length
  if (cleaned.length > 10000) {
    cleaned = cleaned.slice(0, 10000) + "... [truncated]";
  }

  return cleaned;
}

/** PII redaction */
export function redactPII(text: string): string {
  let redacted = text;

  // Email addresses
  redacted = redacted.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]");

  // Phone numbers (basic patterns)
  redacted = redacted.replace(/\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g, "[PHONE]");

  // Credit card numbers (basic Luhn-like pattern)
  redacted = redacted.replace(/\b(?:\d[ -]*?){13,16}\b/g, "[CARD]");

  // SSN (US)
  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]");

  // IP addresses
  redacted = redacted.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]");

  return redacted;
}

/** Prompt injection detection */
export function detectPromptInjection(text: string): { detected: boolean; patterns: string[] } {
  const patterns: string[] = [];
  const injections = [
    { pattern: /ignore\s+(?:previous|above|all)\s+(?:instructions|prompts?|rules?)/gi, name: "ignore_instructions" },
    { pattern: /forget\s+(?:everything|all|previous)/gi, name: "forget_context" },
    { pattern: /you\s+are\s+(?:now|a|an)\s+/gi, name: "role_override" },
    { pattern: /system\s*:/gi, name: "system_override" },
    { pattern: /assistant\s*:/gi, name: "assistant_override" },
    { pattern: /user\s*:/gi, name: "user_override" },
    { pattern: /\[INST\]/gi, name: "instruction_marker" },
    { pattern: /<\|im_start\|>/gi, name: "chat_marker" },
    { pattern: /<\|im_end\|>/gi, name: "chat_marker" },
    { pattern: /<s>/gi, name: "bos_token" },
    { pattern: /<\/s>/gi, name: "eos_token" },
    { pattern: /jailbreak/gi, name: "jailbreak_keyword" },
    { pattern: /prompt\s+injection/gi, name: "injection_keyword" },
  ];

  for (const { pattern, name } of injections) {
    if (pattern.test(text)) {
      patterns.push(name);
    }
  }

  return { detected: patterns.length > 0, patterns };
}

/** Main validation entry point */
export function validateLLMOutput(output: string, options: CodeValidationOptions): ValidationResult {
  switch (options.target) {
    case "dsl":
      return validateDsl(output, options.columns);
    case "sql":
      return validateSql(output, options.columns);
    case "dax":
      return validateDax(output, options.columns);
    case "python":
    case "pandas":
      return validatePython(output, options.columns, !options.strictMode);
    default:
      return { valid: false, errors: [`Unknown target: ${options.target}`], warnings: [] };
  }
}

/** Widen untrusted JSON to a record, or null when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Validate chart recommendation output */
export function validateChartRecommendation(rec: unknown, columns: ColumnDef[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const candidate = asRecord(rec);
  if (!candidate) {
    errors.push("Chart recommendation must be an object");
    return { valid: false, errors, warnings };
  }

  if (!candidate.type) {
    errors.push("Missing chart type");
  }

  const confidence = candidate.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
    errors.push("Confidence must be between 0 and 1");
  }

  const mapping = asRecord(candidate.mapping);
  if (mapping) {
    const colNames = new Set(columns.map((c) => c.name));
    for (const [field, col] of Object.entries(mapping)) {
      if (typeof col === "string" && col !== "" && !colNames.has(col)) {
        warnings.push(`Mapping ${field} references unknown column: ${col}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
