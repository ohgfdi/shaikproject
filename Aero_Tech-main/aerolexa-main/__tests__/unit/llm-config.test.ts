/**
 * Out-of-the-box LLM configuration resolution.
 *
 * Anthropic is the only generation provider. A missing key must leave the
 * deployment unconfigured (callers degrade deterministically), while a key
 * selects the env-configured main/fast models with no hardcoded model names.
 * Env is read lazily and cached at module level, so each scenario re-imports
 * the providers module with `jest.resetModules()`.
 */

export {};

function baseEnv() {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
  process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.AI_MODEL_MAIN = "claude-main-test";
  process.env.AI_MODEL_FAST = "claude-fast-test";
  process.env.AI_TIMEOUT_MS = "";
  process.env.AI_MAX_RETRIES = "";
  process.env.AI_RETRY_BASE_DELAY_MS = "";
  for (const key of [
    "AI_COST_MAIN_INPUT_PER_MTOK",
    "AI_COST_MAIN_OUTPUT_PER_MTOK",
    "AI_COST_MAIN_CACHE_READ_PER_MTOK",
    "AI_COST_MAIN_CACHE_WRITE_PER_MTOK",
    "AI_COST_FAST_INPUT_PER_MTOK",
    "AI_COST_FAST_OUTPUT_PER_MTOK",
    "AI_COST_FAST_CACHE_READ_PER_MTOK",
    "AI_COST_FAST_CACHE_WRITE_PER_MTOK",
  ]) {
    process.env[key] = "";
  }
}

describe("resolveLLMConfig — Anthropic-only behavior", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv();
  });

  it("no key → unconfigured, configured model ids reported, source none", async () => {
    const { resolveLLMConfig } = await import("@/lib/llm/providers");
    expect(resolveLLMConfig()).toEqual({
      kind: "anthropic",
      model: "claude-main-test",
      fastModel: "claude-fast-test",
      apiKeyConfigured: false,
      source: "none",
    });
  });

  it("a key alone → configured with the env-named models", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { resolveLLMConfig } = await import("@/lib/llm/providers");
    expect(resolveLLMConfig()).toMatchObject({
      kind: "anthropic",
      model: "claude-main-test",
      fastModel: "claude-fast-test",
      apiKeyConfigured: true,
      source: "auto-key",
    });
  });

  it("a key without model ids fails fast instead of calling with an empty model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_MODEL_MAIN = "";
    const { resolveLLMConfig } = await import("@/lib/llm/providers");
    expect(() => resolveLLMConfig()).toThrow(/AI_MODEL_MAIN/);
  });

  it("AI_MODEL_MAIN / AI_MODEL_FAST override the defaults", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_MODEL_MAIN = "claude-main-test";
    process.env.AI_MODEL_FAST = "claude-fast-test";
    const { resolveLLMConfig } = await import("@/lib/llm/providers");
    expect(resolveLLMConfig()).toMatchObject({
      model: "claude-main-test",
      fastModel: "claude-fast-test",
    });
  });

  it("no key never fabricates a provider", async () => {
    const { getLiveLLMProvider, getAvailableLLMProvider } = await import("@/lib/llm/providers");
    expect(getLiveLLMProvider()).toBeNull();
    expect(await getAvailableLLMProvider()).toBeNull();
  });

  it("a key yields an Anthropic-backed provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { getLiveLLMProvider } = await import("@/lib/llm/providers");
    const provider = getLiveLLMProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("anthropic");
    expect(provider!.model).toBe("claude-main-test");
  });
});

describe("one-key setup end-to-end", () => {
  beforeEach(() => {
    jest.resetModules();
    baseEnv();
  });

  it("defaultChatModelId reflects the configured main model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_MODEL_MAIN = "claude-main-test";
    const { defaultChatModelId } = await import("@/lib/llm/providers");
    expect(defaultChatModelId()).toBe("anthropic:claude-main-test");
  });

  it("the chain starts with the main model and includes the fast model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { getChatProviderChain } = await import("@/lib/llm/providers");
    const chain = getChatProviderChain().map((p) => `${p.name}:${p.model}`);
    expect(chain).toEqual(["anthropic:claude-main-test", "anthropic:claude-fast-test"]);
  });

  it("a requested configured model is first; an unknown model is ignored", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { getChatProviderChain } = await import("@/lib/llm/providers");
    expect(getChatProviderChain("anthropic:claude-fast-test")[0]!.model).toBe("claude-fast-test");
    expect(getChatProviderChain("anthropic:not-configured")[0]!.model).toBe("claude-main-test");
  });

  it("the chain is empty without a key", async () => {
    const { getChatProviderChain } = await import("@/lib/llm/providers");
    expect(getChatProviderChain()).toEqual([]);
  });
});
