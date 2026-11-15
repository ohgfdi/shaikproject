/**
 * Tool executor — the single chokepoint every model tool call passes through.
 *
 * Responsibilities, in order:
 *  1. Validate the input against the strict Zod schema (unknown keys fail).
 *  2. Refuse any tier other than READ.
 *  3. Re-resolve the book from the server-owned run context and re-check
 *     workspace + active organization + role. Fail closed.
 *  4. Run the tool, map failures to instructive typed errors (never a stack).
 *  5. Assign a result id, hash the output and hand an audit record to the run
 *     logger. A failed audit write returns no data to the model.
 *
 * The model never passes identity fields: they are absent from the schemas and
 * the executor would ignore them if they were present (Zod strict rejects).
 */

import { createHash, randomBytes } from "node:crypto";

import { clip } from "@/lib/ai/format";
import { scrubForLog, scrubText } from "@/lib/ai/redact";
import { getToolDefinition } from "@/lib/ai/tools/registry";
import type { AssistantContext, ToolEnvelope } from "@/lib/ai/tools/types";
import { ApiError } from "@/lib/auth/guard";
import { assertBookTenant } from "@/lib/server/book-tenancy";

const READ_ORG_ROLES = new Set(["OWNER", "ADMIN", "MEMBER", "AUDITOR"]);

export interface ToolAuditRecord {
  resultId: string;
  toolName: string;
  /** Scrubbed, JSON-serialisable input. */
  input: unknown;
  outputSummary: string;
  outputHash: string;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
}

export interface ExecutorDeps {
  assertBookTenant: (
    ctx: AssistantContext["auth"],
    bookId: string,
  ) => Promise<{ id: string; organizationId: string | null }>;
  record: (record: ToolAuditRecord) => Promise<void>;
  /** Test seam; production uses crypto randomness. */
  newResultId?: () => string;
  now?: () => number;
}

export function defaultExecutorDeps(): ExecutorDeps {
  return {
    assertBookTenant,
    record: async () => {
      // The agent replaces this with the append-only audit writer. A missing
      // writer is only acceptable in unit tests; the API always supplies one.
    },
    newResultId: () => `tr_${randomBytes(5).toString("hex")}`,
  };
}

export interface ExecuteToolOptions {
  name: string;
  input: unknown;
  context: AssistantContext;
  deps?: Partial<ExecutorDeps>;
}

/** Stable hash of the model-visible output (used for the audit trail). */
export function hashToolOutput(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function outputSummary(data: unknown): string {
  if (!data || typeof data !== "object") return clip(String(data), 500) ?? "";
  const record = data as Record<string, unknown>;
  const bits: string[] = [];
  for (const key of ["rowCount", "total", "truncated", "itemCount", "assetCount", "entryCount", "lockedPeriodCount"]) {
    if (key in record) bits.push(`${key}=${String(record[key])}`);
  }
  const body = clip(JSON.stringify(data), 700) ?? "";
  return scrubText(bits.length ? `${bits.join(", ")}; ${body}` : body) ?? "";
}

function mapError(error: unknown): { code: string; message: string; next: string; details?: unknown } {
  if (error instanceof ApiError) {
    const code = error.code || "TOOL_ERROR";
    const next =
      error.status === 404
        ? "Re-check the id with the relevant list/search tool; do not retry the same id."
        : error.status === 403
          ? "The caller lacks access to this book/engagement. Ask the user to switch to the correct organization/book; do not attempt another id."
          : error.status === 400
            ? "Adjust the input as the store requires (valid date/period/amount) and retry once."
            : "Report the failure plainly; do not fabricate a result.";
    return {
      code,
      message: scrubText(error.message) ?? "The tool rejected the request.",
      next,
      ...(error.details ? { details: scrubForLog(error.details) } : {}),
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = scrubText(clip(raw, 300)) ?? "The tool failed.";
  if (/Unknown account/i.test(raw)) {
    return {
      code: "UNKNOWN_ACCOUNT",
      message,
      next: "Call financial_statements with statement='trial_balance' to obtain a valid account code.",
    };
  }
  if (/not found in the selected book/i.test(raw)) {
    return { code: "NOT_FOUND", message, next: "Use search_vouchers to obtain a valid voucherId for this book." };
  }
  if (/No book is attached/i.test(raw)) {
    return { code: "BOOK_REQUIRED", message, next: "Ask the user to select a book in the UI; do not guess one." };
  }
  if (/No engagement is selected/i.test(raw)) {
    return {
      code: "ENGAGEMENT_REQUIRED",
      message,
      next: "Ask the user to open an engagement in the UI; do not guess an id.",
    };
  }
  if (/at least one filter|must be|invalid|does not exist|no assets/i.test(raw)) {
    return {
      code: "VALIDATION",
      message,
      next: "Correct the input and retry once, or tell the user the data needed is unavailable.",
    };
  }
  // Unrecognised failures may contain infrastructure detail (hosts, ports,
  // SQL). Return a stable, non-technical message instead of the raw string.
  return {
    code: "TOOL_FAILED",
    message: "The tool could not read the book data.",
    next: "Tell the user this tool failed and that the answer cannot be determined from the available data.",
  };
}

export async function executeTool(options: ExecuteToolOptions): Promise<ToolEnvelope> {
  const deps: ExecutorDeps = { ...defaultExecutorDeps(), ...options.deps };
  const def = getToolDefinition(options.name);
  const started = (deps.now ?? Date.now)();
  const resultId = (deps.newResultId ?? (() => `tr_${randomBytes(5).toString("hex")}`))();

  if (!def) {
    return {
      ok: false,
      resultId,
      tool: options.name,
      tier: "READ",
      error: {
        code: "UNKNOWN_TOOL",
        message: `No tool named "${clip(options.name, 60) ?? "unknown"}".`,
        next: "Use one of the provided tool names exactly.",
      },
    };
  }

  // Tier gate. No EXECUTE/PROPOSE tool exists in Phase 2, and even a
  // mistakenly-registered one cannot run.
  if (def.tier !== "READ") {
    return {
      ok: false,
      resultId,
      tool: def.name,
      tier: def.tier,
      error: {
        code: "TIER_DENIED",
        message: `${def.name} is not a READ tool.`,
        next: "This action is not available to the assistant.",
      },
    };
  }

  const parsed = def.schema.safeParse(options.input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "input";
    return {
      ok: false,
      resultId,
      tool: def.name,
      tier: def.tier,
      error: {
        code: "INVALID_INPUT",
        message: `${path}: ${issue?.message ?? "invalid value"}`,
        next: "Send only the documented fields with the stated units/formats. Unknown fields are rejected.",
      },
    };
  }

  try {
    if (def.requiresBook) {
      if (!options.context.bookId) {
        return {
          ok: false,
          resultId,
          tool: def.name,
          tier: def.tier,
          error: {
            code: "BOOK_REQUIRED",
            message: "No book is attached to this run.",
            next: "Ask the user to select a book in the UI. Do not guess a book id or answer from another book.",
          },
        };
      }
      const book = await deps.assertBookTenant(options.context.auth, options.context.bookId);
      if (book.id !== options.context.bookId) {
        return {
          ok: false,
          resultId,
          tool: def.name,
          tier: def.tier,
          error: {
            code: "FORBIDDEN",
            message: "Book identity changed during the run.",
            next: "Ask the user to reselect the book.",
          },
        };
      }
      if (book.organizationId) {
        const role = (options.context.auth.organizationRole ?? "").toUpperCase();
        if (!READ_ORG_ROLES.has(role)) {
          return {
            ok: false,
            resultId,
            tool: def.name,
            tier: def.tier,
            error: {
              code: "FORBIDDEN",
              message: "Your organization role does not allow reading this book.",
              next: "Ask an owner/admin to grant a read role. Do not retry with a different book id.",
            },
          };
        }
      }
    }

    const data = await def.execute(parsed.data as never, options.context);
    const latencyMs = Math.max(0, (deps.now ?? Date.now)() - started);
    const envelope: ToolEnvelope = {
      ok: true,
      resultId,
      tool: def.name,
      tier: def.tier,
      data,
      meta: {
        rowCount:
          typeof (data as Record<string, unknown>).rowCount === "number"
            ? Number((data as Record<string, unknown>).rowCount)
            : null,
        total:
          typeof (data as Record<string, unknown>).total === "number"
            ? Number((data as Record<string, unknown>).total)
            : null,
        truncated: Boolean((data as Record<string, unknown>).truncated),
        ...(typeof (data as Record<string, unknown>).nextCursor === "string"
          ? { nextCursor: String((data as Record<string, unknown>).nextCursor) }
          : {}),
        ...(typeof (data as Record<string, unknown>).note === "string"
          ? { note: String((data as Record<string, unknown>).note) }
          : {}),
        provenance: `lib/ai/tools → ${def.module} store`,
        generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        ...(options.context.bookId ? { bookId: options.context.bookId } : {}),
      },
    };
    await deps.record({
      resultId,
      toolName: def.name,
      input: scrubForLog(parsed.data),
      outputSummary: outputSummary(data),
      outputHash: hashToolOutput(data),
      ok: true,
      latencyMs,
    });
    return envelope;
  } catch (error) {
    const mapped = mapError(error);
    const latencyMs = Math.max(0, (deps.now ?? Date.now)() - started);
    try {
      await deps.record({
        resultId,
        toolName: def.name,
        input: scrubForLog(parsed.data),
        outputSummary: clip(mapped.message, 500) ?? "",
        outputHash: hashToolOutput(mapped),
        ok: false,
        errorCode: mapped.code,
        latencyMs,
      });
    } catch (auditError) {
      return {
        ok: false,
        resultId,
        tool: def.name,
        tier: def.tier,
        error: {
          code: "AUDIT_WRITE_FAILED",
          message: "The assistant could not write its audit record, so the tool result is withheld.",
          next: "Tell the user the assistant is temporarily unavailable. Do not retry in this run.",
          details: { auditError: auditError instanceof Error ? auditError.name : "unknown" },
        },
      };
    }
    return {
      ok: false,
      resultId,
      tool: def.name,
      tier: def.tier,
      error: mapped,
    };
  }
}
