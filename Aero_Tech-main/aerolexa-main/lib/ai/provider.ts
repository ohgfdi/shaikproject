/**
 * Anthropic (Claude) provider — the only chat/generation integration.
 *
 * Design rules:
 * - Server-only. The API key is read from env and never logged, serialised
 *   into a response, or passed to a client component.
 * - Typed failures. Callers can distinguish a missing key, a rate limit, an
 *   overloaded API, an invalid request, a timeout, and an abort instead of
 *   parsing strings.
 * - Bounded retries with exponential backoff for transient errors. Every
 *   attempt is independently abortable.
 * - Prompt caching for the static system prompt and tool definitions. The
 *   cache breakpoint sits on the system block (which follows tools in
 *   Anthropic's prompt order), so one breakpoint covers both prefixes.
 * - Parallel tool calls are enabled by default; callers that must serialise
 *   them can pass `parallelToolCalls: false`.
 * - Cost is reported only from configured per-million-token prices. Unknown
 *   pricing yields `costUsd: null` rather than a fabricated number.
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  Tool,
  ToolChoice,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import { serverEnv } from "@/lib/env";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AIErrorCode =
  | "MISSING_API_KEY"
  | "AUTHENTICATION"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK"
  | "API_ERROR";

export interface AIProviderErrorOptions {
  code: AIErrorCode;
  status?: number;
  retryable?: boolean;
  requestId?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

/** A typed provider failure. `message` never contains credentials. */
export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: AIProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AIProviderError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AITextBlock {
  type: "text";
  text: string;
}

export interface AIToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AIToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type AIContentBlock = AITextBlock | AIToolUseBlock | AIToolResultBlock;

export interface AIMessage {
  role: "user" | "assistant";
  content: string | AIContentBlock[];
}

export interface AIToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input; must describe an object. */
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export type AIToolChoice = "auto" | "any" | "none" | { name: string };

export interface AIRequest {
  /** Explicit model id. Omit to use the configured main model. */
  model?: string;
  system?: string;
  messages: AIMessage[];
  tools?: AIToolDefinition[];
  toolChoice?: AIToolChoice;
  /** Defaults to true; Anthropic emits independent tool calls in one turn. */
  parallelToolCalls?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Cache the static system prompt + tool definitions. Defaults to true. */
  cache?: boolean;
  /** Opaque end-user id for abuse detection; never an email or name. */
  metadata?: { userId?: string };
  /** Per-request timeout override. */
  timeoutMs?: number;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
}

export interface AIResponse {
  id: string;
  model: string;
  content: AIContentBlock[];
  /** Concatenated text blocks; empty when the model only called tools. */
  text: string;
  stopReason: string | null;
  usage: AIUsage;
  /** USD, or null when the deployment has not configured prices. */
  costUsd: number | null;
  latencyMs: number;
  requestId?: string;
}

export type AIStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_input_delta"; partialJson: string }
  | { type: "usage"; usage: Partial<AIUsage> }
  | { type: "done" };

export interface AIPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  mainModel?: string;
  fastModel?: string;
  timeoutMs?: number;
  /** Retries after the first attempt (0 disables retries). */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  mainPricing?: AIPricing;
  fastPricing?: AIPricing;
  /** Injectable for deterministic tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable SDK surface for tests; defaults to a real Anthropic client. */
  sdk?: AnthropicLike;
}

/** The subset of the SDK this provider uses. Lets tests pass a small fake. */
export interface AnthropicLike {
  messages: {
    create(
      body: MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Message>;
    stream(
      body: MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): AsyncIterable<{
      type: string;
      delta?: { type?: string; text?: string; partial_json?: string };
      content_block?: { type?: string; id?: string; name?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
  models: {
    retrieve(model: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 8_000;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider {
  readonly mainModel: string;
  readonly fastModel: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly mainPricing: AIPricing;
  private readonly fastPricing: AIPricing;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly client: AnthropicLike;

  constructor(options: AnthropicProviderOptions = {}) {
    const env = serverEnv();
    this.apiKey = options.apiKey ?? env.ANTHROPIC_API_KEY;
    this.mainModel = options.mainModel || env.AI_MODEL_MAIN;
    this.fastModel = options.fastModel || env.AI_MODEL_FAST;
    this.timeoutMs = options.timeoutMs ?? env.AI_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? env.AI_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? env.AI_RETRY_BASE_DELAY_MS;
    this.mainPricing = options.mainPricing ?? pricingFromEnv("MAIN");
    this.fastPricing = options.fastPricing ?? pricingFromEnv("FAST");
    this.sleep = options.sleep ?? defaultSleep;
    this.client =
      options.sdk ??
      (new Anthropic({
        apiKey: this.apiKey || "missing-key",
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        // Retries are owned by this class so the policy is observable/tested.
        maxRetries: 0,
        timeout: this.timeoutMs,
      }) as unknown as AnthropicLike);
  }

  /** True when an API key is present. No network call. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Interface-compatible alias used by the app's provider abstraction. */
  async isAvailable(): Promise<boolean> {
    return this.isConfigured();
  }

  /**
   * Real reachability check for status UIs: validates the key and the
   * configured model with a cheap Models API call. Never throws.
   */
  async probe(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.client.models.retrieve(this.mainModel, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async generate(request: AIRequest, options: { signal?: AbortSignal } = {}): Promise<AIResponse> {
    if (!this.isConfigured()) throw missingKeyError();
    const model = this.resolveModel(request.model);
    const params = this.buildParams(request, model);

    return this.withRetry(async (signal) => {
      const started = Date.now();
      const message = await this.callOnce(params, signal, request.timeoutMs);
      return this.toResponse(message, model, Date.now() - started);
    }, options.signal);
  }

  /**
   * Stream text/tool events. Streaming is attempted once: replaying after a
   * partial answer would duplicate output. Non-streaming `generate` carries
   * the retry policy.
   */
  async *stream(request: AIRequest, options: { signal?: AbortSignal } = {}): AsyncGenerator<AIStreamEvent> {
    if (!this.isConfigured()) throw missingKeyError();
    const model = this.resolveModel(request.model);
    const params = { ...this.buildParams(request, model), stream: true } as MessageCreateParamsStreaming;
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const { signal, cleanup } = linkAbort(options.signal, timeoutMs);

    try {
      const stream = this.client.messages.stream(params, { signal, timeout: timeoutMs });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          yield {
            type: "tool_use_start",
            id: event.content_block.id ?? "",
            name: event.content_block.name ?? "",
          };
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          yield { type: "tool_input_delta", partialJson: event.delta.partial_json ?? "" };
        } else if (event.type === "message_delta" && event.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
            },
          };
        } else if (event.type === "message_stop") {
          yield { type: "done" };
        }
      }
    } catch (error) {
      throw this.classifyError(error, options.signal);
    } finally {
      cleanup();
    }
  }

  // -------------------------------------------------------------------------
  // Request construction
  // -------------------------------------------------------------------------

  private resolveModel(requested?: string): string {
    if (!requested) return this.mainModel;
    return requested;
  }

  private buildParams(request: AIRequest, model: string): MessageCreateParamsNonStreaming {
    const { system, messages } = splitSystemMessages(request.system, request.messages);
    if (messages.length === 0) {
      throw new AIProviderError("A request needs at least one user or assistant message.", {
        code: "INVALID_REQUEST",
      });
    }

    const tools = request.tools?.length ? request.tools.map(toWireTool) : undefined;
    const cache = request.cache !== false;
    if (cache && tools?.length && !system) {
      // No system block to anchor the breakpoint on: cache the tool prefix.
      tools[tools.length - 1] = {
        ...tools[tools.length - 1]!,
        cache_control: { type: "ephemeral" },
      };
    }

    return {
      model,
      max_tokens: request.maxTokens ?? 2_048,
      messages: messages.map(toWireMessage),
      ...(tools ? { tools } : {}),
      ...(system
        ? {
            system: cache
              ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
              : system,
          }
        : {}),
      ...(request.toolChoice
        ? { tool_choice: toWireToolChoice(request.toolChoice, request.parallelToolCalls !== false) }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.metadata?.userId ? { metadata: { user_id: request.metadata.userId } } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Calls, retries, timeouts
  // -------------------------------------------------------------------------

  private async callOnce(
    params: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
    timeoutOverride?: number,
  ): Promise<Message> {
    const timeoutMs = timeoutOverride ?? this.timeoutMs;
    const { signal: linked, cleanup, timedOut } = linkAbort(signal, timeoutMs);
    try {
      return await this.client.messages.create(params, { signal: linked, timeout: timeoutMs });
    } catch (error) {
      if (timedOut()) {
        throw new AIProviderError(`Anthropic did not respond within ${timeoutMs}ms.`, {
          code: "TIMEOUT",
          retryable: true,
          cause: error,
        });
      }
      throw this.classifyError(error, signal);
    } finally {
      cleanup();
    }
  }

  private async withRetry<T>(
    attempt: (signal: AbortSignal) => Promise<T>,
    callerSignal: AbortSignal | undefined,
  ): Promise<T> {
    let lastError: AIProviderError | null = null;
    for (let index = 0; index <= this.maxRetries; index += 1) {
      if (callerSignal?.aborted) throw abortedError();
      try {
        return await attempt(callerSignal ?? new AbortController().signal);
      } catch (error) {
        const typed = error instanceof AIProviderError ? error : this.classifyError(error, callerSignal);
        lastError = typed;
        if (!typed.retryable || index === this.maxRetries || callerSignal?.aborted) throw typed;

        const backoff = Math.min(MAX_BACKOFF_MS, this.retryBaseDelayMs * 2 ** index);
        await this.wait(typed.retryAfterMs ?? backoff, callerSignal);
      }
    }
    throw lastError ?? new AIProviderError("Anthropic request failed.", { code: "API_ERROR" });
  }

  private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) return;
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(abortedError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // Errors and response mapping
  // -------------------------------------------------------------------------

  private classifyError(error: unknown, callerSignal?: AbortSignal): AIProviderError {
    if (error instanceof AIProviderError) return error;
    if (callerSignal?.aborted) return abortedError();

    if (error instanceof APIUserAbortError) return abortedError();
    if (error instanceof APIConnectionTimeoutError) {
      return new AIProviderError("Anthropic connection timed out.", {
        code: "TIMEOUT",
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof RateLimitError) {
      return new AIProviderError("Anthropic rate limit reached. Retry shortly.", {
        code: "RATE_LIMITED",
        status: 429,
        retryable: true,
        requestId: error.requestID ?? undefined,
        retryAfterMs: retryAfterFrom(error.headers),
        cause: error,
      });
    }
    if (error instanceof InternalServerError) {
      return new AIProviderError("Anthropic is overloaded or unavailable. Retry shortly.", {
        code: "OVERLOADED",
        status: error.status,
        retryable: true,
        requestId: error.requestID ?? undefined,
        cause: error,
      });
    }
    if (error instanceof APIConnectionError) {
      return new AIProviderError("Could not reach Anthropic. Check the server's network.", {
        code: "NETWORK",
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof APIError) {
      const status = error.status;
      const requestId = error.requestID ?? undefined;
      if (status === 401) {
        return new AIProviderError("Anthropic rejected the API key.", {
          code: "AUTHENTICATION",
          status,
          retryable: false,
          requestId,
          cause: error,
        });
      }
      if (status === 429) {
        return new AIProviderError("Anthropic rate limit reached. Retry shortly.", {
          code: "RATE_LIMITED",
          status,
          retryable: true,
          requestId,
          retryAfterMs: retryAfterFrom(error.headers),
          cause: error,
        });
      }
      if (status === 529 || status === 503) {
        return new AIProviderError("Anthropic is overloaded. Retry shortly.", {
          code: "OVERLOADED",
          status,
          retryable: true,
          requestId,
          cause: error,
        });
      }
      if (status !== undefined && status >= 500) {
        return new AIProviderError(`Anthropic returned HTTP ${status}.`, {
          code: "API_ERROR",
          status,
          retryable: true,
          requestId,
          cause: error,
        });
      }
      if (status !== undefined && status >= 400) {
        return new AIProviderError(`Anthropic rejected the request (HTTP ${status}).`, {
          code: "INVALID_REQUEST",
          status,
          retryable: false,
          requestId,
          cause: error,
        });
      }
      return new AIProviderError("Anthropic request failed.", {
        code: "API_ERROR",
        status,
        retryable: false,
        requestId,
        cause: error,
      });
    }
    return new AIProviderError("Anthropic request failed before a response was received.", {
      code: "NETWORK",
      retryable: true,
      cause: error,
    });
  }

  private toResponse(message: Message, model: string, latencyMs: number): AIResponse {
    const content: AIContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const usage: AIUsage = {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      totalTokens:
        (message.usage.input_tokens ?? 0) +
        (message.usage.output_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0),
    };

    return {
      id: message.id,
      model: message.model || model,
      content,
      text: content
        .filter((block): block is AITextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      stopReason: message.stop_reason ?? null,
      usage,
      costUsd: computeCost(usage, model === this.fastModel ? this.fastPricing : this.mainPricing, model),
      latencyMs,
      requestId: (message as { _request_id?: string })._request_id,
    };
  }
}

// ---------------------------------------------------------------------------
// Factories and helpers
// ---------------------------------------------------------------------------

/** The configured provider, or null when ANTHROPIC_API_KEY is absent. */
export function getAnthropicProvider(): AnthropicProvider | null {
  const env = serverEnv();
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicProvider();
}

function missingKeyError(): AIProviderError {
  return new AIProviderError(
    "ANTHROPIC_API_KEY is not configured. Set it in the server environment to enable Claude.",
    { code: "MISSING_API_KEY", retryable: false },
  );
}

function abortedError(): AIProviderError {
  return new AIProviderError("The Anthropic request was cancelled.", {
    code: "ABORTED",
    retryable: false,
  });
}

function pricingFromEnv(tier: "MAIN" | "FAST"): AIPricing {
  const env = serverEnv() as unknown as Record<string, number | undefined>;
  return {
    inputPerMTok: env[`AI_COST_${tier}_INPUT_PER_MTOK`],
    outputPerMTok: env[`AI_COST_${tier}_OUTPUT_PER_MTOK`],
    cacheReadPerMTok: env[`AI_COST_${tier}_CACHE_READ_PER_MTOK`],
    cacheWritePerMTok: env[`AI_COST_${tier}_CACHE_WRITE_PER_MTOK`],
  };
}

/**
 * USD cost from real token counts and configured rates. Returns null when a
 * token category with a non-zero count has no configured price — an estimate
 * would be a fabricated number.
 */
export function computeCost(usage: AIUsage, pricing: AIPricing, _model?: string): number | null {
  const categories: Array<[number, number | undefined]> = [
    [usage.inputTokens, pricing.inputPerMTok],
    [usage.outputTokens, pricing.outputPerMTok],
    [usage.cacheReadInputTokens, pricing.cacheReadPerMTok],
    [usage.cacheCreationInputTokens, pricing.cacheWritePerMTok],
  ];
  let micros = 0;
  for (const [tokens, rate] of categories) {
    if (tokens <= 0) continue;
    if (rate === undefined) return null;
    micros += (tokens * rate) / 1_000_000;
  }
  if (micros === 0) {
    const anyPricing = categories.some(([, rate]) => rate !== undefined);
    return anyPricing ? 0 : null;
  }
  return Math.round(micros * 1_000_000) / 1_000_000;
}

function retryAfterFrom(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const value = (headers as { get?: (name: string) => string | null }).get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_BACKOFF_MS, Math.round(seconds * 1000));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Link a caller abort signal to a fresh timeout controller. The returned
 * `timedOut()` distinguishes our deadline from an explicit cancellation.
 */
function linkAbort(caller: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

function splitSystemMessages(
  system: string | undefined,
  messages: AIMessage[],
): { system?: string; messages: AIMessage[] } {
  const systemParts: string[] = [];
  if (system?.trim()) systemParts.push(system.trim());
  const body: AIMessage[] = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    if (typeof message.content === "string") {
      if (!message.content.trim()) {
        throw new AIProviderError("Message content cannot be empty.", { code: "INVALID_REQUEST" });
      }
    } else if (message.content.length === 0) {
      throw new AIProviderError("Message content cannot be empty.", { code: "INVALID_REQUEST" });
    }
    body.push(message);
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: mergeAdjacentText(body),
  };
}

/** Anthropic expects alternating roles; merge adjacent plain-text turns. */
function mergeAdjacentText(messages: AIMessage[]): AIMessage[] {
  const merged: AIMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.role === message.role &&
      typeof previous.content === "string" &&
      typeof message.content === "string"
    ) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function toWireTool(tool: AIToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...tool.inputSchema,
      type: "object",
    },
  };
}

function toWireToolChoice(choice: AIToolChoice, parallel: boolean): ToolChoice {
  const disableParallel = parallel ? undefined : true;
  if (choice === "auto") return { type: "auto", ...(disableParallel ? { disable_parallel_tool_use: true } : {}) };
  if (choice === "any") return { type: "any", ...(disableParallel ? { disable_parallel_tool_use: true } : {}) };
  if (choice === "none") return { type: "none" };
  return { type: "tool", name: choice.name, ...(disableParallel ? { disable_parallel_tool_use: true } : {}) };
}

function toWireMessage(message: AIMessage): MessageParam {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map(toWireBlock) as ContentBlockParam[],
  };
}

function toWireBlock(block: AIContentBlock): ContentBlockParam {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    } satisfies ToolUseBlockParam;
  }
  return {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content,
    ...(block.isError ? { is_error: true } : {}),
  } satisfies ToolResultBlockParam;
}
