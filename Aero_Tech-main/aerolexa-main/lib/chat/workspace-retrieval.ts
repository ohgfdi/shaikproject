/**
 * Workspace RAG wiring — env-selected embedding provider + TTL-cached index.
 *
 * The chat route rebuilt its retrieval index from Prisma on EVERY request and
 * always used the deterministic lexical/LSA hybrid. Both honest, but they left
 * performance and semantic quality on the table:
 *
 *  - PERFORMANCE: the index is metadata-only (names, counts, kinds — never
 *    row data), so rebuilding it per request wastes queries on unchanged data.
 *    A small TTL cache (default 30s) absorbs bursts; the builder callback is
 *    re-invoked only after expiry. Cache identity = workspace id + a caller
 *    version stamp (bump the stamp when the metadata shapes change).
 *
 *  - SEMANTIC QUALITY: `hybridRetrieveFactsWithEmbeddings` adds a TRUE dense
 *    channel ("customer attrition" ↔ "churn report") fused with BM25 by
 *    Reciprocal Rank Fusion. When no provider is configured — or the provider
 *    fails at call time — the same call degrades to the deterministic
 *    LSA/TF-IDF hybrid. Retrieval NEVER breaks because a network dependency
 *    is missing, and never degrades silently: `usedEmbeddings` in the result
 *    records which path ran.
 *
 * Honesty contract (inherited from rag.ts/embedders.ts): only artifact
 * metadata enters the index and the embedding requests. Row data never
 * leaves the workspace through this module.
 */

import {
  createOllamaEmbedder,
  createOpenAICompatibleEmbedder,
  EmbeddingCache,
  type EmbeddingProvider,
} from "@/lib/chat/embedders";
import type { RagFact, RagHit } from "@/lib/chat/rag";
import { hybridRetrieveFactsWithEmbeddings, type HybridSearchOptions } from "@/lib/chat/semantic-search";
import { serverEnv } from "@/lib/env";

// ---------------------------------------------------------------------------
// Embedding provider selection (server-side, from validated env)
// ---------------------------------------------------------------------------

let cachedProvider: EmbeddingProvider | null | undefined;

/**
 * The env-selected embedding provider, or null when none is configured
 * (EMBEDDING_PROVIDER unset/empty). The decision is made ONCE per process —
 * env is validated at boot, so re-reading it per request cannot change the
 * answer. A malformed config surfaces at boot via the env schema superRefine.
 */
export function workspaceEmbeddingProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;
  const env = serverEnv();
  if (env.EMBEDDING_PROVIDER === "openai") {
    const baseUrl = (env.EMBEDDING_BASE_URL || env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const apiKey = env.EMBEDDING_API_KEY || env.LLM_API_KEY;
    cachedProvider = createOpenAICompatibleEmbedder({
      baseUrl,
      apiKey,
      model: env.EMBEDDING_MODEL,
    });
  } else if (env.EMBEDDING_PROVIDER === "ollama") {
    cachedProvider = createOllamaEmbedder({
      baseUrl: env.EMBEDDING_BASE_URL || env.OLLAMA_URL,
      model: env.EMBEDDING_MODEL,
    });
  } else {
    cachedProvider = null; // deterministic-only mode
  }
  return cachedProvider;
}

/** Test seam: forget the memoized provider decision (and the vector cache). */
export function __resetWorkspaceRetrievalForTests(): void {
  cachedProvider = undefined;
  embeddingCache = undefined;
  indexCache.clear();
}

// ---------------------------------------------------------------------------
// Process-level embedding vector cache (LRU-ish, insertion-ordered)
// ---------------------------------------------------------------------------

let embeddingCache: EmbeddingCache | undefined;

/** Shared vector cache so repeated turns don't re-embed unchanged facts. */
function getEmbeddingCache(): EmbeddingCache {
  if (!embeddingCache) embeddingCache = new EmbeddingCache(4_000);
  return embeddingCache;
}

// ---------------------------------------------------------------------------
// TTL-cached workspace index
// ---------------------------------------------------------------------------

interface IndexCacheEntry {
  index: RagFact[];
  builtAt: number;
}

const indexCache = new Map<string, IndexCacheEntry>();
const INDEX_TTL_MS = 30_000; // 30s — metadata changes propagate quickly, bursts stay cheap

/**
 * Build (or reuse) the workspace retrieval index. `build` is the route's
 * Prisma-loading callback — invoked only on cache miss/expiry. The cache key
 * includes the workspace id so multi-workspace processes never share facts.
 */
export async function getWorkspaceIndex(
  workspaceId: string,
  build: () => Promise<RagFact[]> | RagFact[],
): Promise<RagFact[]> {
  const entry = indexCache.get(workspaceId);
  if (entry && Date.now() - entry.builtAt < INDEX_TTL_MS) return entry.index;
  const index = await build();
  indexCache.set(workspaceId, { index, builtAt: Date.now() });
  // Bound the cache: one entry per workspace is tiny, but a long-lived
  // process serving thousands of workspaces should not grow unbounded.
  if (indexCache.size > 100) {
    const oldest = indexCache.keys().next().value;
    if (oldest !== undefined) indexCache.delete(oldest);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Retrieval entry point used by the chat route
// ---------------------------------------------------------------------------

export interface WorkspaceRetrievalResult {
  hits: RagHit[];
  /** Whether the dense embedding channel actually ran (vs deterministic fallback). */
  usedEmbeddings: boolean;
}

/**
 * Hybrid retrieval over the workspace index: BM25 ⊕ dense embeddings (RRF)
 * when a provider is configured, BM25 ⊕ TF-IDF-cosine otherwise. Provider
 * failures at call time degrade to the deterministic channel — honestly
 * (`usedEmbeddings: false`), never with invented hits.
 */
export async function retrieveWorkspaceFacts(
  message: string,
  index: RagFact[],
  limit = 5,
  opts: HybridSearchOptions = {},
): Promise<WorkspaceRetrievalResult> {
  const provider = workspaceEmbeddingProvider();
  if (!provider) {
    // Deterministic mode: LSA/TF-IDF ⊕ BM25 (the semantic-search upgrade path).
    const { hybridRetrieveFacts } = await import("@/lib/chat/semantic-search");
    return { hits: hybridRetrieveFacts(message, index, limit, opts), usedEmbeddings: false };
  }
  try {
    const hits = await hybridRetrieveFactsWithEmbeddings(message, index, limit, {
      ...opts,
      embedder: provider,
      cache: getEmbeddingCache(),
    });
    return { hits, usedEmbeddings: true };
  } catch {
    // Provider construction itself failed (e.g. bad URL): deterministic path.
    const { hybridRetrieveFacts } = await import("@/lib/chat/semantic-search");
    return { hits: hybridRetrieveFacts(message, index, limit, opts), usedEmbeddings: false };
  }
}
