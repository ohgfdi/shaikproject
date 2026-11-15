/**
 * The READ-only tool registry. Phase 2 deliberately contains no PROPOSE or
 * EXECUTE definitions; the executor refuses any tier other than READ, so a
 * future definition cannot become callable by accident.
 */

import type { AIToolDefinition } from "@/lib/ai/provider";
import {
  financialStatements,
  dayBook,
  searchVouchers,
  voucherDetail,
  ledgerAccountStatement,
} from "@/lib/ai/tools/books";
import { gstInvoices, gstReconciliation } from "@/lib/ai/tools/gst";
import {
  bankFeedStatus,
  fixedAssetsSummary,
  inventorySummary,
  payrollRunSummary,
  periodLockStatus,
  tdsSummary,
} from "@/lib/ai/tools/operations";
import { engagementStatus, listVisibleBooks } from "@/lib/ai/tools/practice";
import { zodToJsonSchema } from "@/lib/ai/tools/schema";
import type { RegisteredToolDefinition } from "@/lib/ai/tools/types";

// Heterogeneous registry: each entry owns a different Zod input type, so the
// element type is type-erased. Callers validate with `def.schema` before
// invoking `execute`.
export const TOOL_DEFINITIONS: readonly RegisteredToolDefinition[] = [
  financialStatements,
  dayBook,
  searchVouchers,
  voucherDetail,
  ledgerAccountStatement,
  gstInvoices,
  gstReconciliation,
  inventorySummary,
  fixedAssetsSummary,
  tdsSummary,
  payrollRunSummary,
  bankFeedStatus,
  periodLockStatus,
  listVisibleBooks,
  engagementStatus,
];

const byName = new Map(TOOL_DEFINITIONS.map((def) => [def.name, def] as const));

export function getToolDefinition(name: string): RegisteredToolDefinition | undefined {
  return byName.get(name);
}

/** Anthropic tool declarations. `inputSchema` is projected from the Zod schema. */
export function toAnthropicTools(defs: readonly RegisteredToolDefinition[] = TOOL_DEFINITIONS): AIToolDefinition[] {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: zodToJsonSchema(def.schema) as AIToolDefinition["inputSchema"],
  }));
}

/** The only tool the model may use to finish. It has no data access. */
export const SUBMIT_ANSWER_TOOL = {
  name: "submit_answer",
  description:
    "Submit the final answer and the evidence for each factual claim. Call this exactly once, after all data tools you need. " +
    "Every claim must cite one or more resultId values returned by data tools in THIS run. " +
    "The answer is verified automatically; uncited numbers, dates or identifiers are rejected and you will be asked once to correct them.",
  inputSchema: {
    type: "object" as const,
    properties: {
      answer: {
        type: "string",
        description:
          "Markdown answer for the user. Use only figures/dates/names present in cited tool results. Use the tool's inr strings for money, or quote paise explicitly.",
      },
      claims: {
        type: "array",
        description: "One entry per factual claim. An honest 'cannot determine' answer may have an empty list.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "A single factual sentence copied/derived from the cited results." },
            result_ids: {
              type: "array",
              items: { type: "string", pattern: "^tr_[a-z0-9]{8,}$" },
              minItems: 1,
              description: "resultId values of the tool results that support this claim.",
            },
          },
          required: ["text", "result_ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["answer", "claims"],
    additionalProperties: false,
  },
} as const;

/** Build the full tool list handed to Anthropic: READ tools + final submit. */
export function toModelTools(): AIToolDefinition[] {
  return [...toAnthropicTools(), SUBMIT_ANSWER_TOOL as unknown as AIToolDefinition];
}

/** Names that must never be accepted from the model. */
export const FORBIDDEN_IDENTITY_FIELDS = ["userId", "workspaceId", "organizationId", "bookId", "engagementId"] as const;
