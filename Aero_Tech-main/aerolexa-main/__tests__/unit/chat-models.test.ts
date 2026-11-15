/**
 * Copilot model catalogue + provider chain. Env is read lazily and cached at
 * module level, so each scenario re-imports the providers module with
 * `jest.resetModules()` to control which models are configured.
 */

import type { LLMProvider, LLMRequest, LLMResponse } from "@/lib/llm/providers";

type ProvidersModule = typeof import("@/lib/llm/providers");

function baseEnv() {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
  process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.AI_MODEL_MAIN = "claude-main-test";
  process.env.AI_MODEL_FAST = "claude-fast-test";
}

function fakeProvider(name: string, model: string, reachable: boolean): LLMProvider {
  return {
    name,
    model,
    isAvailable: async () => reachable,
    generate: async (_request: LLMRequest): Promise<LLMResponse> => ({
      content: "",
      provider: name,
      model,
      latencyMs: 0,
    }),
  };
}

describe("chat models — option builders", () => {
  it("buildChatModelOption returns a stable provider:model id", () => {
    const { buildChatModelOption } = jest.requireActual<ProvidersModule>("@/lib/llm/providers");
    const opt = buildChatModelOption("anthropic", "claude-sonnet-5-5", true, true);
    expect(opt).toEqual({
      id: "anthropic:claude-sonnet-5-5",
      provider: "anthropic",
      label: "Claude · claude-sonnet-5-5",
      model: "claude-sonnet-5-5",
      reachable: true,
      default: true,
    });
  });

  it("parseChatModelId round-trips and rejects malformed/non-Anthropic ids", () => {
    const { parseChatModelId } = jest.requireActual<ProvidersModule>("@/lib/llm/providers");
    expect(parseChatModelId("anthropic:claude-sonnet-5-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(parseChatModelId("anthropic:model:v2")).toEqual({
      provider: "anthropic",
      model: "model:v2",
    });
    expect(parseChatModelId("ollama:llama3.2")).toBeNull();
    expect(parseChatModelId("openai:gpt-4o-mini")).toBeNull();
    expect(parseChatModelId("claude-sonnet-5-5")).toBeNull();
    expect(parseChatModelId("anthropic:")).toBeNull();
    expect(parseChatModelId("")).toBeNull();
    expect(parseChatModelId(null)).toBeNull();
  });
});

describe("chat models — env-driven defaults", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv();
  });

  it("no key yields no selectable models", async () => {
    const { listChatModels } = await import("@/lib/llm/providers");
    expect(await listChatModels(false)).toEqual([]);
  });

  it("listChatModels with probe=false exposes the configured main + fast models", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { listChatModels } = await import("@/lib/llm/providers");
    expect(await listChatModels(false)).toEqual([
      {
        id: "anthropic:claude-main-test",
        provider: "anthropic",
        label: "Claude · claude-main-test",
        model: "claude-main-test",
        reachable: false,
        default: true,
      },
      {
        id: "anthropic:claude-fast-test",
        provider: "anthropic",
        label: "Claude · claude-fast-test",
        model: "claude-fast-test",
        reachable: false,
        default: false,
      },
    ]);
  });

  it("identical main/fast models are listed once", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_MODEL_MAIN = "same-model";
    process.env.AI_MODEL_FAST = "same-model";
    const { listChatModels } = await import("@/lib/llm/providers");
    expect((await listChatModels(false)).map((m) => m.model)).toEqual(["same-model"]);
  });
});

describe("chat models — availability", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv();
  });

  it("firstAvailableLLMProvider returns the first reachable candidate", async () => {
    const { firstAvailableLLMProvider } = await import("@/lib/llm/providers");
    const blocked = fakeProvider("anthropic", "blocked-model", false);
    const reachable = fakeProvider("anthropic", "reachable-model", true);
    expect(await firstAvailableLLMProvider([blocked, reachable])).toBe(reachable);
  });

  it("firstAvailableLLMProvider returns null when all candidates fail", async () => {
    const { firstAvailableLLMProvider } = await import("@/lib/llm/providers");
    expect(await firstAvailableLLMProvider([fakeProvider("anthropic", "down", false)])).toBeNull();
  });
});
