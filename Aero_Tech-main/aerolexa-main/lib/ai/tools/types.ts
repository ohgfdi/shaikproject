/**
 * Assistant tool contract (Phase 2, READ tier only).
 *
 * Every tool runs against the caller's session context. The model supplies
 * only semantic arguments (dates, sections, filters); it can never supply or
 * alter `userId`, `workspaceId`, `organizationId`, `bookId` or
 * `engagementId`. Book/engagement identity is injected by the server and
 * re-validated on every single call by the executor.
 *
 * Outputs are deliberately compact: totals, counts, top-N rows and stable ids
 * for drill-down — never a whole ledger. Every list carries a hard cap and a
 * `truncated` flag so a model can tell the difference between "none" and
 * "more than I was shown".
 */

import type { z } from "zod";

import type { AuthContext } from "@/lib/auth/guard";

export type ToolTier = "READ" | "PROPOSE" | "EXECUTE";

/** Server-owned identity for one assistant run. Never model-supplied. */
export interface AssistantContext {
  auth: AuthContext;
  runId: string;
  requestId: string;
  /** Validated by assertBookTenant before the run; null when ambiguous. */
  bookId: string | null;
  /** Validated by requireEngagementRole on the first engagement tool call. */
  engagementId: string | null;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ToolErrorBody {
  code: string;
  message: string;
  /** A concrete next step the model can take, not a stack trace. */
  next: string;
  details?: unknown;
}

export interface ToolSuccess<T = unknown> {
  ok: true;
  resultId: string;
  tool: string;
  tier: ToolTier;
  data: T;
  meta: ToolMeta;
}

export interface ToolFailure {
  ok: false;
  resultId: string;
  tool: string;
  tier: ToolTier;
  error: ToolErrorBody;
}

export type ToolEnvelope<T = unknown> = ToolSuccess<T> | ToolFailure;

export interface ToolMeta {
  /** Rows returned in `data`. Null for aggregate-only results. */
  rowCount: number | null;
  /** Total rows matching the query before the cap. */
  total: number | null;
  truncated: boolean;
  /** Opaque cursor for the next page, when one exists. */
  nextCursor?: string;
  /** Human-readable note when data is absent or capped. */
  note?: string;
  /** Store function or query path that produced this result. */
  provenance: string;
  generatedAt: string;
  bookId?: string;
  window?: { from?: string; to?: string };
}

export type ToolData = Record<string, unknown>;

export interface ToolDefinition<I = unknown> {
  name: string;
  /** Says when to use it and — just as important — when not to. */
  description: string;
  tier: ToolTier;
  /** Strict Zod schema. Unknown keys are rejected. */
  schema: z.ZodType<I>;
  /** True when the executor must resolve and re-check a book first. */
  requiresBook: boolean;
  /** For audit and prompt grouping: books | gst | tds | payroll | ... */
  module: string;
  execute: (input: I, ctx: AssistantContext) => Promise<ToolData>;
}

/**
 * A tool after type erasure, as held by the registry. Each tool keeps its
 * concrete input type at the definition site, but the registry must store them
 * together. Schemas are still enforced per call by the executor.
 */
export type RegisteredToolDefinition = Omit<ToolDefinition<never>, "schema" | "execute"> & {
  schema: z.ZodTypeAny;
  execute: (input: never, ctx: AssistantContext) => Promise<ToolData>;
};

/** A list page helper shared by tools. */
export interface Page<T> {
  rows: T[];
  total: number;
  truncated: boolean;
  nextCursor?: string;
}
