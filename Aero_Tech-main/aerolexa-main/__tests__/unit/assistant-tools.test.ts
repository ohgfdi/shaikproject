/**
 * Tool registry + executor safety tests.
 *
 * These prove the non-negotiable properties of the Phase 2 tool layer without
 * touching the database:
 *  - tools never accept tenant identity fields (strict Zod rejects them);
 *  - every registered tool is READ tier;
 *  - a denied book tenant stops every book-scoped tool before it runs;
 *  - a missing/insufficient organization role fails closed;
 *  - the executor refuses unknown tools and unknown fields.
 */

import { executeTool } from "@/lib/ai/tools/executor";
import {
  FORBIDDEN_IDENTITY_FIELDS,
  TOOL_DEFINITIONS,
  getToolDefinition,
  toAnthropicTools,
} from "@/lib/ai/tools/registry";
import type { AssistantContext } from "@/lib/ai/tools/types";
import { ApiError, type AuthContext } from "@/lib/auth/guard";

const auth = {
  user: { id: "user-1", email: "user@example.com", name: "Test User" },
  workspace: { id: "workspace-1" },
  settings: {},
  organization: { id: "org-1" },
  organizationRole: "MEMBER",
} as unknown as AuthContext;

function context(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return {
    auth,
    runId: "run-1",
    requestId: "req-1",
    bookId: "book-1",
    engagementId: null,
    ...overrides,
  };
}

/** Minimal schema-valid input per tool. Kept in one place so new tools fail loudly. */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  financial_statements: { statement: "trial_balance" },
  day_book: { from: "2025-04-01", to: "2025-04-30" },
  search_vouchers: {},
  voucher_detail: { voucherId: "voucher-1" },
  ledger_account_statement: { accountCode: "1000" },
  gst_invoices: {},
  gst_register_ledger_reconciliation: { period: "2025-04" },
  inventory_summary: {},
  fixed_assets_summary: { fy: "2025-26" },
  tds_summary: { fy: "2025-26", quarter: "Q1" },
  payroll_run_summary: {},
  bank_feed_status: {},
  period_lock_status: {},
  list_books: {},
  engagement_status: {},
};

describe("tool registry", () => {
  it("registers exactly the READ tools and nothing executable", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(15);
    expect(TOOL_DEFINITIONS.every((definition) => definition.tier === "READ")).toBe(true);
    expect(new Set(TOOL_DEFINITIONS.map((definition) => definition.name)).size).toBe(TOOL_DEFINITIONS.length);
  });

  it("has a valid input fixture for every registered tool", () => {
    for (const definition of TOOL_DEFINITIONS) {
      const input = VALID_INPUT[definition.name];
      expect({ name: definition.name, input: Boolean(input) }).toEqual({ name: definition.name, input: true });
      expect({ name: definition.name, parsed: definition.schema.safeParse(input ?? {}).success }).toEqual({
        name: definition.name,
        parsed: true,
      });
    }
  });

  it("never advertises a tenant identity field to the model", () => {
    for (const tool of toAnthropicTools()) {
      const properties = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
      for (const forbidden of FORBIDDEN_IDENTITY_FIELDS) {
        expect({ tool: tool.name, field: forbidden, present: properties.includes(forbidden) }).toEqual({
          tool: tool.name,
          field: forbidden,
          present: false,
        });
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("strictly rejects identity fields supplied by the model", () => {
    for (const definition of TOOL_DEFINITIONS) {
      for (const forbidden of FORBIDDEN_IDENTITY_FIELDS) {
        const parsed = definition.schema.safeParse({
          ...VALID_INPUT[definition.name],
          [forbidden]: "attacker-controlled",
        });
        expect({ tool: definition.name, field: forbidden, ok: parsed.success }).toEqual({
          tool: definition.name,
          field: forbidden,
          ok: false,
        });
        if (!parsed.success) {
          expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
        }
      }
    }
  });
});

describe("executeTool", () => {
  it("refuses an unknown tool", async () => {
    const envelope = await executeTool({ name: "wire_money", input: {}, context: context() });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("UNKNOWN_TOOL");
  });

  it("refuses unknown fields on a known tool", async () => {
    const envelope = await executeTool({
      name: "financial_statements",
      input: { statement: "trial_balance", bookId: "other-book" },
      context: context(),
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("INVALID_INPUT");
  });

  it("stops every book-scoped tool when the tenant check denies access", async () => {
    const checked: string[] = [];
    const denied = async () => {
      checked.push("called");
      throw new ApiError(403, "FORBIDDEN", "Book not found in this workspace.");
    };

    for (const definition of TOOL_DEFINITIONS) {
      const envelope = await executeTool({
        name: definition.name,
        input: VALID_INPUT[definition.name],
        context: context(),
        deps: { assertBookTenant: denied },
      });

      if (definition.requiresBook) {
        expect({ tool: definition.name, ok: envelope.ok }).toEqual({ tool: definition.name, ok: false });
        if (!envelope.ok) {
          expect({ tool: definition.name, code: envelope.error.code }).toEqual({
            tool: definition.name,
            code: "FORBIDDEN",
          });
        }
      }
    }

    const bookScoped = TOOL_DEFINITIONS.filter((definition) => definition.requiresBook);
    expect(checked).toHaveLength(bookScoped.length);
    expect(bookScoped.length).toBeGreaterThan(0);
  });

  it("fails closed when an organization-owned book has no acceptable role", async () => {
    const envelope = await executeTool({
      name: "financial_statements",
      input: { statement: "trial_balance" },
      context: context({ auth: { ...auth, organizationRole: null } as AuthContext }),
      deps: {
        assertBookTenant: async () => ({ id: "book-1", organizationId: "org-1" }),
      },
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("FORBIDDEN");
  });

  it("refuses a book-scoped tool when the run has no selected book", async () => {
    const envelope = await executeTool({
      name: "financial_statements",
      input: { statement: "trial_balance" },
      context: context({ bookId: null }),
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("BOOK_REQUIRED");
  });

  it("does not expose a tool error stack to the model", async () => {
    const envelope = await executeTool({
      name: "financial_statements",
      input: { statement: "trial_balance" },
      context: context(),
      deps: {
        assertBookTenant: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        },
      },
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.message).not.toMatch(/ECONNREFUSED/);
      expect(envelope.error.message).not.toMatch(/\bat .*\.ts:\d+/);
    }
  });
});

describe("getToolDefinition", () => {
  it("is exact-name only", () => {
    expect(getToolDefinition("financial_statements")?.name).toBe("financial_statements");
    expect(getToolDefinition("Financial_Statements")).toBeUndefined();
    expect(getToolDefinition("submit_answer")).toBeUndefined();
  });
});
