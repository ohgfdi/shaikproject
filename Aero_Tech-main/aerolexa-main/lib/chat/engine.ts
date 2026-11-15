/**
 * Copilot chat engine — a ChatGPT-style, multi-turn assistant that can
 * consult the live web ("use Google").
 *
 * Two real phases, both opt-in and honest about what they used:
 *
 *  1. Web routing (non-streamed, fast): when the user enables web search, the
 *     model is asked to decide, from the conversation alone, whether the last
 *     question needs up-to-date/factual web information. If it does, the
 *     engine runs real searches (Google Custom Search when configured, free
 *     DuckDuckGo otherwise) and collects the actual returned titles/URLs.
 *
 *  2. Streaming answer (token stream): the chosen provider generates the
 *     reply, given the conversation + (optionally) the real web snippets.
 *     The reply streams to the client token by token. If web results were
 *     used, the model is instructed to cite each one inline ([1](url)) and
 *     list them as Sources — the client renders those as links.
 *
 * Honesty contract:
 * - The engine never fabricates a URL or summarises a page it did not fetch.
 * - A failed web lookup degrades to "no web results" and a normal answer;
 *   the assistant says when it could not find anything online.
 * - No provider configured? The route answers with a clear error instead of
 *   pretending a model ran.
 */

import { renderRagContext, type RagHit } from "@/lib/chat/rag";
import type { LLMProvider } from "@/lib/llm/providers";
import { searchWeb, webSearchUsesGoogle, type SearchResult } from "@/lib/web/search";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ChatSource = SearchResult;

export interface WebSearchContext {
  used: boolean;
  backend: "google" | "duckduckgo" | "none";
  queries: string[];
  sources: ChatSource[];
}

/**
 * Optional, factual context injected into the assistant's persona. Only real
 * workspace facts are ever included — never row data, predictions or guesses.
 */
export interface ChatParticipantContext {
  userName?: string | null;
  workspaceName?: string | null;
  organization?: string | null;
  industry?: string | null;
  projects?: { name: string }[];
  datasets?: { name: string; rowCount: number; columnCount: number }[];
}

export const CHAT_MAX_MESSAGES = 13;
export const CHAT_MAX_QUERIES = 2;

/**
 * Renders the user's real workspace context into a few honest prompt lines.
 * Every fact comes from the database; names are embedded verbatim and counts
 * are exact. The persona still forbids pretending to have queried any dataset.
 */
export function renderPersonalContext(context: ChatParticipantContext): string {
  const lines: string[] = [];
  if (context.workspaceName) lines.push(`Workspace: ${context.workspaceName}`);
  if (context.userName)
    lines.push(`User: ${context.userName}${context.organization ? ` (${context.organization})` : ""}`);
  if (context.industry) lines.push(`Industry: ${context.industry}`);
  if (context.projects && context.projects.length > 0) {
    lines.push(`Projects: ${context.projects.map((p) => p.name).join(", ")}`);
  }
  if (context.datasets && context.datasets.length > 0) {
    lines.push(
      `Datasets available in the workspace: ${context.datasets
        .map((d) => `${d.name} (${d.rowCount.toLocaleString()} rows × ${d.columnCount} columns)`)
        .join("; ")}`,
    );
  }
  if (lines.length === 0) return "";
  return [
    "Facts about the user's workspace (real, from their account — use only to personalise tone and examples):",
    ...lines.map((l) => ` - ${l}`),
    "You have NOT opened or queried any dataset. If the user asks about their data, tell them you can see what exists but cannot read values, and suggest using the workspace's analysis tools.",
  ].join("\n");
}

/** The assistant's persistent persona. Web results, when present, are appended. */
export function chatSystemPrompt(context?: ChatParticipantContext): string {
  const parts = [
    "You are Ledgerly Copilot — a helpful, friendly AI assistant inside the Ledgerly data analytics workspace.",
    "You can write, answer questions, explain concepts, suggest analysis ideas and help with the app.",
    "You prefer clear, well-structured answers and use markdown (headings, bullet lists, tables) when it improves readability.",
    "You are honest about uncertainty: if you do not know something, say so plainly rather than guessing.",
    "When the user gives you data in chat, treat it as what they say it is, and say how you used it.",
  ];
  if (context) {
    const personal = renderPersonalContext(context);
    if (personal) parts.push(personal);
  }
  return parts.join("\n");
}

/** A short, human title for a fresh conversation (first user message). */
export function titleForChat(messages: ChatMessage[], fallback = "New chat"): string {
  for (const m of messages) {
    if (m.role === "user" && m.content.trim().length > 0) {
      const text = m.content.trim().replace(/\s+/g, " ");
      if (text.length <= 48) return text;
      return `${text.slice(0, 45).trimEnd()}…`;
    }
  }
  return fallback;
}

/** Serialise the recent conversation for a stateless system+user provider. */
export function renderConversation(messages: ChatMessage[]): string {
  const recent = messages.slice(-CHAT_MAX_MESSAGES);
  const lines = recent.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  return lines.join("\n\n");
}

/** Extract a JSON array of search queries from a strict model answer. */
export function parseSearchQueries(content: string): string[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim().slice(0, 200))
    .filter((q) => q.length > 0)
    .slice(0, CHAT_MAX_QUERIES);
}

async function askSearchDecision(provider: LLMProvider, conversation: ChatMessage[]): Promise<string[]> {
  const prompt = [
    "You are the web-search router for an assistant.",
    "",
    "Conversation:",
    renderConversation(conversation),
    "",
    "Decide whether answering the user's LAST message requires CURRENT, REAL, FACTUAL web information (news, prices, releases, people, docs, URLs, things outside the conversation).",
    'If it does, reply with ONLY a JSON array of 1-2 concise web search queries, e.g. ["latest ARM chips 2026 announcements"].',
    "If it does not, reply with ONLY: []",
    "No prose, no markdown — just the JSON array.",
  ].join("\n");

  try {
    const res = await provider.generate({
      systemPrompt: "You are a strict JSON-only search router. You reply with exactly one JSON array and nothing else.",
      userPrompt: prompt,
      maxTokens: 60,
      temperature: 0,
      timeout: 12000,
    });
    return parseSearchQueries(res.content);
  } catch {
    return [];
  }
}

/**
 * Step 1 — ask the model whether live web info is needed and, if so, extract
 * 1-2 concrete queries. Never throws: provider/router failures mean "web off".
 */
export async function decideSearch(provider: LLMProvider, conversation: ChatMessage[]): Promise<string[]> {
  try {
    return await askSearchDecision(provider, conversation);
  } catch {
    return [];
  }
}

/**
 * Step 2 — run the real searches for the decided queries and collect actual
 * results. Never throws: a failed lookup simply means no web results.
 */
export async function runWebSearches(queries: string[]): Promise<WebSearchContext> {
  if (queries.length === 0) {
    return { used: false, backend: "none", queries: [], sources: [] };
  }

  const sources: ChatSource[] = [];
  for (const query of queries) {
    const results = await searchWeb(query);
    for (const r of results) sources.push(r);
    if (sources.length >= 10) break;
  }

  return {
    used: sources.length > 0,
    backend: sources.length > 0 ? (webSearchUsesGoogle() ? "google" : "duckduckgo") : "none",
    queries,
    sources: dedupeSources(sources),
  };
}

/**
 * Phase 1 — decide whether live web info is needed and gather real results.
 * Convenience wrapper (decide + run) kept for existing callers/tests.
 */
export async function gatherWebContext(provider: LLMProvider, conversation: ChatMessage[]): Promise<WebSearchContext> {
  return runWebSearches(await decideSearch(provider, conversation));
}

/** Render the gathered web snippets — the only URLs the model may cite. */
export function renderWebContext(ctx: WebSearchContext): string {
  if (!ctx.used || ctx.sources.length === 0) {
    return "Web search ran but returned no usable results. Say you could not find anything online rather than guessing.";
  }
  const lines = ctx.sources.map((s, i) => `${i + 1}. ${s.title}\n   URL: ${s.url}\n   Snippet: ${s.snippet}`);
  return `Live web search results (the ONLY URLs you may cite):\n${lines.join("\n\n")}`;
}

/**
 * Build the system+user pair streamed to the provider for the final answer.
 *
 * `ragHits` carries workspace-fact retrieval (lib/chat/rag.ts) — internal
 * RAG alongside the web-search RAG. When provided, the grounding block is
 * injected so answers can point the user at their real datasets/projects
 * without the model inventing their contents.
 */
export function buildStreamRequest(
  conversation: ChatMessage[],
  web: WebSearchContext,
  context?: ChatParticipantContext,
  ragHits?: RagHit[],
): { systemPrompt: string; userPrompt: string } {
  const systemParts = [chatSystemPrompt(context)];

  const ragBlock = renderRagContext(ragHits ?? []);
  if (ragBlock) systemParts.push(ragBlock);

  if (web.used) {
    systemParts.push(
      "You were given live web results for the last question.",
      renderWebContext(web),
      [
        "Rules when web results were used:",
        '- begin the answer with a short phrase such as "Here\'s what I found online".',
        "- cite each claim from the web inline as [N](url) using the numbered list above.",
        '- finish with a "Sources" bullet list of the URLs you cited; never list a URL not in the results.',
      ].join("\n"),
    );
  }

  systemParts.push("Answer the user's LAST message directly. Use markdown. Keep it helpful and appropriately concise.");

  return {
    systemPrompt: systemParts.join("\n\n"),
    userPrompt: renderConversation(conversation),
  };
}

function dedupeSources(sources: ChatSource[]): ChatSource[] {
  const seen = new Set<string>();
  const out: ChatSource[] = [];
  for (const s of sources) {
    const key = s.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
