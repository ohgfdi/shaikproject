/**
 * Application-facing LLM abstraction.
 *
 * Anthropic (Claude) is the only chat/generation provider. The old
 * Ollama/OpenAI-compatible classes were removed once every caller had been
 * routed through lib/ai/provider.ts; this module is now a thin adapter that
 * preserves the interfaces the rest of the app already consumes.
 *
 * Honesty rules:
 * - Providers report only facts (content, model, token usage, latency, cost
 *   when pricing is configured). They do NOT emit a "confidence" score.
 * - `getLiveLLMProvider()` returns null when ANTHROPIC_API_KEY is absent, and
 *   callers degrade to their deterministic engines. Nothing pretends to be a
 *   model.
 */

import { AnthropicProvider, type AIRequest, type AIResponse } from "@/lib/ai/provider";
import { serverEnv } from "@/lib/env";

export interface LLMProvider {
  name: string;
  /** Human-readable model identifier reported to callers (the configured id). */
  readonly model: string;
  isAvailable(): Promise<boolean>;
  /** Real reachability/credentials probe, when the provider supports one. */
  probe?(): Promise<boolean>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** Optional token streaming. */
  generateStream?(request: LLMRequest): AsyncGenerator<string, void, unknown>;
}

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  tokensUsed?: number;
  latencyMs: number;
  /** USD, or undefined when no price is configured for this model. */
  costUsd?: number | null;
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

export class AnthropicLLMProvider implements LLMProvider {
  name = "anthropic";
  readonly model: string;
  private readonly client: AnthropicProvider;

  constructor(client: AnthropicProvider, model?: string) {
    this.client = client;
    this.model = model || client.mainModel;
  }

  isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  probe(): Promise<boolean> {
    return this.client.probe();
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.client.generate(this.toAIRequest(request));
    return toLLMResponse(response);
  }

  async *generateStream(request: LLMRequest): AsyncGenerator<string, void, unknown> {
    for await (const event of this.client.stream(this.toAIRequest(request))) {
      if (event.type === "text_delta") yield event.text;
    }
  }

  private toAIRequest(request: LLMRequest): AIRequest {
    return {
      model: this.model,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userPrompt }],
      maxTokens: request.maxTokens ?? 1_024,
      temperature: request.temperature ?? 0.2,
      ...(request.timeout ? { timeoutMs: request.timeout } : {}),
    };
  }
}

function toLLMResponse(response: AIResponse): LLMResponse {
  return {
    content: response.text,
    provider: "anthropic",
    model: response.model,
    tokensUsed: response.usage.totalTokens,
    latencyMs: response.latencyMs,
    costUsd: response.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

export type LLMProviderKind = "anthropic";

export interface LLMConfig {
  kind: LLMProviderKind;
  model: string;
  fastModel: string;
  apiKeyConfigured: boolean;
  /** How this configuration was arrived at — surfaced by /api/llm/status. */
  source: "auto-key" | "none";
}

/**
 * The single source of truth for "which live model is this deployment using?"
 *
 * There is one provider: Anthropic. The key and model IDs come from env
 * (ANTHROPIC_API_KEY, AI_MODEL_MAIN, AI_MODEL_FAST). No model name is
 * hardcoded in feature code. `source: "none"` means no key is configured;
 * callers degrade to the deterministic engines.
 */
export function resolveLLMConfig(): LLMConfig {
  const env = serverEnv();
  return {
    kind: "anthropic",
    model: env.AI_MODEL_MAIN,
    fastModel: env.AI_MODEL_FAST,
    apiKeyConfigured: env.ANTHROPIC_API_KEY.length > 0,
    source: env.ANTHROPIC_API_KEY ? "auto-key" : "none",
  };
}

/**
 * Resolve the configured provider, or null when no key is configured.
 * Callers MUST null-check and degrade to their deterministic path.
 */
export function getLiveLLMProvider(): LLMProvider | null {
  const cfg = resolveLLMConfig();
  if (!cfg.apiKeyConfigured) return null;
  return new AnthropicLLMProvider(new AnthropicProvider(), cfg.model);
}

/**
 * Availability means "credentials are configured". Reachability is a separate
 * network probe (`probe()`), used by the status UI, so a transient probe
 * failure never blocks an actual generation attempt.
 */
export async function getAvailableLLMProvider(): Promise<LLMProvider | null> {
  const provider = getLiveLLMProvider();
  if (!provider) return null;
  return (await provider.isAvailable()) ? provider : null;
}

/** Retained for the status route's cache-reset call; configuration is static. */
export function resetLLMAvailabilityCache(): void {
  // No cache: env is read once per process by lib/env.ts.
}

// ---------------------------------------------------------------------------
// Copilot model catalogue & provider chain
// ---------------------------------------------------------------------------

/** A selectable model the copilot UI offers. */
export interface ChatModelOption {
  /** Stable id in "provider:model" form, e.g. "anthropic:<model-id>". */
  id: string;
  provider: "anthropic";
  label: string;
  model: string;
  /** True when a live probe confirmed the model's endpoint responds. */
  reachable: boolean;
  /** True for the env-configured main model; the UI preselects this one. */
  default: boolean;
}

export function buildChatModelOption(
  provider: "anthropic",
  model: string,
  reachable: boolean,
  isDefault = false,
): ChatModelOption {
  return {
    id: `${provider}:${model}`,
    provider,
    label: `Claude · ${model}`,
    model,
    reachable,
    default: isDefault,
  };
}

/** Split a "provider:model" id into its parts, or null when malformed. */
export function parseChatModelId(id: string | undefined | null): { provider: "anthropic"; model: string } | null {
  if (!id) return null;
  const [provider, ...rest] = id.split(":");
  const model = rest.join(":").trim();
  if (provider === "anthropic" && model) return { provider, model };
  return null;
}

/** The model id the server is configured with, or "" when Claude is off. */
export function defaultChatModelId(): string {
  const cfg = resolveLLMConfig();
  return cfg.apiKeyConfigured ? `anthropic:${cfg.model}` : "";
}

/**
 * Ordered, de-duplicated provider chain for a chat turn: the requested model
 * (only when it is one of the two configured models), then the env main model,
 * then the fast model. Restricting to configured models prevents a client
 * from selecting an arbitrary, unbudgeted model id.
 */
export function getChatProviderChain(modelId?: string): LLMProvider[] {
  const cfg = resolveLLMConfig();
  if (!cfg.apiKeyConfigured) return [];

  const allowed = new Set([cfg.model, cfg.fastModel]);
  const requested = parseChatModelId(modelId)?.model;
  const seen = new Set<string>();
  const chain: LLMProvider[] = [];

  for (const model of [requested, cfg.model, cfg.fastModel]) {
    if (!model || !allowed.has(model) || seen.has(model)) continue;
    seen.add(model);
    chain.push(new AnthropicLLMProvider(new AnthropicProvider({ mainModel: model, fastModel: model }), model));
  }
  return chain;
}

/** Probe each provider in order and return the first configured one (or null). */
export async function firstAvailableLLMProvider(chain: LLMProvider[]): Promise<LLMProvider | null> {
  for (const provider of chain) {
    try {
      if (await provider.isAvailable()) return provider;
    } catch {
      // Unreachable candidate — keep walking the chain.
    }
  }
  return null;
}

/**
 * The real, selectable models. Never throws: a missing key yields an empty
 * list; an unreachable API yields options with `reachable: false`. When
 * `probe` is false no network call is made.
 */
export async function listChatModels(probe = true): Promise<ChatModelOption[]> {
  const cfg = resolveLLMConfig();
  if (!cfg.apiKeyConfigured) return [];

  const models = [...new Set([cfg.model, cfg.fastModel])];
  const reachable = probe
    ? await Promise.all(models.map((model) => new AnthropicProvider({ mainModel: model, fastModel: model }).probe()))
    : models.map(() => false);

  return models.map((model, index) => buildChatModelOption("anthropic", model, reachable[index] ?? false, index === 0));
}
