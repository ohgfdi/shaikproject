/**
 * Anthropic provider tests with a mocked SDK surface.
 *
 * These exercise the policy that lives in lib/ai/provider.ts — not the SDK:
 * prompt caching, tool mapping, timeout classification, retry/backoff,
 * 429/overload semantics, abort handling, usage/cost reporting and streaming.
 */

import { APIConnectionTimeoutError, APIError, RateLimitError } from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";

import { AnthropicProvider, AIProviderError, computeCost, type AnthropicLike, type AIUsage } from "@/lib/ai/provider";

function baseEnv() {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
  process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.AI_MODEL_MAIN = "claude-main-test";
  process.env.AI_MODEL_FAST = "claude-fast-test";
  process.env.AI_TIMEOUT_MS = "5000";
  process.env.AI_MAX_RETRIES = "2";
  process.env.AI_RETRY_BASE_DELAY_MS = "5";
}

beforeEach(baseEnv);

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-main-test",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  } as unknown as Message;
}

function sdkWith(create: jest.Mock, stream?: jest.Mock): AnthropicLike {
  return {
    messages: {
      create,
      stream: stream ?? jest.fn(),
    },
    models: { retrieve: jest.fn().mockResolvedValue({ id: "claude-main-test" }) },
  } as unknown as AnthropicLike;
}

function provider(
  create: jest.Mock,
  options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: "sk-ant-test",
    mainModel: "claude-main-test",
    fastModel: "claude-fast-test",
    timeoutMs: 5_000,
    maxRetries: 0,
    retryBaseDelayMs: 5,
    sleep: async () => {},
    sdk: sdkWith(create),
    ...options,
  });
}

const REQUEST = {
  system: "You are a careful accounting assistant.",
  messages: [{ role: "user" as const, content: "What is the balance?" }],
};

describe("AnthropicProvider — success and reporting", () => {
  it("returns text, tool calls, usage and a configured cost", async () => {
    const create = jest.fn().mockResolvedValue(
      message({
        content: [
          { type: "text", text: "Here is the balance." },
          { type: "tool_use", id: "tu_1", name: "get_balance", input: { account: "cash" } },
        ],
      }),
    );
    const p = provider(create, {
      mainPricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
    });

    const response = await p.generate(REQUEST);

    expect(response.text).toBe("Here is the balance.");
    expect(response.content).toEqual([
      { type: "text", text: "Here is the balance." },
      { type: "tool_use", id: "tu_1", name: "get_balance", input: { account: "cash" } },
    ]);
    expect(response.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 1_100,
    });
    // 1000 × $3/M + 100 × $15/M = $0.0045
    expect(response.costUsd).toBe(0.0045);
    expect(response.model).toBe("claude-main-test");
  });

  it("reports costUsd null when no prices are configured", async () => {
    const p = provider(jest.fn().mockResolvedValue(message()), {
      mainPricing: {},
      fastPricing: {},
    });
    const response = await p.generate(REQUEST);
    expect(response.costUsd).toBeNull();
  });

  it("computes cache-read and cache-write costs separately", () => {
    const usage: AIUsage = {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 10_000,
      totalTokens: 13_100,
    };
    const cost = computeCost(usage, {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    });
    // 0.003 + 0.0015 + 0.003 + 0.0075 = 0.015
    expect(cost).toBe(0.015);
  });
});

describe("AnthropicProvider — prompt caching and tools", () => {
  it("caches the static system prompt and maps tool definitions", async () => {
    const create = jest.fn().mockResolvedValue(message());
    const p = provider(create);

    await p.generate({
      ...REQUEST,
      tools: [
        {
          name: "get_balance",
          description: "Read an account balance",
          inputSchema: {
            type: "object",
            properties: { account: { type: "string" } },
            required: ["account"],
          },
        },
      ],
      toolChoice: "auto",
    });

    const body = create.mock.calls[0]![0] as MessageCreateParamsNonStreaming;
    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are a careful accounting assistant.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(body.tools).toEqual([
      {
        name: "get_balance",
        description: "Read an account balance",
        input_schema: {
          type: "object",
          properties: { account: { type: "string" } },
          required: ["account"],
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("caches the tool prefix when there is no system prompt", async () => {
    const create = jest.fn().mockResolvedValue(message());
    const p = provider(create);

    await p.generate({
      messages: [{ role: "user", content: "balance?" }],
      tools: [
        { name: "a", description: "a", inputSchema: { type: "object" } },
        { name: "b", description: "b", inputSchema: { type: "object" } },
      ],
    });

    const body = create.mock.calls[0]![0] as MessageCreateParamsNonStreaming;
    expect(body.tools?.[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  it("disables parallel tool use only when explicitly requested", async () => {
    const create = jest.fn().mockResolvedValue(message());
    const p = provider(create);
    await p.generate({
      ...REQUEST,
      tools: [{ name: "x", description: "x", inputSchema: { type: "object" } }],
      toolChoice: "any",
      parallelToolCalls: false,
    });
    expect((create.mock.calls[0]![0] as MessageCreateParamsNonStreaming).tool_choice).toEqual({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });

  it("maps structured tool_result blocks", async () => {
    const create = jest.fn().mockResolvedValue(message({ content: [{ type: "text", text: "ok" }] }));
    const p = provider(create);
    await p.generate({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: "42" }],
        },
      ],
    });
    const body = create.mock.calls[0]![0] as MessageCreateParamsNonStreaming;
    expect(body.messages[0]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: "42" }]);
  });
});

describe("AnthropicProvider — errors, timeouts and retries", () => {
  it("throws MISSING_API_KEY without calling the SDK", async () => {
    const create = jest.fn();
    const p = provider(create, { apiKey: "" });
    await expect(p.generate(REQUEST)).rejects.toMatchObject({
      name: "AIProviderError",
      code: "MISSING_API_KEY",
      retryable: false,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("classifies a timeout and does not retry beyond maxRetries", async () => {
    const create = jest.fn(
      (_body: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new APIConnectionTimeoutError()));
        }),
    );
    const p = provider(create, { timeoutMs: 10, maxRetries: 0 });
    await expect(p.generate(REQUEST)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries 429 twice with exponential backoff, then succeeds", async () => {
    const rateLimited = () =>
      new RateLimitError(
        429,
        { error: { type: "rate_limit_error", message: "slow down" } },
        "slow down",
        new Headers(),
        "rate_limit_error",
      );
    const create = jest
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(message());
    const sleeps: number[] = [];
    const p = provider(create, {
      maxRetries: 2,
      retryBaseDelayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const response = await p.generate(REQUEST);
    expect(response.text).toBe("Hello");
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5, 10]);
  });

  it("surfaces RATE_LIMITED after retries are exhausted", async () => {
    const rateLimited = () =>
      new RateLimitError(
        429,
        { error: { type: "rate_limit_error", message: "slow down" } },
        "slow down",
        new Headers(),
        "rate_limit_error",
      );
    const create = jest.fn().mockRejectedValue(rateLimited());
    const p = provider(create, { maxRetries: 1, retryBaseDelayMs: 1 });

    await expect(p.generate(REQUEST)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry an invalid request", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        new APIError(
          400,
          { error: { type: "invalid_request_error", message: "bad input" } },
          "bad input",
          new Headers(),
          "invalid_request_error",
        ),
      );
    const p = provider(create, { maxRetries: 2 });
    await expect(p.generate(REQUEST)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("classifies a rejected key as AUTHENTICATION and never echoes the key", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        new APIError(
          401,
          { error: { type: "authentication_error", message: "invalid x-api-key" } },
          "invalid x-api-key",
          new Headers(),
          "authentication_error",
        ),
      );
    const p = provider(create, { maxRetries: 2 });
    const error = await p.generate(REQUEST).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "AUTHENTICATION", retryable: false });
    expect((error as Error).message).not.toContain("sk-ant-test");
    expect(JSON.stringify(error)).not.toContain("sk-ant-test");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("classifies overload as retryable OVERLOADED", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        new APIError(
          529,
          { error: { type: "overloaded_error", message: "overloaded" } },
          "overloaded",
          new Headers(),
          "overloaded_error",
        ),
      );
    const p = provider(create, { maxRetries: 0 });
    await expect(p.generate(REQUEST)).rejects.toMatchObject({
      code: "OVERLOADED",
      retryable: true,
    });
  });

  it("honours an already-aborted caller signal without calling the SDK", async () => {
    const create = jest.fn();
    const controller = new AbortController();
    controller.abort();
    const p = provider(create);
    await expect(p.generate(REQUEST, { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
      retryable: false,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("AIProviderError is a real Error subclass", () => {
    const error = new AIProviderError("x", { code: "API_ERROR" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AIProviderError");
  });
});

describe("AnthropicProvider — streaming", () => {
  it("yields text deltas and a done event", async () => {
    async function* events() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
      yield { type: "message_stop" };
    }
    const stream = jest.fn().mockReturnValue(events());
    const p = provider(jest.fn(), { sdk: sdkWith(jest.fn(), stream) });

    const received: string[] = [];
    for await (const event of p.stream(REQUEST)) {
      if (event.type === "text_delta") received.push(event.text);
      else if (event.type === "done") received.push("|done");
    }
    expect(received).toEqual(["Hel", "lo", "|done"]);
    expect(stream.mock.calls[0]![0]).toMatchObject({ stream: true, model: "claude-main-test" });
  });
});

describe("AnthropicProvider — reachability", () => {
  it("is configured with a key and probes the configured model", async () => {
    const retrieve = jest.fn().mockResolvedValue({ id: "claude-main-test" });
    const p = new AnthropicProvider({
      apiKey: "sk-ant-test",
      mainModel: "claude-main-test",
      fastModel: "claude-fast-test",
      sdk: {
        messages: { create: jest.fn(), stream: jest.fn() },
        models: { retrieve },
      } as unknown as AnthropicLike,
    });
    expect(p.isConfigured()).toBe(true);
    expect(await p.probe()).toBe(true);
    expect(retrieve).toHaveBeenCalledWith("claude-main-test", { timeout: 5_000 });
  });

  it("probe returns false without a key or when the API rejects the model", async () => {
    const noKey = new AnthropicProvider({
      apiKey: "",
      sdk: {
        messages: { create: jest.fn(), stream: jest.fn() },
        models: { retrieve: jest.fn() },
      } as unknown as AnthropicLike,
    });
    expect(await noKey.probe()).toBe(false);

    const rejected = new AnthropicProvider({
      apiKey: "sk-ant-test",
      mainModel: "nope",
      fastModel: "nope",
      sdk: {
        messages: { create: jest.fn(), stream: jest.fn() },
        models: { retrieve: jest.fn().mockRejectedValue(new Error("404")) },
      } as unknown as AnthropicLike,
    });
    expect(await rejected.probe()).toBe(false);
  });
});
