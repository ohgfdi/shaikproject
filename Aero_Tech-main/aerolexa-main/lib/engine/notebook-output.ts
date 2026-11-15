/**
 * Runtime type guards for notebook cell outputs.
 *
 * `NotebookCellOutput` is a discriminated union on `type` (lib/types.ts), so a
 * plain `output.type === "table"` check narrows correctly inside a single
 * expression. Published notebooks, however, are rehydrated from API/JSON
 * payloads, and render code is easier to audit when the narrowing lives in one
 * named guard instead of being repeated (and occasionally lost) inline.
 *
 * The guards also verify the payload arrays at runtime: a published snapshot
 * from an older writer can be missing `columns`/`rows`, and we would rather
 * render a graceful fallback than throw while mapping `undefined`.
 */

import type { NotebookCellOutput } from "@/lib/types";

/** The `"table"` variant of `NotebookCellOutput`. */
export type TableOutput = Extract<NotebookCellOutput, { type: "table" }>;

/** The `"conditional-table"` variant of `NotebookCellOutput`. */
export type ConditionalTableOutput = Extract<NotebookCellOutput, { type: "conditional-table" }>;

/** True when `output` is a well-formed table output. Narrows for callers. */
export function isTableOutput(output: NotebookCellOutput | null | undefined): output is TableOutput {
  return output?.type === "table" && Array.isArray(output.columns) && Array.isArray(output.rows);
}

/** True when `output` is a well-formed conditional-table output. Narrows for callers. */
export function isConditionalTableOutput(
  output: NotebookCellOutput | null | undefined,
): output is ConditionalTableOutput {
  return output?.type === "conditional-table" && Array.isArray(output.columns) && Array.isArray(output.rows);
}
