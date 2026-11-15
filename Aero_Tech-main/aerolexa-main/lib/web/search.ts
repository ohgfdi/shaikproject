/**
 * Copilot web search — "use Google".
 *
 * Two real backends, resolved at request time:
 *   1. Google Custom Search JSON API — used when GOOGLE_CSE_API_KEY and
 *      GOOGLE_CSE_ENGINE_ID are configured. This is the documented "Google"
 *      path and the one with the best result quality.
 *   2. DuckDuckGo HTML endpoint — a free, key-less fallback so web lookup
 *      works out of the box before any API keys are created.
 *
 * Contract:
 * - Never throws. A failed provider (timeout, 403, network) degrades to
 *   `[]`, and the calling agent then simply answers from its own knowledge or
 *   says it could not find anything. A search outage is never allowed to take
 *   the whole chat request down.
 * - Results are the real, raw titles/URLs/snippets from the provider — they
 *   are only ever trimmed and de-duplicated here, never rewritten.
 */

import { serverEnv } from "@/lib/env";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const REQUEST_TIMEOUT_MS = 8000;

/** Resolve where to fetch results from, with a hard cap on latency. */
async function fetchJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Ledgerly-Copilot/0.1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`search provider returned ${res.status}`);
  return (await res.json()) as unknown;
}

// ---------------------------------------------------------------------------
// Google Custom Search JSON API
// ---------------------------------------------------------------------------

function fromGoogle(data: unknown): SearchResult[] {
  const items = (data as { items?: unknown[] } | undefined)?.items ?? [];
  const out: SearchResult[] = [];
  for (const item of items) {
    const rec = item as { title?: string; link?: string; snippet?: string } | null;
    if (!rec?.link) continue;
    out.push({
      title: trim(rec.title ?? "Untitled", 200),
      url: rec.link,
      snippet: trim(rec.snippet ?? "", 320),
    });
  }
  return dedupe(out);
}

async function googleSearch(query: string, limit: number): Promise<SearchResult[]> {
  const env = serverEnv();
  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?key=${encodeURIComponent(env.GOOGLE_CSE_API_KEY)}` +
    `&cx=${encodeURIComponent(env.GOOGLE_CSE_ENGINE_ID)}` +
    `&q=${encodeURIComponent(query)}` +
    `&num=${Math.min(limit, 10)}`;
  return fromGoogle(await fetchJson(url)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML fallback (free, key-less)
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  // Server-side decode of the small entity subset the results pages actually
  // use; any residual tags are stripped as a fallback.
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function fromDuckDuckGo(html: string, limit: number): SearchResult[] {
  // The HTML results page wraps every hit in <a rel="nofollow" class="result__a".
  // One pass over the page keeps title/url/snippet triplets aligned.
  const out: SearchResult[] = [];
  const blocks = html.split(/class="result__body"/);
  for (let i = 1; i < blocks.length; i++) {
    if (out.length >= limit) break;
    const block = blocks[i] as string;
    const anchor = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const snippetMatch =
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td class="result__snippet"[^>]*>([\s\S]*?)<\/td>/.exec(block);
    if (!anchor) continue;
    const url = normalizeResultUrl(anchor[1] as string);
    if (!url) continue;
    out.push({
      title: decodeEntities((anchor[2] as string).trim()),
      url,
      snippet: decodeEntities(trim((snippetMatch?.[1] ?? snippetMatch?.[2] ?? "").replace(/<[^>]*>/g, " "), 320)),
    });
  }
  return dedupe(out);
}

/** DuckDuckGo links are redirects (/l/?uddg=…) — extract the real destination. */
function normalizeResultUrl(href: string): string | null {
  const decoded = href.replace(/&amp;/g, "&");
  const uddg = /(?:\?|&)uddg=([^&]+)/.exec(decoded);
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return null;
    }
  }
  return decoded.startsWith("http") ? decoded : null;
}

async function duckDuckGoSearch(query: string, limit: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Ledgerly-Copilot/0.1" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`duckduckgo returned ${res.status}`);
  return fromDuckDuckGo(await res.text(), limit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the live web for `query`. Uses Google when configured, otherwise a
 * free DuckDuckGo lookup. Never throws — returns `[]` on any failure.
 */
export async function searchWeb(query: string, limit?: number): Promise<SearchResult[]> {
  const configuredLimit = serverEnv().SEARCH_RESULT_LIMIT;
  const capped = Math.max(1, Math.min(limit ?? configuredLimit, 10));
  const env = serverEnv();
  const useGoogle = Boolean(env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_ENGINE_ID);

  try {
    return useGoogle ? await googleSearch(query, capped) : await duckDuckGoSearch(query, capped);
  } catch {
    return [];
  }
}

/** True when the configured primary backend is the Google Custom Search API. */
export function webSearchUsesGoogle(): boolean {
  const env = serverEnv();
  return Boolean(env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_ENGINE_ID);
}

function trim(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = r.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (seen.has(key) || !r.title.trim()) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
