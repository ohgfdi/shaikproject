/**
 * Compatibility shim for the older engine-facing LLM client.
 *
 * This module used to contain four independent wire implementations
 * (OpenAI, Anthropic, Azure OpenAI, Ollama) plus a mock. Those are gone.
 * Every method now delegates to lib/ai/provider.ts, so timeout, retry,
 * typed-error, caching, usage and cost behaviour is identical everywhere.
 *
 * The exported request/response shapes are preserved for existing engine
 * callers (NL→code, chart recommendations, the LLM copilot).
 */

import { AnthropicProvider, AIProviderError } from "@/lib/ai/provider";
import { serverEnv } from "@/lib/env";

export type LLMProvider = "anthropic";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LLMTool[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  responseFormat?: { type: "json_object" } | { type: "text" };
  seed?: number;
}

export interface LLMChoice {
  index: number;
  message: LLMMessage;
  finishReason: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  id: string;
  model: string;
  choices: LLMChoice[];
  usage: LLMUsage;
  created: number;
}

let _llmClient: LLMClient | null = null;

export class LLMClient {
  private readonly provider: AnthropicProvider;

  constructor(_provider?: LLMProvider) {
    this.provider = new AnthropicProvider();
  }

  /** The only generation provider. */
  getProvider(): LLMProvider {
    return "anthropic";
  }

  getDefaultModel(): string {
    return serverEnv().AI_MODEL_MAIN;
  }

  getModels(): string[] {
    const env = serverEnv();
    return [...new Set([env.AI_MODEL_MAIN, env.AI_MODEL_FAST])];
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const systemParts: string[] = [];
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const message of request.messages) {
      if (message.role === "system") {
        if (message.content.trim()) systemParts.push(message.content);
        continue;
      }
      if (message.role === "tool") {
        // Tool results are represented as user-visible text in this legacy
        // shape; callers that need structured tool blocks use lib/ai/provider.
        if (message.content.trim()) messages.push({ role: "user", content: message.content });
        continue;
      }
      if (!message.content.trim()) continue;
      messages.push({ role: message.role, content: message.content });
    }

    if (request.responseFormat?.type === "json_object") {
      systemParts.push("Return only valid JSON. Do not wrap it in markdown fences.");
    }

    try {
      const response = await this.provider.generate({
        model: request.model,
        system: systemParts.length ? systemParts.join("\n\n") : undefined,
        messages,
        tools: request.tools?.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: (tool.function.parameters ?? { type: "object" }) as {
            type: "object";
            properties?: Record<string, unknown>;
            required?: string[];
            [key: string]: unknown;
          },
        })),
        toolChoice:
          request.toolChoice === "none"
            ? "none"
            : request.toolChoice === "auto" || request.toolChoice === undefined
              ? "auto"
              : { name: request.toolChoice.function.name },
        temperature: request.temperature ?? 0.1,
        maxTokens: request.maxTokens ?? 2_000,
      });

      const text = response.text;
      const toolCalls: LLMToolCall[] = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));

      return {
        id: response.id,
        model: response.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finishReason: mapFinishReason(response.stopReason, toolCalls.length > 0),
          },
        ],
        usage: {
          promptTokens:
            response.usage.inputTokens + response.usage.cacheReadInputTokens + response.usage.cacheCreationInputTokens,
          completionTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
        },
        created: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      throw toLLMError(error);
    }
  }

  /** Simple text completion (single user message). */
  async completeText(
    prompt: string,
    options?: {
      system?: string;
      temperature?: number;
      maxTokens?: number;
      jsonMode?: boolean;
      model?: string;
    },
  ): Promise<string> {
    const messages: LLMMessage[] = [];
    if (options?.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });

    const response = await this.complete({
      messages,
      temperature: options?.temperature ?? 0.1,
      maxTokens: options?.maxTokens ?? 2_000,
      responseFormat: options?.jsonMode ? { type: "json_object" } : { type: "text" },
      model: options?.model,
    });
    return response.choices[0]?.message?.content ?? "";
  }

  /** Structured JSON completion with schema validation. */
  async completeJSON<T>(
    prompt: string,
    schema?: Record<string, unknown>,
    options?: {
      system?: string;
      temperature?: number;
      maxTokens?: number;
      model?: string;
    },
  ): Promise<T> {
    const system =
      options?.system ??
      "You are a precise JSON generator. Output only valid JSON matching the requested schema. No markdown, no commentary.";
    const response = await this.completeText(
      schema ? `${prompt}\n\nRespond with JSON matching this schema: ${JSON.stringify(schema)}` : prompt,
      { system, temperature: 0, maxTokens: options?.maxTokens ?? 2_000, jsonMode: true, model: options?.model },
    );

    try {
      return JSON.parse(response) as T;
    } catch (error) {
      throw new LLMError(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Get singleton LLM client (lazy init). */
export function getLLMClient(_provider?: LLMProvider): LLMClient {
  if (!_llmClient) _llmClient = new LLMClient();
  return _llmClient;
}

/** Reset client (for tests). */
export function resetLLMClient(): void {
  _llmClient = null;
}

function mapFinishReason(stopReason: string | null, hasTools: boolean): string {
  if (hasTools || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return stopReason ?? "stop";
}

function toLLMError(error: unknown): LLMError {
  if (error instanceof LLMError) return error;
  if (error instanceof AIProviderError) {
    const typed = new LLMError(error.message);
    typed.code = error.code;
    typed.status = error.status;
    typed.provider = "anthropic";
    return typed;
  }
  return new LLMError(error instanceof Error ? error.message : "Anthropic request failed.");
}

export class LLMError extends Error {
  status?: number;
  code?: string;
  provider?: string;
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}
