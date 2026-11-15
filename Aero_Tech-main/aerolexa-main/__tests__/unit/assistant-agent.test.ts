/**
 * Bounded agent loop — limit and correction tests.
 *
 * The model client is fully injected, so these tests exercise the loop's
 * accounting (tool-call cap, duplicate detection, wall/token/cost ceilings,
 * cancellation and the one correction retry) without a network or database.
 */

import { runAssistantAgent, type ModelClient } from "@/lib/ai/agent";
import type { AIResponse, AIToolUseBlock } from "@/lib/ai/provider";
import type { AssistantContext } from "@/lib/ai/tools/types";
import type { AuthContext } from "@/lib/auth/guard";

const auth = {
  user: { id: "user-1" },
  workspace: { id: "workspace-1" },
  settings: {},
  organization: null,
  organizationRole: null,
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

function response(blocks: AIResponse["content"], overrides: Partial<AIResponse> = {}): AIResponse {
  return {
    id: "msg-1",
    model: "test-model",
    content: blocks,
    text: blocks
      .filter((block): block is Extract<AIResponse["content"][number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(""),
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 15,
    },
    costUsd: 0,
    latencyMs: 1,
    ...overrides,
  };
}

function toolUse(name: string, input: Record<string, unknown>, id = `tool-${name}`): AIToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function providerWith(responses: AIResponse[]): ModelClient & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async generate() {
      this.calls += 1;
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!next) throw new Error("no scripted response");
      return next;
    },
  };
}

const options = {
  question: "What is the revenue?",
  system: "system",
};

describe("runAssistantAgent limits", () => {
  it("stops before exceeding the tool-call cap", async () => {
    const provider = providerWith([
      response([toolUse("no_such_tool", {}, "a"), toolUse("also_no_such_tool", {}, "b")]),
    ]);

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      limits: { maxToolCalls: 1 },
    });

    expect(result.status).toBe("limit");
    expect(result.errorCode).toBe("TOOL_CALL_LIMIT");
    expect(result.toolCallCount).toBe(0);
    expect(result.answer).toBeNull();
  });

  it("stops on an identical repeated tool call", async () => {
    const provider = providerWith([
      response([toolUse("no_such_tool", { period: "2025-04" }, "a")]),
      response([toolUse("no_such_tool", { period: "2025-04" }, "b")]),
    ]);

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      limits: { maxToolCalls: 8 },
    });

    expect(result.status).toBe("limit");
    expect(result.errorCode).toBe("REPEATED_TOOL_CALL");
    expect(result.toolCallCount).toBe(1);
  });

  it("stops at the wall-clock deadline", async () => {
    const provider = providerWith([response([{ type: "text", text: "thinking" }])]);
    let clock = 1_000;

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      now: () => {
        clock += 2_000;
        return clock;
      },
      limits: { maxWallMs: 1_000 },
    });

    expect(result.status).toBe("limit");
    expect(result.answer).toBeNull();
  });

  it("stops when output tokens exceed the run budget", async () => {
    const provider = providerWith([
      response([{ type: "text", text: "thinking" }], {
        usage: {
          inputTokens: 10,
          outputTokens: 5_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 5_010,
        },
      }),
    ]);

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      limits: { maxOutputTokens: 100, maxWallMs: 60_000 },
    });

    expect(result.status).toBe("limit");
    expect(result.answer).toBeNull();
  });

  it("stops when the configured cost cap is exceeded", async () => {
    const provider = providerWith([response([{ type: "text", text: "thinking" }], { costUsd: 1.5 })]);

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      limits: { maxCostUsd: 0.01, maxToolCalls: 8 },
    });

    expect(result.status).toBe("limit");
    expect(result.costUsd).toBe(1.5);
  });

  it("reports cancelled runs as aborted", async () => {
    const provider = providerWith([response([{ type: "text", text: "never used" }])]);
    const controller = new AbortController();
    controller.abort();

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context({ signal: controller.signal }),
    });

    expect(result.status).toBe("aborted");
    expect(provider.calls).toBe(0);
  });
});

describe("runAssistantAgent verification", () => {
  it("asks for exactly one correction, then stops honestly if verification fails again", async () => {
    const fabricated = {
      answer: "Revenue was ₹9,99,999.",
      claims: [{ text: "Revenue was ₹9,99,999.", result_ids: ["tr_doesnotexist"] }],
    };
    const provider = providerWith([
      response([toolUse("no_such_tool", {}, "a")]),
      response([toolUse("submit_answer", fabricated, "submit-1")]),
      response([toolUse("submit_answer", fabricated, "submit-2")]),
    ]);

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      limits: { maxToolCalls: 8 },
    });

    expect(provider.calls).toBe(3);
    expect(result.status).toBe("verification_failed");
    expect(result.answer).toBeNull();
    expect(result.message).toMatch(/could not produce a verified answer/i);
  });

  it("shows an honest answer after a corrected submission", async () => {
    const honest = {
      answer: "I cannot determine that with the tools I have.",
      claims: [],
    };
    const provider = providerWith([
      response([toolUse("no_such_tool", {}, "a")]),
      response([toolUse("submit_answer", { answer: "Revenue was ₹1.", claims: [] }, "submit-1")]),
      response([toolUse("submit_answer", honest, "submit-2")]),
    ]);

    const result = await runAssistantAgent({
      ...options,
      provider,
      context: context(),
      limits: { maxToolCalls: 8 },
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toBe(honest.answer);
    expect(result.verification?.ok).toBe(true);
  });
});
