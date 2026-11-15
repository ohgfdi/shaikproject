# Aerolexa Error Types Reference

This document catalogs all error types, classes, codes, and handling patterns in the Aerolexa project.

---

## 1. API / HTTP Errors

**Source files:** `lib/auth/guard.ts`, `lib/server/api.ts`, `lib/client/api.ts`

### Server-Side: `ApiError`

```typescript
// lib/auth/guard.ts
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>);
}
```

**Helper functions:**

- `notFoundError(message?)` → 404 `NOT_FOUND`
- `forbiddenError(message?)` → 403 `FORBIDDEN`

**Complete error code list:**

| Status | Code                    | Usage                                                  |
| ------ | ----------------------- | ------------------------------------------------------ |
| 400    | `VALIDATION`            | Input validation failure (name, email, password, role) |
| 400    | `INVALID_TOKEN`         | Invalid verification/reset link                        |
| 400    | `EXPIRED_TOKEN`         | Expired verification/reset link                        |
| 400    | `BAD_JSON`              | Request body not valid JSON                            |
| 400    | `BAD_FORM`              | Could not read multipart form data                     |
| 400    | `ANALYSIS_INPUT`        | Analysis config references missing/wrong columns       |
| 400    | `SQL_INPUT`             | SQL parse/execution error                              |
| 400    | `WHATIF_INPUT`          | What-if input validation failure                       |
| 400    | `FILE_INVALID`          | File parse failure                                     |
| 400    | `CONNECTOR_ERROR`       | Connector failure (default)                            |
| 401    | `UNAUTHENTICATED`       | User not signed in                                     |
| 401    | `INVALID_CREDENTIALS`   | Wrong email/password                                   |
| 401    | `CONNECTOR_AUTH`        | Database auth failure (28P01, 28000)                   |
| 403    | `FORBIDDEN`             | Access denied / workspace mismatch                     |
| 403    | `EMAIL_UNVERIFIED`      | Email not verified before sign-in                      |
| 403    | `CONNECTOR_PERMISSION`  | DB permission denied (42501)                           |
| 404    | `NOT_FOUND`             | Resource not found                                     |
| 404    | `CONNECTOR_NOT_FOUND`   | DB/table not found (3D000, 42P01)                      |
| 409    | `EMAIL_TAKEN`           | Email already registered                               |
| 500    | `INTERNAL`              | Unexpected server error (never leaks stack)            |
| 502    | `CONNECTOR_UNREACHABLE` | DB unreachable (ECONNREFUSED, 08006)                   |
| 503    | `ENGINE_UNAVAILABLE`    | DuckDB engine unavailable                              |
| 504    | `CONNECTOR_TIMEOUT`     | DB query timeout (ETIMEDOUT, EHOSTUNREACH, 57014)      |

### Client-Side: `ApiClientError`

```typescript
// lib/client/api.ts
export class ApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown);
}
```

**Helper:**

- `errorMessage(err: unknown): string` — formats error for UI display

**API envelope shape:**

```typescript
interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}
```

---

## 2. Engine Errors

**Source:** `lib/engine/` subdirectories

| Class                    | File                              | Thrown When                                                                                  |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `SqlError`               | `lib/engine/sql.ts`               | SQL syntax errors, unknown columns, forbidden ops, empty queries, multiple statements        |
| `AnalysisInputError`     | `lib/engine/analyses.ts`          | Analysis config missing columns, wrong column types, insufficient data for trend             |
| `WhatIfError`            | `lib/engine/whatif.ts`            | Missing driver/outcome columns, invalid pctChange, driver=outcome, column not found          |
| `ConnectorError`         | `lib/engine/connectors/errors.ts` | Database connection/query failures                                                           |
| `HypothesisError`        | `lib/engine/hypothesis.ts`        | Statistical test input errors                                                                |
| `TrainingError`          | `lib/engine/training.ts`          | Model training impossibility                                                                 |
| `CronError`              | `lib/engine/cron.ts`              | Scheduled job failures                                                                       |
| `JinjaError`             | `lib/engine/jinja.ts`             | Template rendering type/position errors                                                      |
| `DslCommandError`        | `lib/engine/notebook-dsl.ts`      | Notebook DSL unknown commands, missing columns, empty cells (internal, caught and re-mapped) |
| `DuckDbUnavailableError` | `lib/engine/duckdb/shared.ts`     | DuckDB engine init failure                                                                   |

### `SqlError` examples:

- "The query is empty."
- "Only read-only SELECT queries are supported (found "...")."
- ""..." is not allowed — the SQL lab runs read-only SELECT queries only."
- "Expected keyword ..."
- "Expected "..." but found "..."."
- "Unknown column "..."": `
- "Operator "..." is not supported yet."
- "Unterminated /* comment in the query."
- "Unterminated string literal in the query."
- "Unexpected character "..." in the query."
- "LIMIT must be a whole number ≥ 0."

### `ConnectorError` codes (from `friendlyPgError`):

| SQLSTATE/Code            | Status | Code                  | Message                           |
| ------------------------ | ------ | --------------------- | --------------------------------- |
| 28P01                    | 401    | CONNECTOR_AUTH        | PostgreSQL rejected password      |
| 28000                    | 401    | CONNECTOR_AUTH        | User not allowed to connect       |
| 3D000                    | 404    | CONNECTOR_NOT_FOUND   | Database does not exist           |
| 42501                    | 403    | CONNECTOR_PERMISSION  | Permission denied on schema/table |
| 42P01                    | 404    | CONNECTOR_NOT_FOUND   | Table/view does not exist         |
| ECONNREFUSED             | 502    | CONNECTOR_UNREACHABLE | Connection refused                |
| ETIMEDOUT / EHOSTUNREACH | 504    | CONNECTOR_TIMEOUT     | Connection timed out              |
| 08006                    | 502    | CONNECTOR_UNREACHABLE | Connection lost                   |
| 57014                    | 504    | CONNECTOR_TIMEOUT     | Query cancelled (timeout)         |
| default                  | 400    | CONNECTOR_ERROR       | Generic DB failure                |

---

## 3. File Parsing Errors

**Source:** `lib/file/parse.ts`

```typescript
export class ParseError extends Error {
  constructor(message: string);
}
```

**Thrown scenarios:**

- "File exceeds the N MB upload limit. Split the file or upload a subset."
- "Unsupported file type "..." ": Upload a .csv or .xlsx file."
- "The file has N columns — above the 300 column limit."
- "The file has no usable header row."
- "Could not read the CSV file: ..."
- "Could not read the Excel file. ..."
- "The Excel file is empty."
- "The Excel file has N data rows. For files this large, export to CSV..."
- "The file contains a header row but no data rows beneath it."
- "Uploaded file is missing on disk."
- "Column "..." was not found in the dataset." (from `applyColumnOps`)

---

## 4. Validation Errors (Zod)

**Source:** `zod` package, handled in `lib/server/api.ts`

```typescript
if (err instanceof ZodError) {
  const first = err.issues[0];
  return fail(400, "VALIDATION", first ? `${first.path.join(".")} || "input"}: ${first.message}` : "Invalid input.");
}
```

---

## 5. Client-Side State Errors (React)

Used across components via `useState<string | null>(null)`:

| State Variable                     | Component                                                    | Purpose                    |
| ---------------------------------- | ------------------------------------------------------------ | -------------------------- |
| `error` / `setError`               | Many components                                              | General operation errors   |
| `formError` / `setFormError`       | `models-tab`, `team-tab`, `prompts-panel`, `scheduled-panel` | Inline form validation     |
| `publishError` / `setPublishError` | `notebook-tab`                                               | Notebook publish failures  |
| `kernelError` / `setKernelError`   | `notebook-tab`                                               | Pyodide/DSL kernel errors  |
| `llmError` / `setLlmError`         | `copilot-hook`                                               | Copilot/LLM errors         |
| `setMappingMessage`                | `project-hub`                                                | Dataset mapping errors     |
| `onError` callback                 | `apex-chart`                                                 | Chart load timeout/failure |

---

## 6. UI Error Components

**Source:** `components/ui/feedback.tsx`

### `ErrorMessage`

```typescript
<ErrorMessage
  title?: string          // Default: "Something went wrong"
  message?: string        // Detailed explanation
  howToFix?: string       // Fix instructions
  onRetry?: () => void   // Retry button
  className?: string
/>
```

Renders: alert box with triangle icon, expandable "What happened?", optional "How to fix", optional Retry button.

### `WarningBanner`

```typescript
<WarningBanner
  title: string
  children?: ReactNode
  onDismiss?: () => void
  severity?: "warning" | "info" | "critical"
  className?: string
/>
```

### `ErrorBoundary`

React error boundary class component. Catches render errors, shows `ErrorMessage` with "This section hit a snag" title. Never renders stack traces.

### `DemoBadge`

Not an error, but a warning indicator for prototype/demo results.

---

## 7. Notebook Cell Output Types

**Source:** `lib/types.ts` (discriminated union)

```typescript
export type NotebookCellOutput =
  | { type: "error"; message: string }
  | { type: "note"; title: string; detail: string }
  | { type: "text"; text: string }
  | { type: "image"; image: { mimeType: "image/png"; data: string } }
  | {
      type: "table";
      title: string;
      columns: { key: string; label: string; format?: "number" | "pct" | "date" | "text" }[];
      rows: (string | number | null)[][];
    }
  | { type: "stats"; title: string; stats: { label: string; value: string; hint?: string }[] }
  | ({ type: "chart"; title: string; chart: ChartSpec } & { kernel?: "pyodide" | "dsl" });
```

---

## 8. Runtime / Infrastructure Errors

| Error                | Source                                                               | Message                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox config       | `lib/server/execution/sandbox.ts`                                    | "Sandbox requires an organizationId." / "Memory limit X exceeds maximum of 8GB." / "CPU limit X exceeds maximum of 4 cores." / "Timeout X exceeds maximum of 1 hour."   |
| Pyodide unavailable  | `lib/engine/notebook-pyodide.ts`                                     | "Pyodide is available only in the browser." / "Pyodide loaded without its browser loader." / "The active dataset could not be loaded." / "Pyodide session unavailable." |
| Prisma migration     | `__tests__/api/global-setup.cjs`, test files                         | "global-setup: prisma migrate deploy failed against scratch DB."                                                                                                        |
| Workspace creation   | `prisma/seed.ts`                                                     | "Workspace creation failed."                                                                                                                                            |
| Archived project     | `app/api/projects/[id]/demo/route.ts`                                | "Archived projects are read-only."                                                                                                                                      |
| Empty dataset        | `app/api/studio/route.ts`, `app/api/datasets/[id]/analyses/route.ts` | "The dataset file is missing on disk — re-upload it."                                                                                                                   |
| Unsupported protocol | `app/api/connectors/rest/import/route.ts`                            | "unsupported protocol"                                                                                                                                                  |

---

## 9. Python Export Errors (Phase 1.5)

**Source:** `lib/export/python.ts` (**resolved** — see §12)

| Error                                                    | Details                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SyntaxError: unterminated triple-quoted string literal` | Generated Python scripts have broken `"""..."""` docstrings — detected at lines 20-24 of exported scripts |
| nbformat validation discrepancy                          | Exported .ipynb files fail `nbformat.validate()` with 1 discrepancy                                       |

**Affected functions:**

- `exportAnalysisScript`
- `exportWhatIfScript`
- `exportModelScript`
- `exportHypothesisScript`
- `exportNotebookToIpynb`

---

## 10. Error Handling Flow

```
Server Route Handler
  │
  ├─ Throws typed error (ApiError, SqlError, ParseError, etc.)
  │
  ▼
toErrorResponse(err)  ← lib/server/api.ts
  │
  ├─ ApiError     → fail(status, code, message, details)
  ├─ ZodError     → fail(400, "VALIDATION", first issue)
  ├─ ParseError   → fail(400, "FILE_INVALID", message)
  ├─ AnalysisInputError → fail(400, "ANALYSIS_INPUT", message)
  ├─ SqlError     → fail(400, "SQL_INPUT", message)
  ├─ WhatIfError  → fail(400, "WHATIF_INPUT", message)
  ├─ ConnectorError → fail(status, code, message)
  ├─ Error        → fail(500, "INTERNAL", "An unexpected error occurred. Please try again.")
  └─ unknown      → fail(500, "INTERNAL", ...)
  │
  ▼
JSON Response { ok: false, error: { code, message, details } }
  │
  ▼
Client: api()  ← lib/client/api.ts
  │
  ├─ res.ok && envelope.ok → return envelope.data
  └─ Otherwise → throw new ApiClientError(status, code, message, details)
  │
  ▼
Component .catch() → setError(errorMessage(err)) or toast(...)
  │
  ▼
UI: <ErrorMessage> or <ErrorBoundary> fallback
```

---

## 11. SQL Error Categories (for reference)

**Tokenizer errors (`SqlError`):**

- "The query is empty."
- "Unterminated /* comment in the query."
- "Unterminated quoted identifier in the query."
- "Unterminated string literal in the query."
- "Invalid number literal "..."."`
- "Unexpected character "..." in the query."

**Parser errors (`SqlError`):**

- "The query ended unexpectedly."
- "Expected keyword ..."
- "Expected "..." but found "..."."
- "Expected a name but found "..."."`
- "Only read-only SELECT queries are supported (found "...")."
- """..." is not allowed..."
- "The query is empty."
- "One SELECT per query — multiple statements are not allowed."
- "Unexpected "..." after the statement — one SELECT per query."
- "SELECT needs at least one column."
- "Aggregates are not allowed in ..."
- "Unknown column "..."": `
- "Unknown column "..." in GROUP BY."
- "Column "..." must appear inside an aggregate function or a GROUP BY clause."
- "Operator "..." is not supported yet."
- "This expression form is not supported yet."
- "LIMIT must be a whole number ≥ 0."
- "Unexpected "..." in the query."

**Runtime evaluation errors (`SqlError`):**

- "COUNT(*) can only appear in the SELECT list."
- "Unknown column "..."." (during evaluation)
- "Aggregate query without GROUP BY: bare columns would be ambiguous"

---

## 12. Error Fixes Applied (2026-09-13)

The following error handling improvements were made:

### Fixed: Python Export SyntaxError

- **File**: `lib/export/python.ts`
- **Issue**: `json.loads('''...''')` pattern caused `SyntaxError: unterminated triple-quoted string literal`
- **Fix**: Changed to `json.loads(${JSON.stringify(JSON.stringify(...))})` for proper escaping
- **Result**: 5/5 python-export tests passing

### Fixed: Raw Error → Typed Errors (API Routes)

- **Files**: All `app/api/**/route.ts`
- **Changes**:
  - `app/api/projects/[id]/demo/route.ts` — `Error` → `ApiError(403, "ARCHIVED_PROJECT")`
  - `app/api/datasets/[id]/analyses/route.ts` — 3 `Error` → `ApiError` with codes
  - `app/api/projects/[id]/joins/route.ts` — 4 `Error` → `ApiError` with codes
  - `app/api/studio/route.ts` — `Error` → `ApiError(400, "DATA_MISSING")`
  - `app/api/connectors/rest/import/route.ts` — `Error` → `ApiError(400, "VALIDATION")`
  - `app/api/datasets/[id]/replace/route.ts` — 3 `Error` → `ApiError` with codes

### Fixed: Raw Error → Typed Errors (Engine)

- **Files**: `lib/engine/**/*.ts`
- **Changes**:
  - `lib/engine/connectors/bigquery.ts` — `Error` → `ConnectorError(501, "CONNECTOR_NOT_IMPLEMENTED")`
  - `lib/engine/connectors/snowflake.ts` — `Error` → `ConnectorError(501, "CONNECTOR_NOT_IMPLEMENTED")`
  - `lib/engine/connectors/crypto.ts` — `Error` → `ConnectorError(400, "CONNECTOR_DECRYPT")`
  - `lib/engine/studio.ts` — 8 `Error` → `AnalysisInputError` with "What happened / How to fix"
  - `lib/engine/dataset-joins.ts` — `Error` → `AnalysisInputError`
  - `lib/server/execution/sandbox.ts` — 7 `Error` → `ApiError(400, "SANDBOX_CONFIG")`

### Fixed: Raw Error → Helpful Messages (Components)

- **Files**: `components/**/*.tsx`
- **Changes**:
  - `components/pivot/pivot-cell.tsx` — improved error parsing from API responses
  - `components/ui/confirm.tsx` — added "What happened / How to fix" to hook error
  - `components/notebook/notebook-tab.tsx` — added context to Pyodide errors
  - `lib/auth/mail.ts` — `Error` → `ApiError(500, "MAIL_TRANSPORT")`
  - `prisma/seed.ts` — added recovery guidance to workspace creation error

### Added: ErrorBoundary Coverage

- **Files**: `components/layout/app-shell.tsx`, `app/(app)/published-notebook/page.tsx`
- **Result**: Critical UI routes now catch React render errors gracefully

---

## 13. Error Handling Principles

All errors in the Aerolexa app now follow these principles:

1. **Typed errors everywhere**: Use `ApiError`, `ConnectorError`, `AnalysisInputError`, etc. instead of raw `Error`
2. **User-friendly messages**: Every error includes:
   - **What happened**: Brief explanation of the failure
   - **How to fix**: Actionable steps to resolve the issue
3. **Machine-readable codes**: API errors include status codes and machine codes for client-side handling
4. **No stack trace leaks**: Production errors never expose internal stack traces to clients
5. **Error boundaries**: React components wrap critical sections with `ErrorBoundary` to prevent full app crashes
6. **Consistent format**: All API errors follow the `{ ok: false, error: { code, message, details } }` envelope

---

_End of error reference document._
