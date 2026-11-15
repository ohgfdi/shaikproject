/**
 * Pluggable embedding providers for semantic search.
 *
 * Closes the "classic IR only" gap: when a workspace configures an embedding
 * endpoint, hybrid retrieval gains a true dense-embedding channel (modern
 * semantic matching) fused with BM25 via Reciprocal Rank Fusion — the same
 * architecture as production vector-search systems. WITHOUT a provider the
 * deterministic LSA/TF-IDF path keeps working unchanged: search never breaks
 * because a network dependency is missing, and it never degrades silently —
 * callers can see which channels produced each hit.
 *
 * Honesty contract (matches rag.ts): embeddings are computed over fact TEXT
 * only (titles/keywords/metadata). No row data ever enters an embedding
 * request, so configuring a provider never moves user data off the workspace
 * beyond the artifact names that already render in the UI.
 *
 * Transport notes:
 *  - OpenAI-compatible: POST {baseUrl}/embeddings { model, input: string[] }
 *    → data[].embedding. Works with OpenAI, Azure-style gateways, vLLM,
 *    LM Studio, LocalAI, and any /v1-compatible server.
 *  - Ollama: POST {baseUrl}/api/embed { model, input: string[] }
 *    → embeddings[][]. (The legacy /api/embeddings shape is not used — it
 *    accepts only one input per call.)
 *  - Both are fail-loud at the call site: `embed` throws on non-2xx or a
 *    shape mismatch, and `hybridRetrieveFactsWithEmbeddings` catches and falls
 *    back to the deterministic channel rather than returning invented zeros.
 */

export interface EmbeddingProvider {
  /** Stable id used as the cache-key prefix (e.g. "openai:text-embedding-3-small"). */
  readonly id: string;
  /** Declared vector width, when the provider advertises one (0 = unknown until first call). */
  readonly dims: number;
  /** Embed a batch of texts. Order-preserving; throws on transport/shape errors. */
  embed(texts: string[]): Promise<number[][]>;
}

interface FetchLike {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<Response>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function assertFiniteVectors(vectors: unknown, expect: number, label: string): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expect) {
    throw new Error(
      `${label}: expected ${expect} embedding vector(s), got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`,
    );
  }
  return vectors.map((v, i) => {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`${label}: embedding ${i} is not a finite numeric vector`);
    }
    return v as number[];
  });
}

/**
 * OpenAI-compatible /embeddings provider. Works with any /v1-compatible
 * server (OpenAI, vLLM, LM Studio, LocalAI, LiteLLM proxies).
 */
export function createOpenAICompatibleEmbedder(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): EmbeddingProvider {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const model = opts.model;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    id: `openai:${model}`,
    dims: 0,
    async embed(texts) {
      if (texts.length === 0) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Embedding endpoint returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const json = (await res.json()) as { data?: { embedding?: unknown }[] };
        return assertFiniteVectors(
          (json.data ?? []).map((d) => d.embedding),
          texts.length,
          `Embedding endpoint (${model})`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Ollama /api/embed provider (batch input, one call). */
export function createOllamaEmbedder(opts: {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): EmbeddingProvider {
  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = opts.model;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    id: `ollama:${model}`,
    dims: 0,
    async embed(texts) {
      if (texts.length === 0) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Ollama embed returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const json = (await res.json()) as { embeddings?: unknown };
        return assertFiniteVectors(json.embeddings, texts.length, `Ollama (${model})`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Embedding cache — maps provider id + text hash → vector so an index built
 * once per process (or per conversation) doesn't re-embed unchanged facts.
 * Keys are deterministic (FNV-1a over the text), insertion-bounded: when the
 * cache exceeds `maxEntries` the OLDEST entry is evicted (insertion order —
 * Maps iterate in insertion order), keeping memory flat for long-lived
 * processes without any timers.
 */
export class EmbeddingCache {
  private readonly map = new Map<string, number[]>();
  constructor(private readonly maxEntries = 4_000) {}

  private static hash(text: string): string {
    // FNV-1a 32-bit + length — cheap, stable, collision-safe enough for cache
    // keys (a collision at worst reuses a semantically different vector for a
    // fact of the same length; the lexical channel still gates ordering).
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(36)}:${text.length}`;
  }

  key(providerId: string, text: string): string {
    return `${providerId}#${EmbeddingCache.hash(text)}`;
  }

  get(providerId: string, text: string): number[] | undefined {
    const k = this.key(providerId, text);
    const v = this.map.get(k);
    if (v !== undefined) {
      // Refresh insertion order so hot entries survive eviction.
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(providerId: string, text: string, vector: number[]): void {
    const k = this.key(providerId, text);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, vector);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** L2-normalize in place-ish (returns a new array); zero vector stays zero. */
export function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm > 1e-12 ? v.map((x) => x / norm) : v;
}

/** Cosine similarity of two vectors (assumes comparable scales; no mutation). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-12 ? dot / denom : 0;
}
